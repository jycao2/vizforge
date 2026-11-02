<script setup lang="ts">
/**
 * 扫描光锥（Cesium 版）
 * ===========================================================================
 * 一块绕站点旋转的扇形，两层叠出来：
 *
 *   · 地面扇面：贴地多边形，交代扫过的范围（半透明青色）；
 *   · 体光锥：同一个 hierarchy 加 extrudedHeight，就是立在空中的「光」。
 *
 * hierarchy 用 CallbackProperty 每帧现算 —— 26 个顶点，代价可以忽略。
 * 目标点是否被扫到，用方位角区间判断，命中就换 point 的颜色：
 * 这个判定放在 Python 一样的「逻辑层」里，比在着色器里做简单得多，
 * 而 8 个点的颜色更新也远没到需要 GPU 化的规模。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'
import { applyScreenLook, glowSprite, ringToPositions, screenHome } from './screenScene'
import { HOTSPOTS, circleRing, sector } from '@/examples/shared/screen'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const CENTER = HOTSPOTS[0].center
const R_KM = 2.3

const HOME = screenHome([CENTER[0] + 0.004, CENTER[1] - 0.012], 3600, -45, 0, 1700)
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => HOME,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

const speed = ref(52)
const spread = ref(64)
const height = ref(90)
const paused = ref(false)

const TARGETS = Array.from({ length: 8 }, (_, i) => {
  const a = (i / 8) * Math.PI * 2 + 0.4
  const r = R_KM * (0.42 + ((i * 37) % 50) / 100)
  return {
    id: i,
    lon: CENTER[0] + (r * Math.cos(a)) / (111.32 * Math.cos((CENTER[1] * Math.PI) / 180)),
    lat: CENTER[1] + (r * Math.sin(a)) / 110.574,
    name: `目标 ${String(i + 1).padStart(2, '0')}`,
  }
})

let angle = 0
let removeTick: (() => void) | null = null
const hitEntities: Cesium.Entity[] = []

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  const v = viewer
  applyBasemap(currentBasemap.value)
  applyScreenLook(v)
  v.camera.setView(HOME)

  // 刻度圈
  for (const k of [0.55, 1]) {
    v.entities.add({
      polyline: {
        positions: ringToPositions(circleRing(CENTER, R_KM * k, 96), 3),
        width: 1.4,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#5fd8ff').withAlpha(0.55),
          dashLength: 12,
        }),
      },
    })
  }

  // 扇面 + 体光锥：共用同一个 hierarchy 计算
  const sectorPositions = () => ringToPositions(sector(CENTER, R_KM, angle, spread.value, 24), 0)

  v.entities.add({
    polygon: {
      hierarchy: new Cesium.CallbackProperty(() => new Cesium.PolygonHierarchy(sectorPositions()), false),
      material: Cesium.Color.fromCssColorString('#4fe4ff').withAlpha(0.2),
      extrudedHeight: new Cesium.CallbackProperty(() => height.value, false),
      perPositionHeight: false,
    },
  })
  v.entities.add({
    polygon: {
      hierarchy: new Cesium.CallbackProperty(() => new Cesium.PolygonHierarchy(sectorPositions()), false),
      material: Cesium.Color.fromCssColorString('#9df2ff').withAlpha(0.3),
      height: 2,
    },
  })

  // 中心光点
  const sprite = glowSprite(64)
  v.entities.add({
    position: Cesium.Cartesian3.fromDegrees(CENTER[0], CENTER[1], 20),
    billboard: { image: sprite, width: 54, height: 54, disableDepthTestDistance: Number.POSITIVE_INFINITY },
  })
  v.entities.add({
    position: Cesium.Cartesian3.fromDegrees(CENTER[0], CENTER[1], 40),
    label: {
      text: '监测站 · 滨江',
      font: '600 13px "PingFang SC", "Microsoft YaHei", sans-serif',
      fillColor: Cesium.Color.fromCssColorString('#eaf8ff'),
      outlineColor: Cesium.Color.fromCssColorString('#03101f'),
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -18),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  })

  // 目标点
  for (const t of TARGETS) {
    hitEntities.push(
      v.entities.add({
        position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, 6),
        point: {
          pixelSize: 8,
          color: Cesium.Color.fromCssColorString('#2b6f96'),
          outlineColor: Cesium.Color.fromCssColorString('#8cd7ff').withAlpha(0.6),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    )
  }

  removeTick = v.clock.onTick.addEventListener(() => {
    if (paused.value) return
    angle = (angle + speed.value * 0.0167) % 360
    // 命中判定：目标方位角是否落在 [angle, angle+spread]
    TARGETS.forEach((t, i) => {
      const dx = (t.lon - CENTER[0]) * Math.cos((CENTER[1] * Math.PI) / 180)
      const dy = t.lat - CENTER[1]
      let a = (Math.atan2(dy, dx) * 180) / Math.PI
      if (a < 0) a += 360
      const hit = (a - angle + 360) % 360 <= spread.value
      const e = hitEntities[i]
      if (e?.point) {
        e.point.color = new Cesium.ConstantProperty(
          Cesium.Color.fromCssColorString(hit ? '#ffd166' : '#2b6f96'),
        )
        e.point.pixelSize = new Cesium.ConstantProperty(hit ? 12 : 8)
      }
    })
  })
})

onBeforeUnmount(() => {
  removeTick?.()
  removeTick = null
  hitEntities.length = 0
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>

    <div class="scr-overlay">
      <div class="scr-frame"><i></i><i></i><i></i><i></i></div>
      <div class="scr-top">
        <div class="scr-title">园区立体巡检</div>
        <div class="scr-sub">SCAN CONE · POLYGON EXTRUSION</div>
      </div>

      <div class="scr-card left">
        <div class="scr-h">扫描参数</div>
        <label class="scr-slider">
          <span>转速</span>
          <input v-model.number="speed" type="range" min="10" max="150" step="5" />
          <b>{{ speed }}°/s</b>
        </label>
        <label class="scr-slider">
          <span>张角</span>
          <input v-model.number="spread" type="range" min="20" max="120" step="5" />
          <b>{{ spread }}°</b>
        </label>
        <label class="scr-slider">
          <span>光锥高</span>
          <input v-model.number="height" type="range" min="20" max="260" step="10" />
          <b>{{ height }}m</b>
        </label>
        <div class="scr-btn-row">
          <button class="scr-btn" :class="{ on: !paused }" @click="paused = !paused">
            {{ paused ? '继续' : '暂停' }}
          </button>
        </div>
      </div>

      <div class="scr-card right">
        <div class="scr-h">巡检目标 <em>扫到即高亮</em></div>
        <div class="scr-list">
          <div v-for="t in TARGETS.slice(0, 5)" :key="t.id" class="scr-item">
            <span>{{ t.name }}</span>
            <b>正常</b>
            <div class="scr-bar"><i style="width: 100%"></i></div>
          </div>
        </div>
      </div>

      <div class="scr-tip">hierarchy 用 CallbackProperty 每帧现算 26 个顶点 · extrudedHeight 出体光锥 · 命中判定走方位角区间</div>
    </div>

    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
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
.left {
  top: 76px;
  left: 16px;
  width: 214px;
}
.right {
  top: 76px;
  right: 16px;
  width: 200px;
}
</style>
