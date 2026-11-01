<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS, DEFAULT_BASEMAP, applyCesiumBasemap } from './basemaps'
import { zoomCesiumCamera, useCesiumHost } from './useCesium'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const currentBasemap = ref(DEFAULT_BASEMAP)
const count = ref(0)
const tip = ref('左键添加顶点，右键结束绘制')
let viewer: Cesium.Viewer | null = null

useCesiumHost(() => viewer)

let baseLayer: Cesium.ImageryLayer | null = null

function setBasemap(id: string) {
  if (!viewer) return
  baseLayer = applyCesiumBasemap(viewer, id, baseLayer)
  currentBasemap.value = id
}
let handler: Cesium.ScreenSpaceEventHandler | null = null
let positions: Cesium.Cartesian3[] = []
let cursor: Cesium.Cartesian3 | null = null
let dynamicEntity: Cesium.Entity | null = null

const HOME = {
  destination: Cesium.Cartesian3.fromDegrees(116.391, 39.907, 220000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-70), roll: 0 },
}

function pickGround(pos: Cesium.Cartesian2): Cesium.Cartesian3 | null {
  if (!viewer) return null
  return viewer.camera.pickEllipsoid(pos, viewer.scene.globe.ellipsoid) ?? null
}

function resetDrawing() {
  if (!viewer) return
  if (dynamicEntity) {
    viewer.entities.remove(dynamicEntity)
    dynamicEntity = null
  }
  positions = []
  cursor = null
  count.value = 0
}

function clearAll() {
  if (!viewer) return
  resetDrawing()
  viewer.entities.removeAll()
  tip.value = '左键添加顶点，右键结束绘制'
}

function finish() {
  if (!viewer) return
  if (positions.length >= 3) {
    if (dynamicEntity) {
      viewer.entities.remove(dynamicEntity)
      dynamicEntity = null
    }
    viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions.slice()),
        material: Cesium.Color.CYAN.withAlpha(0.35),
        outline: true,
        outlineColor: Cesium.Color.CYAN,
      },
    })
    tip.value = `已生成多边形（${positions.length} 个顶点）`
  } else {
    tip.value = '顶点不足 3 个，无法构成多边形'
  }
  resetDrawing()
}

function zoomIn() {
  if (viewer) zoomCesiumCamera(viewer, 1 / 1.6)
}
function zoomOut() {
  if (viewer) zoomCesiumCamera(viewer, 1.6)
}
function resetView() {
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
    (m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const p = pickGround(m.position)
      if (!p || !viewer) return
      positions.push(p)
      count.value = positions.length
      viewer.entities.add({
        position: p,
        point: {
          pixelSize: 8,
          color: Cesium.Color.ORANGE,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
        },
      })
      if (!dynamicEntity) {
        dynamicEntity = viewer.entities.add({
          polygon: {
            hierarchy: new Cesium.CallbackProperty(() => {
              const list = cursor && positions.length >= 1 ? [...positions, cursor] : positions
              return new Cesium.PolygonHierarchy(list)
            }, false),
            material: Cesium.Color.CYAN.withAlpha(0.3),
            outline: true,
            outlineColor: Cesium.Color.CYAN,
          },
        })
      }
    },
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  )

  handler.setInputAction(
    (m: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      const p = pickGround(m.endPosition)
      if (p) cursor = p
    },
    Cesium.ScreenSpaceEventType.MOUSE_MOVE,
  )

  handler.setInputAction(() => finish(), Cesium.ScreenSpaceEventType.RIGHT_CLICK)
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
      @reset="resetView"
      @fullscreen="toggleFullscreen"
    />
    <div class="panel">
      <div class="tip">{{ tip }}</div>
      <div class="row">
        <span class="count">顶点：{{ count }}</span>
        <button class="clear-btn" @click="clearAll">清除</button>
      </div>
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
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(17, 24, 34, 0.88);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  font-size: 13px;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.count {
  color: #8b9aab;
  font-size: 12px;
}
.clear-btn {
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.6);
  background: transparent;
  color: #d7e2ee;
  font-size: 12px;
  cursor: pointer;
}
.clear-btn:hover {
  border-color: #4f9dff;
  color: #4f9dff;
}
</style>
