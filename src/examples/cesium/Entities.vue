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
let viewer: Cesium.Viewer | null = null

let baseLayer: Cesium.ImageryLayer | null = null

function setBasemap(id: string) {
  if (!viewer) return
  baseLayer = applyCesiumBasemap(viewer, id, baseLayer)
  currentBasemap.value = id
}

const LON = 116.391
const LAT = 39.907
const HOME = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT, 900000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
  // 要素从北京铺到 117.6°E，跨度 ~100km；按包围球取景，复位/缩放都不会把它们甩出去
  focus: {
    center: Cesium.Cartesian3.fromDegrees(LON + 0.6, LAT + 0.18),
    radius: 70000,
    range: 150000,
  },
}

const { zoomIn, zoomOut, reset } = useCesiumView(() => viewer, () => HOME)
async function toggleFullscreen() {
  const el = wrapRef.value
  if (!el) return
  if (document.fullscreenElement) await document.exitFullscreen()
  else await el.requestFullscreen()
}

onMounted(() => {
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

  const lon = LON
  const lat = LAT

  setBasemap(currentBasemap.value)

  // 点 + 标签
  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    point: {
      pixelSize: 14,
      color: Cesium.Color.RED,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
    },
    label: {
      text: '北京',
      font: '16px sans-serif',
      pixelOffset: new Cesium.Cartesian2(0, -26),
      fillColor: Cesium.Color.YELLOW,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    },
  })

  // 多边形
  viewer.entities.add({
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray([
        lon, lat,
        lon + 0.12, lat,
        lon + 0.12, lat + 0.12,
        lon, lat + 0.12,
      ]),
      material: Cesium.Color.fromRandom({ alpha: 0.45 }),
      outline: true,
      outlineColor: Cesium.Color.WHITE,
    },
  })

  // 折线
  viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([
        lon, lat,
        lon + 0.6, lat + 0.35,
        lon + 1.2, lat + 0.1,
      ]),
      width: 4,
      material: Cesium.Color.CYAN,
    },
  })

  reset()
})

onBeforeUnmount(() => {
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
