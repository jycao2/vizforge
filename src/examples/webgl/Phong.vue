<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  createProgram,
  createSphere,
  lookAt,
  normalMat3,
  perspective,
  rotationY,
  setupGL,
  type GLContext,
} from './gl'

const container = ref<HTMLDivElement>()
const shininess = ref(64)
let raf = 0
let ctx: GLContext | null = null
let resizeHandler: (() => void) | null = null
let shininessLoc: WebGLUniformLocation | null = null
let glRef: WebGLRenderingContext | null = null

const vs = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec3 vNormal;
varying vec3 vWorld;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  gl_Position = uProj * uView * world;
}
`

const fs = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vWorld;
uniform vec3 uLightPos;
uniform vec3 uEye;
uniform float uShininess;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uEye - vWorld);

  // 主光（绕球旋转）+ 固定冷色补光
  vec3 keyDir = normalize(uLightPos - vWorld);
  vec3 fillDir = normalize(vec3(-2.6, -1.1, 1.7) - vWorld);

  // 漫反射：Lambert
  float keyDiff = max(dot(N, keyDir), 0.0);
  float fillDiff = max(dot(N, fillDir), 0.0);

  // 高光：Blinn-Phong 用半程向量 H = normalize(L + V)，比 pow(dot(R,V)) 更省
  vec3 H = normalize(keyDir + V);
  float spec = pow(max(dot(N, H), 0.0), uShininess);

  // 边缘光：视线与法线夹角越大越亮
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);

  vec3 base = vec3(0.34, 0.48, 0.86);
  vec3 color = base * 0.02                       // 环境光
             + base * keyDiff * 1.0              // 主光漫反射
             + vec3(0.16, 0.30, 0.55) * fillDiff * 0.55  // 补光
             + vec3(1.0) * spec * 5.0            // 高光（数值放大后交给色调映射压缩）
             + vec3(0.35, 0.62, 1.0) * rim * 0.35;

  // 色调映射：把 [0, ∞) 压到 [0, 1)，高光保留层次而不是直接削平
  color = color / (color + vec3(1.0));
  gl_FragColor = vec4(pow(color, vec3(1.0 / 2.2)), 1.0);
}
`

onMounted(() => {
  const el = container.value
  if (!el) return
  ctx = setupGL(el)
  if (!ctx) return
  const { gl, canvas } = ctx
  glRef = gl

  const resizeHandlerFn = () => ctx?.resize()
  resizeHandler = resizeHandlerFn
  window.addEventListener('resize', resizeHandlerFn)

  const program = createProgram(gl, vs, fs)
  if (!program) return
  gl.useProgram(program)

  const sphere = createSphere(64, 40)

  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, sphere.positions, gl.STATIC_DRAW)
  const posLoc = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0)

  const nbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, nbo)
  gl.bufferData(gl.ARRAY_BUFFER, sphere.normals, gl.STATIC_DRAW)
  const normalLoc = gl.getAttribLocation(program, 'aNormal')
  gl.enableVertexAttribArray(normalLoc)
  gl.vertexAttribPointer(normalLoc, 3, gl.FLOAT, false, 0, 0)

  const ibo = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW)

  const uProj = gl.getUniformLocation(program, 'uProj')
  const uView = gl.getUniformLocation(program, 'uView')
  const uModel = gl.getUniformLocation(program, 'uModel')
  const uNormalMat = gl.getUniformLocation(program, 'uNormalMat')
  const uLightPos = gl.getUniformLocation(program, 'uLightPos')
  const uEye = gl.getUniformLocation(program, 'uEye')
  shininessLoc = gl.getUniformLocation(program, 'uShininess')

  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0.045, 0.06, 0.09, 1)

  const eye: [number, number, number] = [0, 0, 3.4]
  const view = lookAt(eye, [0, 0, 0], [0, 1, 0])

  const render = (now: number) => {
    raf = requestAnimationFrame(render)
    const t = now / 1000
    const proj = perspective(Math.PI / 4, canvas.width / canvas.height, 0.1, 100)
    const model = rotationY(t * 0.6)

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    gl.uniformMatrix4fv(uProj, false, proj)
    gl.uniformMatrix4fv(uView, false, view)
    gl.uniformMatrix4fv(uModel, false, model)
    gl.uniformMatrix3fv(uNormalMat, false, normalMat3(model))
    gl.uniform3f(uLightPos, Math.cos(t * 0.8) * 2.6, 1.9, 1.5 + Math.sin(t * 0.8) * 0.7)
    gl.uniform3fv(uEye, eye)
    gl.uniform1f(shininessLoc, shininess.value)

    gl.drawElements(gl.TRIANGLES, sphere.indices.length, gl.UNSIGNED_SHORT, 0)
  }
  raf = requestAnimationFrame(render)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (resizeHandler) window.removeEventListener('resize', resizeHandler)
  ctx?.gl?.getExtension('WEBGL_lose_context')?.loseContext()
  ctx = null
  glRef = null
})

function onShininessInput(v: number) {
  shininess.value = v
  if (glRef && shininessLoc) glRef.uniform1f(shininessLoc, v)
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">高光指数</span>
        <input
          class="range"
          type="range"
          min="2"
          max="256"
          step="2"
          :value="shininess"
          @input="onShininessInput(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ shininess }}</span>
      </div>
      <div class="tip">手写 Blinn-Phong：环境光 + 漫反射 + 高光 + 边缘光，法线用 3×3 法线矩阵变换。</div>
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
  width: 320px;
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
  width: 34px;
  text-align: right;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
