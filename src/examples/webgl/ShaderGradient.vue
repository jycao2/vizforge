<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

const container = ref<HTMLDivElement>()
let raf = 0
let gl: WebGLRenderingContext | null = null
let program: WebGLProgram | null = null
let buffer: WebGLBuffer | null = null
let canvas: HTMLCanvasElement | null = null
let timeLoc: WebGLUniformLocation | null = null

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
    varying vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `
  const fs = `
    precision mediump float;
    varying vec2 vUv;
    uniform float uTime;
    void main() {
      vec3 top = vec3(0.05, 0.10, 0.28);
      vec3 bot = vec3(0.85, 0.22, 0.50);
      float m = 0.5 + 0.5 * sin(uTime + vUv.x * 6.2831);
      vec3 col = mix(top, bot, m);
      col += 0.08 * sin((vUv.y + uTime * 0.25) * 22.0);
      gl_FragColor = vec4(col, 1.0);
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

  const posLoc = gl.getAttribLocation(program, 'aPos')
  timeLoc = gl.getUniformLocation(program, 'uTime')

  // 覆盖整个裁剪空间的四边形（三角形条带）
  const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
  buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

  resize()
  window.addEventListener('resize', resize)

  const start = performance.now()
  const render = () => {
    raf = requestAnimationFrame(render)
    if (!gl || !program) return
    const t = (performance.now() - start) / 1000
    gl.uniform1f(timeLoc, t)
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
