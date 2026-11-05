<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/* ============================================================
 * 流体模拟（Jos Stam「Stable Fluids」的 GPU 实现，
 * 管线参考 Pavel Dobryakov 的 WebGL-Fluid-Simulation，核心全部手写）
 *
 * 每帧的解算步骤（全是全屏三角形 + 片元着色器，乒乓读写浮点纹理）：
 *   1. advect      速度自平流（半拉格朗日：沿速度回溯采样）
 *   2. curl        计算旋度
 *   3. vorticity   涡度约束（把数值耗散损失的小漩涡加回来，烟才会「打卷」）
 *   4. divergence  求散度场
 *   5. pressure    Jacobi 迭代解压力泊松方程（不可压缩条件）
 *   6. subtract    速度减去压力梯度 → 无散场
 *   7. dye advect  染料随新速度场平流（+ 少量耗散）
 * 鼠标拖动 = splat 注入高斯速度脉冲 + 染料
 * ============================================================ */

const container = ref<HTMLDivElement>()
const unsupported = ref('')
const pressureIters = ref(22)
const curlStrength = ref(24)
const dyeDecay = ref(0.985)
const fps = ref(0)

let raf = 0
let gl: WebGL2RenderingContext | null = null
let canvas: HTMLCanvasElement | null = null

// —— 分辨率：速度场低分辨率就够（物理是低频的），染料高分辨率保细节 ——
const SIM_RES = 256
const DYE_RES = 1024

interface Target {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
  w: number
  h: number
}
function createTarget(w: number, h: number, internal: number, format: number, type: number): Target {
  const g = gl!
  const tex = g.createTexture()!
  g.bindTexture(g.TEXTURE_2D, tex)
  g.texImage2D(g.TEXTURE_2D, 0, internal, w, h, 0, format, type, null)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
  const fbo = g.createFramebuffer()!
  g.bindFramebuffer(g.FRAMEBUFFER, fbo)
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0)
  g.viewport(0, 0, w, h)
  g.clearColor(0, 0, 0, 0)
  g.clear(g.COLOR_BUFFER_BIT)
  return { fbo, tex, w, h }
}
function deleteTarget(t: Target | null) {
  if (!t || !gl) return
  gl.deleteFramebuffer(t.fbo)
  gl.deleteTexture(t.tex)
}
class Double {
  a: Target
  b: Target
  constructor(w: number, h: number, internal: number, format: number, type: number) {
    this.a = createTarget(w, h, internal, format, type)
    this.b = createTarget(w, h, internal, format, type)
  }
  get read() {
    return this.a
  }
  get write() {
    return this.b
  }
  swap() {
    const t = this.a
    this.a = this.b
    this.b = t
  }
  dispose() {
    deleteTarget(this.a)
    deleteTarget(this.b)
  }
}

// RG16F 存速度，RGBA16F 存染料，R16F 存压力 / 散度 / 旋度
let velocity: Double | null = null
let dye: Double | null = null
let pressure: Double | null = null
let divergence: Target | null = null
let curlTex: Target | null = null

const cleanups: Array<() => void> = []

/* ---------------- 着色器 ---------------- */
const BASE_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // gl_VertexID 造全屏三角形，免 VBO
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const ADVECT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;      // 速度场纹素
uniform float uDt;
uniform float uDissipation;
void main() {
  // 半拉格朗日：沿速度往回走一步，取旧值（无条件稳定的关键）
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  vec4 result = texture(uSource, coord);
  frag = result * uDissipation;
}`

const SPLAT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uTarget;
uniform vec2 uPoint;      // 归一化坐标
uniform vec3 uValue;      // 注入量
uniform float uRadius;
void main() {
  vec2 d = vUv - uPoint;
  // 纵横比修正
  d.x *= 1.6;
  float g = exp(-dot(d, d) / uRadius);
  frag = vec4(texture(uTarget, vUv).xyz + uValue * g, 1.0);
}`

const CURL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vUv - vec2(1.0 / 256.0, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(1.0 / 256.0, 0.0)).y;
  float B = texture(uVelocity, vUv - vec2(0.0, 1.0 / 256.0)).x;
  float T = texture(uVelocity, vUv + vec2(0.0, 1.0 / 256.0)).x;
  frag = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}`

const VORTICITY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uCurlStrength;
uniform float uDt;
void main() {
  float L = texture(uCurl, vUv - vec2(1.0 / 256.0, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(1.0 / 256.0, 0.0)).x;
  float B = texture(uCurl, vUv - vec2(0.0, 1.0 / 256.0)).x;
  float T = texture(uCurl, vUv + vec2(0.0, 1.0 / 256.0)).x;
  float C = texture(uCurl, vUv).x;
  // 旋度梯度方向（指向旋度增大处），力垂直于它 → 放大漩涡
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= uCurlStrength * C;
  force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  frag = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
}`

const DIVERGENCE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vUv - vec2(1.0 / 256.0, 0.0)).x;
  float R = texture(uVelocity, vUv + vec2(1.0 / 256.0, 0.0)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, 1.0 / 256.0)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, 1.0 / 256.0)).y;
  vec2 C = texture(uVelocity, vUv).xy;
  // 边界：贴墙的法向速度置零（无穿透）
  if (vUv.x < 1.0 / 256.0 + 0.001) L = -C.x;
  if (vUv.x > 1.0 - 1.0 / 256.0 - 0.001) R = -C.x;
  if (vUv.y < 1.0 / 256.0 + 0.001) B = -C.y;
  if (vUv.y > 1.0 - 1.0 / 256.0 - 0.001) T = -C.y;
  frag = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`

const CLEAR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uTexture;
uniform float uValue;
void main() {
  frag = uValue * texture(uTexture, vUv);
}`

const PRESSURE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float L = texture(uPressure, vUv - vec2(1.0 / 256.0, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(1.0 / 256.0, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, 1.0 / 256.0)).x;
  float T = texture(uPressure, vUv + vec2(0.0, 1.0 / 256.0)).x;
  float div = texture(uDivergence, vUv).x;
  frag = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`

const GRADIENT_SUBTRACT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  float L = texture(uPressure, vUv - vec2(1.0 / 256.0, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(1.0 / 256.0, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, 1.0 / 256.0)).x;
  float T = texture(uPressure, vUv + vec2(0.0, 1.0 / 256.0)).x;
  vec2 vel = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  frag = vec4(vel, 0.0, 1.0);
}`

const DISPLAY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uDye;
void main() {
  vec3 c = texture(uDye, vUv).rgb;
  // 轻微 gamma + 暗部压制，色彩更「墨水」
  c = pow(clamp(c, 0.0, 1.4), vec3(0.82));
  vec3 bg = vec3(0.024, 0.028, 0.04);
  frag = vec4(bg + c, 1.0);
}`

/* ---------------- 程序与 uniform 管理 ---------------- */
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

interface Prog {
  prog: WebGLProgram
  u: Record<string, WebGLUniformLocation | null>
}
function makeProg(fs: string, names: string[]): Prog | null {
  const p = program(fs)
  if (!p) return null
  const u: Record<string, WebGLUniformLocation | null> = {}
  for (const n of names) u[n] = gl!.getUniformLocation(p, n)
  return { prog: p, u }
}

let pAdvect: Prog | null = null
let pSplat: Prog | null = null
let pCurl: Prog | null = null
let pVorticity: Prog | null = null
let pDivergence: Prog | null = null
let pClear: Prog | null = null
let pPressure: Prog | null = null
let pGradient: Prog | null = null
let pDisplay: Prog | null = null

function use(p: Prog) {
  gl!.useProgram(p.prog)
}
function bindTex(p: Prog, name: string, tex: WebGLTexture, unit: number) {
  const g = gl!
  g.activeTexture(g.TEXTURE0 + unit)
  g.bindTexture(g.TEXTURE_2D, tex)
  if (p.u[name]) g.uniform1i(p.u[name]!, unit)
}

/* ---------------- 交互 ---------------- */
interface Pointer {
  x: number
  y: number
  dx: number
  dy: number
  down: boolean
  moved: boolean
  color: [number, number, number]
}
const pointer: Pointer = {
  x: 0,
  y: 0,
  dx: 0,
  dy: 0,
  down: false,
  moved: false,
  color: [0.6, 0.8, 1.0],
}
// 拖动过程循环取色的调色板
const PALETTE: Array<[number, number, number]> = [
  [0.15, 0.55, 1.0],
  [1.0, 0.35, 0.55],
  [1.0, 0.75, 0.2],
  [0.4, 1.0, 0.65],
  [0.8, 0.45, 1.0],
]
let colorIdx = 0

function splat(x: number, y: number, dx: number, dy: number, color: [number, number, number]) {
  const g = gl!
  // 速度注入（力度与拖动速度成正比）
  use(pSplat!)
  bindTex(pSplat!, 'uTarget', velocity!.read.tex, 0)
  g.uniform2f(pSplat!.u.uPoint!, x, y)
  g.uniform3f(pSplat!.u.uValue!, dx, dy, 0)
  g.uniform1f(pSplat!.u.uRadius!, 0.0016)
  g.bindFramebuffer(g.FRAMEBUFFER, velocity!.write.fbo)
  g.viewport(0, 0, velocity!.write.w, velocity!.write.h)
  g.drawArrays(g.TRIANGLES, 0, 3)
  velocity!.swap()

  // 染料注入
  bindTex(pSplat!, 'uTarget', dye!.read.tex, 0)
  g.uniform3f(pSplat!.u.uValue!, color[0] * 0.35, color[1] * 0.35, color[2] * 0.35)
  g.uniform1f(pSplat!.u.uRadius!, 0.0022)
  g.bindFramebuffer(g.FRAMEBUFFER, dye!.write.fbo)
  g.viewport(0, 0, dye!.write.w, dye!.write.h)
  g.drawArrays(g.TRIANGLES, 0, 3)
  dye!.swap()
}

function step(dt: number) {
  const g = gl!
  g.disable(g.BLEND)

  // 1. curl
  use(pCurl!)
  bindTex(pCurl!, 'uVelocity', velocity!.read.tex, 0)
  g.bindFramebuffer(g.FRAMEBUFFER, curlTex!.fbo)
  g.viewport(0, 0, curlTex!.w, curlTex!.h)
  g.drawArrays(g.TRIANGLES, 0, 3)

  // 2. vorticity
  use(pVorticity!)
  bindTex(pVorticity!, 'uVelocity', velocity!.read.tex, 0)
  bindTex(pVorticity!, 'uCurl', curlTex!.tex, 1)
  g.uniform1f(pVorticity!.u.uCurlStrength!, curlStrength.value)
  g.uniform1f(pVorticity!.u.uDt!, dt)
  g.bindFramebuffer(g.FRAMEBUFFER, velocity!.write.fbo)
  g.viewport(0, 0, velocity!.write.w, velocity!.write.h)
  g.drawArrays(g.TRIANGLES, 0, 3)
  velocity!.swap()

  // 3. divergence
  use(pDivergence!)
  bindTex(pDivergence!, 'uVelocity', velocity!.read.tex, 0)
  g.bindFramebuffer(g.FRAMEBUFFER, divergence!.fbo)
  g.viewport(0, 0, divergence!.w, divergence!.h)
  g.drawArrays(g.TRIANGLES, 0, 3)

  // 4. 压力先衰减（否则边界不断累积）
  use(pClear!)
  bindTex(pClear!, 'uTexture', pressure!.read.tex, 0)
  g.uniform1f(pClear!.u.uValue!, 0.8)
  g.bindFramebuffer(g.FRAMEBUFFER, pressure!.write.fbo)
  g.viewport(0, 0, pressure!.write.w, pressure!.write.h)
  g.drawArrays(g.TRIANGLES, 0, 3)
  pressure!.swap()

  // 5. Jacobi 迭代解压力
  use(pPressure!)
  bindTex(pPressure!, 'uDivergence', divergence!.tex, 1)
  for (let i = 0; i < pressureIters.value; i++) {
    bindTex(pPressure!, 'uPressure', pressure!.read.tex, 0)
    g.bindFramebuffer(g.FRAMEBUFFER, pressure!.write.fbo)
    g.viewport(0, 0, pressure!.write.w, pressure!.write.h)
    g.drawArrays(g.TRIANGLES, 0, 3)
    pressure!.swap()
  }

  // 6. 减压力梯度
  use(pGradient!)
  bindTex(pGradient!, 'uPressure', pressure!.read.tex, 0)
  bindTex(pGradient!, 'uVelocity', velocity!.read.tex, 1)
  g.bindFramebuffer(g.FRAMEBUFFER, velocity!.write.fbo)
  g.viewport(0, 0, velocity!.write.w, velocity!.write.h)
  g.drawArrays(g.TRIANGLES, 0, 3)
  velocity!.swap()

  // 7. 速度自平流
  use(pAdvect!)
  bindTex(pAdvect!, 'uVelocity', velocity!.read.tex, 0)
  bindTex(pAdvect!, 'uSource', velocity!.read.tex, 0)
  g.uniform2f(pAdvect!.u.uTexel!, 1 / SIM_RES, 1 / SIM_RES)
  g.uniform1f(pAdvect!.u.uDt!, dt)
  // 衰减按 dt 归一化（基准 60fps）：直接乘系数的话，高刷屏消散快 2~6 倍，低帧机反而拖尾更长
  g.uniform1f(pAdvect!.u.uDissipation!, Math.pow(0.999, dt * 60))
  g.bindFramebuffer(g.FRAMEBUFFER, velocity!.write.fbo)
  g.viewport(0, 0, velocity!.write.w, velocity!.write.h)
  g.drawArrays(g.TRIANGLES, 0, 3)
  velocity!.swap()

  // 8. 染料平流
  bindTex(pAdvect!, 'uVelocity', velocity!.read.tex, 0)
  bindTex(pAdvect!, 'uSource', dye!.read.tex, 1)
  g.uniform2f(pAdvect!.u.uTexel!, 1 / SIM_RES, 1 / SIM_RES)
  g.uniform1f(pAdvect!.u.uDt!, dt)
  g.uniform1f(pAdvect!.u.uDissipation!, Math.pow(dyeDecay.value, dt * 60))
  g.bindFramebuffer(g.FRAMEBUFFER, dye!.write.fbo)
  g.viewport(0, 0, dye!.write.w, dye!.write.h)
  g.drawArrays(g.TRIANGLES, 0, 3)
  dye!.swap()
}

function render() {
  const g = gl!
  use(pDisplay!)
  bindTex(pDisplay!, 'uDye', dye!.read.tex, 0)
  g.bindFramebuffer(g.FRAMEBUFFER, null)
  g.viewport(0, 0, canvas!.width, canvas!.height)
  g.drawArrays(g.TRIANGLES, 0, 3)
}

function reset() {
  const g = gl!
  for (const t of [velocity!.read, velocity!.write, dye!.read, dye!.write]) {
    g.bindFramebuffer(g.FRAMEBUFFER, t.fbo)
    g.viewport(0, 0, t.w, t.h)
    g.clearColor(0, 0, 0, 0)
    g.clear(g.COLOR_BUFFER_BIT)
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
  gl.getExtension('OES_texture_float_linear')

  pAdvect = makeProg(ADVECT_FS, ['uVelocity', 'uSource', 'uTexel', 'uDt', 'uDissipation'])
  pSplat = makeProg(SPLAT_FS, ['uTarget', 'uPoint', 'uValue', 'uRadius'])
  pCurl = makeProg(CURL_FS, ['uVelocity'])
  pVorticity = makeProg(VORTICITY_FS, ['uVelocity', 'uCurl', 'uCurlStrength', 'uDt'])
  pDivergence = makeProg(DIVERGENCE_FS, ['uVelocity'])
  pClear = makeProg(CLEAR_FS, ['uTexture', 'uValue'])
  pPressure = makeProg(PRESSURE_FS, ['uPressure', 'uDivergence'])
  pGradient = makeProg(GRADIENT_SUBTRACT_FS, ['uPressure', 'uVelocity'])
  pDisplay = makeProg(DISPLAY_FS, ['uDye'])
  if (!pAdvect || !pSplat || !pCurl || !pVorticity || !pDivergence || !pClear || !pPressure || !pGradient || !pDisplay) {
    unsupported.value = '着色器编译失败'
    return
  }

  // 创建所有场（RG16F 速度 / RGBA16F 染料 / R16F 压力散度旋度）
  velocity = new Double(SIM_RES, SIM_RES, gl.RG16F, gl.RG, gl.HALF_FLOAT)
  dye = new Double(DYE_RES, DYE_RES, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)
  pressure = new Double(SIM_RES, SIM_RES, gl.R16F, gl.RED, gl.HALF_FLOAT)
  divergence = createTarget(SIM_RES, SIM_RES, gl.R16F, gl.RED, gl.HALF_FLOAT)
  curlTex = createTarget(SIM_RES, SIM_RES, gl.R16F, gl.RED, gl.HALF_FLOAT)

  function resize() {
    if (!canvas || !el) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(el.clientWidth * dpr))
    canvas.height = Math.max(1, Math.floor(el.clientHeight * dpr))
  }
  resize()
  window.addEventListener('resize', resize)
  cleanups.push(() => window.removeEventListener('resize', resize))

  // —— 指针交互 ——
  const toUv = (e: PointerEvent) => {
    const r = canvas!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height }
  }
  const onDown = (e: PointerEvent) => {
    const p = toUv(e)
    pointer.down = true
    pointer.x = p.x
    pointer.y = p.y
    pointer.dx = 0
    pointer.dy = 0
    colorIdx = (colorIdx + 1) % PALETTE.length
    pointer.color = PALETTE[colorIdx]
    canvas!.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!pointer.down) return
    const p = toUv(e)
    pointer.dx = (p.x - pointer.x) * 8
    pointer.dy = (p.y - pointer.y) * 8
    pointer.x = p.x
    pointer.y = p.y
    pointer.moved = Math.abs(pointer.dx) > 0 || Math.abs(pointer.dy) > 0
  }
  const onUp = () => {
    pointer.down = false
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointerleave', onUp)
  cleanups.push(() => {
    canvas?.removeEventListener('pointerdown', onDown)
    canvas?.removeEventListener('pointermove', onMove)
    canvas?.removeEventListener('pointerup', onUp)
    canvas?.removeEventListener('pointerleave', onUp)
  })

  // —— 主循环 ——
  let last = performance.now()
  let frames = 0
  let fpsClock = performance.now()
  let lastInteract = performance.now()
  let lastAuto = 0

  const loop = () => {
    raf = requestAnimationFrame(loop)
    const now = performance.now()
    const dt = Math.min((now - last) / 1000, 1 / 30)
    last = now

    if (pointer.moved) {
      pointer.moved = false
      lastInteract = now
      splat(pointer.x, pointer.y, pointer.dx, pointer.dy, pointer.color)
    } else if (now - lastInteract > 3500 && now - lastAuto > 1600) {
      // 空闲自动泼溅：染料留存 0.985/帧，开场那几朵十几秒就衰没了，
      // 页面会一直黑着像坏了——没人拖的时候每隔 1.6s 自己来一发
      lastAuto = now
      colorIdx = (colorIdx + 1) % PALETTE.length
      const ang = Math.random() * Math.PI * 2
      const mag = 8 + Math.random() * 8
      splat(
        0.2 + Math.random() * 0.6,
        0.25 + Math.random() * 0.5,
        Math.cos(ang) * mag,
        Math.sin(ang) * mag,
        PALETTE[colorIdx],
      )
    }
    step(dt)
    render()

    frames++
    if (now - fpsClock > 500) {
      fps.value = Math.round((frames * 1000) / (now - fpsClock))
      frames = 0
      fpsClock = now
    }
  }
  loop()

  // 开场彩蛋：五色各来一朵，别让用户打开页面先看 3 秒纯黑
  const seeds: Array<[number, number, number, number]> = [
    [0.5, 0.5, 12, 0],
    [0.35, 0.4, -8, 10],
    [0.65, 0.6, 8, -10],
    [0.55, 0.3, 6, 9],
    [0.4, 0.65, -9, -7],
  ]
  seeds.forEach(([x, y, dx, dy], i) => splat(x, y, dx, dy, PALETTE[i % PALETTE.length]))
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  cleanups.forEach((f) => f())
  velocity?.dispose()
  dye?.dispose()
  pressure?.dispose()
  deleteTarget(divergence)
  deleteTarget(curlTex)
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="container"></div>
    <div v-if="unsupported" class="unsupported">{{ unsupported }}</div>
    <div class="panel">
      <div class="row">
        <span class="label">压力迭代</span>
        <input
          class="range"
          type="range"
          min="4"
          max="40"
          step="1"
          :value="pressureIters"
          @input="pressureIters = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ pressureIters }}</span>
      </div>
      <div class="row">
        <span class="label">涡度强度</span>
        <input
          class="range"
          type="range"
          min="0"
          max="50"
          step="1"
          :value="curlStrength"
          @input="curlStrength = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ curlStrength }}</span>
      </div>
      <div class="row">
        <span class="label">染料留存</span>
        <input
          class="range"
          type="range"
          min="0.9"
          max="1"
          step="0.002"
          :value="dyeDecay"
          @input="dyeDecay = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ dyeDecay.toFixed(3) }}</span>
      </div>
      <div class="meta">256² 速度场 · 1024² 染料 · {{ fps }} FPS</div>
      <div class="tip">
        经典 Stable Fluids 管线：半拉格朗日平流 → 涡度约束 → Jacobi 迭代解压力泊松方程 →
        投影成无散场。按住拖动注入速度与染料，涡度越大烟卷得越厉害。
      </div>
      <button class="btn" @click="reset()">清空画布</button>
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
  margin-bottom: 8px;
}
.btn {
  padding: 3px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.5);
  background: rgba(30, 42, 60, 0.7);
  color: #d7e2ee;
  cursor: pointer;
}
</style>
