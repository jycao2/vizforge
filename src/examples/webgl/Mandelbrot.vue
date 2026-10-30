<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/* ============================================================
 * 分形探索器 · Mandelbrot / Julia
 *  - 全屏片元着色器逐像素迭代 z = z² + c
 *  - 用迭代次数做平滑着色（逃逸时间 + 对数平滑），配正弦调色板
 *  - 滚轮以鼠标位置为中心缩放，双击在 Mandelbrot / Julia 之间切换
 * ============================================================ */

const container = ref<HTMLDivElement>()
const mode = ref<'mandelbrot' | 'julia'>('mandelbrot')
const maxIter = ref(220)
const colorShift = ref(0)
const zoomText = ref('1.0×')
const fps = ref(0)

let raf = 0
let gl: WebGL2RenderingContext | null = null
let program: WebGLProgram | null = null
let vao: WebGLVertexArrayObject | null = null

/** 视口：cx/cy 中心（复平面），halfSpan 半宽 */
let cx = -0.6
let cy = 0
let halfSpan = 1.9
/** Julia 常量 */
let jc = { x: -0.79, y: 0.15 }

const FS = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  uRes;
uniform vec2  uCenter;
uniform float uHalfSpan;
uniform int   uMaxIter;
uniform int   uMode;      // 0 = Mandelbrot, 1 = Julia
uniform vec2  uJulia;
uniform float uShift;

vec3 palette(float t) {
  // 经典余弦调色板（Iñigo Quílez）：三通道相位错开，色带连续且不脏
  vec3 d = vec3(0.0, 0.42, 0.72) + uShift;
  return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0, 0.92, 0.86) * t * 2.6 + d));
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 c = uCenter + uv * uHalfSpan * 2.0 * vec2(1.0, 1.0);
  c.y += 0.0;

  vec2 z = (uMode == 1) ? c : vec2(0.0);
  vec2 k = (uMode == 1) ? uJulia : c;

  float iter = 0.0;
  float esc = 0.0;
  for (int i = 0; i < 1024; i++) {
    if (i >= uMaxIter) break;
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + k;
    if (dot(z, z) > 65536.0) { esc = 1.0; break; }
    iter += 1.0;
  }

  if (esc < 0.5) {
    outColor = vec4(0.02, 0.025, 0.045, 1.0);
    return;
  }

  // 对数平滑：消除整数迭代带来的色带，边缘才能连续
  float mag = length(z);
  float smoothIter = iter - log2(log2(mag)) + 4.0;
  // 快速逃逸区迭代次数很小，直接线性映射会糊成一片纯色，取对数再归一
  float t = log(1.0 + smoothIter) * 0.32;
  vec3 col = palette(t) * (0.55 + 0.6 * clamp(smoothIter / 40.0, 0.0, 1.0));
  col = pow(clamp(col, 0.0, 1.0), vec3(0.9));
  outColor = vec4(col, 1.0);
}`

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`

const uni = {
  res: null as WebGLUniformLocation | null,
  center: null as WebGLUniformLocation | null,
  halfSpan: null as WebGLUniformLocation | null,
  maxIter: null as WebGLUniformLocation | null,
  mode: null as WebGLUniformLocation | null,
  julia: null as WebGLUniformLocation | null,
  shift: null as WebGLUniformLocation | null,
}

function initGL(el: HTMLDivElement): boolean {
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  canvas.style.cursor = 'crosshair'
  el.appendChild(canvas)

  const ctx = canvas.getContext('webgl2', { antialias: false, alpha: false })
  if (!ctx) {
    el.innerHTML = '<div style="color:#93a5b8;padding:24px;font:13px sans-serif">当前浏览器不支持 WebGL2</div>'
    return false
  }
  gl = ctx

  const compile = (type: number, src: string) => {
    const sh = ctx.createShader(type)!
    ctx.shaderSource(sh, src)
    ctx.compileShader(sh)
    if (!ctx.getShaderParameter(sh, ctx.COMPILE_STATUS)) {
      console.error('着色器编译失败：', ctx.getShaderInfoLog(sh))
      return null
    }
    return sh
  }
  const vs = compile(ctx.VERTEX_SHADER, VS)
  const fs = compile(ctx.FRAGMENT_SHADER, FS)
  if (!vs || !fs) return false

  const prog = ctx.createProgram()!
  ctx.attachShader(prog, vs)
  ctx.attachShader(prog, fs)
  ctx.linkProgram(prog)
  ctx.deleteShader(vs)
  ctx.deleteShader(fs)
  if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) {
    console.error('程序链接失败：', ctx.getProgramInfoLog(prog))
    return false
  }
  program = prog
  vao = ctx.createVertexArray()

  uni.res = ctx.getUniformLocation(prog, 'uRes')
  uni.center = ctx.getUniformLocation(prog, 'uCenter')
  uni.halfSpan = ctx.getUniformLocation(prog, 'uHalfSpan')
  uni.maxIter = ctx.getUniformLocation(prog, 'uMaxIter')
  uni.mode = ctx.getUniformLocation(prog, 'uMode')
  uni.julia = ctx.getUniformLocation(prog, 'uJulia')
  uni.shift = ctx.getUniformLocation(prog, 'uShift')
  return true
}

/** 屏幕坐标 → 复平面，用于"以鼠标为中心缩放" */
function toComplex(px: number, py: number, w: number, h: number) {
  const ux = (px - w / 2) / h
  const uy = (py - h / 2) / h
  return { x: cx + ux * halfSpan * 2, y: cy - uy * halfSpan * 2 }
}

function bindInteractions(el: HTMLDivElement) {
  let dragging = false
  let lx = 0
  let ly = 0

  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    const rect = el.getBoundingClientRect()
    const before = toComplex(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
    const scale = Math.exp(e.deltaY * 0.0012)
    halfSpan = Math.min(2.6, Math.max(1e-9, halfSpan * scale))
    const after = toComplex(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
    // 保持鼠标下的复点不动
    cx += before.x - after.x
    cy += before.y - after.y
    updateZoomText()
  }

  const down = (e: PointerEvent) => {
    dragging = true
    lx = e.clientX
    ly = e.clientY
    el.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    if (!dragging) return
    const rect = el.getBoundingClientRect()
    cx -= ((e.clientX - lx) / rect.height) * halfSpan * 2
    cy += ((e.clientY - ly) / rect.height) * halfSpan * 2
    lx = e.clientX
    ly = e.clientY
  }
  const up = (e: PointerEvent) => {
    dragging = false
    try {
      el.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }
  const dbl = (e: MouseEvent) => {
    const rect = el.getBoundingClientRect()
    if (mode.value === 'mandelbrot') {
      // 把双击处的点作为 Julia 常量
      const p = toComplex(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
      jc = { x: p.x, y: p.y }
      mode.value = 'julia'
      cx = 0
      cy = 0
      halfSpan = 1.55
    } else {
      mode.value = 'mandelbrot'
      cx = -0.6
      cy = 0
      halfSpan = 1.9
    }
    updateZoomText()
  }

  el.addEventListener('wheel', wheel, { passive: false })
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('dblclick', dbl)
  cleanups.push(() => {
    el.removeEventListener('wheel', wheel)
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    el.removeEventListener('dblclick', dbl)
  })
}

function updateZoomText() {
  zoomText.value = (1.9 / halfSpan).toExponential(2).replace('e+', '×10^')
}

const cleanups: Array<() => void> = []

function start(el: HTMLDivElement) {
  if (!gl || !program || !vao) return
  const g = gl
  const prog = program

  let last = performance.now()
  let acc = 0
  let frames = 0

  const frame = () => {
    raf = requestAnimationFrame(frame)
    const now = performance.now()
    const dt = now - last
    last = now
    acc += dt
    frames++
    if (acc > 500) {
      fps.value = Math.round((frames * 1000) / acc)
      acc = 0
      frames = 0
    }

    const w = el.clientWidth || 1
    const h = el.clientHeight || 1
    const canvas = g.canvas
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    g.viewport(0, 0, w, h)
    g.useProgram(prog)
    g.bindVertexArray(vao)
    g.uniform2f(uni.res, w, h)
    g.uniform2f(uni.center, cx, cy)
    g.uniform1f(uni.halfSpan, halfSpan)
    g.uniform1i(uni.maxIter, maxIter.value)
    g.uniform1i(uni.mode, mode.value === 'julia' ? 1 : 0)
    g.uniform2f(uni.julia, jc.x, jc.y)
    g.uniform1f(uni.shift, colorShift.value)
    g.drawArrays(g.TRIANGLES, 0, 3)
  }
  frame()
}

onMounted(() => {
  const el = container.value
  if (!el) return
  if (!initGL(el)) return
  bindInteractions(el)
  updateZoomText()
  start(el)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  cleanups.forEach((fn) => fn())
  if (gl) {
    if (program) gl.deleteProgram(program)
    if (vao) gl.deleteVertexArray(vao)
  }
})

function reset() {
  cx = mode.value === 'julia' ? 0 : -0.6
  cy = 0
  halfSpan = mode.value === 'julia' ? 1.55 : 1.9
  updateZoomText()
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>

    <div class="hud">
      <span class="fps">{{ fps }} FPS</span>
      <span class="sep">·</span>
      <span>{{ zoomText }}</span>
    </div>

    <div class="panel">
      <div class="title">分形探索器 · {{ mode === 'julia' ? 'Julia' : 'Mandelbrot' }}</div>
      <div class="sub">滚轮缩放 · 拖拽平移 · 双击切换</div>

      <div class="ctrl">
        <span class="lab">迭代</span>
        <input v-model.number="maxIter" type="range" min="60" max="900" step="20" />
        <b>{{ maxIter }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">配色</span>
        <input v-model.number="colorShift" type="range" min="0" max="1" step="0.01" />
        <b>{{ colorShift.toFixed(2) }}</b>
      </div>

      <div class="row">
        <button class="btn" @click="reset">复位视角</button>
        <button class="btn primary" @click="mode = mode === 'julia' ? 'mandelbrot' : 'julia'">
          {{ mode === 'julia' ? '回到 Mandelbrot' : '切到 Julia' }}
        </button>
      </div>

      <div class="tip">
        每个像素迭代 z ← z² + c：Mandelbrot 固定 z₀=0 变化 c，Julia 固定 c 变化 z₀。
        用 log₂(log₂|z|) 做逃逸时间平滑，才不会出现一圈圈的色带。放大到 1e-9 仍能看清细节。
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #05070c;
}
.gl-container {
  width: 100%;
  height: 100%;
}
.hud {
  position: absolute;
  top: 14px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 11px;
  color: #a9bccf;
  border-radius: 7px;
  background: rgba(10, 14, 22, 0.66);
  border: 1px solid rgba(90, 110, 134, 0.32);
  backdrop-filter: blur(6px);
  font-variant-numeric: tabular-nums;
}
.fps {
  color: #7ee787;
  font-weight: 600;
}
.sep {
  color: #4a5a6a;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 280px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(10, 14, 22, 0.84);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(10px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.sub {
  margin-top: 3px;
  font-size: 11px;
  color: #7d8fa2;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 11px;
  color: #93a5b8;
}
.ctrl .lab {
  width: 26px;
  flex: none;
}
.ctrl input {
  flex: 1;
  height: 3px;
  accent-color: #61b6ff;
}
.ctrl b {
  width: 40px;
  text-align: right;
  color: #cfe0f2;
  font-variant-numeric: tabular-nums;
}
.row {
  display: flex;
  gap: 7px;
  margin-top: 10px;
}
.btn {
  flex: 1;
  padding: 6px 0;
  font-size: 11.5px;
  border-radius: 7px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(20, 28, 38, 0.9);
  color: #b9c8d8;
  cursor: pointer;
  transition: all 0.15s;
}
.btn:hover {
  border-color: rgba(120, 165, 220, 0.75);
  color: #e6f0fa;
}
.btn.primary {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.tip {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.26);
  font-size: 10.6px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
