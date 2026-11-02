<script setup lang="ts">
/**
 * 三维数据柱（Cesium 版）
 * ===========================================================================
 * Cesium 里做柱子有两条路：
 *
 *   · Entity + CylinderGeometry：一行搞定，且 length 可以是 CallbackProperty，
 *     入场生长、悬停变高都是白送的；
 *   · Primitive + CylinderGeometry：几百根柱子一次 draw call，但要自己管矩阵。
 *
 * 十几根柱子用 Entity 就够，代码短得多。唯一要记住的是：Cylinder 以「几何中心」
 * 定位，所以 position 的高度得写 length/2，否则柱子有一半埋在地下 ——
 * 高度又是逐帧变的，position 也只能一起用 CallbackProperty。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'
import { applyScreenLook, screenHome } from './screenScene'
import { bars, easeOutCubic } from '@/examples/shared/screen'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const HOME = screenHome([120.2245, 30.2425], 4300, -46, 24, 2000)
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => HOME,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

const BARS = bars()
const MAX = Math.max(...BARS.map((b) => b.value))
const scale = ref(1)
const grow = ref(0)

const ZONE_NAME: Record<string, string> = {
  cbd: '中央商务区',
  expo: '钱江世纪城',
  binjiang: '滨江高新',
}

function colorOf(v: number): Cesium.Color {
  if (v >= 85) return Cesium.Color.fromCssColorString('#ff7a5c')
  if (v >= 70) return Cesium.Color.fromCssColorString('#ffd166')
  if (v >= 50) return Cesium.Color.fromCssColorString('#2fd3c0')
  return Cesium.Color.fromCssColorString('#2b8bff')
}

/** 当前这一帧的柱高（米） */
function barHeight(v: number): number {
  return (v / MAX) * 320 * easeOutCubic(grow.value) * scale.value
}

let removeTick: (() => void) | null = null

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  const v = viewer
  applyBasemap(currentBasemap.value)
  applyScreenLook(v)
  v.camera.setView(HOME)

  BARS.forEach((b) => {
    const color = colorOf(b.value)
    const [lon, lat] = b.center
    v.entities.add({
      position: new Cesium.CallbackProperty(
        () => Cesium.Cartesian3.fromDegrees(lon, lat, barHeight(b.value) / 2),
        false,
      ) as unknown as Cesium.Cartesian3,
      cylinder: {
        length: new Cesium.CallbackProperty(() => Math.max(1, barHeight(b.value)), false),
        topRadius: 88,
        bottomRadius: 88,
        material: color.withAlpha(0.88),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#dff6ff').withAlpha(0.55),
        slices: 24,
      },
    })
    // 数值牌：跟着柱顶走，disableDepthTest 保证不被楼块挡住
    v.entities.add({
      position: new Cesium.CallbackProperty(
        () => Cesium.Cartesian3.fromDegrees(lon, lat, barHeight(b.value) + 60),
        false,
      ) as unknown as Cesium.Cartesian3,
      label: {
        text: String(b.value),
        font: '700 15px "SF Mono", "PingFang SC", monospace',
        fillColor: Cesium.Color.fromCssColorString('#eaf8ff'),
        outlineColor: Cesium.Color.fromCssColorString('#03101f'),
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  })

  // 入场：clock.onTick 推进进度，几何在 CallbackProperty 里读它
  removeTick = v.clock.onTick.addEventListener(() => {
    if (grow.value < 1) grow.value = Math.min(1, grow.value + 0.012)
  })
})

onBeforeUnmount(() => {
  removeTick?.()
  removeTick = null
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})

function replay() {
  grow.value = 0
}

const top5 = () => [...BARS].sort((a, b) => b.value - a.value).slice(0, 5)
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>

    <div class="scr-overlay">
      <div class="scr-frame"><i></i><i></i><i></i><i></i></div>
      <div class="scr-top">
        <div class="scr-title">区块指标对比</div>
        <div class="scr-sub">3D BAR · CYLINDER ENTITY</div>
      </div>

      <div class="scr-card left">
        <div class="scr-h">展示参数</div>
        <label class="scr-slider">
          <span>夸张倍数</span>
          <input v-model.number="scale" type="range" min="0.4" max="2.2" step="0.1" />
          <b>×{{ scale.toFixed(1) }}</b>
        </label>
        <div class="scr-btn-row">
          <button class="scr-btn" @click="replay">重播入场</button>
        </div>
        <div class="scr-note">
          柱高 = 指标 / 最大值 × 320m；生长靠 CallbackProperty 逐帧读进度
        </div>
      </div>

      <div class="scr-card right">
        <div class="scr-h">指标 Top 5 <em>{{ BARS.length }} 根柱</em></div>
        <div class="scr-list">
          <div v-for="(b, i) in top5()" :key="i" class="scr-item">
            <span>{{ i + 1 }}. {{ ZONE_NAME[b.zone] }}</span>
            <b>{{ b.value }}</b>
            <div class="scr-bar" :class="{ warn: b.value > 85 }"><i :style="{ width: `${b.value}%` }"></i></div>
          </div>
        </div>
      </div>

      <div class="scr-tip">Cylinder 以几何中心定位 → position 高度必须写 length/2，否则柱子一半埋在地下</div>
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
  width: 214px;
}
.scr-note {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(140, 180, 210, 0.85);
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
