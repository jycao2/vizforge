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
const info = ref('在地球上点击任意位置，拾取经纬度与高度')
let viewer: Cesium.Viewer | null = null
let baseLayer: Cesium.ImageryLayer | null = null
let handler: Cesium.ScreenSpaceEventHandler | null = null

function setBasemap(id: string) {
  if (!viewer) return
  baseLayer = applyCesiumBasemap(viewer, id, baseLayer)
  currentBasemap.value = id
}

const HOME = {
  destination: Cesium.Cartesian3.fromDegrees(104, 30, 14000000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
}

function zoomIn() {
  if (viewer) zoomCesiumCamera(viewer, 1 / 1.6)
}
function zoomOut() {
  if (viewer) zoomCesiumCamera(viewer, 1.6)
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
  handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  handler.setInputAction(
    (movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (!viewer) return
      let cartesian: Cesium.Cartesian3 | undefined = viewer.scene.pickPosition(movement.position)
      if (!cartesian) {
        cartesian = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid)
      }
      if (!cartesian) return

      const carto = Cesium.Cartographic.fromCartesian(cartesian)
      const lon = Cesium.Math.toDegrees(carto.longitude)
      const lat = Cesium.Math.toDegrees(carto.latitude)
      info.value = `经度 ${lon.toFixed(5)}°　纬度 ${lat.toFixed(5)}°　高度 ${carto.height.toFixed(1)} m`

      viewer.entities.add({
        position: cartesian,
        point: {
          pixelSize: 10,
          color: Cesium.Color.YELLOW,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        },
      })
    },
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  )
})

onBeforeUnmount(() => {
  handler?.destroy()
  handler = null
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
    <div class="info">{{ info }}</div>
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
.info {
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
</style>
