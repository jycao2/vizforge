<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/* ============================================================
 * 水下焦散（WebGL2）
 *  - 池底 / 池壁：经典「迭代扭曲场」算 caustics —— 五层嵌套 sin/cos
 *    扭曲采样坐标，取倒数累加，得到水面光线汇聚形成的亮网纹
 *  - 水面：顶点位移波浪 + 从水下看的菲涅尔与 Snell 窗口
 *  - 体积光柱：面向相机的加法混合四边形，从水面斜插池底
 *  - 气泡：点精灵向上飘，到水面循环
 * ============================================================ */

const container = ref<HTMLDivElement>()
const unsupported = ref('')
const causticPower = ref(1.0)
const waveAmp = ref(0.22)
const shaftOpacity = ref(0.5)
const tint = ref(0.75)
const fps = ref(0)

let raf = 0
let gl: WebGL2RenderingContext | null = null
let canvas: HTMLCanvasElement | null = null
const cleanups: Array<() => void> = []

/* ---------------- 矩阵 ---------------- */
function perspective(fov: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fov / 2)
  const m = new Float32Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = (far + near) / (near - far)
  m[11] = -1
  m[14] = (2 * far * near) / (near - far)
  return m
}
function lookAt(eye: number[], center: number[], up: number[]) {
  const z = [eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]
  let l = Math.hypot(...z)
  const zn = z.map((v) => v / l)
  const x = [up[1] * zn[2] - up[2] * zn[1], up[2] * zn[0] - up[0] * zn[2], up[0] * zn[1] - up[1] * zn[0]]
  l = Math.hypot(...x) || 1
  const xn = x.map((v) => v / l)
  const y = [zn[1] * xn[2] - zn[2] * xn[1], zn[2] * xn[0] - zn[0] * xn[2], zn[0] * xn[1] - zn[1] * xn[0]]
  return new Float32Array([
    xn[0], y[0], zn[0], 0,
    xn[1], y[1], zn[1], 0,
    xn[2], y[2], zn[2], 0,
    -(xn[0] * eye[0] + xn[1] * eye[1] + xn[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(zn[0] * eye[0] + zn[1] * eye[1] + zn[2] * eye[2]),
    1,
  ])
}
function mul(a: Float32Array, b: Float32Array) {
  const o = new Float32Array(16)
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]
      o[i * 4 + j] = s
    }
  return o
}

/* ---------------- 着色器 ---------------- */
// 池底 / 池壁：顶点自带法线，一次 draw 画完整个水池
const POOL_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uVP;
out vec3 vWorld;
out vec3 vNormalW;
void main() {
  vWorld = aPos;
  vNormalW = aNormal;
  gl_Position = uVP * vec4(aPos, 1.0);
}`

const POOL_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormalW;
out vec4 frag;
uniform float uTime;
uniform float uCaustic;
uniform float uTint;

// 经典水下焦散：多层迭代扭曲，取倒数累加后做幂次提亮
float caustic(vec2 uv, float time) {
  // 忠实复刻经典 caustics（Dave_Hoskins）：mod 平铺 + -250 偏移不能省，
  // 它保证 p.x*inten 与 sin 的比值量级正确；少偏移会让 1/length 全面爆炸、整屏刷白
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 5; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 5.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}

void main() {
  vec3 n = normalize(vNormalW);
  // 三平面映射：地面用 xz，侧墙用 zy / xy，瓷砖在墙上也不拉伸
  vec2 uv;
  if (abs(n.y) > 0.5) uv = vWorld.xz;
  else if (abs(n.x) > 0.5) uv = vWorld.zy;
  else uv = vWorld.xy;

  vec2 t2 = uv * 0.55;
  vec2 g = abs(fract(t2) - 0.5);
  float grout = smoothstep(0.46, 0.5, min(g.x, g.y)); // 瓷砖缝
  vec2 cell = floor(t2);
  float checker = mod(cell.x + cell.y, 2.0);
  vec3 tile = mix(vec3(0.38, 0.55, 0.62), vec3(0.26, 0.40, 0.47), checker * 0.55);
  tile = mix(tile, tile * 0.72, grout);

  // 焦散：两个不同尺度叠加，避免过于规则
  float c1 = caustic(vWorld.xz * 0.22, uTime * 0.55);
  float c2 = caustic(vWorld.xz * 0.36 + 11.0, uTime * 0.42);
  float caus = (c1 * 0.65 + c2 * 0.42) * uCaustic;
  // 地面（法线朝上）接收最强焦散，墙面弱一些
  float facing = abs(n.y) * 0.85 + 0.15;

  vec3 col = tile * (0.30 + 0.42 * uTint);
  // 焦散是「光」：只在光纹处提亮，底色保持暗，光纹才有对比
  col += vec3(0.55, 0.85, 0.95) * caus * facing * 0.75;
  col = mix(col, vec3(0.03, 0.16, 0.22), 0.18);

  frag = vec4(pow(col, vec3(0.4545)), 1.0);
}`

// 水面（从水下看）
const WATER_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uVP;
uniform float uTime;
uniform float uAmp;
out vec3 vWorld;
out vec3 vNormalW;
void main() {
  vec3 p = aPos;
  float t = uTime;
  float h = 0.0;
  h += sin(p.x * 0.85 + t * 1.4) * 0.5;
  h += sin(p.z * 1.1 - t * 1.1) * 0.35;
  h += sin((p.x + p.z) * 0.62 + t * 1.9) * 0.28;
  h += sin((p.x - p.z) * 1.4 - t * 2.3) * 0.15;
  p.y += h * uAmp;

  float dx = (cos(p.x * 0.85 + t * 1.4) * 0.5 * 0.85
            + cos((p.x + p.z) * 0.62 + t * 1.9) * 0.28 * 0.62
            + cos((p.x - p.z) * 1.4 - t * 2.3) * 0.15 * 1.4) * uAmp;
  float dz = (cos(p.z * 1.1 - t * 1.1) * 0.35 * 1.1
            + cos((p.x + p.z) * 0.62 + t * 1.9) * 0.28 * 0.62
            - cos((p.x - p.z) * 1.4 - t * 2.3) * 0.15 * 1.4) * uAmp;
  vNormalW = normalize(vec3(-dx, 1.0, -dz));

  vWorld = p;
  gl_Position = uVP * vec4(p, 1.0);
}`

const WATER_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormalW;
out vec4 frag;
uniform vec3 uCamPos;
uniform float uTime;
void main() {
  vec3 n = normalize(vNormalW);
  vec3 viewDir = normalize(uCamPos - vWorld);
  float cosT = abs(dot(n, viewDir));

  float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  vec3 sky = vec3(0.55, 0.78, 0.92);
  vec3 deep = vec3(0.05, 0.28, 0.34);
  vec3 col = mix(deep, sky, fres * 0.9 + 0.12);

  // Snell 窗口：水下仰视时头顶那圈亮圆
  float window = smoothstep(0.62, 0.72, cosT);
  col += sky * window * 0.35;

  float ripple = pow(abs(sin(vWorld.x * 2.4 + uTime * 1.5) * sin(vWorld.z * 2.1 - uTime * 1.2)), 6.0);
  col += vec3(0.6, 0.9, 1.0) * ripple * 0.5;

  // 水面透明度压低：这页的主角是池底的焦散光纹，水若太不透明就只剩一片灰白
  frag = vec4(pow(col, vec3(0.4545)), 0.26 + fres * 0.6);
}`

// 体积光柱：aV 0=底部 1=顶部
const SHAFT_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aV;
uniform mat4 uVP;
out float vV;
out vec3 vWorld;
void main() {
  vV = aV;
  vWorld = aPos;
  gl_Position = uVP * vec4(aPos, 1.0);
}`

const SHAFT_FS = `#version 300 es
precision highp float;
in float vV;
in vec3 vWorld;
out vec4 frag;
uniform float uTime;
uniform float uOpacity;
uniform vec3 uCamPos;
void main() {
  float edge = smoothstep(0.0, 0.18, vV) * smoothstep(1.0, 0.72, vV);
  float flicker = 0.75 + 0.25 * sin(uTime * 1.6 + vWorld.x * 0.5);
  float dist = length(uCamPos - vWorld);
  float fade = exp(-dist * 0.055);
  frag = vec4(vec3(0.45, 0.82, 0.95), edge * flicker * fade * uOpacity);
}`

const BUBBLE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aSize;
uniform mat4 uVP;
out float vAlpha;
void main() {
  vec4 clip = uVP * vec4(aPos, 1.0);
  gl_Position = clip;
  gl_PointSize = aSize * 240.0 / max(clip.w, 0.001);
  vAlpha = smoothstep(0.7, -1.6, aPos.y);
}`

const BUBBLE_FS = `#version 300 es
precision highp float;
in float vAlpha;
out vec4 frag;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float ring = smoothstep(0.5, 0.34, d) * smoothstep(0.16, 0.34, d);
  float hi = smoothstep(0.2, 0.0, length(c - vec2(-0.13, -0.13)));
  frag = vec4(vec3(0.72, 0.94, 1.0), (ring * 0.85 + hi * 0.9) * vAlpha * 0.9);
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
function program(vs: string, fs: string) {
  const g = gl!
  const p = g.createProgram()!
  const v = compile(g.VERTEX_SHADER, vs)
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

let progPool: WebGLProgram | null = null
let progWater: WebGLProgram | null = null
let progShaft: WebGLProgram | null = null
let progBubble: WebGLProgram | null = null

let poolVAO: WebGLVertexArrayObject | null = null
let poolCount = 0
let waterVAO: WebGLVertexArrayObject | null = null
let waterCount = 0
let shaftVAO: WebGLVertexArrayObject | null = null
let shaftVBO: WebGLBuffer | null = null
let bubbleVAO: WebGLVertexArrayObject | null = null
let bubbleVBO: WebGLBuffer | null = null

const POOL = 12 // 半边长
const FLOOR_Y = -2.2
const WATER_Y = 0.62
const BUBBLES = 260
const bubbleData = new Float32Array(BUBBLES * 4)

let yaw = 0.5
// 初始视角必须在水面之上（eye.y > WATER_Y），否则默认画面就是
// 水下仰视——整个上半球被 Snell 窗口+菲涅尔刷成天光白，像白屏
let pitch = 0.3
let dist = 10
let dragging = false
let lastX = 0
let lastY = 0

/** 把一块矩形（位置 + 法线）追加进数组 */
function pushQuad(
  pos: number[],
  nor: number[],
  a: number[],
  b: number[],
  c: number[],
  d: number[],
  n: number[],
) {
  for (const v of [a, b, c, a, c, d]) {
    pos.push(v[0], v[1], v[2])
    nor.push(n[0], n[1], n[2])
  }
}

onMounted(() => {
  const el = container.value
  if (!el) return

  canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  el.appendChild(canvas)

  const ctx = canvas.getContext('webgl2', { antialias: true, alpha: false })
  if (!ctx) {
    unsupported.value = '当前环境不支持 WebGL2'
    return
  }
  gl = ctx

  progPool = program(POOL_VS, POOL_FS)
  progWater = program(WATER_VS, WATER_FS)
  progShaft = program(SHAFT_VS, SHAFT_FS)
  progBubble = program(BUBBLE_VS, BUBBLE_FS)
  if (!progPool || !progWater || !progShaft || !progBubble) {
    unsupported.value = '着色器编译失败'
    return
  }

  // —— 水池：地面 + 四面墙（顶点自带法线，一次 draw）——
  const pos: number[] = []
  const nor: number[] = []
  pushQuad(
    pos, nor,
    [-POOL, FLOOR_Y, -POOL], [POOL, FLOOR_Y, -POOL], [POOL, FLOOR_Y, POOL], [-POOL, FLOOR_Y, POOL],
    [0, 1, 0],
  )
  pushQuad(
    pos, nor,
    [-POOL, FLOOR_Y, -POOL], [POOL, FLOOR_Y, -POOL], [POOL, WATER_Y + 0.4, -POOL], [-POOL, WATER_Y + 0.4, -POOL],
    [0, 0, 1],
  )
  pushQuad(
    pos, nor,
    [POOL, FLOOR_Y, POOL], [-POOL, FLOOR_Y, POOL], [-POOL, WATER_Y + 0.4, POOL], [POOL, WATER_Y + 0.4, POOL],
    [0, 0, -1],
  )
  pushQuad(
    pos, nor,
    [-POOL, FLOOR_Y, POOL], [-POOL, FLOOR_Y, -POOL], [-POOL, WATER_Y + 0.4, -POOL], [-POOL, WATER_Y + 0.4, POOL],
    [1, 0, 0],
  )
  pushQuad(
    pos, nor,
    [POOL, FLOOR_Y, -POOL], [POOL, FLOOR_Y, POOL], [POOL, WATER_Y + 0.4, POOL], [POOL, WATER_Y + 0.4, -POOL],
    [-1, 0, 0],
  )
  poolCount = pos.length / 3

  poolVAO = gl.createVertexArray()
  gl.bindVertexArray(poolVAO)
  const pb = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, pb)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
  const nb = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, nb)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(nor), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)

  // —— 水面网格 ——
  const N = 96
  const wp: number[] = []
  const wi: number[] = []
  for (let z = 0; z <= N; z++)
    for (let x = 0; x <= N; x++) wp.push((x / N - 0.5) * POOL * 2, WATER_Y, (z / N - 0.5) * POOL * 2)
  for (let z = 0; z < N; z++)
    for (let x = 0; x < N; x++) {
      const a = z * (N + 1) + x
      wi.push(a, a + 1, a + N + 1, a + 1, a + N + 2, a + N + 1)
    }
  waterCount = wi.length
  waterVAO = gl.createVertexArray()
  gl.bindVertexArray(waterVAO)
  const wv = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, wv)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(wp), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
  const wib = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wib)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(wi), gl.STATIC_DRAW)
  gl.bindVertexArray(null)

  // —— 光柱（每帧重建顶点）——
  shaftVAO = gl.createVertexArray()
  gl.bindVertexArray(shaftVAO)
  shaftVBO = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, shaftVBO)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(4 * 6 * 4), gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12)
  gl.bindVertexArray(null)

  // —— 气泡 ——
  const bd = new Float32Array(BUBBLES * 4)
  for (let i = 0; i < BUBBLES; i++) {
    bd[i * 4] = (Math.random() - 0.5) * 20
    bd[i * 4 + 1] = FLOOR_Y + Math.random() * 2.6
    bd[i * 4 + 2] = (Math.random() - 0.5) * 20
    bd[i * 4 + 3] = 0.03 + Math.random() * 0.07
  }
  bubbleData.set(bd)
  bubbleVAO = gl.createVertexArray()
  gl.bindVertexArray(bubbleVAO)
  bubbleVBO = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, bubbleVBO)
  gl.bufferData(gl.ARRAY_BUFFER, bubbleData, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12)
  gl.bindVertexArray(null)

  function resize() {
    if (!canvas || !el) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(el.clientWidth * dpr))
    canvas.height = Math.max(1, Math.floor(el.clientHeight * dpr))
  }
  resize()
  window.addEventListener('resize', resize)
  cleanups.push(() => window.removeEventListener('resize', resize))

  const onDown = (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas!.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    yaw -= (e.clientX - lastX) * 0.006
    pitch = Math.max(-1.0, Math.min(0.45, pitch + (e.clientY - lastY) * 0.005))
    lastX = e.clientX
    lastY = e.clientY
  }
  const onUp = () => (dragging = false)
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    dist = Math.max(4.5, Math.min(20, dist * (1 + e.deltaY * 0.001)))
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

  const uPool = {
    vp: gl.getUniformLocation(progPool!, 'uVP'),
    time: gl.getUniformLocation(progPool!, 'uTime'),
    caustic: gl.getUniformLocation(progPool!, 'uCaustic'),
    tint: gl.getUniformLocation(progPool!, 'uTint'),
  }
  const uWater = {
    vp: gl.getUniformLocation(progWater!, 'uVP'),
    time: gl.getUniformLocation(progWater!, 'uTime'),
    amp: gl.getUniformLocation(progWater!, 'uAmp'),
    cam: gl.getUniformLocation(progWater!, 'uCamPos'),
  }
  const uShaft = {
    vp: gl.getUniformLocation(progShaft!, 'uVP'),
    time: gl.getUniformLocation(progShaft!, 'uTime'),
    opacity: gl.getUniformLocation(progShaft!, 'uOpacity'),
    cam: gl.getUniformLocation(progShaft!, 'uCamPos'),
  }
  const uBubble = { vp: gl.getUniformLocation(progBubble!, 'uVP') }

  let t = 0
  let frames = 0
  let fpsClock = performance.now()
  const shaftVerts = new Float32Array(4 * 6 * 4)

  const loop = () => {
    raf = requestAnimationFrame(loop)
    const g = gl!
    t += 0.016
    const aspect = canvas!.width / Math.max(1, canvas!.height)
    const eye = [
      dist * Math.cos(pitch) * Math.sin(yaw),
      0.35 + dist * Math.sin(pitch),
      dist * Math.cos(pitch) * Math.cos(yaw),
    ]
    const proj = perspective((56 * Math.PI) / 180, aspect, 0.1, 60)
    const view = lookAt(eye, [0, -0.9, 0], [0, 1, 0])
    const vp = mul(proj, view)

    g.viewport(0, 0, canvas!.width, canvas!.height)
    g.clearColor(0.02, 0.10, 0.14, 1)
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT)
    g.enable(g.DEPTH_TEST)
    g.depthMask(true)
    g.disable(g.BLEND)
    g.disable(g.CULL_FACE)

    // 1. 水池
    g.useProgram(progPool!)
    g.uniformMatrix4fv(uPool.vp!, false, vp)
    g.uniform1f(uPool.time!, t)
    g.uniform1f(uPool.caustic!, causticPower.value)
    g.uniform1f(uPool.tint!, tint.value)
    g.bindVertexArray(poolVAO!)
    g.drawArrays(g.TRIANGLES, 0, poolCount)

    // 2. 水面（半透明）
    g.useProgram(progWater!)
    g.uniformMatrix4fv(uWater.vp!, false, vp)
    g.uniform1f(uWater.time!, t)
    g.uniform1f(uWater.amp!, waveAmp.value)
    g.uniform3f(uWater.cam!, eye[0], eye[1], eye[2])
    g.enable(g.BLEND)
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA)
    g.depthMask(false)
    g.bindVertexArray(waterVAO!)
    g.drawElements(g.TRIANGLES, waterCount, g.UNSIGNED_INT, 0)

    // 3. 光柱：面向相机（横向方向垂直于视线）
    g.useProgram(progShaft!)
    g.uniformMatrix4fv(uShaft.vp!, false, vp)
    g.uniform1f(uShaft.time!, t)
    g.uniform1f(uShaft.opacity!, shaftOpacity.value)
    g.uniform3f(uShaft.cam!, eye[0], eye[1], eye[2])
    shaftVerts.fill(0)
    const rx = Math.cos(yaw)
    const rz = -Math.sin(yaw)
    for (let s = 0; s < 4; s++) {
      const cx = (s - 1.5) * 4.6 + Math.sin(t * 0.3 + s) * 1.2
      const cz = -3 + s * 2.2
      const hw = 1.1 + 0.35 * Math.sin(t * 0.7 + s * 1.7)
      const quad = [
        [cx - rx * hw, FLOOR_Y, cz - rz * hw, 0],
        [cx + rx * hw, FLOOR_Y, cz + rz * hw, 0],
        [cx + rx * hw * 1.5, WATER_Y, cz + rz * hw * 1.5, 1],
        [cx - rx * hw, FLOOR_Y, cz - rz * hw, 0],
        [cx + rx * hw * 1.5, WATER_Y, cz + rz * hw * 1.5, 1],
        [cx - rx * hw * 1.5, WATER_Y, cz - rz * hw * 1.5, 1],
      ]
      for (let v = 0; v < 6; v++) shaftVerts.set(quad[v], (s * 6 + v) * 4)
    }
    g.bindVertexArray(shaftVAO!)
    g.bindBuffer(g.ARRAY_BUFFER, shaftVBO!)
    g.bufferSubData(g.ARRAY_BUFFER, 0, shaftVerts)
    g.blendFunc(g.SRC_ALPHA, g.ONE) // 加法混合，光会叠加变亮
    g.drawArrays(g.TRIANGLES, 0, 24)

    // 4. 气泡
    g.useProgram(progBubble!)
    g.uniformMatrix4fv(uBubble.vp!, false, vp)
    for (let i = 0; i < BUBBLES; i++) {
      bubbleData[i * 4 + 1] += 0.006 + (i % 7) * 0.0012
      bubbleData[i * 4] += Math.sin(t * 1.2 + i) * 0.0015
      if (bubbleData[i * 4 + 1] > WATER_Y) {
        bubbleData[i * 4 + 1] = FLOOR_Y
        bubbleData[i * 4] = (Math.random() - 0.5) * 20
        bubbleData[i * 4 + 2] = (Math.random() - 0.5) * 20
      }
    }
    g.bindVertexArray(bubbleVAO!)
    g.bindBuffer(g.ARRAY_BUFFER, bubbleVBO!)
    g.bufferSubData(g.ARRAY_BUFFER, 0, bubbleData)
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA)
    g.drawArrays(g.POINTS, 0, BUBBLES)

    g.bindVertexArray(null)
    g.depthMask(true)

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
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="container"></div>
    <div v-if="unsupported" class="unsupported">{{ unsupported }}</div>
    <div class="panel">
      <div class="row">
        <span class="label">焦散强度</span>
        <input
          class="range"
          type="range"
          min="0"
          max="2.2"
          step="0.05"
          :value="causticPower"
          @input="causticPower = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ causticPower.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">水面波幅</span>
        <input
          class="range"
          type="range"
          min="0"
          max="0.6"
          step="0.02"
          :value="waveAmp"
          @input="waveAmp = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ waveAmp.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">光柱浓度</span>
        <input
          class="range"
          type="range"
          min="0"
          max="1.2"
          step="0.05"
          :value="shaftOpacity"
          @input="shaftOpacity = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ shaftOpacity.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">水体色调</span>
        <input
          class="range"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="tint"
          @input="tint = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ tint.toFixed(2) }}</span>
      </div>
      <div class="meta">{{ fps }} FPS</div>
      <div class="tip">
        池底亮网纹 = 五层迭代 sin/cos 扭曲场的倒数累加（经典 caustics 公式），配合瓷砖缝与深度衰减；
        水面从水下看用菲涅尔 + Snell 窗口提亮；光柱为加法混合的面向相机四边形。
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
