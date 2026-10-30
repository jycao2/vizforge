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

const LON = 116.391
const LAT = 39.907
const MAX_R = 60000 // 扫描半径 60 km
const RING_DURATION = 2600 // 单圈扩散时长 ms
const SWEEP_SPEED = 72 // 每秒转过的角度

const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.42, 130000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-52), roll: 0 },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

/** 按方位角与距离求目标点经纬度（球面公式） */
function destination(lon: number, lat: number, dist: number, bearingDeg: number): [number, number] {
  const R = 6371000
  const d = dist / R
  const brng = Cesium.Math.toRadians(bearingDeg)
  const lat1 = Cesium.Math.toRadians(lat)
  const lon1 = Cesium.Math.toRadians(lon)
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
  )
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    )
  return [Cesium.Math.toDegrees(lon2), Cesium.Math.toDegrees(lat2)]
}

const TARGETS = [
  { name: '目标 A', dist: 18000, bearing: 35 },
  { name: '目标 B', dist: 32000, bearing: 118 },
  { name: '目标 C', dist: 44000, bearing: 210 },
  { name: '目标 D', dist: 26000, bearing: 300 },
]

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  viewer.scene.globe.enableLighting = false
  viewer.camera.setView(home)
  viewer.clock.shouldAnimate = true

  const center = Cesium.Cartesian3.fromDegrees(LON, LAT)

  // 中心站点
  viewer.entities.add({
    position: center,
    point: {
      pixelSize: 10,
      color: Cesium.Color.fromCssColorString('#4ecdc4'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
    },
    label: {
      text: '雷达站',
      font: '12px sans-serif',
      pixelOffset: new Cesium.Cartesian2(0, -20),
      fillColor: Cesium.Color.fromCssColorString('#4ecdc4'),
      showBackground: true,
      backgroundColor: Cesium.Color.BLACK.withAlpha(0.6),
    },
  })

  // 扩散圆环统一用 clock 时间推进：同一个 time 求值结果一致，
  // 否则长轴/短轴两次采样可能落在不同毫秒上，Cesium 会报
  // 「semiMajorAxis must be greater than or equal to the semiMinorAxis」
  const t0 = Cesium.JulianDate.clone(viewer.clock.currentTime)
  const phaseOf = (time: Cesium.JulianDate | undefined, phase: number) => {
    const now = time ?? t0
    const sec = Cesium.JulianDate.secondsDifference(now, t0)
    return (sec / (RING_DURATION / 1000) + phase) % 1
  }

  for (let i = 0; i < 3; i++) {
    const phase = i / 3
    const radiusProp = new Cesium.CallbackProperty(
      (time?: Cesium.JulianDate) => Math.max(1, phaseOf(time, phase) * MAX_R),
      false,
    )
    const alphaProp = new Cesium.CallbackProperty(
      (time?: Cesium.JulianDate) =>
        Cesium.Color.fromCssColorString('#4ecdc4').withAlpha(
          Math.max(0, 0.55 * (1 - phaseOf(time, phase)) ** 1.6),
        ),
      false,
    )

    viewer.entities.add({
      position: center,
      ellipse: {
        semiMajorAxis: radiusProp,
        semiMinorAxis: radiusProp,
        height: 80,
        material: new Cesium.ColorMaterialProperty(alphaProp),
      },
    })
  }

  // 旋转扫描扇面 + 扫描线
  const sweep = viewer.entities.add({
    polygon: {
      hierarchy: new Cesium.CallbackProperty(() => {
        const heading = ((performance.now() / 1000) * SWEEP_SPEED) % 360
        const pts: Cesium.Cartesian3[] = [center]
        for (let a = 0; a <= 26; a++) {
          const [lon, lat] = destination(LON, LAT, MAX_R, heading - 26 + a)
          pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, 80))
        }
        return new Cesium.PolygonHierarchy(pts)
      }, false),
      material: new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(() => {
          const heading = ((performance.now() / 1000) * SWEEP_SPEED) % 360
          // 用角度做呼吸感，扇面本身半透明渐变由颜色叠层近似
          return Cesium.Color.fromCssColorString('#4ecdc4').withAlpha(
            0.18 + 0.08 * Math.sin(Cesium.Math.toRadians(heading * 2)),
          )
        }, false),
      ),
      classificationType: Cesium.ClassificationType.BOTH,
    },
  })

  viewer.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        const heading = ((performance.now() / 1000) * SWEEP_SPEED) % 360
        const [lon, lat] = destination(LON, LAT, MAX_R, heading)
        return [center, Cesium.Cartesian3.fromDegrees(lon, lat, 80)]
      }, false),
      width: 2,
      material: Cesium.Color.fromCssColorString('#7fe7d8').withAlpha(0.9),
      arcType: Cesium.ArcType.NONE,
    },
  })

  // 静态目标
  for (const t of TARGETS) {
    const [lon, lat] = destination(LON, LAT, t.dist, t.bearing)
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 120),
      point: {
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString('#ff7b72'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `${t.name} · ${(t.dist / 1000).toFixed(0)}km`,
        font: '11px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -18),
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#7a1f1f').withAlpha(0.75),
        backgroundPadding: new Cesium.Cartesian2(5, 3),
      },
    })
  }

  // 扇面用 classificationType 时不需要实体自身高度，这里防止被地球遮挡
  sweep.show = true
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
      <div class="title">雷达扫描 · 半径 60 km</div>
      <div class="hint">
        三个相位错开的圆环用 CallbackProperty 驱动半径与透明度；扫描扇面按方位角逐帧重算多边形顶点，形成旋转扫掠。
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
