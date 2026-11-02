<script setup lang="ts">
/**
 * 视角巡航（Cesium 版）
 * ===========================================================================
 * 大屏没人操作时不能停着不动 —— 几个机位轮流飞。
 *
 * Cesium 的 `camera.flyTo({ destination, orientation, duration })` 内部用的是
 * 专门的飞行插值（会算一条绕球的弧线并按弧长重参数化），比自己 lerp 经纬度
 * 自然得多，跨尺度时尤其明显。
 *
 * 状态机与 MapLibre 那版一致（fly → dwell → 下一站），区别只在：
 * 这里用 rAF 自己算 dt，而相机动画交给 Cesium；两者互不依赖，
 * 所以切站点、暂停、手动跳站都不会错拍。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'
import { applyScreenLook, glowLine, glowSprite, ringToPositions, screenHome } from './screenScene'
import { ZONES, nGon } from '@/examples/shared/screen'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

interface Stop {
  id: string
  name: string
  center: [number, number]
  range: number
  pitch: number
  heading: number
  note: string
}

const STOPS: Stop[] = [
  { id: 'cbd', name: '中央商务区', center: [120.2145, 30.2452], range: 2100, pitch: -42, heading: -28, note: '楼宇能耗 / 人流密度' },
  { id: 'expo', name: '钱江世纪城', center: [120.2488, 30.2331], range: 2300, pitch: -44, heading: 42, note: '场馆客流 / 停车饱和度' },
  { id: 'binjiang', name: '滨江高新', center: [120.2085, 30.1902], range: 2200, pitch: -41, heading: 16, note: '园区设备 / 用能监测' },
  { id: 'westlake', name: '西湖景区', center: [120.1425, 30.2418], range: 2900, pitch: -38, heading: -74, note: '客流热力 / 水上安全' },
]

const FLY = 2.6
const DWELL = 2.8

const HOME = screenHome(STOPS[0].center, STOPS[0].range, STOPS[0].pitch, STOPS[0].heading, 1400)
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => HOME,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

const auto = ref(true)
const idx = ref(0)
const progress = ref(0)

let phase: 'fly' | 'dwell' = 'fly'
let t = 0
let raf = 0
let last = 0

const highlights = new Map<string, Cesium.Entity[]>()

function setHighlight(id: string) {
  for (const [zid, list] of highlights) {
    const on = zid === id
    for (const e of list) e.show = on
  }
}

function flyTo(i: number, instant = false) {
  idx.value = i
  t = 0
  phase = 'fly'
  progress.value = 0
  const s = STOPS[i]
  setHighlight(s.id)
  if (!viewer) return
  const home = screenHome(s.center, s.range, s.pitch, s.heading, s.range / 2)
  viewer.camera.flyTo({
    destination: home.destination,
    orientation: home.orientation,
    duration: instant ? 0 : FLY,
  })
}

function tick(now: number) {
  raf = requestAnimationFrame(tick)
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
  last = now
  if (!auto.value) {
    progress.value = 1
    return
  }
  t += dt
  if (phase === 'fly') {
    progress.value = Math.min(1, t / FLY)
    if (t >= FLY) {
      phase = 'dwell'
      t = 0
    }
    return
  }
  progress.value = Math.min(1, t / DWELL)
  if (t >= DWELL - 0.6) flyTo((idx.value + 1) % STOPS.length)
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  const v = viewer
  applyBasemap(currentBasemap.value)
  applyScreenLook(v)
  v.camera.setView(HOME)

  // 每个片区：常暗底边 + 高亮描边（只显示当前这一组）
  const sprite = glowSprite(64)
  for (const z of ZONES) {
    const ring = nGon(z.center, z.radiusKm, 40, z.value)
    const dim = glowLine(v, ringToPositions(ring, 4), { color: '#2b7fa8', width: 1.6, glow: 0.15, alpha: 0.55 })
    const hot = glowLine(v, ringToPositions(ring, 6), { color: '#9fe8ff', width: 3.4, glow: 0.3 })
    hot.show = false
    highlights.set(z.id, [hot])
    void dim
  }
  for (const s of STOPS) {
    v.entities.add({
      position: Cesium.Cartesian3.fromDegrees(s.center[0], s.center[1], 60),
      billboard: { image: sprite, width: 34, height: 34, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    })
    v.entities.add({
      position: Cesium.Cartesian3.fromDegrees(s.center[0], s.center[1], 90),
      label: {
        text: s.name,
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
  }

  flyTo(0, true)
  raf = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  highlights.clear()
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})

const current = () => STOPS[idx.value]
const RING = 2 * Math.PI * 15
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>

    <div class="scr-overlay">
      <div class="scr-frame"><i></i><i></i><i></i><i></i></div>
      <div class="scr-top">
        <div class="scr-title">重点区域轮巡</div>
        <div class="scr-sub">CAMERA TOUR · CESIUM FLYTO</div>
      </div>

      <div class="scr-card left">
        <div class="scr-h">轮巡站点 <em>{{ idx + 1 }} / {{ STOPS.length }}</em></div>
        <div class="scr-list">
          <div
            v-for="(s, i) in STOPS"
            :key="s.id"
            class="scr-item stop"
            :class="{ active: i === idx }"
            @click="((auto = false), flyTo(i))"
          >
            <span>{{ i + 1 }}. {{ s.name }}</span>
            <b>{{ (s.range / 1000).toFixed(1) }}km</b>
          </div>
        </div>
        <div class="scr-btn-row">
          <button class="scr-btn" :class="{ on: auto }" @click="auto = !auto">
            {{ auto ? '自动轮巡' : '已暂停' }}
          </button>
          <button class="scr-btn" @click="flyTo((idx + 1) % STOPS.length)">下一站</button>
        </div>
      </div>

      <div class="scr-card right">
        <div class="scr-h">当前视角</div>
        <div class="focus">
          <svg class="ring" viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(120,200,255,0.18)" stroke-width="2" />
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="#6fe4ff"
              stroke-width="2"
              stroke-linecap="round"
              :stroke-dasharray="RING"
              :stroke-dashoffset="RING * (1 - progress)"
              transform="rotate(-90 18 18)"
            />
          </svg>
          <div class="focus-body">
            <div class="focus-name">{{ current().name }}</div>
            <div class="scr-label">{{ current().note }}</div>
          </div>
        </div>
        <div class="scr-kpi-row" style="margin-top: 10px">
          <div class="scr-kpi">
            <div class="scr-num">{{ (current().range / 1000).toFixed(1) }}<small>km</small></div>
            <div class="scr-label">视距</div>
          </div>
          <div class="scr-kpi">
            <div class="scr-num">{{ Math.round(current().heading) }}<small>°</small></div>
            <div class="scr-label">方位角</div>
          </div>
        </div>
      </div>

      <div class="scr-tip">camera.flyTo 自动算绕球弧线 · rAF 状态机只管进度环（fly 2.6s / dwell 2.8s）</div>
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
  width: 200px;
}
.right {
  top: 76px;
  right: 16px;
  width: 208px;
}
.stop {
  cursor: pointer;
  padding: 2px 4px;
  margin: 0 -4px;
  border-radius: 3px;
  transition: background 0.16s ease;
}
.stop:hover {
  background: rgba(90, 190, 255, 0.14);
}
.stop.active span {
  color: #9fe8ff;
  text-shadow: 0 0 10px rgba(90, 210, 255, 0.6);
}
.focus {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ring {
  width: 44px;
  height: 44px;
  flex: none;
  filter: drop-shadow(0 0 6px rgba(90, 200, 255, 0.5));
}
.focus-name {
  font-size: 14px;
  font-weight: 600;
  color: #eaf8ff;
  text-shadow: 0 0 12px rgba(80, 190, 255, 0.5);
}
</style>
