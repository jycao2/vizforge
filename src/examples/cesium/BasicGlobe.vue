<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS, DEFAULT_BASEMAP, applyCesiumBasemap } from './basemaps'
import { zoomCesiumCamera } from './useCesium'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const currentBasemap = ref(DEFAULT_BASEMAP)
let viewer: Cesium.Viewer | null = null
let baseLayer: Cesium.ImageryLayer | null = null

const HOME = {
  destination: Cesium.Cartesian3.fromDegrees(104, 30, 16000000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
}

function setBasemap(id: string) {
  if (!viewer) return
  baseLayer = applyCesiumBasemap(viewer, id, baseLayer)
  currentBasemap.value = id
}

function zoomIn() {
  if (!viewer) return
  zoomCesiumCamera(viewer, 1 / 1.6)
}
function zoomOut() {
  if (!viewer) return
  zoomCesiumCamera(viewer, 1.6)
}
function reset() {
  viewer?.camera.flyTo({ ...HOME, duration: 1.2 })
}
async function toggleFullscreen() {
  const el = wrapRef.value
  if (!el) return
  if (document.fullscreenElement) await document.exitFullscreen()
  else await el.requestFullscreen()
}

onMounted(() => {
  if (!container.value) return

  // 底图由 MapControls 切换，这里先关闭默认底图，避免 Cesium Ion Token 依赖。
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

  viewer.scene.globe.enableLighting = false
  viewer.scene.globe.showGroundAtmosphere = false
  setBasemap(currentBasemap.value)
  viewer.camera.setView(HOME)
})

onBeforeUnmount(() => {
  viewer?.destroy()
  viewer = null
  baseLayer = null
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
</style>
