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

const HUB: [number, number] = [116.391, 39.907]

const home = {
  // 接近俯视的机位：既能看到全国范围，又能保留飞线的立体弧度
  destination: Cesium.Cartesian3.fromDegrees(108, 26, 3800000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-78), roll: 0 },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

interface City {
  name: string
  lon: number
  lat: number
}

const CITIES: City[] = [
  { name: '上海', lon: 121.474, lat: 31.23 },
  { name: '广州', lon: 113.264, lat: 23.129 },
  { name: '成都', lon: 104.066, lat: 30.572 },
  { name: '乌鲁木齐', lon: 87.617, lat: 43.792 },
  { name: '哈尔滨', lon: 126.535, lat: 45.803 },
  { name: '昆明', lon: 102.833, lat: 24.88 },
  { name: '拉萨', lon: 91.14, lat: 29.645 },
  { name: '三亚', lon: 109.512, lat: 18.253 },
]

/** 两端点之间的抛物线：经纬度线性插值 + 正弦抬升，得到「飞线」弧线 */
function arcPoint(a: [number, number], b: [number, number], t: number, lift: number) {
  const lon = a[0] + (b[0] - a[0]) * t
  const lat = a[1] + (b[1] - a[1]) * t
  return Cesium.Cartesian3.fromDegrees(lon, lat, Math.sin(Math.PI * t) * lift)
}

function arcPositions(a: [number, number], b: [number, number], lift: number, seg = 72) {
  const out: Cesium.Cartesian3[] = []
  for (let i = 0; i <= seg; i++) out.push(arcPoint(a, b, i / seg, lift))
  return out
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  viewer.scene.globe.enableLighting = false
  viewer.camera.setView(home)
  viewer.clock.shouldAnimate = true

  const t0 = Cesium.JulianDate.now()

  // 中心点
  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(HUB[0], HUB[1], 0),
    point: {
      pixelSize: 12,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString('#4f9dff'),
      outlineWidth: 3,
    },
    label: {
      text: '北京 · 中心节点',
      font: '600 13px sans-serif',
      pixelOffset: new Cesium.Cartesian2(0, -22),
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#4f9dff').withAlpha(0.85),
      backgroundPadding: new Cesium.Cartesian2(8, 5),
    },
  })

  CITIES.forEach((city, idx) => {
    const dist = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(HUB[0], HUB[1]),
      Cesium.Cartesian3.fromDegrees(city.lon, city.lat),
    )
    const lift = 180000 + dist * 0.18
    const a: [number, number] = [HUB[0], HUB[1]]
    const b: [number, number] = [city.lon, city.lat]
    const duration = 2.6 + (idx % 4) * 0.5
    const offset = (idx / CITIES.length) * 1.0
    const color = Cesium.Color.fromCssColorString(idx % 2 ? '#4ecdc4' : '#4f9dff')

    // 弧线本体
    viewer!.entities.add({
      polyline: {
        positions: arcPositions(a, b, lift),
        width: 2,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.22,
          taperPower: 0.6,
          color: color.withAlpha(0.75),
        }),
      },
    })

    // 目标城市
    viewer!.entities.add({
      position: Cesium.Cartesian3.fromDegrees(city.lon, city.lat, 0),
      point: {
        pixelSize: 6,
        color,
        outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
        outlineWidth: 1,
      },
      label: {
        text: city.name,
        font: '12px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -18),
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
      },
    })

    // 沿弧线飞行的高亮光点：用 CallbackProperty 按时间取位置，无需手动逐帧更新
    viewer!.entities.add({
      position: new Cesium.CallbackPositionProperty(() => {
        const v = viewer
        if (!v) return Cesium.Cartesian3.fromDegrees(HUB[0], HUB[1])
        const sec = Cesium.JulianDate.secondsDifference(v.clock.currentTime, t0)
        const t = (sec / duration + offset) % 1
        return arcPoint(a, b, t, lift)
      }, false),
      point: {
        pixelSize: 9,
        color: Cesium.Color.WHITE,
        outlineColor: color,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
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
      <div class="title">OD 飞线 · 北京 → 8 城市</div>
      <div class="hint">
        两端点经纬度线性插值 + sin(πt) 抬升得到弧线，PolylineGlowMaterial 发光；光点位置由
        CallbackProperty 按 clock 时间解算，无需手写逐帧更新。
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
  width: 340px;
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
</style>
