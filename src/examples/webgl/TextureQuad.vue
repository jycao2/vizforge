<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const container = ref<HTMLDivElement>()
let raf = 0
let gl: WebGLRenderingContext | null = null
let program: WebGLProgram | null = null
let buffer: WebGLBuffer | null = null
let texture: WebGLTexture | null = null
let canvas: HTMLCanvasElement | null = null
let rotLoc: WebGLUniformLocation | null = null
let posLoc = 0
let uvLoc = 0

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('shader compile error:', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/** 用 Canvas 2D 程序化生成一张纹理（渐变 + 网格） */
function makeTexture(gl: WebGLRenderingContext): WebGLTexture | null {
  const size = 256
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')
  if (!ctx) return null

  const g = ctx.createLinearGradient(0, 0, size, size)
  g.addColorStop(0, '#ff5e62')
  g.addColorStop(1, '#ff9966')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  ctx.strokeStyle = 'rgba(255,255,255,0.45)'
  ctx.lineWidth = 2
  for (let i = 0; i <= size; i += 32) {
    ctx.beginPath()
    ctx.moveTo(i, 0)
    ctx.lineTo(i, size)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i)
    ctx.lineTo(size, i)
    ctx.stroke()
  }

  const tex = gl.createTexture()
  if (!tex) return null
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  return tex
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
    attribute vec2 aPos;
    attribute vec2 aUv;
    uniform mat2 uRot;
    varying vec2 vUv;
    void main() {
      vUv = aUv;
      gl_Position = vec4(uRot * aPos, 0.0, 1.0);
    }
  `
  const fs = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    void main() {
      gl_FragColor = texture2D(uTex, vUv);
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
    console.error('program link error:', gl.getProgramInfoLog(program))
    return
  }
  gl.useProgram(program)

  posLoc = gl.getAttribLocation(program, 'aPos')
  uvLoc = gl.getAttribLocation(program, 'aUv')
  rotLoc = gl.getUniformLocation(program, 'uRot')

  // 顶点位置 + UV（两个三角形组成矩形）
  const data = new Float32Array([
    // x, y,   u, v
    -0.7, -0.7, 0, 0,
     0.7, -0.7, 1, 0,
    -0.7,  0.7, 0, 1,
     0.7,  0.7, 1, 1,
  ])
  buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  const stride = 4 * 4
  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(uvLoc)
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, stride, 2 * 4)

  texture = makeTexture(gl)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0)

  resize()
  window.addEventListener('resize', resize)

  const start = performance.now()
  const render = () => {
    raf = requestAnimationFrame(render)
    if (!gl || !program) return
    const t = (performance.now() - start) / 1000
    const a = t * 0.6
    const c = Math.cos(a)
    const s = Math.sin(a)
    gl.uniformMatrix2fv(rotLoc, false, new Float32Array([c, -s, s, c]))
    gl.clearColor(0.04, 0.06, 0.1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
  render()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
  if (gl) {
    if (program) gl.deleteProgram(program)
    if (buffer) gl.deleteBuffer(buffer)
    if (texture) gl.deleteTexture(texture)
  }
})
</script>

<template>
  <div ref="container" class="webgl-container"></div>
</template>

<style scoped>
.webgl-container {
  width: 100%;
  height: 100%;
  background: #0a0e16;
}
</style>
