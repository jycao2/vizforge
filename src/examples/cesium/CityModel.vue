<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 116.335 // 街区左下角
const LAT = 39.865
const GRID = 16 // 16 × 16 个街区
const STEP = 0.0018 // 街区中心间距（度，约 170 m）
const SIZE = 0.00115 // 单体建筑占地（度）
const buildings = GRID * GRID

// 街区中心
const CX = LON + (GRID * STEP) / 2
const CY = LAT + (GRID * STEP) / 2

const home = {
  // 相机放在街区南侧，俯角 42°，让整个街区落在画面中间
  destination: Cesium.Cartesian3.fromDegrees(CX, CY - 0.024, 2400),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-42),
    roll: 0,
  },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

/** 按建筑高度取色：低层青蓝 → 中层青绿 → 高层橙黄 → 超高层红 */
function heightColor(h: number): Cesium.Color {
  if (h > 240) return Cesium.Color.fromCssColorString('#ff7b72')
  if (h > 160) return Cesium.Color.fromCssColorString('#ffd166')
  if (h > 90) return Cesium.Color.fromCssColorString('#4ecdc4')
  return Cesium.Color.fromCssColorString('#3d7ea6')
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  viewer.scene.globe.enableLighting = false
  viewer.camera.setView(home)

  // 简易噪声：让少数几个区域自然形成「CBD 高楼群」
  const hotspots = [
    { x: 10, y: 6, r: 4 },
    { x: 5, y: 11, r: 3 },
    { x: 13, y: 12, r: 2.5 },
  ]

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const lon = LON + i * STEP
      const lat = LAT + j * STEP
      let boost = 0
      for (const spot of hotspots) {
        const d = Math.hypot(i - spot.x, j - spot.y)
        boost = Math.max(boost, Math.max(0, 1 - d / spot.r))
      }
      const h = Math.round(24 + boost * 230 + Math.random() * (30 + boost * 120))

      viewer!.entities.add({
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray([
            lon - SIZE / 2, lat - SIZE / 2,
            lon + SIZE / 2, lat - SIZE / 2,
            lon + SIZE / 2, lat + SIZE / 2,
            lon - SIZE / 2, lat + SIZE / 2,
          ]),
          extrudedHeight: h,
          height: 0,
          material: heightColor(h).withAlpha(0.92),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#0b1622').withAlpha(0.55),
        },
      })
    }
  }

  // 一条主干道示意：用贴地折线穿过街区
  viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([
        LON - 0.002, LAT + 8 * STEP,
        LON + GRID * STEP + 0.002, LAT + 8 * STEP,
      ]),
      width: 6,
      material: Cesium.Color.fromCssColorString('#3a4a5c').withAlpha(0.85),
      clampToGround: true,
    },
  })
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
      @update:model-value="applyBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="panel">
      <div class="title">城市白模 · {{ buildings }} 栋建筑</div>
      <div class="hint">
        用 PolygonGraphics 的 extrudedHeight 拉伸街区多边形，高度由中心热点衰减 + 随机生成，按高度分色，模拟 CBD 高楼群。
      </div>
      <div class="legend">
        <span class="bar"></span>
        <span class="legend-text">低 0 m</span>
        <span class="legend-text right">高 280 m+</span>
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
  width: 350px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e6eef7;
}
.hint {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.55;
  color: #8b9aab;
}
.legend {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(90deg, #3d7ea6, #4ecdc4, #ffd166, #ff7b72);
}
.legend-text {
  font-size: 10.5px;
  color: #7f8d9d;
  white-space: nowrap;
}
</style>
