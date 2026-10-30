<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createCube, createProgram, lookAt, perspective, setupGL, type GLContext } from './gl'

const container = ref<HTMLDivElement>()
const COUNT = 2000
let raf = 0
let ctx: GLContext | null = null
let resizeHandler: (() => void) | null = null
const errorText = ref('')
const fps = ref(0)

const vs = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aOffset;
attribute float aPhase;
uniform mat4 uProj;
uniform mat4 uView;
uniform float uTime;
varying vec3 vColor;
varying float vShade;

void main() {
  float angle = uTime * 0.6 + aPhase;
  float c = cos(angle);
  float s = sin(angle);
  vec3 p = vec3(c * aPos.x + s * aPos.z, aPos.y, -s * aPos.x + c * aPos.z);
  vec3 n = vec3(c * aNormal.x + s * aNormal.z, aNormal.y, -s * aNormal.x + c * aNormal.z);

  p = p * 0.3 + aOffset;

  float l = max(dot(normalize(n), normalize(vec3(0.45, 0.85, 0.6))), 0.0);
  vShade = 0.22 + 0.78 * l;
  vColor = 0.5 + 0.5 * cos(6.28318 * (aPhase * 0.12 + vec3(0.0, 0.33, 0.67)));

  gl_Position = uProj * uView * vec4(p, 1.0);
}
`

const fs = /* glsl */ `
precision mediump float;
varying vec3 vColor;
varying float vShade;
void main() {
  gl_FragColor = vec4(vColor * vShade, 1.0);
}
`

onMounted(() => {
  const el = container.value
  if (!el) return
  ctx = setupGL(el)
  if (!ctx) return
  const { gl, canvas } = ctx

  const ext = gl.getExtension('ANGLE_instanced_arrays') as ANGLE_instanced_arrays | null
  if (!ext) {
    errorText.value = '当前浏览器不支持 ANGLE_instanced_arrays'
    return
  }

  resizeHandler = () => ctx?.resize()
  window.addEventListener('resize', resizeHandler)

  const program = createProgram(gl, vs, fs)
  if (!program) return
  gl.useProgram(program)

  const cube = createCube()

  const posBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
  gl.bufferData(gl.ARRAY_BUFFER, cube.positions, gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
  ext.vertexAttribDivisorANGLE(aPos, 0)

  const normalBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuf)
  gl.bufferData(gl.ARRAY_BUFFER, cube.normals, gl.STATIC_DRAW)
  const aNormal = gl.getAttribLocation(program, 'aNormal')
  gl.enableVertexAttribArray(aNormal)
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0)
  ext.vertexAttribDivisorANGLE(aNormal, 0)

  const indexBuf = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cube.indices, gl.STATIC_DRAW)

  // 逐实例数据：位置 + 相位
  const offsets = new Float32Array(COUNT * 3)
  const phases = new Float32Array(COUNT)
  for (let i = 0; i < COUNT; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = 4.6 * Math.cbrt(Math.random())
    offsets[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    offsets[i * 3 + 1] = r * Math.cos(phi) * 0.75
    offsets[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    phases[i] = Math.random() * Math.PI * 2
  }

  const offsetBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, offsetBuf)
  gl.bufferData(gl.ARRAY_BUFFER, offsets, gl.STATIC_DRAW)
  const aOffset = gl.getAttribLocation(program, 'aOffset')
  gl.enableVertexAttribArray(aOffset)
  gl.vertexAttribPointer(aOffset, 3, gl.FLOAT, false, 0, 0)
  ext.vertexAttribDivisorANGLE(aOffset, 1)

  const phaseBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, phaseBuf)
  gl.bufferData(gl.ARRAY_BUFFER, phases, gl.STATIC_DRAW)
  const aPhase = gl.getAttribLocation(program, 'aPhase')
  gl.enableVertexAttribArray(aPhase)
  gl.vertexAttribPointer(aPhase, 1, gl.FLOAT, false, 0, 0)
  ext.vertexAttribDivisorANGLE(aPhase, 1)

  const uProj = gl.getUniformLocation(program, 'uProj')
  const uView = gl.getUniformLocation(program, 'uView')
  const uTime = gl.getUniformLocation(program, 'uTime')

  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0.04, 0.055, 0.08, 1)

  const view = lookAt([0, 1.5, 13], [0, 0, 0], [0, 1, 0])
  const start = performance.now()
  let frames = 0
  let lastFpsTs = start

  const render = (now: number) => {
    raf = requestAnimationFrame(render)
    const t = (now - start) / 1000

    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(program)

    gl.uniformMatrix4fv(uProj, false, perspective(Math.PI / 4, canvas.width / canvas.height, 0.1, 100))
    gl.uniformMatrix4fv(uView, false, view)
    gl.uniform1f(uTime, t)

    ext.drawElementsInstancedANGLE(gl.TRIANGLES, cube.indices.length, gl.UNSIGNED_SHORT, 0, COUNT)

    frames++
    if (now - lastFpsTs > 500) {
      fps.value = Math.round((frames * 1000) / (now - lastFpsTs))
      frames = 0
      lastFpsTs = now
    }
  }
  raf = requestAnimationFrame(render)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (resizeHandler) window.removeEventListener('resize', resizeHandler)
  ctx = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="row">
        <span class="tag">{{ COUNT }} 实例 · 1 次 draw call</span>
        <span class="tag hl">{{ fps }} FPS</span>
      </div>
      <div class="tip">
        逐实例属性 aOffset / aPhase，配合 vertexAttribDivisorANGLE 一次绘制全部立方体。
        <span v-if="errorText" class="err">{{ errorText }}</span>
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
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  gap: 10px;
}
.tag {
  font-size: 12px;
  color: #c3cfdb;
}
.tag.hl {
  color: #7ee787;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
.err {
  color: #ff7b72;
}
</style>
