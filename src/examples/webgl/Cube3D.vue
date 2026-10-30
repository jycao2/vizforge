<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const container = ref<HTMLDivElement>()
let canvas: HTMLCanvasElement | null = null
let gl: WebGLRenderingContext | null = null
let program: WebGLProgram | null = null
let buffer: WebGLBuffer | null = null
let mvpLoc: WebGLUniformLocation | null = null
let raf = 0
let aspect = 1

function compile(g: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = g.createShader(type)
  if (!sh) return null
  g.shaderSource(sh, src)
  g.compileShader(sh)
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    console.error('shader error:', g.getShaderInfoLog(sh))
    g.deleteShader(sh)
    return null
  }
  return sh
}

// ---- 极简 mat4 工具（列主序） ----
function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}
function perspective(fovy: number, asp: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / asp, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ])
}
function translateZ(z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1])
}
function rotateX(a: number): Float32Array {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1])
}
function rotateY(a: number): Float32Array {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1])
}

function resize() {
  if (!canvas || !container.value || !gl) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = container.value.clientWidth
  const h = container.value.clientHeight
  canvas.width = Math.max(1, Math.floor(w * dpr))
  canvas.height = Math.max(1, Math.floor(h * dpr))
  canvas.style.width = w + 'px'
  canvas.style.height = h + 'px'
  aspect = w / Math.max(1, h)
  gl.viewport(0, 0, canvas.width, canvas.height)
}

onMounted(() => {
  const el = container.value!
  canvas = document.createElement('canvas')
  el.appendChild(canvas)
  gl = canvas.getContext('webgl')
  if (!gl) {
    console.error('WebGL not supported')
    return
  }

  const vs = `
    attribute vec3 aPos;
    attribute vec3 aColor;
    uniform mat4 uMvp;
    varying vec3 vColor;
    void main() {
      vColor = aColor;
      gl_Position = uMvp * vec4(aPos, 1.0);
    }
  `
  const fs = `
    precision mediump float;
    varying vec3 vColor;
    void main() {
      gl_FragColor = vec4(vColor, 1.0);
    }
  `

  const vsh = compile(gl, gl.VERTEX_SHADER, vs)
  const fsh = compile(gl, gl.FRAGMENT_SHADER, fs)
  if (!vsh || !fsh) return

  program = gl.createProgram()
  if (!program) return
  gl.attachShader(program, vsh)
  gl.attachShader(program, fsh)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('link error:', gl.getProgramInfoLog(program))
    return
  }
  gl.useProgram(program)

  const posLoc = gl.getAttribLocation(program, 'aPos')
  const colorLoc = gl.getAttribLocation(program, 'aColor')
  mvpLoc = gl.getUniformLocation(program, 'uMvp')

  // 构建立方体：6 个面 × 2 个三角形，每个面一种颜色
  const h = 0.62
  const data: number[] = []
  const push = (p: number[], c: number[]) => data.push(p[0], p[1], p[2], c[0], c[1], c[2])
  const quad = (a: number[], b: number[], c: number[], d: number[], col: number[]) => {
    push(a, col); push(b, col); push(c, col)
    push(a, col); push(c, col); push(d, col)
  }

  const F = [0.31, 0.62, 1.0]
  const B = [1.0, 0.37, 0.38]
  const L = [0.49, 0.9, 0.53]
  const R = [1.0, 0.65, 0.34]
  const T = [0.82, 0.66, 1.0]
  const D = [0.47, 0.75, 1.0]

  quad([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h], F)
  quad([h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h], B)
  quad([-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h], L)
  quad([h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h], R)
  quad([-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h], T)
  quad([-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h], D)

  const verts = new Float32Array(data)
  buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW)

  const stride = 6 * 4
  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(colorLoc)
  gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, stride, 3 * 4)

  gl.enable(gl.DEPTH_TEST)
  gl.disable(gl.CULL_FACE)

  resize()
  window.addEventListener('resize', resize)

  const start = performance.now()
  const render = () => {
    raf = requestAnimationFrame(render)
    if (!gl || !program) return
    const t = (performance.now() - start) / 1000

    let m = mul(perspective(Math.PI / 3, aspect, 0.1, 100), translateZ(-3.4))
    m = mul(m, rotateX(t * 0.6))
    m = mul(m, rotateY(t * 0.9))

    gl.uniformMatrix4fv(mvpLoc, false, m)
    gl.clearColor(0.04, 0.06, 0.1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 36)
  }
  render()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  if (gl) {
    if (program) gl.deleteProgram(program)
    if (buffer) gl.deleteBuffer(buffer)
  }
})
</script>

<template>
  <div ref="container" class="webgl-container">
    <div class="hint">透视投影 + 深度测试：一个持续旋转的彩色立方体</div>
  </div>
</template>

<style scoped>
.webgl-container {
  position: relative;
  width: 100%;
  height: 100%;
  background: #0a0e16;
}
.hint {
  position: absolute;
  left: 14px;
  bottom: 14px;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(17, 24, 34, 0.85);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  font-size: 12px;
  pointer-events: none;
}
</style>
