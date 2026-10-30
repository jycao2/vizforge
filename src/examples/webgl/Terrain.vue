<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createProgram, lookAt, multiply, perspective, setupGL } from './gl'

const container = ref<HTMLDivElement>()
const amplitude = ref(0.55)
const showWire = ref(false)

let rebuild: ((amp: number) => void) | null = null
let toggleWire: ((on: boolean) => void) | null = null

/* ---------------- 噪声：值噪声 + 分形叠加（fBm） ---------------- */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = smooth(x - xi)
  const yf = smooth(y - yi)
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  return a * (1 - xf) * (1 - yf) + b * xf * (1 - yf) + c * (1 - xf) * yf + d * xf * yf
}

function fbm(x: number, y: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  for (let i = 0; i < 5; i++) {
    sum += amp * valueNoise(x * freq, y * freq)
    norm += amp
    amp *= 0.5
    freq *= 2.07
  }
  return sum / norm
}

const VS = `
attribute vec3 a_pos;
attribute vec3 a_normal;
attribute float a_h;
uniform mat4 u_vp;
varying vec3 v_n;
varying vec3 v_world;
varying float v_h;
void main() {
  v_n = a_normal;
  v_h = a_h;
  v_world = a_pos;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}
`

const FS = `
precision mediump float;
varying vec3 v_n;
varying vec3 v_world;
varying float v_h;
uniform float u_wire;

vec3 ramp(float t) {
  vec3 c1 = vec3(0.06, 0.13, 0.22);  // 低地：深蓝
  vec3 c2 = vec3(0.13, 0.38, 0.42);  // 丘陵：青
  vec3 c3 = vec3(0.55, 0.62, 0.42);  // 高地：草黄
  vec3 c4 = vec3(0.86, 0.88, 0.92);  // 峰顶：雪白
  if (t < 0.35) return mix(c1, c2, t / 0.35);
  if (t < 0.68) return mix(c2, c3, (t - 0.35) / 0.33);
  return mix(c3, c4, pow((t - 0.68) / 0.32, 1.4));
}

void main() {
  if (u_wire > 0.5) {
    gl_FragColor = vec4(vec3(0.30, 0.62, 0.95) * (0.45 + 0.75 * v_h), 1.0);
    return;
  }

  vec3 N = normalize(v_n);
  vec3 V = normalize(vec3(0.0, 1.6, 2.6) - v_world);
  vec3 L1 = normalize(vec3(0.55, 0.9, 0.45));
  vec3 L2 = normalize(vec3(-0.7, 0.35, -0.5));

  float d1 = max(dot(N, L1), 0.0);
  float d2 = max(dot(N, L2), 0.0);
  float spec = pow(max(dot(N, normalize(L1 + V)), 0.0), 42.0) * 0.35;

  vec3 base = ramp(v_h);
  // 陡坡露出岩石色
  float slope = 1.0 - N.y;
  base = mix(base, vec3(0.28, 0.28, 0.30), smoothstep(0.35, 0.75, slope));

  vec3 col = base * (0.16 + 0.86 * d1 + 0.24 * d2)
           + vec3(0.75, 0.85, 1.0) * spec;

  // 远处雾化
  float fog = smoothstep(1.6, 4.6, length(v_world.xz));
  col = mix(col, vec3(0.05, 0.08, 0.13), fog * 0.75);

  gl_FragColor = vec4(pow(col, vec3(0.9)), 1.0);
}
`

onMounted(() => {
  const el = container.value
  if (!el) return
  const ctx = setupGL(el)
  if (!ctx) return
  const { gl, canvas, resize } = ctx

  const program = createProgram(gl, VS, FS)
  if (!program) return
  gl.useProgram(program)

  const N = 100
  const vpr = N + 1
  const count = vpr * vpr

  // 基础高度场（只算一次，之后只做缩放）
  const baseH = new Float32Array(count)
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * 3.4
      const z = (j / N) * 3.4
      baseH[j * vpr + i] = fbm(x, z)
    }
  }

  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const heights = new Float32Array(count)

  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const idx = j * vpr + i
      positions[idx * 3] = -1 + (2 * i) / N
      positions[idx * 3 + 2] = -1 + (2 * j) / N
      heights[idx] = baseH[idx]
    }
  }

  const posBuffer = gl.createBuffer()
  const nrmBuffer = gl.createBuffer()
  const hBuffer = gl.createBuffer()

  gl.bindBuffer(gl.ARRAY_BUFFER, hBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, heights, gl.STATIC_DRAW)

  // 三角形索引
  const triIndices: number[] = []
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * vpr + i
      const b = a + 1
      const c = a + vpr
      const d = c + 1
      triIndices.push(a, c, b, b, c, d)
    }
  }
  const triBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(triIndices), gl.STATIC_DRAW)

  // 线框索引（每个顶点的横竖连线）
  const lineIndices: number[] = []
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const a = j * vpr + i
      if (i < N) lineIndices.push(a, a + 1)
      if (j < N) lineIndices.push(a, a + vpr)
    }
  }
  const lineBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(lineIndices), gl.STATIC_DRAW)

  const aPos = gl.getAttribLocation(program, 'a_pos')
  const aNormal = gl.getAttribLocation(program, 'a_normal')
  const aH = gl.getAttribLocation(program, 'a_h')
  const uVP = gl.getUniformLocation(program, 'u_vp')
  const uWire = gl.getUniformLocation(program, 'u_wire')

  /** 按振幅重建高度与法线（法线用中心差分求） */
  function applyAmplitude(amp: number) {
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const idx = j * vpr + i
        positions[idx * 3 + 1] = Math.pow(baseH[idx], 1.55) * amp * 1.7
      }
    }
    const dx = 2 / N
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const idx = j * vpr + i
        const hl = positions[(j * vpr + Math.max(0, i - 1)) * 3 + 1]
        const hr = positions[(j * vpr + Math.min(N, i + 1)) * 3 + 1]
        const hd = positions[(Math.max(0, j - 1) * vpr + i) * 3 + 1]
        const hu = positions[(Math.min(N, j + 1) * vpr + i) * 3 + 1]
        const nx = hl - hr
        const nz = hd - hu
        const ny = 2 * dx
        const len = Math.hypot(nx, ny, nz) || 1
        normals[idx * 3] = nx / len
        normals[idx * 3 + 1] = ny / len
        normals[idx * 3 + 2] = nz / len
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW)
  }

  rebuild = applyAmplitude
  applyAmplitude(amplitude.value)

  let wire = false
  toggleWire = (on: boolean) => {
    wire = on
  }

  // 属性绑定在每次绘制前设置，避免被上面的 buffer 绑定顺序打乱
  function bindAttribs() {
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer)
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuffer)
    gl.enableVertexAttribArray(aNormal)
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, hBuffer)
    gl.enableVertexAttribArray(aH)
    gl.vertexAttribPointer(aH, 1, gl.FLOAT, false, 0, 0)
  }

  gl.enable(gl.DEPTH_TEST)
  gl.disable(gl.CULL_FACE)

  let raf = 0
  const draw = () => {
    raf = requestAnimationFrame(draw)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0.031, 0.047, 0.075, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    const t = performance.now() / 1000
    const ang = t * 0.12
    const r = 3.1
    const eye: [number, number, number] = [Math.cos(ang) * r, 1.55, Math.sin(ang) * r]
    const view = lookAt(eye, [0, 0.12, 0], [0, 1, 0])
    const proj = perspective((48 * Math.PI) / 180, canvas.width / canvas.height, 0.1, 100)
    gl.uniformMatrix4fv(uVP, false, multiply(proj, view))

    bindAttribs()

    gl.uniform1f(uWire, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuffer)
    gl.drawElements(gl.TRIANGLES, triIndices.length, gl.UNSIGNED_SHORT, 0)

    if (wire) {
      gl.uniform1f(uWire, 1)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineBuffer)
      gl.drawElements(gl.LINES, lineIndices.length, gl.UNSIGNED_SHORT, 0)
    }
  }
  draw()

  const onResize = () => resize()
  window.addEventListener('resize', onResize)

  onBeforeUnmount(() => {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    gl.deleteBuffer(posBuffer)
    gl.deleteBuffer(nrmBuffer)
    gl.deleteBuffer(hBuffer)
    gl.deleteBuffer(triBuffer)
    gl.deleteBuffer(lineBuffer)
    gl.deleteProgram(program)
    canvas.remove()
  })
})

onBeforeUnmount(() => {
  rebuild = null
  toggleWire = null
})

function onAmp(v: number) {
  amplitude.value = v
  rebuild?.(v)
}
function onWire(v: boolean) {
  showWire.value = v
  toggleWire?.(v)
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">地形起伏</span>
        <input
          class="range"
          type="range"
          min="0"
          max="1.2"
          step="0.02"
          :value="amplitude"
          @input="onAmp(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ amplitude.toFixed(2) }}</span>
      </div>
      <label class="check">
        <input
          type="checkbox"
          :checked="showWire"
          @change="onWire(($event.target as HTMLInputElement).checked)"
        />
        <span>显示线框</span>
      </label>
      <div class="tip">
        值噪声 fBm 生成 101×101 高度场，CPU 中心差分算法线，高度着色 + 双光源 Blinn-Phong。
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
.gl-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 330px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(12, 18, 27, 0.84);
  border: 1px solid rgba(90, 110, 135, 0.45);
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
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
  width: 36px;
  text-align: right;
  font-size: 12px;
  color: #7ee787;
}
.check {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  font-size: 12px;
  color: #b9c8d8;
  cursor: pointer;
}
.check input {
  accent-color: #4f9dff;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
