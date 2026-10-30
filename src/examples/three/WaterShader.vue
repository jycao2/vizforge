<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const amplitude = ref(0.35)
const materialRef = shallowRef<THREE.ShaderMaterial | null>(null)

const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uAmp;
varying float vHeight;
varying vec2 vUv;

void main() {
  vUv = uv;
  vec3 p = position;
  float h = sin(p.x * 0.55 + uTime) * uAmp
          + sin(p.y * 0.75 + uTime * 1.25) * uAmp * 0.65
          + sin((p.x + p.y) * 0.32 + uTime * 0.7) * uAmp * 0.45;
  p.z += h;
  vHeight = h;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`

const fragmentShader = /* glsl */ `
uniform float uTime;
varying float vHeight;
varying vec2 vUv;

void main() {
  vec3 deep = vec3(0.015, 0.12, 0.26);
  vec3 shallow = vec3(0.06, 0.48, 0.72);
  vec3 crest = vec3(0.78, 0.96, 1.0);

  float t = smoothstep(-0.7, 0.75, vHeight);
  vec3 col = mix(deep, shallow, t);
  col = mix(col, crest, smoothstep(0.42, 0.85, vHeight) * 0.8);

  // 网格刻线，让起伏更容易看清
  vec2 g = abs(fract(vUv * 44.0) - 0.5);
  float line = smoothstep(0.47, 0.5, max(g.x, g.y));
  col += line * 0.07;

  // 缓慢流动的高光带
  float band = sin(vUv.x * 12.0 + uTime * 0.6) * 0.5 + 0.5;
  col += band * 0.03;

  gl_FragColor = vec4(col, 1.0);
}
`

useThree(
  container,
  {
    background: 0x04080f,
    cameraPos: [0, 7, 13],
    lookAt: [0, 0, 0],
    controls: true,
  },
  ({ scene }) => {
    const geometry = new THREE.PlaneGeometry(34, 34, 160, 160)
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: amplitude.value },
      },
      side: THREE.DoubleSide,
    })
    materialRef.value = material

    const water = new THREE.Mesh(geometry, material)
    water.rotation.x = -Math.PI / 2
    water.position.y = -1
    scene.add(water)

    return (dt) => {
      material.uniforms.uTime.value += dt
      material.uniforms.uAmp.value = amplitude.value
    }
  },
)

function onAmpInput(v: number) {
  amplitude.value = v
  if (materialRef.value) materialRef.value.uniforms.uAmp.value = v
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">波浪振幅</span>
        <input
          class="range"
          type="range"
          min="0"
          max="0.8"
          step="0.02"
          :value="amplitude"
          @input="onAmpInput(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ amplitude.toFixed(2) }}</span>
      </div>
      <div class="tip">ShaderMaterial 自定义顶点位移与片元着色，正弦波在 GPU 上实时计算。</div>
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
  width: 300px;
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
  width: 36px;
  text-align: right;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
