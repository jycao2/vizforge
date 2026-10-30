<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const container = ref<HTMLDivElement>()
let canvas: HTMLCanvasElement | null = null
let gl: WebGLRenderingContext | null = null
let program: WebGLProgram | null = null
let buffer: WebGLBuffer | null = null
let timeLoc: WebGLUniformLocation | null = null
let raf = 0
let pointCount = 0

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
    attribute float aSize;
    attribute vec3 aColor;
    uniform float uTime;
    varying vec3 vColor;
    void main() {
      float ang = uTime * 0.15;
      mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
      vec2 p = rot * aPos;
      gl_Position = vec4(p, 0.0, 1.0);
      gl_PointSize = aSize;
      vColor = aColor;
    }
  `
  const fs = `
    precision mediump float;
    varying vec3 vColor;
    void main() {
      vec2 d = gl_PointCoord - vec2(0.5);
      float r = length(d);
      if (r > 0.5) discard;
      float alpha = 1.0 - smoothstep(0.0, 0.5, r);
      gl_FragColor = vec4(vColor, alpha);
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
  const sizeLoc = gl.getAttribLocation(program, 'aSize')
  const colorLoc = gl.getAttribLocation(program, 'aColor')
  timeLoc = gl.getUniformLocation(program, 'uTime')

  pointCount = 900
  const data = new Float32Array(pointCount * 6)
  for (let i = 0; i < pointCount; i++) {
    const o = i * 6
    data[o] = Math.random() * 2 - 1
    data[o + 1] = Math.random() * 2 - 1
    data[o + 2] = 2 + Math.random() * 6
    data[o + 3] = 0.4 + Math.random() * 0.6
    data[o + 4] = 0.4 + Math.random() * 0.6
    data[o + 5] = 0.4 + Math.random() * 0.6
  }

  buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)

  const stride = 6 * 4
  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0)
  gl.enableVertexAttribArray(sizeLoc)
  gl.vertexAttribPointer(sizeLoc, 1, gl.FLOAT, false, stride, 2 * 4)
  gl.enableVertexAttribArray(colorLoc)
  gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, stride, 3 * 4)

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.disable(gl.DEPTH_TEST)

  resize()
  window.addEventListener('resize', resize)

  const start = performance.now()
  const render = () => {
    raf = requestAnimationFrame(render)
    if (!gl) return
    const t = (performance.now() - start) / 1000
    gl.uniform1f(timeLoc, t)
    gl.clearColor(0.02, 0.03, 0.06, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.POINTS, 0, pointCount)
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
    <div class="hint">gl.POINTS + gl_PointCoord：柔边圆形点精灵缓慢旋转</div>
  </div>
</template>

<style scoped>
.webgl-container {
  position: relative;
  width: 100%;
  height: 100%;
  background: #05070d;
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
