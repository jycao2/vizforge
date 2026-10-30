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

const home = {
  destination: Cesium.Cartesian3.fromDegrees(105, 20, 26000000),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-90),
    roll: 0,
  },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

const RADIUS = 7000000 // 轨道半径 7000 km
const PERIOD = 5400 // 90 分钟（秒），这里压缩到 40 秒播放

interface OrbitSpec {
  name: string
  inclination: number // 度
  raan: number // 升交点赤经（度）
  color: Cesium.Color
  phase: number // 初始相位
}

const satellites: OrbitSpec[] = [
  { name: 'SAT-A', inclination: 51.6, raan: 0, color: Cesium.Color.CYAN, phase: 0 },
  { name: 'SAT-B', inclination: 51.6, raan: 120, color: Cesium.Color.ORANGE, phase: 0.35 },
  { name: 'SAT-C', inclination: 28.5, raan: 240, color: Cesium.Color.VIOLET, phase: 0.7 },
]

/** 由轨道参数计算 ECEF 坐标（简化二体圆轨道，忽略摄动） */
function orbitPoint(spec: OrbitSpec, angle: number): Cesium.Cartesian3 {
  const inc = Cesium.Math.toRadians(spec.inclination)
  const raan = Cesium.Math.toRadians(spec.raan)
  // 轨道平面内
  const px = RADIUS * Math.cos(angle)
  const py = RADIUS * Math.sin(angle)
  // 绕 X 轴倾斜
  const y1 = py * Math.cos(inc)
  const z1 = py * Math.sin(inc)
  // 绕 Z 轴旋转升交点赤经
  const x = px * Math.cos(raan) - y1 * Math.sin(raan)
  const y = px * Math.sin(raan) + y1 * Math.cos(raan)
  return new Cesium.Cartesian3(x, y, z1)
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  viewer.scene.globe.enableLighting = false
  viewer.camera.setView(home)

  const start = Cesium.JulianDate.now()
  const stop = Cesium.JulianDate.addSeconds(start, 40, new Cesium.JulianDate())
  viewer.clock.startTime = start.clone()
  viewer.clock.stopTime = stop.clone()
  viewer.clock.currentTime = start.clone()
  viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP
  viewer.clock.multiplier = 1
  viewer.clock.shouldAnimate = true

  for (const spec of satellites) {
    // 轨道线
    const orbitPositions: Cesium.Cartesian3[] = []
    const SEG = 180
    for (let i = 0; i <= SEG; i++) {
      orbitPositions.push(orbitPoint(spec, (i / SEG) * Math.PI * 2))
    }
    viewer.entities.add({
      polyline: {
        positions: orbitPositions,
        width: 1.6,
        material: spec.color.withAlpha(0.55),
      },
    })

    // 卫星位置（随时间采样）
    const position = new Cesium.SampledPositionProperty()
    const STEPS = 120
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS
      const angle = spec.phase * Math.PI * 2 + t * Math.PI * 2
      const time = Cesium.JulianDate.addSeconds(start, t * 40, new Cesium.JulianDate())
      position.addSample(time, orbitPoint(spec, angle))
    }

    viewer.entities.add({
      availability: new Cesium.TimeIntervalCollection([
        new Cesium.TimeInterval({ start, stop }),
      ]),
      position,
      point: {
        pixelSize: 10,
        color: spec.color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
      },
      label: {
        text: spec.name,
        font: '12px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -20),
        fillColor: spec.color,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.6),
      },
    })
  }
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
      <div class="title">三颗卫星 · 圆轨道（7000 km / 90 min）</div>
      <div class="hint">
        用 SampledPositionProperty 采样轨道位置，Clock 驱动卫星绕地运行；轨道线由轨道倾角与升交点赤经参数生成。
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
  width: 330px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.9);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
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
