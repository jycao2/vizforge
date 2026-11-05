<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/* ============================================================
 * 迭代式路径追踪（WebGL2）
 *  - 每帧每像素打 1 条路径（含 5 次弹射），结果累加进 RGBA32F 累积纹理；
 *    相机静止时画面逐帧降噪收敛，一动就清零重积。
 *  - 材质：漫反射（余弦重要性采样）/ 金属（微粗糙镜面）/ 玻璃（Schlick 菲涅尔
 *    决定反射或折射）/ 自发光。地面是经典棋盘格。
 *  - 随机数用 PCG hash（像素坐标 + 帧号做种子），分布足够好。
 * ============================================================ */

const container = ref<HTMLDivElement>()
const unsupported = ref('')
const samples = ref(0)
const fps = ref(0)
const resScale = ref(0.75)
const maxBounces = ref(5)

let raf = 0
let gl: WebGL2RenderingContext | null = null
let canvas: HTMLCanvasElement | null = null
let accA: WebGLTexture | null = null
let accB: WebGLTexture | null = null
let scratch: WebGLTexture | null = null
let fboA: WebGLFramebuffer | null = null
let fboB: WebGLFramebuffer | null = null
let fboS: WebGLFramebuffer | null = null
let readIsA = true
let simW = 1
let simH = 1
let frame = 0

const cleanups: Array<() => void> = []

/* ---------------- 相机（球坐标） ---------------- */
let yaw = 0.55
let pitch = 0.28
let dist = 6.5
let dragging = false
let lastX = 0
let lastY = 0

const TRACE_FS = `#version 300 es
precision highp float;
out vec4 frag;
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uFovScale;
uniform int uFrame;     // 帧号（随机种子）
uniform int uBounces;

/* ---------- PCG 随机数 ---------- */
uint pcg(inout uint state) {
  uint prev = state * 747796405u + 2891336453u;
  uint word = ((prev >> ((prev >> 28u) + 4u)) ^ prev) * 277803737u;
  state = prev;
  return (word >> 22u) ^ word;
}
float rnd(inout uint seed) {
  return float(pcg(seed)) / 4294967296.0;
}
vec2 rnd2(inout uint seed) { return vec2(rnd(seed), rnd(seed)); }
vec3 rnd3(inout uint seed) { return vec3(rnd(seed), rnd(seed), rnd(seed)); }

// 单位球内均匀取点（ rejection 采样）
vec3 randInSphere(inout uint seed) {
  for (int i = 0; i < 8; i++) {
    vec3 p = rnd3(seed) * 2.0 - 1.0;
    if (dot(p, p) < 1.0) return p;
  }
  return vec3(0.0);
}

/* ---------- 场景：解析球体 ---------- */
// 材质编码：albedo.rgb + 类型(w: 0 漫反射 / 1 金属 / 2 玻璃)，emission 为发光
struct Hit {
  float t;
  vec3 n;
  vec3 albedo;
  int type;
  vec3 emission;
};

const int SPHERES = 6;
// xyz w=radius
uniform vec4 uSpheres[SPHERES];
uniform vec4 uSphereMat[SPHERES];   // rgb = albedo, w = 类型
uniform vec4 uSphereEmis[SPHERES];  // rgb = 发光，w = 未用

float iSphere(vec3 ro, vec3 rd, vec4 s) {
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - s.w * s.w;
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  float t = -b - sqrt(h);
  return t > 0.001 ? t : -1.0;
}

// 地面棋盘格 y = -1
float iPlane(vec3 ro, vec3 rd) {
  float t = (-1.0 - ro.y) / rd.y;
  return (rd.y < -0.0001 && t > 0.001) ? t : -1.0;
}

Hit traceScene(vec3 ro, vec3 rd) {
  Hit h;
  h.t = 1e30;
  h.type = -1;
  h.emission = vec3(0.0);

  float tp = iPlane(ro, rd);
  if (tp > 0.0 && tp < h.t) {
    h.t = tp;
    h.n = vec3(0.0, 1.0, 0.0);
    vec3 p = ro + rd * tp;
    float ck = mod(floor(p.x) + floor(p.z), 2.0);
    h.albedo = mix(vec3(0.92), vec3(0.16), ck);
    h.type = 0;
  }

  for (int i = 0; i < SPHERES; i++) {
    float t = iSphere(ro, rd, uSpheres[i]);
    if (t > 0.0 && t < h.t) {
      h.t = t;
      h.n = normalize(ro + rd * t - uSpheres[i].xyz);
      h.albedo = uSphereMat[i].rgb;
      h.type = int(uSphereMat[i].w + 0.5);
      h.emission = uSphereEmis[i].rgb;
    }
  }
  return h;
}

vec3 sky(vec3 rd) {
  // 夜空渐变 + 环境底光
  float up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.035, 0.045, 0.085), vec3(0.09, 0.12, 0.22), up);
  return col;
}

/* ---------- 路径追踪一条路径 ---------- */
vec3 radiance(vec3 ro, vec3 rd, inout uint seed) {
  vec3 through = vec3(1.0);
  vec3 acc = vec3(0.0);

  for (int b = 0; b < 12; b++) {
    if (b >= uBounces) break;
    Hit h = traceScene(ro, rd);
    if (h.type < 0) {
      acc += through * sky(rd);
      break;
    }
    // 自发光
    acc += through * h.emission;
    vec3 p = ro + rd * h.t;

    if (h.type == 0) {
      // 漫反射：余弦加权重要性采样
      vec3 d = normalize(h.n + randInSphere(seed));
      through *= h.albedo;
      ro = p + h.n * 0.001;
      rd = d;
    } else if (h.type == 1) {
      // 金属：镜面反射 + 粗糙度扰动
      vec3 r = reflect(rd, h.n);
      rd = normalize(r + randInSphere(seed) * 0.08);
      if (dot(rd, h.n) < 0.0) rd = r;
      through *= h.albedo;
      ro = p + h.n * 0.001;
    } else {
      // 玻璃：Schlick 菲涅尔选反射或折射
      bool entering = dot(rd, h.n) < 0.0;
      vec3 n = entering ? h.n : -h.n;
      float eta = entering ? (1.0 / 1.5) : 1.5;
      float cosi = -dot(rd, n);
      float k = 1.0 - eta * eta * (1.0 - cosi * cosi);
      float f0 = 0.04; // 玻璃界面反射率
      float fres = f0 + (1.0 - f0) * pow(1.0 - cosi, 5.0);
      if (k < 0.0 || rnd(seed) < fres) {
        rd = reflect(rd, n);
        ro = p + n * 0.001;
      } else {
        rd = normalize(eta * rd + (eta * cosi - sqrt(k)) * n);
        ro = p - n * 0.001;
      }
    }

    // 俄罗斯轮盘：贡献小的路径早点终止
    float q = max(through.r, max(through.g, through.b));
    if (rnd(seed) > q) break;
    through /= max(q, 0.01);
  }
  return acc;
}

void main() {
  uint seed = uint(gl_FragCoord.x) * 1973u + uint(gl_FragCoord.y) * 9277u + uint(uFrame) * 26699u;
  seed = pcg(seed); // 预热一次

  // 抖动采样（抗锯齿 + 软阴影都靠它）
  vec2 jitter = rnd2(seed) - 0.5;
  vec2 ndc = ((gl_FragCoord.xy + jitter) / uRes) * 2.0 - 1.0;
  ndc.x *= uRes.x / uRes.y;
  vec3 rd = normalize(uCamFwd + uFovScale * (ndc.x * uCamRight + ndc.y * uCamUp));

  vec3 col = radiance(uCamPos, rd, seed);
  // 防火萤石（NaN / 负值抑制）
  col = clamp(col, vec3(0.0), vec3(60.0));

  frag = vec4(col, 1.0);
}`

const ACCUM_FS = `#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D uPrev;
uniform sampler2D uCurr;
void main() {
  frag = texture(uPrev, gl_FragCoord.xy / vec2(textureSize(uPrev, 0))) + texture(uCurr, gl_FragCoord.xy / vec2(textureSize(uCurr, 0)));
}`

const COPY_FS = `#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D uSrc;
void main() {
  frag = texture(uSrc, gl_FragCoord.xy / vec2(textureSize(uSrc, 0)));
}`

const DISPLAY_FS = `#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D uAcc;
uniform float uSamples;
uniform vec2 uScreen; // 画布像素尺寸（与累积纹理分辨率不同，UV 要按它算）
// ACES 近似色调映射
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 c = texture(uAcc, gl_FragCoord.xy / uScreen).rgb / uSamples;
  c = aces(c * 1.15);
  c = pow(c, vec3(1.0 / 2.2));
  frag = vec4(c, 1.0);
}`

const BASE_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

function compile(type: number, src: string) {
  const g = gl!
  const s = g.createShader(type)!
  g.shaderSource(s, src)
  g.compileShader(s)
  if (!g.getShaderParameter(s, g.COMPILE_STATUS)) {
    console.error(g.getShaderInfoLog(s))
    return null
  }
  return s
}
function program(fs: string) {
  const g = gl!
  const p = g.createProgram()!
  const v = compile(g.VERTEX_SHADER, BASE_VS)
  const f = compile(g.FRAGMENT_SHADER, fs)
  g.attachShader(p, v!)
  g.attachShader(p, f!)
  g.linkProgram(p)
  g.deleteShader(v!)
  g.deleteShader(f!)
  if (!g.getProgramParameter(p, g.LINK_STATUS)) {
    console.error(g.getProgramInfoLog(p))
    return null
  }
  return p
}

let progTrace: WebGLProgram | null = null
let progAccum: WebGLProgram | null = null
let progDisplay: WebGLProgram | null = null
let progCopy: WebGLProgram | null = null

function createAccTex(w: number, h: number) {
  const g = gl!
  const tex = g.createTexture()!
  g.bindTexture(g.TEXTURE_2D, tex)
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA32F, w, h, 0, g.RGBA, g.FLOAT, null)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
  return tex
}

function rebuildTargets() {
  const g = gl!
  const el = container.value!
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * resScale.value
  simW = Math.max(1, Math.floor(el.clientWidth * dpr))
  simH = Math.max(1, Math.floor(el.clientHeight * dpr))
  if (accA) {
    for (const t of [accA, accB, scratch]) g.deleteTexture(t)
    for (const f of [fboA, fboB, fboS]) g.deleteFramebuffer(f!)
  }
  accA = createAccTex(simW, simH)
  accB = createAccTex(simW, simH)
  scratch = createAccTex(simW, simH)
  fboA = g.createFramebuffer()
  fboB = g.createFramebuffer()
  fboS = g.createFramebuffer()
  for (const [f, t] of [
    [fboA, accA],
    [fboB, accB],
    [fboS, scratch],
  ] as Array<[WebGLFramebuffer, WebGLTexture]>) {
    g.bindFramebuffer(g.FRAMEBUFFER, f)
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, t, 0)
  }
  g.clearColor(0, 0, 0, 0)
  for (const f of [fboA, fboB, fboS]) {
    g.bindFramebuffer(g.FRAMEBUFFER, f)
    g.clear(g.COLOR_BUFFER_BIT)
  }
  g.bindFramebuffer(g.FRAMEBUFFER, null)
  samples.value = 0
}

onMounted(() => {
  const el = container.value
  if (!el) return

  canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  el.appendChild(canvas)

  const ctx = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false })
  if (!ctx) {
    unsupported.value = '当前环境不支持 WebGL2'
    return
  }
  gl = ctx
  if (!gl.getExtension('EXT_color_buffer_float')) {
    unsupported.value = '缺少 EXT_color_buffer_float，无法渲染到浮点纹理'
    return
  }

  progTrace = program(TRACE_FS)
  progAccum = program(ACCUM_FS)
  progDisplay = program(DISPLAY_FS)
  progCopy = program(COPY_FS)
  if (!progTrace || !progAccum || !progDisplay || !progCopy) {
    unsupported.value = '着色器编译失败'
    return
  }

  function resize() {
    if (!canvas || !el) return
    canvas.width = Math.max(1, el.clientWidth)
    canvas.height = Math.max(1, el.clientHeight)
    rebuildTargets()
  }
  resize()
  window.addEventListener('resize', resize)
  cleanups.push(() => window.removeEventListener('resize', resize))

  // —— 相机交互：动了就清零重新累积 ——
  const onDown = (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas!.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    yaw -= (e.clientX - lastX) * 0.006
    pitch = Math.max(-0.1, Math.min(1.2, pitch + (e.clientY - lastY) * 0.005))
    lastX = e.clientX
    lastY = e.clientY
    samples.value = 0 // 视角变了，累积作废
  }
  const onUp = () => (dragging = false)
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    dist = Math.max(3.0, Math.min(16.0, dist * (1 + e.deltaY * 0.001)))
    samples.value = 0
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  cleanups.push(() => {
    canvas?.removeEventListener('pointerdown', onDown)
    canvas?.removeEventListener('pointermove', onMove)
    canvas?.removeEventListener('pointerup', onUp)
    canvas?.removeEventListener('wheel', onWheel)
  })

  // 分辨率档位变化时重建
  let lastScale = resScale.value
  const scaleTimer = window.setInterval(() => {
    if (resScale.value !== lastScale) {
      lastScale = resScale.value
      rebuildTargets()
    }
  }, 300)
  cleanups.push(() => window.clearInterval(scaleTimer))

  // —— 场景定义 ——
  // xyz=球心 w=半径
  const sphereData = new Float32Array([
    -1.35, -0.15, 0.2, 0.85,   // 红 - 漫反射
    1.35, -0.1, -0.15, 0.9,    // 金 - 金属
    0.0, 0.35, -1.6, 0.65,     // 玻璃
    2.6, 2.8, 1.2, 0.5,        // 暖光源
    -3.2, 1.9, -1.8, 0.35,     // 冷光源
    0.1, -0.55, 1.5, 0.45,     // 蓝紫 - 漫反射
  ])
  // rgb=albedo w=类型(0 漫反射 1 金属 2 玻璃)
  const matData = new Float32Array([
    0.85, 0.22, 0.18, 0,
    0.95, 0.75, 0.35, 1,
    0.98, 0.99, 1.0, 2,
    1.0, 1.0, 1.0, 0,
    1.0, 1.0, 1.0, 0,
    0.35, 0.3, 0.8, 0,
  ])
  // 发光
  const emisData = new Float32Array([
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    16, 12, 7, 0,
    4, 7, 14, 0,
    0, 0, 0, 0,
  ])

  const uT = {
    res: gl.getUniformLocation(progTrace!, 'uRes'),
    camPos: gl.getUniformLocation(progTrace!, 'uCamPos'),
    camRight: gl.getUniformLocation(progTrace!, 'uCamRight'),
    camUp: gl.getUniformLocation(progTrace!, 'uCamUp'),
    camFwd: gl.getUniformLocation(progTrace!, 'uCamFwd'),
    fovScale: gl.getUniformLocation(progTrace!, 'uFovScale'),
    frame: gl.getUniformLocation(progTrace!, 'uFrame'),
    bounces: gl.getUniformLocation(progTrace!, 'uBounces'),
    spheres: gl.getUniformLocation(progTrace!, 'uSpheres'),
    mat: gl.getUniformLocation(progTrace!, 'uSphereMat'),
    emis: gl.getUniformLocation(progTrace!, 'uSphereEmis'),
  }
  const uA = {
    prev: gl.getUniformLocation(progAccum!, 'uPrev'),
    curr: gl.getUniformLocation(progAccum!, 'uCurr'),
  }
  const uD = {
    acc: gl.getUniformLocation(progDisplay!, 'uAcc'),
    samples: gl.getUniformLocation(progDisplay!, 'uSamples'),
    screen: gl.getUniformLocation(progDisplay!, 'uScreen'),
  }
  const uCopySrc = gl.getUniformLocation(progCopy!, 'uSrc')

  gl.useProgram(progTrace!)
  gl.uniform4fv(uT.spheres!, sphereData)
  gl.uniform4fv(uT.mat!, matData)
  gl.uniform4fv(uT.emis!, emisData)

  let lastBounces = maxBounces.value
  let frames = 0
  let fpsClock = performance.now()

  const loop = () => {
    raf = requestAnimationFrame(loop)
    const g = gl!
    frame++

    // 相机基向量
    const cp = Math.cos(pitch)
    const camPos: [number, number, number] = [
      dist * cp * Math.sin(yaw),
      dist * Math.sin(pitch) + 0.6,
      dist * cp * Math.cos(yaw),
    ]
    const fwd = [-camPos[0], -camPos[1] + 0.2, -camPos[2]]
    const fl = Math.hypot(...fwd)
    const f: [number, number, number] = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl]
    const r: [number, number, number] = [f[2], 0, -f[0]]
    const rl = Math.hypot(...r)
    const rr: [number, number, number] = [r[0] / rl, r[1] / rl, r[2] / rl]
    const up: [number, number, number] = [
      f[1] * rr[2] - f[2] * rr[1],
      f[2] * rr[0] - f[0] * rr[2],
      f[0] * rr[1] - f[1] * rr[0],
    ]

    // —— 三纹理乒乓：trace → scratch；accum(read + scratch) → write；swap ——
    const accReadTex = readIsA ? accA : accB
    const accWriteTex = readIsA ? accB : accA
    const accWriteFbo = readIsA ? fboB : fboA

    // 1. 追踪：本帧单样本 → scratch
    g.bindFramebuffer(g.FRAMEBUFFER, fboS)
    g.viewport(0, 0, simW, simH)
    g.useProgram(progTrace!)
    if (maxBounces.value !== lastBounces) {
      lastBounces = maxBounces.value
      samples.value = 0
    }
    g.uniform2f(uT.res!, simW, simH)
    g.uniform3f(uT.camPos!, ...camPos)
    g.uniform3f(uT.camRight!, ...rr)
    g.uniform3f(uT.camUp!, ...up)
    g.uniform3f(uT.camFwd!, ...f)
    g.uniform1f(uT.fovScale!, 0.62)
    g.uniform1i(uT.frame!, frame)
    g.uniform1i(uT.bounces!, maxBounces.value)
    g.drawArrays(g.TRIANGLES, 0, 3)

    // 2. 累积：历史(read) + 本帧(scratch) → write（三张纹理互不冲突）
    g.bindFramebuffer(g.FRAMEBUFFER, accWriteFbo)
    g.viewport(0, 0, simW, simH)
    if (samples.value === 0) {
      // 刚重置：本帧即全部历史，原样拷贝
      g.useProgram(progCopy!)
      g.activeTexture(g.TEXTURE0)
      g.bindTexture(g.TEXTURE_2D, scratch)
      g.uniform1i(uCopySrc, 0)
    } else {
      g.useProgram(progAccum!)
      g.activeTexture(g.TEXTURE0)
      g.bindTexture(g.TEXTURE_2D, accReadTex!)
      g.uniform1i(uA.prev!, 0)
      g.activeTexture(g.TEXTURE1)
      g.bindTexture(g.TEXTURE_2D, scratch)
      g.uniform1i(uA.curr!, 1)
    }
    g.drawArrays(g.TRIANGLES, 0, 3)
    readIsA = !readIsA
    samples.value++

    // 3. 显示：累积均值 + ACES
    g.bindFramebuffer(g.FRAMEBUFFER, null)
    g.viewport(0, 0, canvas!.width, canvas!.height)
    g.useProgram(progDisplay!)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, accWriteTex)
    g.uniform1i(uD.acc!, 0)
    g.uniform1f(uD.samples!, samples.value)
    g.uniform2f(uD.screen!, canvas!.width, canvas!.height)
    g.drawArrays(g.TRIANGLES, 0, 3)

    frames++
    const now = performance.now()
    if (now - fpsClock > 500) {
      fps.value = Math.round((frames * 1000) / (now - fpsClock))
      frames = 0
      fpsClock = now
    }
  }
  loop()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  cleanups.forEach((f) => f())
  if (gl && accA) {
    for (const t of [accA, accB, scratch]) if (t) gl.deleteTexture(t)
    for (const f of [fboA, fboB, fboS]) if (f) gl.deleteFramebuffer(f)
  }
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="container"></div>
    <div v-if="unsupported" class="unsupported">{{ unsupported }}</div>
    <div class="panel">
      <div class="row">
        <span class="label">渲染精度</span>
        <input
          class="range"
          type="range"
          min="0.35"
          max="1"
          step="0.05"
          :value="resScale"
          @input="resScale = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ Math.round(resScale * 100) }}%</span>
      </div>
      <div class="row">
        <span class="label">最大弹射</span>
        <input
          class="range"
          type="range"
          min="2"
          max="10"
          step="1"
          :value="maxBounces"
          @input="maxBounces = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ maxBounces }}</span>
      </div>
      <div class="meta">已累积 {{ samples }} spp · {{ fps }} FPS</div>
      <div class="tip">
        每帧每像素 1 条路径累加进浮点缓冲，静止时画面逐帧收敛（拖动相机即重置）。场景含
        漫反射 / 金属 / 玻璃（菲涅尔折射）三材质 + 两个面光源，ACES 色调映射输出。
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.container {
  width: 100%;
  height: 100%;
}
.unsupported {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e88;
  font-size: 14px;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 300px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.label {
  font-size: 12px;
  color: #9fb0c2;
  white-space: nowrap;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  font-size: 12px;
  color: #7ee787;
  width: 42px;
  text-align: right;
}
.meta {
  font-size: 11.5px;
  color: #7ee787;
  margin: 2px 0 4px;
}
.tip {
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
