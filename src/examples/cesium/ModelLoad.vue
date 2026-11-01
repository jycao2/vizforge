<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS, DEFAULT_BASEMAP, applyCesiumBasemap } from './basemaps'
import { useCesiumView } from './useCesium'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const currentBasemap = ref(DEFAULT_BASEMAP)
const loading = ref(true)
const error = ref('')
let viewer: Cesium.Viewer | null = null

let baseLayer: Cesium.ImageryLayer | null = null
let destroyed = false

function setBasemap(id: string) {
  if (!viewer) return
  baseLayer = applyCesiumBasemap(viewer, id, baseLayer)
  currentBasemap.value = id
}

const DUCK_URL =
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Duck/glTF-Binary/Duck.glb'
const LON = 116.391
const LAT = 39.907

const HOME = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.02, 2500),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
  focus: { center: Cesium.Cartesian3.fromDegrees(LON, LAT), radius: 1500, range: 5200 },
}

const { zoomIn, zoomOut, reset } = useCesiumView(() => viewer, () => HOME)

async function toggleFullscreen() {
  const el = wrapRef.value
  if (!el) return
  if (document.fullscreenElement) await document.exitFullscreen()
  else await el.requestFullscreen()
}

onMounted(async () => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, {
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  })
  setBasemap(currentBasemap.value)
  viewer.camera.setView(HOME)

  try {
    const position = Cesium.Cartesian3.fromDegrees(LON, LAT, 0)
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(position)
    const model = await Cesium.Model.fromGltfAsync({
      url: DUCK_URL,
      modelMatrix,
      scale: 1000,
      minimumPixelSize: 48,
      maximumScale: 200000,
    })
    if (destroyed || !viewer) {
      return
    }
    viewer.scene.primitives.add(model)
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(LON, LAT, 300),
      label: {
        text: 'glTF 模型（Duck）',
        font: '14px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -30),
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
      },
    })
    loading.value = false
  } catch (e) {
    error.value = '模型加载失败：' + String(e)
    loading.value = false
  }
})

onBeforeUnmount(() => {
  destroyed = true
  viewer?.destroy()
  viewer = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>
    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="setBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen"
    />
    <div v-if="loading" class="hint">模型加载中…</div>
    <div v-else-if="error" class="hint error">{{ error }}</div>
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
.hint {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(17, 24, 34, 0.88);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  font-size: 13px;
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.hint.error {
  color: #ff7b72;
}
</style>
