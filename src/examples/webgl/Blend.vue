<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createProgram, lookAt, perspective, setupGL, type GLContext } from './gl'

const container = ref<HTMLDivElement>()
const depthOn = ref(true)
const reverse = ref(false)
let raf = 0
let ctx: GLContext | null = null
let resizeHandler: (() => void) | null = null

const vs = /* glsl */ `
attribute vec2 aPos;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = uProj * uView * uModel * vec4(aPos, 0.0, 1.0);
}
`

const fs = /* glsl */ `
precision mediump float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uAlpha;
void main() {
  // 中心稍亮，边缘透明一点，方便观察叠加关系
  float d = distance(vUv, vec2(0.5));
  float a = uAlpha * (1.0 - smoothstep(0.28, 0.72, d));
  gl_FragColor = vec4(uColor, a);
}
`

interface Quad {
  x: number
  z: number
  color: [number, number, number]
}

// 沿 x 轴错开、z 轴略有前后差，让透明片互相部分重叠，便于观察混合结果
const quads: Quad[] = [
  { x: -2.4, z: -0.6, color: [0.31, 0.62, 1.0] },
  { x: -1.2, z: 0.1, color: [0.49, 0.9, 0.53] },
  { x: 0.0, z: -0.2, color: [1.0, 0.65, 0.34] },
  { x: 1.2, z: 0.5, color: [1.0, 0.48, 0.45] },
  { x: 2.4, z: -0.4, color: [0.7, 0.55, 1.0] },
]

onMounted(() => {
  const el = container.value
  if (!el) return
  ctx = setupGL(el)
  if (!ctx) return
  const { gl, canvas } = ctx

  resizeHandler = () => ctx?.resize()
  window.addEventListener('resize', resizeHandler)

  const program = createProgram(gl, vs, fs)
  if (!program) return
  gl.useProgram(program)

  const quadBuf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  )
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const uProj = gl.getUniformLocation(program, 'uProj')
  const uView = gl.getUniformLocation(program, 'uView')
  const uModel = gl.getUniformLocation(program, 'uModel')
  const uColor = gl.getUniformLocation(program, 'uColor')
  const uAlpha = gl.getUniformLocation(program, 'uAlpha')

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.clearColor(0.04, 0.055, 0.08, 1)

  const view = lookAt([0, 0, 7], [0, 0, 0], [0, 1, 0])

  const render = (now: number) => {
    raf = requestAnimationFrame(render)
    const t = now / 1000

    if (depthOn.value) gl.enable(gl.DEPTH_TEST)
    else gl.disable(gl.DEPTH_TEST)

    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(program)

    gl.uniformMatrix4fv(uProj, false, perspective(Math.PI / 4, canvas.width / canvas.height, 0.1, 100))
    gl.uniformMatrix4fv(uView, false, view)

    const order = reverse.value ? [...quads].reverse() : quads
    order.forEach((q) => {
      const rot = Math.sin(t * 0.5) * 0.35
      // 每个四边形绕 Y 轴轻微旋转，并沿 z 排列
      const c = Math.cos(rot)
      const s = Math.sin(rot)
      const k = 1.5
      const model = new Float32Array([
        c * k, 0, -s * k, 0,
        0, k, 0, 0,
        s * k, 0, c * k, 0,
        q.x, 0, q.z, 1,
      ])
      gl.uniformMatrix4fv(uModel, false, model)
      gl.uniform3fv(uColor, q.color)
      gl.uniform1f(uAlpha, 0.6)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    })
  }
  raf = requestAnimationFrame(render)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (resizeHandler) window.removeEventListener('resize', resizeHandler)
  ctx = null
})

function toggleDepth() {
  depthOn.value = !depthOn.value
}
function toggleOrder() {
  reverse.value = !reverse.value
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="row">
        <button class="btn" :class="{ on: depthOn }" @click="toggleDepth">
          深度测试 {{ depthOn ? '开' : '关' }}
        </button>
        <button class="btn" :class="{ on: reverse }" @click="toggleOrder">
          {{ reverse ? '前→后绘制' : '后→前绘制' }}
        </button>
      </div>
      <div class="tip">
        关闭深度测试或改变绘制顺序，透明片之间的遮挡关系会明显变化 —— 这正是混合需要按深度排序的原因。
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
  width: 340px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  gap: 8px;
}
.btn {
  flex: 1;
  padding: 6px 0;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.55);
  background: transparent;
  color: #c3cfdb;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn:hover {
  border-color: #4f9dff;
  color: #4f9dff;
}
.btn.on {
  border-color: #4f9dff;
  color: #4f9dff;
  background: rgba(79, 157, 255, 0.15);
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
