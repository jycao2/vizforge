<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/* ============================================================
 * SSAO 屏幕空间环境光遮蔽（WebGL2）
 *   1. G-Buffer：一次渲染场景，输出视角空间法线（color）+ 深度纹理（depth texture）
 *   2. AO pass：按法线构造 TBN，在半球内撒 16 个采样点，投影回屏幕比较深度，
 *      被挡住的样本计入遮蔽率 —— 这就是「缝隙为什么会变暗」
 *   3. 模糊：4×4 盒式模糊去掉采样噪声
 *   4. 合成：重新渲染场景（Phong 着色），按屏幕 UV 乘 AO
 * ============================================================ */

const container = ref<HTMLDivElement>()
const unsupported = ref('')
const radius = ref(0.55)
const intensity = ref(1.6)
const showAO = ref(false)
const samples = ref(16)

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
const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
out vec3 vNormalV;   // 视角空间法线
out vec3 vPosW;
void main() {
  vec4 viewPos = uView * vec4(aPos, 1.0);
  vNormalV = normalize(mat3(uView) * aNormal);
  vPosW = aPos;
  gl_Position = uProj * viewPos;
}`

const GBUF_FS = `#version 300 es
precision highp float;
in vec3 vNormalV;
in vec3 vPosW;
out vec4 frag;
uniform vec3 uBaseColor;
void main() {
  // 存法线 + 材质色调（w 通道闲置，这里塞一个简单的环境光变体）
  frag = vec4(normalize(vNormalV) * 0.5 + 0.5, 1.0);
}`

const LIT_FS = `#version 300 es
precision highp float;
in vec3 vNormalV;
in vec3 vPosW;
out vec4 frag;
uniform vec3 uBaseColor;
uniform sampler2D uAO;
uniform float uAOIntensity;
uniform bool uShowAO;
uniform vec2 uScreen;
uniform int uAOOn;

void main() {
  // —— Phong 着色（与 SSAO 相乘后才有体积感）——
  vec3 n = normalize(vNormalV);
  vec3 L1 = normalize(vec3(-0.4, 0.8, 0.6));
  vec3 L2 = normalize(vec3(0.7, 0.3, 0.5));
  float d1 = max(dot(n, L1), 0.0);
  float d2 = max(dot(n, L2), 0.0);
  vec3 col = uBaseColor * (0.16 + 0.85 * d1) + uBaseColor * vec3(0.25, 0.35, 0.6) * d2 * 0.5;

  // 边缘光，突出轮廓
  float rim = pow(1.0 - max(dot(n, normalize(vec3(0.0, 0.0, 1.0))), 0.0), 3.0);
  col += vec3(0.15, 0.35, 0.6) * rim * 0.35;

  if (uAOOn == 1) {
    vec2 uv = gl_FragCoord.xy / uScreen;
    float ao = texture(uAO, uv).r;
    ao = pow(clamp(ao, 0.0, 1.0), uAOIntensity);
    if (uShowAO) {
      col = vec3(ao);
    } else {
      col *= ao;
    }
  }
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  frag = vec4(col, 1.0);
}`

const AO_FS = `#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D uNormal;  // 视角空间法线（编码）
uniform sampler2D uDepth;   // 深度纹理
uniform vec2 uRes;
uniform mat4 uProj;
uniform float uRadius;
uniform int uKernelSize;

float linearDepth(float d, float near, float far) {
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}

// 由屏幕 uv 反推视角空间射线（透视相机，z 朝 -1）
vec3 viewRay(vec2 uv, float aspect, float tanHalf) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(vec3(ndc.x * aspect * tanHalf, ndc.y * tanHalf, -1.0));
}

// 伪随机旋转（去掉重复采样带来的条纹）
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// 16 个半球核样本（固定表，省得每帧洗牌）。GLSL ES 3.00 支持数组构造器，
// 且允许非常量下标取数组元素，所以直接整表放在片元里，不用 uniform 上传。
vec3 kernelAt(int i) {
  // 指数分布：近处更密，遮挡才不会被远处样本糊掉
  vec3 k[16] = vec3[16](
    vec3( 0.2025,  0.0549,  0.0856), vec3(-0.1476,  0.2126,  0.1089),
    vec3( 0.0707, -0.2355,  0.1524), vec3(-0.2634, -0.1288,  0.1826),
    vec3( 0.3401,  0.2736,  0.2143), vec3(-0.3812,  0.1015,  0.2468),
    vec3( 0.1104,  0.4028,  0.2887), vec3(-0.0681, -0.4227,  0.3051),
    vec3( 0.4502, -0.2132,  0.3602), vec3(-0.5124, -0.2981,  0.4103),
    vec3( 0.6012,  0.1885,  0.4471), vec3(-0.2389,  0.6021,  0.4888),
    vec3( 0.1557, -0.6622,  0.5205), vec3(-0.7041,  0.3502,  0.5631),
    vec3( 0.8003, -0.3011,  0.6012), vec3(-0.4211, -0.7902,  0.6408)
  );
  return normalize(k[i]);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float depth = texture(uDepth, uv).r;
  if (depth >= 0.99999) { frag = vec4(1.0); return; }

  float near = 0.1;
  float far = 60.0;
  float aspect = uRes.x / uRes.y;
  float tanHalf = tan(radians(50.0) * 0.5);

  vec3 n = normalize(texture(uNormal, uv).xyz * 2.0 - 1.0);
  // 深度 → 视角空间位置
  vec3 ray = viewRay(uv, aspect, tanHalf);
  float lin = linearDepth(depth, near, far);
  vec3 posV = ray * (lin / -ray.z);

  // 随机 TBN：以法线为 z 轴，随机旋转切线
  float ang = hash(gl_FragCoord.xy) * 6.28318;
  vec3 t = normalize(abs(n.x) > 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
  t = normalize(t - n * dot(t, n));
  vec3 b = cross(n, t);
  float c = cos(ang), s = sin(ang);
  vec3 tt = t * c + b * s;
  vec3 bb = -t * s + b * c;

  float occlusion = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uKernelSize) break;
    vec3 k = kernelAt(i);
    // 半空间样本 → 视角空间
    vec3 samplePos = posV + (tt * k.x + bb * k.y + n * k.z) * uRadius;

    // 投影回屏幕
    vec4 clip = uProj * vec4(samplePos, 1.0);
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    float sd = texture(uDepth, suv).r;
    if (sd >= 0.99999) continue;
    float slin = linearDepth(sd, near, far);
    vec3 sray = viewRay(suv, aspect, tanHalf);
    // 该像素的真实视角空间 z
    float sPosZ = -slin;

    // 场景表面比采样点更靠近相机 → 采样点被挡住
    float bias = 0.035;
    float diff = sPosZ - samplePos.z;
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / abs(diff + 0.0001));
    occlusion += (diff > bias ? 1.0 : 0.0) * rangeCheck;
  }

  float ao = 1.0 - occlusion / float(uKernelSize) * 1.25;
  frag = vec4(clamp(ao, 0.0, 1.0));
}`

const BLUR_FS = `#version 300 es
precision highp float;
out vec4 frag;
uniform sampler2D uTex;
uniform vec2 uRes;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 texel = 1.0 / uRes;
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      sum += texture(uTex, uv + vec2(float(x), float(y)) * texel * 1.5).r;
    }
  }
  frag = vec4(sum / 9.0);
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

/* ---------------- 场景：石柱阵（合并成一个 VBO） ---------------- */
function buildScene() {
  const pos: number[] = []
  const nor: number[] = []
  const idx: number[] = []
  let base = 0

  function addBox(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
    const faces = [
      { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
      { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
      { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
      { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
      { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
      { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    ]
    for (const f of faces) {
      for (const v of f.v) {
        pos.push(cx + v[0] * sx, cy + v[1] * sy, cz + v[2] * sz)
        nor.push(...f.n)
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      base += 4
    }
  }
  function addSphere(cx: number, cy: number, cz: number, r: number) {
    const seg = 28
    const rings = 20
    const start = base
    for (let y = 0; y <= rings; y++) {
      const phi = (y / rings) * Math.PI
      for (let x = 0; x <= seg; x++) {
        const th = (x / seg) * Math.PI * 2
        const nx = Math.sin(phi) * Math.cos(th)
        const ny = Math.cos(phi)
        const nz = Math.sin(phi) * Math.sin(th)
        pos.push(cx + nx * r, cy + ny * r, cz + nz * r)
        nor.push(nx, ny, nz)
      }
    }
    for (let y = 0; y < rings; y++)
      for (let x = 0; x < seg; x++) {
        const a = start + y * (seg + 1) + x
        const b = a + seg + 1
        idx.push(a, b, a + 1, b, b + 1, a + 1)
      }
    base = start + (rings + 1) * (seg + 1)
  }

  // 地面
  addBox(0, -0.5, 0, 14, 0.5, 14)
  // 石柱阵（高度与人眼高度参差，缝隙明显）
  const pillars: Array<[number, number, number, number, number, number]> = [
    [-3.2, 0, -2.4, 0.55, 1.5, 0.55],
    [-1.1, 0, -3.6, 0.7, 2.4, 0.7],
    [1.4, 0, -3.0, 0.6, 1.9, 0.6],
    [3.4, 0, -2.0, 0.5, 1.2, 0.5],
    [-4.0, 0, 0.6, 1.1, 0.8, 1.1],
    [-1.8, 0, 1.2, 0.75, 2.9, 0.75],
    [0.8, 0, 1.8, 0.9, 1.4, 0.9],
    [3.0, 0, 1.0, 0.65, 2.2, 0.65],
    [-2.6, 0, 3.4, 1.3, 0.6, 1.3],
    [1.0, 0, 3.8, 0.8, 1.7, 0.8],
  ]
  for (const [x, y, z, sx, sy, sz] of pillars) addBox(x, y + sy, z, sx, sy, sz)
  // 几个球体增加曲面遮蔽
  addSphere(-0.4, 0.75, -0.6, 0.75)
  addSphere(2.2, 0.55, 2.6, 0.55)
  addSphere(-3.6, 0.45, 3.0, 0.45)

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    indices: new Uint32Array(idx),
  }
}

/* ---------------- G-Buffer 目标 ---------------- */
interface GBuf {
  fbo: WebGLFramebuffer
  normal: WebGLTexture
  depth: WebGLTexture
  w: number
  h: number
}
function createGBuf(w: number, h: number): GBuf {
  const g = gl!
  const normal = g.createTexture()!
  g.bindTexture(g.TEXTURE_2D, normal)
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA16F, w, h, 0, g.RGBA, g.HALF_FLOAT, null)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)

  const depth = g.createTexture()!
  g.bindTexture(g.TEXTURE_2D, depth)
  g.texImage2D(g.TEXTURE_2D, 0, g.DEPTH_COMPONENT24, w, h, 0, g.DEPTH_COMPONENT, g.UNSIGNED_INT, null)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)

  const fbo = g.createFramebuffer()!
  g.bindFramebuffer(g.FRAMEBUFFER, fbo)
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, normal, 0)
  g.framebufferTexture2D(g.FRAMEBUFFER, g.DEPTH_ATTACHMENT, g.TEXTURE_2D, depth, 0)
  g.bindFramebuffer(g.FRAMEBUFFER, null)
  return { fbo, normal, depth, w, h }
}
function createAO(w: number, h: number) {
  const g = gl!
  const tex = g.createTexture()!
  g.bindTexture(g.TEXTURE_2D, tex)
  g.texImage2D(g.TEXTURE_2D, 0, g.R16F, w, h, 0, g.RED, g.HALF_FLOAT, null)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
  const fbo = g.createFramebuffer()!
  g.bindFramebuffer(g.FRAMEBUFFER, fbo)
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0)
  g.bindFramebuffer(g.FRAMEBUFFER, null)
  return { fbo, tex, w, h }
}

let gbuf: GBuf | null = null
let ao0: ReturnType<typeof createAO> | null = null
let ao1: ReturnType<typeof createAO> | null = null
let vao: WebGLVertexArrayObject | null = null
let indexCount = 0
let progGBuf: WebGLProgram | null = null
let progLit: WebGLProgram | null = null
let progAO: WebGLProgram | null = null
let progBlur: WebGLProgram | null = null
let emptyVao: WebGLVertexArrayObject | null = null

// 相机
let yaw = 0.6
let pitch = 0.42
let dist = 9.5
let dragging = false
let lastX = 0
let lastY = 0
let autoSpin = true
const fps = ref(0)

onMounted(() => {
  const el = container.value
  if (!el) return

  canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  el.appendChild(canvas)

  const ctx = canvas.getContext('webgl2', { antialias: false, alpha: false })
  if (!ctx) {
    unsupported.value = '当前环境不支持 WebGL2'
    return
  }
  gl = ctx
  if (!gl.getExtension('EXT_color_buffer_float')) {
    unsupported.value = '缺少 EXT_color_buffer_float'
    return
  }

  progGBuf = program(VS, GBUF_FS)
  progLit = program(VS, LIT_FS)
  progAO = program(BASE_VS, AO_FS)
  progBlur = program(BASE_VS, BLUR_FS)
  if (!progGBuf || !progLit || !progAO || !progBlur) {
    unsupported.value = '着色器编译失败'
    return
  }

  // —— 几何 ——
  const scene = buildScene()
  indexCount = scene.indices.length
  vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  const vboPos = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vboPos)
  gl.bufferData(gl.ARRAY_BUFFER, scene.positions, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
  const vboNor = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vboNor)
  gl.bufferData(gl.ARRAY_BUFFER, scene.normals, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0)
  const ibo = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scene.indices, gl.STATIC_DRAW)
  gl.bindVertexArray(null)
  emptyVao = gl.createVertexArray()

  // —— 目标 ——
  function rebuild() {
    if (!canvas || !el) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(el.clientWidth * dpr))
    canvas.height = Math.max(1, Math.floor(el.clientHeight * dpr))
    const w = Math.floor(canvas.width * 0.75)
    const h = Math.floor(canvas.height * 0.75)
    if (gbuf) {
      gl!.deleteFramebuffer(gbuf.fbo)
      gl!.deleteTexture(gbuf.normal)
      gl!.deleteTexture(gbuf.depth)
      gl!.deleteFramebuffer(ao0!.fbo)
      gl!.deleteTexture(ao0!.tex)
      gl!.deleteFramebuffer(ao1!.fbo)
      gl!.deleteTexture(ao1!.tex)
    }
    gbuf = createGBuf(w, h)
    ao0 = createAO(w, h)
    ao1 = createAO(w, h)
  }
  rebuild()
  window.addEventListener('resize', rebuild)
  cleanups.push(() => window.removeEventListener('resize', rebuild))

  // —— 相机交互 ——
  const onDown = (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas!.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    yaw -= (e.clientX - lastX) * 0.007
    pitch = Math.max(0.05, Math.min(1.25, pitch + (e.clientY - lastY) * 0.006))
    lastX = e.clientX
    lastY = e.clientY
  }
  const onUp = () => (dragging = false)
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    dist = Math.max(4, Math.min(24, dist * (1 + e.deltaY * 0.001)))
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

  // 自动旋转开关（拖拽时暂停）
  let spin = 0
  const spinTimer = window.setInterval(() => {
    spin = autoSpin && !dragging ? 1 : 0
  }, 100)
  cleanups.push(() => window.clearInterval(spinTimer))

  const uGB = {
    proj: gl.getUniformLocation(progGBuf!, 'uProj'),
    view: gl.getUniformLocation(progGBuf!, 'uView'),
    base: gl.getUniformLocation(progGBuf!, 'uBaseColor'),
  }
  const uLit = {
    proj: gl.getUniformLocation(progLit!, 'uProj'),
    view: gl.getUniformLocation(progLit!, 'uView'),
    base: gl.getUniformLocation(progLit!, 'uBaseColor'),
    ao: gl.getUniformLocation(progLit!, 'uAO'),
    aoIntensity: gl.getUniformLocation(progLit!, 'uAOIntensity'),
    showAO: gl.getUniformLocation(progLit!, 'uShowAO'),
    screen: gl.getUniformLocation(progLit!, 'uScreen'),
    aoOn: gl.getUniformLocation(progLit!, 'uAOOn'),
  }
  const uAO = {
    normal: gl.getUniformLocation(progAO!, 'uNormal'),
    depth: gl.getUniformLocation(progAO!, 'uDepth'),
    res: gl.getUniformLocation(progAO!, 'uRes'),
    proj: gl.getUniformLocation(progAO!, 'uProj'),
    radius: gl.getUniformLocation(progAO!, 'uRadius'),
    size: gl.getUniformLocation(progAO!, 'uKernelSize'),
  }
  const uBlur = {
    tex: gl.getUniformLocation(progBlur!, 'uTex'),
    res: gl.getUniformLocation(progBlur!, 'uRes'),
  }

  let frames = 0
  let fpsClock = performance.now()
  let aoOn = true

  const loop = () => {
    raf = requestAnimationFrame(loop)
    const g = gl!
    if (!gbuf || !ao0 || !ao1) return
    if (spin) yaw += 0.0025

    const aspect = gbuf.w / gbuf.h
    const eye = [
      dist * Math.cos(pitch) * Math.sin(yaw),
      dist * Math.sin(pitch),
      dist * Math.cos(pitch) * Math.cos(yaw),
    ]
    const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 60)
    const view = lookAt(eye, [0, 0.6, 0], [0, 1, 0])
    const MVP = mul(proj, view)
    void MVP

    // 1. G-Buffer
    g.bindFramebuffer(g.FRAMEBUFFER, gbuf.fbo)
    g.viewport(0, 0, gbuf.w, gbuf.h)
    g.enable(g.DEPTH_TEST)
    g.clearColor(0.5, 0.5, 0.5, 1)
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT)
    g.useProgram(progGBuf!)
    g.uniformMatrix4fv(uGB.proj!, false, proj)
    g.uniformMatrix4fv(uGB.view!, false, view)
    g.uniform3f(uGB.base!, 1, 1, 1)
    g.bindVertexArray(vao)
    g.drawElements(g.TRIANGLES, indexCount, g.UNSIGNED_INT, 0)

    // 2. AO
    g.bindFramebuffer(g.FRAMEBUFFER, ao0.fbo)
    g.viewport(0, 0, ao0.w, ao0.h)
    g.disable(g.DEPTH_TEST)
    g.useProgram(progAO!)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, gbuf.normal)
    g.uniform1i(uAO.normal!, 0)
    g.activeTexture(g.TEXTURE1)
    g.bindTexture(g.TEXTURE_2D, gbuf.depth)
    g.uniform1i(uAO.depth!, 1)
    g.uniform2f(uAO.res!, ao0.w, ao0.h)
    g.uniformMatrix4fv(uAO.proj!, false, proj)
    g.uniform1f(uAO.radius!, radius.value)
    g.uniform1i(uAO.size!, samples.value)
    g.bindVertexArray(emptyVao)
    g.drawArrays(g.TRIANGLES, 0, 3)

    // 3. 模糊
    g.bindFramebuffer(g.FRAMEBUFFER, ao1.fbo)
    g.viewport(0, 0, ao1.w, ao1.h)
    g.useProgram(progBlur!)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, ao0.tex)
    g.uniform1i(uBlur.tex!, 0)
    g.uniform2f(uBlur.res!, ao1.w, ao1.h)
    g.drawArrays(g.TRIANGLES, 0, 3)

    // 4. 前向着色 + AO
    g.bindFramebuffer(g.FRAMEBUFFER, null)
    g.viewport(0, 0, canvas!.width, canvas!.height)
    g.enable(g.DEPTH_TEST)
    g.clearColor(0.024, 0.028, 0.04, 1)
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT)
    g.useProgram(progLit!)
    g.uniformMatrix4fv(uLit.proj!, false, proj)
    g.uniformMatrix4fv(uLit.view!, false, view)
    g.uniform3f(uLit.base!, 0.62, 0.68, 0.78)
    g.activeTexture(g.TEXTURE2)
    g.bindTexture(g.TEXTURE_2D, ao1.tex)
    g.uniform1i(uLit.ao!, 2)
    g.uniform1f(uLit.aoIntensity!, intensity.value)
    g.uniform1i(uLit.showAO!, showAO.value ? 1 : 0)
    g.uniform2f(uLit.screen!, canvas!.width, canvas!.height)
    g.uniform1i(uLit.aoOn!, aoOn ? 1 : 0)
    g.bindVertexArray(vao)
    g.drawElements(g.TRIANGLES, indexCount, g.UNSIGNED_INT, 0)
    g.bindVertexArray(null)

    frames++
    const now = performance.now()
    if (now - fpsClock > 500) {
      fps.value = Math.round((frames * 1000) / (now - fpsClock))
      frames = 0
      fpsClock = now
    }
  }
  loop()

  // 供外部按钮切换
  ;(window as unknown as Record<string, unknown>).__ssaoToggle = () => {
    aoOn = !aoOn
  }
  cleanups.push(() => {
    delete (window as unknown as Record<string, unknown>).__ssaoToggle
  })
})

function toggleAO() {
  const f = (window as unknown as Record<string, () => void>).__ssaoToggle
  if (f) f()
}

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
        <span class="label">采样半径</span>
        <input
          class="range"
          type="range"
          min="0.15"
          max="1.4"
          step="0.05"
          :value="radius"
          @input="radius = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ radius.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">遮蔽强度</span>
        <input
          class="range"
          type="range"
          min="0.4"
          max="4"
          step="0.1"
          :value="intensity"
          @input="intensity = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ intensity.toFixed(1) }}</span>
      </div>
      <div class="row">
        <span class="label">核大小</span>
        <input
          class="range"
          type="range"
          min="4"
          max="16"
          step="1"
          :value="samples"
          @input="samples = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ samples }}</span>
      </div>
      <div class="row">
        <button class="btn" :class="{ active: showAO }" @click="showAO = !showAO">
          {{ showAO ? '看 AO 通道' : '看合成结果' }}
        </button>
        <button class="btn" @click="toggleAO">AO 开关</button>
      </div>
      <div class="meta">{{ fps }} FPS</div>
      <div class="tip">
        G-Buffer 存视角空间法线与深度 → 半球内 16 个样本投回屏幕比深度 → 模糊 → 与前向着色相乘。
        切到「AO 通道」能直接看到石柱之间、地面与柱脚接触处的变暗。
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
  width: 310px;
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
  width: 40px;
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
.btn {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.5);
  background: rgba(30, 42, 60, 0.7);
  color: #9fd0ff;
  cursor: pointer;
}
.btn.active {
  background: #1f5c9e;
  color: #fff;
  border-color: #4f9dff;
}
</style>
