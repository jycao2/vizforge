<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  createCube,
  createProgram,
  lookAt,
  multiply,
  perspective,
  rotationX,
  rotationY,
  setupGL,
  type GLContext,
} from './gl'

const container = ref<HTMLDivElement>()
const radius = ref(0.6)
let raf = 0
let ctx: GLContext | null = null
let radiusLoc: WebGLUniformLocation | null = null
let resizeHandler: (() => void) | null = null

const SIZE = 1024

const quadVs = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const sceneVs = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
varying vec3 vColor;
varying float vShade;
void main() {
  float l = max(dot(normalize(aNormal), normalize(vec3(0.5, 0.85, 0.6))), 0.0);
  vShade = 0.55 + 0.45 * l;
  vColor = aNormal * 0.5 + 0.5;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}
`

const sceneFs = /* glsl */ `
precision mediump float;
varying vec3 vColor;
varying float vShade;
void main() {
  gl_FragColor = vec4(vColor * vShade, 1.0);
}
`

const postFs = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uRadius;

void main() {
  vec3 sum = vec3(0.0);
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 offset = vec2(float(x), float(y)) * uTexel * uRadius;
      sum += texture2D(uTex, vUv + offset).rgb;
    }
  }
  vec3 color = sum / 25.0;

  // 暗角
  float vig = 1.0 - smoothstep(0.35, 1.05, distance(vUv, vec2(0.5)));
  color *= mix(0.62, 1.0, vig);

  gl_FragColor = vec4(color, 1.0);
}
`

onMounted(() => {
  const el = container.value
  if (!el) return
  ctx = setupGL(el)
  if (!ctx) return
  const { gl, canvas } = ctx

  resizeHandler = () => ctx?.resize()
  window.addEventListener('resize', resizeHandler)

  const sceneProgram = createProgram(gl, sceneVs, sceneFs)
  const postProgram = createProgram(gl, quadVs, postFs)
  if (!sceneProgram || !postProgram) return

  /* ---------- 立方体数据 ---------- */
  const cube = createCube()
  const cubePos = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, cubePos)
  gl.bufferData(gl.ARRAY_BUFFER, cube.positions, gl.STATIC_DRAW)
  const cubeNormal = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, cubeNormal)
  gl.bufferData(gl.ARRAY_BUFFER, cube.normals, gl.STATIC_DRAW)
  const cubeIndex = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cubeIndex)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cube.indices, gl.STATIC_DRAW)

  /* ---------- 全屏四边形 ---------- */
  const quadBuffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  )

  /* ---------- 帧缓冲对象 ---------- */
  const colorTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, colorTex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const depthBuffer = gl.createRenderbuffer()
  gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer)
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, SIZE, SIZE)

  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer)

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('帧缓冲不完整：', status)
  }

  /* ---------- uniform / attribute ---------- */
  const sPos = gl.getAttribLocation(sceneProgram, 'aPos')
  const sNormal = gl.getAttribLocation(sceneProgram, 'aNormal')
  const sProj = gl.getUniformLocation(sceneProgram, 'uProj')
  const sView = gl.getUniformLocation(sceneProgram, 'uView')
  const sModel = gl.getUniformLocation(sceneProgram, 'uModel')

  const pPos = gl.getAttribLocation(postProgram, 'aPos')
  const pTex = gl.getUniformLocation(postProgram, 'uTex')
  const pTexel = gl.getUniformLocation(postProgram, 'uTexel')
  radiusLoc = gl.getUniformLocation(postProgram, 'uRadius')

  gl.enable(gl.DEPTH_TEST)

  const render = (now: number) => {
    raf = requestAnimationFrame(render)
    const t = now / 1000

    /* ---- 1. 渲染场景到 FBO ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, SIZE, SIZE)
    gl.clearColor(0.06, 0.09, 0.14, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    gl.useProgram(sceneProgram)
    const proj = perspective(Math.PI / 4, 1, 0.1, 100)
    const view = lookAt([0, 0, 6], [0, 0, 0], [0, 1, 0])
    const model = multiply(rotationY(t * 0.7), rotationX(t * 0.45))
    gl.uniformMatrix4fv(sProj, false, proj)
    gl.uniformMatrix4fv(sView, false, view)
    gl.uniformMatrix4fv(sModel, false, model)

    gl.bindBuffer(gl.ARRAY_BUFFER, cubePos)
    gl.enableVertexAttribArray(sPos)
    gl.vertexAttribPointer(sPos, 3, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, cubeNormal)
    gl.enableVertexAttribArray(sNormal)
    gl.vertexAttribPointer(sNormal, 3, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cubeIndex)
    gl.drawElements(gl.TRIANGLES, cube.indices.length, gl.UNSIGNED_SHORT, 0)

    /* ---- 2. 把 FBO 纹理画到屏幕，并做模糊后处理 ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0.02, 0.03, 0.05, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(postProgram)
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
    gl.enableVertexAttribArray(pPos)
    gl.vertexAttribPointer(pPos, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, colorTex)
    gl.uniform1i(pTex, 0)
    gl.uniform2f(pTexel, 1 / SIZE, 1 / SIZE)
    gl.uniform1f(radiusLoc, radius.value)

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
  raf = requestAnimationFrame(render)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (resizeHandler) window.removeEventListener('resize', resizeHandler)
  ctx = null
})

function onRadiusInput(v: number) {
  radius.value = v
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">模糊半径</span>
        <input
          class="range"
          type="range"
          min="0"
          max="4"
          step="0.1"
          :value="radius"
          @input="onRadiusInput(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ radius.toFixed(1) }}</span>
      </div>
      <div class="tip">先渲染到帧缓冲（FBO），再用 5×5 采样做模糊后处理，最后绘制到屏幕。</div>
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
