<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const waveHeight = ref(0.6)
const choppiness = ref(0.8)
const sunElev = ref(18)
const materialRef = shallowRef<THREE.ShaderMaterial | null>(null)

/**
 * 手写 Gerstner 波海洋（参考 three.js 官方 webgl_shaders_ocean 的思路，公式全部手写）：
 * - 顶点着色器：4 个 Gerstner 波叠加。与普通 sin 波不同，Gerstner 会把波峰「削尖」、
 *   波谷「拉平」，水平方向还有位移，海面看起来更像真实水体。
 * - 法线不靠 CPU 算，直接在片元里用同一组波函数求偏分（解析法线，比 dFdx 平滑）。
 * - 片元：菲涅尔混合深水色与天空渐变 + Blinn-Phong 太阳高光 + 波峰泡沫。
 */

const WAVE_COUNT = 4
// 波方向（xz 平面内）、陡度、波长。四组不同方向的波叠出海面「乱而有序」的感觉
const waveDirs = [
  [1.0, 0.6],
  [0.7, -1.0],
  [-0.6, 0.8],
  [1.0, 1.0],
]

const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uChoppy;

varying vec3 vWorldPos;
varying float vCrest;

// Gerstner 波：返回垂直位移，同时沿波方向推动顶点（xy 是平面内坐标）
vec3 gerstner(vec2 dir, float steep, float wavelength, vec3 p, float t) {
  float k = 6.28318 / wavelength;          // 波数 2π/λ
  float c = sqrt(9.8 / k);                 // 深水波速 sqrt(g/k)
  vec2 d = normalize(dir);
  float f = k * (dot(d, p.xz) - c * t);
  float a = steep / k;                     // 振幅与陡度绑定，保证不自交
  // 削尖的余弦波：峰尖谷平
  return vec3(
    d.x * a * cos(f) * uChoppy,            // 沿波方向的水平位移
    a * sin(f),
    d.y * a * cos(f) * uChoppy
  );
}

void main() {
  vec3 p = position;
  vec3 disp = vec3(0.0);
  disp += gerstner(vec2(1.0, 0.6),  0.22 * uAmp * 6.0, 14.0, p, uTime);
  disp += gerstner(vec2(0.7, -1.0), 0.18 * uAmp * 6.0, 9.0,  p, uTime * 1.18);
  disp += gerstner(vec2(-0.6, 0.8), 0.15 * uAmp * 6.0, 5.5,  p, uTime * 1.35);
  disp += gerstner(vec2(1.0, 1.0),  0.12 * uAmp * 6.0, 3.0,  p, uTime * 1.6);
  p += disp;

  vCrest = disp.y;                          // 相对高度，片元里做泡沫
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const fragmentShader = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uAmp;

varying vec3 vWorldPos;
varying float vCrest;

// 与顶点同一组波函数（含 uAmp），数值求偏分得到解析法线（比 dFdx 干净）
float waveH(vec2 xz, float t) {
  float h = 0.0;
  // ---- 与顶点保持一致的四组波 ----
  h += sin(6.28318 / 14.0 * (dot(normalize(vec2(1.0, 0.6)),  xz) - sqrt(9.8 / (6.28318 / 14.0)) * t)) * (0.22 * uAmp * 6.0 / (6.28318 / 14.0));
  h += sin(6.28318 / 9.0  * (dot(normalize(vec2(0.7, -1.0)), xz) - sqrt(9.8 / (6.28318 / 9.0))  * t * 1.18)) * (0.18 * uAmp * 6.0 / (6.28318 / 9.0));
  h += sin(6.28318 / 5.5  * (dot(normalize(vec2(-0.6, 0.8)), xz) - sqrt(9.8 / (6.28318 / 5.5))  * t * 1.35)) * (0.15 * uAmp * 6.0 / (6.28318 / 5.5));
  h += sin(6.28318 / 3.0  * (dot(normalize(vec2(1.0, 1.0)),  xz) - sqrt(9.8 / (6.28318 / 3.0))  * t * 1.6)) * (0.12 * uAmp * 6.0 / (6.28318 / 3.0));
  return h;
}

void main() {
  // 数值偏分：两个很近的采样点求斜率
  float e = 0.35;
  float h0 = waveH(vWorldPos.xz, uTime);
  float hx = waveH(vWorldPos.xz + vec2(e, 0.0), uTime);
  float hz = waveH(vWorldPos.xz + vec2(0.0, e), uTime);
  vec3 normal = normalize(vec3(-(hx - h0) / e, 1.0, -(hz - h0) / e));

  vec3 viewDir = normalize(uCamPos - vWorldPos);

  // 深水 → 浅水的体色（近似水深感）
  vec3 deepColor = vec3(0.006, 0.05, 0.10);
  vec3 shallowColor = vec3(0.02, 0.28, 0.38);

  // 天空颜色：按反射向量朝上/朝地平线取渐变
  vec3 refl = reflect(-viewDir, normal);
  float up = clamp(refl.y, 0.0, 1.0);
  vec3 skyZenith = vec3(0.22, 0.42, 0.68);
  vec3 skyHorizon = vec3(0.72, 0.80, 0.88);
  vec3 sky = mix(skyHorizon, skyZenith, pow(up, 0.55));

  // 菲涅尔：视角越平，反射越强
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 5.0);
  fresnel = mix(0.04, 1.0, fresnel); // 4% 垂直入射时的基线反射率

  vec3 col = mix(mix(deepColor, shallowColor, 0.55), sky, fresnel);

  // 太阳高光（Blinn-Phong，指数很高 → 剪影般的粼光）
  vec3 sunDir = normalize(uSunDir);
  vec3 halfV = normalize(sunDir + viewDir);
  float spec = pow(max(dot(normal, halfV), 0.0), 320.0);
  // 高光沿波浪破碎成一条条光带
  col += vec3(1.0, 0.92, 0.75) * spec * 2.6;

  // 次表面散射的假象：迎着视线逆光的波谷被阳光穿透，透出青绿色
  float sss = pow(max(dot(viewDir, -sunDir), 0.0), 3.0) * clamp(-vCrest / (uAmp * 1.2 + 0.001), 0.0, 1.0);
  col += vec3(0.05, 0.35, 0.30) * sss * 0.55;

  // 波峰泡沫
  float foam = smoothstep(0.85, 1.35, vCrest) * 0.5;
  col = mix(col, vec3(0.92, 0.97, 1.0), foam);

  // 简单距离雾，海面与天空在地平线处融合
  float dist = length(uCamPos - vWorldPos);
  float fog = 1.0 - exp(-dist * 0.0028);
  col = mix(col, skyHorizon, fog);

  // gamma 提亮
  col = pow(col, vec3(0.4545));
  gl_FragColor = vec4(col, 1.0);
}
`

useThree(
  container,
  {
    background: 0x87b0d8,
    cameraPos: [0, 6.5, 24],
    lookAt: [0, 0, 0],
    controls: true,
    far: 800,
  },
  ({ scene, camera }) => {
    // 天空穹顶（渐变球）让背景与海面反射同源
    const skyGeo = new THREE.SphereGeometry(600, 32, 16)
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { uSunDir: { value: new THREE.Vector3() } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        varying vec3 vDir;
        void main() {
          float up = clamp(vDir.y, 0.0, 1.0);
          vec3 zenith = vec3(0.22, 0.42, 0.68);
          vec3 horizon = vec3(0.72, 0.80, 0.88);
          vec3 col = mix(horizon, zenith, pow(up, 0.55));
          float sun = pow(max(dot(vDir, normalize(uSunDir)), 0.0), 700.0);
          float halo = pow(max(dot(vDir, normalize(uSunDir)), 0.0), 12.0) * 0.22;
          col += vec3(1.0, 0.9, 0.7) * (sun + halo);
          gl_FragColor = vec4(pow(col, vec3(0.4545)), 1.0);
        }
      `,
    })
    scene.add(new THREE.Mesh(skyGeo, skyMat))

    const geo = new THREE.PlaneGeometry(320, 320, 256, 256)
    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: waveHeight.value },
        uChoppy: { value: choppiness.value },
        uSunDir: { value: new THREE.Vector3(0.6, 0.35, 0.75).normalize() },
        uCamPos: { value: camera.position },
      },
    })
    materialRef.value = mat
    const ocean = new THREE.Mesh(geo, mat)
    ocean.rotation.x = -Math.PI / 2
    scene.add(ocean)

    const skyMatRef = skyMat

    function applySun() {
      const elev = THREE.MathUtils.degToRad(sunElev.value)
      const dir = new THREE.Vector3(
        Math.cos(elev) * 0.78,
        Math.sin(elev),
        Math.cos(elev) * 0.63,
      ).normalize()
      mat.uniforms.uSunDir.value.copy(dir)
      skyMatRef.uniforms.uSunDir.value.copy(dir)
    }
    applySun()

    return (dt) => {
      mat.uniforms.uTime.value += dt
      mat.uniforms.uAmp.value = waveHeight.value
      mat.uniforms.uChoppy.value = choppiness.value
      mat.uniforms.uCamPos.value.copy(camera.position)
      // 相机别掉进海里
      if (camera.position.y < 1.2) camera.position.y = 1.2
    }
  },
)

function onSunInput(v: number) {
  sunElev.value = v
  if (materialRef.value) {
    const elev = THREE.MathUtils.degToRad(v)
    materialRef.value.uniforms.uSunDir.value
      .set(Math.cos(elev) * 0.78, Math.sin(elev), Math.cos(elev) * 0.63)
      .normalize()
  }
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">波高</span>
        <input
          class="range"
          type="range"
          min="0.1"
          max="1.4"
          step="0.05"
          :value="waveHeight"
          @input="waveHeight = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ waveHeight.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">陡度</span>
        <input
          class="range"
          type="range"
          min="0"
          max="1.6"
          step="0.05"
          :value="choppiness"
          @input="choppiness = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ choppiness.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">太阳高度</span>
        <input
          class="range"
          type="range"
          min="2"
          max="60"
          step="1"
          :value="sunElev"
          @input="onSunInput(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ sunElev }}°</span>
      </div>
      <div class="tip">
        Gerstner 波在顶点着色器里叠加四组不同方向的波，片元用解析偏分求法线；菲涅尔混合天空反射、Blinn-Phong
        粼光、波峰泡沫与距离雾，全部无纹理依赖。
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
.three-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 310px;
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
  margin-bottom: 6px;
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
  width: 42px;
  text-align: right;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
