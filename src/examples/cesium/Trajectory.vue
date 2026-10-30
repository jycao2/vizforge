<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const playing = ref(true)
const speed = ref(1)
const progress = ref(0)

let viewer: Cesium.Viewer | null = null
let startTime: Cesium.JulianDate | null = null
let tickListener: (() => void) | null = null

const LON = 116.391
const LAT = 39.907
const DURATION = 60 // 秒

const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.14, 30000),
  orientation: {
    heading: Cesium.Math.toRadians(0),
    pitch: Cesium.Math.toRadians(-52),
    roll: 0,
  },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer)

/** 生成一条绕城飞行的闭合航线（半径与高度做周期变化，视觉更立体） */
function buildRoute(count: number): Cesium.Cartesian3[] {
  const points: Cesium.Cartesian3[] = []
  for (let i = 0; i <= count; i++) {
    const t = i / count
    const angle = t * Math.PI * 2
    const r = 0.045 * (1 + 0.22 * Math.sin(angle * 3))
    const lon = LON + r * Math.cos(angle)
    const lat = LAT + r * Math.sin(angle) * 0.72
    const height = 1500 + 800 * Math.sin(angle * 2)
    points.push(Cesium.Cartesian3.fromDegrees(lon, lat, height))
  }
  return points
}

function syncProgress() {
  if (!viewer || !startTime) return
  const s = Cesium.JulianDate.secondsDifference(viewer.clock.currentTime, startTime)
  progress.value = Math.min(100, Math.max(0, (s / DURATION) * 100))
}

function togglePlay() {
  if (!viewer) return
  playing.value = !playing.value
  viewer.clock.shouldAnimate = playing.value
}

function cycleSpeed() {
  const next = speed.value === 1 ? 4 : speed.value === 4 ? 16 : 1
  speed.value = next
  if (viewer) viewer.clock.multiplier = next
}

function replay() {
  if (!viewer || !startTime) return
  viewer.clock.currentTime = Cesium.JulianDate.clone(startTime)
  playing.value = true
  viewer.clock.shouldAnimate = true
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)

  const start = Cesium.JulianDate.fromDate(new Date())
  const stop = Cesium.JulianDate.addSeconds(start, DURATION, new Cesium.JulianDate())
  startTime = start

  viewer.clock.startTime = start.clone()
  viewer.clock.stopTime = stop.clone()
  viewer.clock.currentTime = start.clone()
  viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP
  viewer.clock.multiplier = speed.value
  viewer.clock.shouldAnimate = true

  // 采样位置属性：让实体沿航线随时间移动
  const route = buildRoute(180)
  const position = new Cesium.SampledPositionProperty()
  route.forEach((p, i) => {
    const t = Cesium.JulianDate.addSeconds(start, (i / (route.length - 1)) * DURATION, new Cesium.JulianDate())
    position.addSample(t, p)
  })

  viewer.entities.add({
    availability: new Cesium.TimeIntervalCollection([
      new Cesium.TimeInterval({ start, stop }),
    ]),
    position,
    orientation: new Cesium.VelocityOrientationProperty(position),
    point: {
      pixelSize: 12,
      color: Cesium.Color.CYAN,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
    },
    label: {
      text: 'UAV-01',
      font: '13px sans-serif',
      pixelOffset: new Cesium.Cartesian2(0, -24),
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    },
    path: {
      resolution: 120,
      width: 5,
      material: new Cesium.PolylineGlowMaterialProperty({
        color: Cesium.Color.CYAN,
        glowPower: 0.28,
      }),
    },
  })

  tickListener = () => syncProgress()
  viewer.clock.onTick.addEventListener(tickListener)

  viewer.camera.setView(home)
})

onBeforeUnmount(() => {
  if (viewer && tickListener) viewer.clock.onTick.removeEventListener(tickListener)
  tickListener = null
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
      <div class="row">
        <button class="btn primary" @click="togglePlay">{{ playing ? '暂停' : '播放' }}</button>
        <button class="btn" @click="cycleSpeed">{{ speed }}× 速度</button>
        <button class="btn" @click="replay">重播</button>
      </div>
      <div class="bar">
        <div class="bar-inner" :style="{ width: progress + '%' }"></div>
      </div>
      <div class="hint">SampledPositionProperty + Path：实体沿航线移动并留下发光轨迹，循环播放。</div>
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
  gap: 8px;
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
.btn.primary {
  background: #4f9dff;
  border-color: #4f9dff;
  color: #fff;
}
.bar {
  margin-top: 9px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}
.bar-inner {
  height: 100%;
  background: linear-gradient(90deg, #4f9dff, #7ee787);
  transition: width 0.1s linear;
}
.hint {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
