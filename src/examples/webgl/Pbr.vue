<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  createProgram,
  createSphere,
  lookAt,
  multiply,
  perspective,
  rotationY,
  scaling,
  setupGL,
  translation,
  type GLContext,
} from './gl'

/**
 * PBR 直接光照（Cook-Torrance）
 *
 * 和 Phong 的区别不是"更亮"，而是能量守恒 + 物理响应：
 *   D  GGX 法线分布：粗糙度控制高光形状（不是简单调指数）
 *   G  Smith-Schlick 几何遮蔽：微表面互相遮挡，掠射角变暗
 *   F  Schlick 菲涅尔：所有材质掠射角都会反射更多（金属 F0 有色，非金属 F0≈0.04）
 * 环境项用解析半球近似（没上 IBL 预过滤贴图），够看出金属/粗糙度的差别。
 */

const container = ref<HTMLDivElement>()
let ctx: GLContext | null = null
let raf = 0

const lightPower = ref(1.0)
const envPower = ref(0.6)
const exposure = ref(1.1)
const stats = ref({ fps: 0 })

let prog: WebGLProgram | null = null
let sphere = { pos: null as WebGLBuffer | null, nrm: null as WebGLBuffer | null, idx: null as WebGLBuffer | null, count: 0 }
let u: Record<string, WebGLUniformLocation | null> = {}
let frames = 0
let lastFps = performance.now()

const VS = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNormalMat;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vN = normalize(uNormalMat * aNormal);
  gl_Position = uProj * uView * w;
}
`

const FS = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vWorld;

uniform vec3 uCamera;
uniform vec3 uBaseColor;
uniform float uRough;
uniform float uMetal;
uniform float uLightPower;
uniform float uEnvPower;
uniform float uExposure;

const float PI = 3.14159265359;

// GGX / Trowbridge-Reitz 法线分布
float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-6);
}

// Smith 几何项（Schlick 近似）
float G_Smith(float NoV, float NoL, float a) {
  float k = (a + 1.0) * (a + 1.0) / 8.0;
  float gv = NoV / (NoV * (1.0 - k) + k);
  float gl = NoL / (NoL * (1.0 - k) + k);
  return gv * gl;
}

// Schlick 菲涅尔
vec3 F_Schlick(float VoH, vec3 f0) {
  return f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
}

vec3 brdf(vec3 N, vec3 V, vec3 L, vec3 albedo, float rough, float metal) {
  vec3 H = normalize(V + L);
  float NoL = max(dot(N, L), 0.0);
  float NoV = max(dot(N, V), 1e-4);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  if (NoL <= 0.0) return vec3(0.0);

  float a = max(rough * rough, 0.002);
  // 金属：F0 取基色；电介质：F0 固定 0.04，漫反射才是基色
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 F = F_Schlick(VoH, f0);
  float D = D_GGX(NoH, a);
  float G = G_Smith(NoV, NoL, a);

  vec3 spec = (D * G * F) / max(4.0 * NoV * NoL, 1e-4);
  // 能量守恒：被反射掉的（F）不能再参与漫反射
  vec3 kd = (1.0 - F) * (1.0 - metal);
  vec3 diff = kd * albedo / PI;
  return (diff + spec) * NoL;
}

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamera - vWorld);
  vec3 L1 = normalize(vec3(0.75, 0.9, 0.55));
  vec3 L2 = normalize(vec3(-0.8, 0.35, 0.4));
  vec3 L3 = normalize(vec3(0.1, 0.5, -0.95));

  vec3 col = vec3(0.0);
  col += brdf(N, V, L1, uBaseColor, uRough, uMetal) * vec3(1.0, 0.96, 0.9) * 3.2 * uLightPower;
  col += brdf(N, V, L2, uBaseColor, uRough, uMetal) * vec3(0.5, 0.72, 1.0) * 1.6 * uLightPower;
  col += brdf(N, V, L3, uBaseColor, uRough, uMetal) * vec3(1.0, 0.8, 0.7) * 1.1 * uLightPower;

  // 廉价环境光：天空色 + 地面色的半球插值，镜面按粗糙度衰减
  float hemi = N.y * 0.5 + 0.5;
  vec3 sky = vec3(0.32, 0.42, 0.6);
  vec3 ground = vec3(0.14, 0.12, 0.11);
  vec3 envDiff = mix(ground, sky, hemi);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 envSpec = mix(ground, sky, pow(hemi, 1.5)) * (0.25 + 0.75 * fres) * (1.0 - uRough * 0.7);
  vec3 f0 = mix(vec3(0.04), uBaseColor, uMetal);
  col += (envDiff * mix(uBaseColor, vec3(0.0), uMetal) + envSpec * mix(vec3(1.0), uBaseColor, uMetal) * (0.4 + f0 * 6.0)) * uEnvPower;

  col *= uExposure;
  col = col / (1.0 + col);                       // 简单色调压缩
  col = pow(col, vec3(1.0 / 2.2));               // gamma
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`

function compile() {
  const gl = ctx!.gl
  prog = createProgram(gl, VS, FS)
  if (!prog) return false
  u = {
    uProj: gl.getUniformLocation(prog, 'uProj'),
    uView: gl.getUniformLocation(prog, 'uView'),
    uModel: gl.getUniformLocation(prog, 'uModel'),
    uNormalMat: gl.getUniformLocation(prog, 'uNormalMat'),
    uCamera: gl.getUniformLocation(prog, 'uCamera'),
    uBaseColor: gl.getUniformLocation(prog, 'uBaseColor'),
    uRough: gl.getUniformLocation(prog, 'uRough'),
    uMetal: gl.getUniformLocation(prog, 'uMetal'),
    uLightPower: gl.getUniformLocation(prog, 'uLightPower'),
    uEnvPower: gl.getUniformLocation(prog, 'uEnvPower'),
    uExposure: gl.getUniformLocation(prog, 'uExposure'),
  }
  return true
}

function buildGeometry() {
  const gl = ctx!.gl
  const s = createSphere(40, 26)
  sphere.count = s.indices.length
  sphere.pos = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, sphere.pos)
  gl.bufferData(gl.ARRAY_BUFFER, s.positions, gl.STATIC_DRAW)
  sphere.nrm = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, sphere.nrm)
  gl.bufferData(gl.ARRAY_BUFFER, s.normals, gl.STATIC_DRAW)
  sphere.idx = gl.createBuffer()
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphere.idx)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, s.indices, gl.STATIC_DRAW)
}

const ROUGHNESS = [0.06, 0.22, 0.42, 0.65, 0.9]
const METALNESS = [1.0, 0.0]

function render(now: number) {
  if (!ctx || !prog) return
  const gl = ctx!.gl
  const t = now * 0.001
  gl.viewport(0, 0, ctx!.canvas.width, ctx!.canvas.height)
  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0.02, 0.024, 0.032, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

  const aspect = ctx!.canvas.width / Math.max(1, ctx!.canvas.height)
  const proj = perspective((46 * Math.PI) / 180, aspect, 0.1, 100)
  const camera: [number, number, number] = [0, 1.9, 8.6]
  const view = lookAt(camera, [0, 0.55, 0], [0, 1, 0])
  gl.useProgram(prog)
  gl.uniformMatrix4fv(u.uProj, false, proj)
  gl.uniformMatrix4fv(u.uView, false, view)
  gl.uniform3fv(u.uCamera, camera)
  gl.uniform1f(u.uLightPower, lightPower.value)
  gl.uniform1f(u.uEnvPower, envPower.value)
  gl.uniform1f(u.uExposure, exposure.value)

  gl.bindBuffer(gl.ARRAY_BUFFER, sphere.pos)
  const aPos = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, sphere.nrm)
  const aNrm = gl.getAttribLocation(prog, 'aNormal')
  gl.enableVertexAttribArray(aNrm)
  gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphere.idx)

  for (let row = 0; row < METALNESS.length; row++) {
    for (let i = 0; i < ROUGHNESS.length; i++) {
      const x = (i - 2) * 1.62
      const y = row === 0 ? 1.05 : -0.05
      const bob = Math.sin(t * 0.9 + i * 0.5 + row) * 0.03
      const m = multiply(
        multiply(translation(x, y + bob, 0), rotationY(t * 0.25 + i * 0.2)),
        scaling(0.62),
      )
      const nm = new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
      gl.uniformMatrix4fv(u.uModel, false, m)
      gl.uniformMatrix3fv(u.uNormalMat, false, nm)
      // 一行金属（金色）、一行电介质（暗红塑料），对比 F0 的差别
      if (row === 0) gl.uniform3f(u.uBaseColor, 0.95, 0.72, 0.32)
      else gl.uniform3f(u.uBaseColor, 0.55, 0.16, 0.14)
      gl.uniform1f(u.uMetal, METALNESS[row])
      gl.uniform1f(u.uRough, ROUGHNESS[i])
      gl.drawElements(gl.TRIANGLES, sphere.count, gl.UNSIGNED_SHORT, 0)
    }
  }

  frames++
  if (now - lastFps > 500) {
    stats.value.fps = Math.round((frames * 1000) / (now - lastFps))
    frames = 0
    lastFps = now
  }
  raf = requestAnimationFrame(render)
}

onMounted(() => {
  if (!container.value) return
  ctx = setupGL(container.value)
  if (!ctx) return
  if (!compile()) return
  buildGeometry()
  raf = requestAnimationFrame(render)
  const onResize = () => ctx!.resize()
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => window.removeEventListener('resize', onResize))
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  raf = 0
  const gl = ctx?.gl
  if (gl) {
    if (prog) gl.deleteProgram(prog)
    for (const b of [sphere.pos, sphere.nrm, sphere.idx]) if (b) gl.deleteBuffer(b)
  }
  ctx = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="gl-container"></div>

    <div class="legend">
      <div class="cap">上排：金属（金） · 下排：电介质（红塑料） · 从左到右粗糙度 {{ ROUGHNESS.join(' / ') }}</div>
    </div>

    <div class="panel">
      <div class="title">PBR 直接光照 · Cook-Torrance</div>
      <div class="sub">GGX + Smith + Schlick · {{ stats.fps }} fps</div>

      <div class="ctrl">
        <span class="lab">光源强度</span>
        <input v-model.number="lightPower" type="range" min="0" max="2.5" step="0.05" />
        <b>{{ lightPower.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">环境光</span>
        <input v-model.number="envPower" type="range" min="0" max="2" step="0.05" />
        <b>{{ envPower.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">曝光</span>
        <input v-model.number="exposure" type="range" min="0.3" max="2.5" step="0.05" />
        <b>{{ exposure.toFixed(2) }}</b>
      </div>

      <div class="tip">
        金属行：基色就是 F0，反射带颜色、且几乎没有漫反射；电介质行：F0 固定 0.04，
        所以亮面看起来偏白。粗糙度只改变高光的形状与锐利程度（GGX 的 a = rough²），
        不改变"有多亮"——这一点是 Phong 指数做不到的。
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
  background: #05070a;
}
.legend {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 5;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(14, 20, 28, 0.78);
  border: 1px solid rgba(88, 108, 132, 0.32);
}
.cap {
  font-size: 10.5px;
  color: #8fa0b3;
  font-family: ui-monospace, monospace;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 308px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(12, 18, 26, 0.9);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: #7d8fa2;
  font-family: ui-monospace, monospace;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}
.lab {
  flex: 0 0 58px;
  font-size: 11px;
  color: #8fa0b3;
}
.ctrl input[type='range'] {
  flex: 1;
  height: 3px;
  appearance: none;
  background: rgba(96, 116, 140, 0.5);
  border-radius: 2px;
  outline: none;
}
.ctrl input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #6fb3f2;
  border: 2px solid #0e141c;
  cursor: pointer;
}
.ctrl b {
  flex: 0 0 46px;
  text-align: right;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #cfe4f5;
  font-weight: 500;
}
.tip {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.24);
  font-size: 10.5px;
  line-height: 1.6;
  color: #7b8b9d;
}
</style>
