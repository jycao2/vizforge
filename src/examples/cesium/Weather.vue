<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

type WeatherMode = 'rain' | 'snow' | 'fog' | 'none'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const mode = ref<WeatherMode>('rain')

let viewer: Cesium.Viewer | null = null
let stage: Cesium.PostProcessStage | null = null
let tick: (() => void) | null = null
const startAt = performance.now()
const stageRef = shallowRef<Cesium.PostProcessStage | null>(null)
const viewerRef = shallowRef<Cesium.Viewer | null>(null)

const home = {
  destination: Cesium.Cartesian3.fromDegrees(116.391, 39.79, 12000),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-35),
    roll: 0,
  },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
// 深色底图对比更强，雨雪更容易看清
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

const fragmentShader = /* glsl */ `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
uniform float u_time;
uniform float u_mode; // 1=雨 2=雪 3=雾

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  vec2 uv = v_textureCoordinates;

  if (u_mode < 1.5) {
    // 雨：按列生成向下移动的细线
    float cols = 90.0;
    float col = floor(uv.x * cols);
    float speed = 1.1 + hash(vec2(col, 7.0)) * 1.7;
    float y = fract(uv.y * 1.4 + u_time * speed + hash(vec2(col, 3.0)));
    float streak = smoothstep(0.86, 1.0, y);
    float lane = 1.0 - smoothstep(0.0, 0.45, abs(fract(uv.x * cols) - 0.5));
    float rain = streak * lane * 0.9;
    color.rgb = mix(color.rgb, vec3(0.78, 0.86, 1.0), rain);
    color.rgb *= 0.72;
  } else if (u_mode < 2.5) {
    // 雪：网格化随机雪花，缓慢下落
    vec2 grid = uv * vec2(64.0, 40.0);
    vec2 gv = fract(grid) - 0.5;
    vec2 id = floor(grid);
    float r = hash(id);
    float speed = 0.05 + r * 0.10;
    vec2 pos = vec2(
      sin((id.y + u_time * 0.3) * 1.7) * 0.28,
      fract(r + u_time * speed) - 0.5
    );
    float d = length(gv - pos);
    float flake = (1.0 - smoothstep(0.0, 0.10, d)) * step(0.62, r);
    color.rgb = mix(color.rgb, vec3(1.0), flake * 0.95);
  } else {
    // 雾：中心亮、四周暗的灰白叠加
    float vig = 1.0 - smoothstep(0.15, 0.75, distance(uv, vec2(0.5)));
    color.rgb = mix(color.rgb, vec3(0.80, 0.84, 0.90), 0.42 + 0.20 * vig);
  }

  out_FragColor = color;
}
`

function applyMode(m: WeatherMode) {
  mode.value = m
  if (!stage) return
  if (m === 'none') {
    stage.enabled = false
    return
  }
  stage.enabled = true
  stage.uniforms.u_mode = m === 'rain' ? 1 : m === 'snow' ? 2 : 3
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  viewerRef.value = viewer
  applyBasemap(currentBasemap.value)
  viewer.camera.setView(home)

  stage = new Cesium.PostProcessStage({
    name: 'weather',
    fragmentShader,
    uniforms: {
      u_time: 0,
      u_mode: 1,
    },
  })
  stageRef.value = stage
  viewer.scene.postProcessStages.add(stage)

  tick = () => {
    if (!stage) return
    stage.uniforms.u_time = (performance.now() - startAt) / 1000
  }
  viewer.scene.preUpdate.addEventListener(tick)

  applyMode(mode.value)
})

onBeforeUnmount(() => {
  if (viewer && tick) viewer.scene.preUpdate.removeEventListener(tick)
  tick = null
  viewer?.destroy()
  viewer = null
  stage = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>
    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="panel">
      <div class="row">
        <button class="btn" :class="{ on: mode === 'rain' }" @click="applyMode('rain')">下雨</button>
        <button class="btn" :class="{ on: mode === 'snow' }" @click="applyMode('snow')">下雪</button>
        <button class="btn" :class="{ on: mode === 'fog' }" @click="applyMode('fog')">大雾</button>
        <button class="btn" :class="{ on: mode === 'none' }" @click="applyMode('none')">晴</button>
      </div>
      <div class="hint">基于 PostProcessStage 的全屏 GLSL 后期特效，逐帧叠加在场景之上。</div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.cesium-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  width: 300px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  gap: 6px;
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
  background: #4f9dff;
  border-color: #4f9dff;
  color: #fff;
}
.hint {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
