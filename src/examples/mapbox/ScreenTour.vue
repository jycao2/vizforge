<script setup lang="ts">
/**
 * 视角巡航（大屏的「自动轮播」）
 * ===========================================================================
 * 大屏没人操作的时候不能停在那不动 —— 标准做法是几个机位轮流飞。
 *
 * 关键点：
 *   · 相机用 `flyTo`（内部是 van Wijk 平滑插值），不要自己 lerp 经纬度，
 *     否则跨尺度飞行会「先慢后快再猛停」，一眼假；
 *   · 飞行与停留用同一个 rAF 状态机推进（fly / dwell 两段），
 *     进度环直接读 t，不依赖 flyTo 的回调，切换机位时不会错拍；
 *   · 当前站点高亮走 setFilter（worker 侧过滤），不要重新 setData。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { MB_FONT } from './basemaps'
import { ZONES, nGon } from '@/examples/shared/screen'
import { addCanvasImage, createMap, dimBasemap, radial, useMapboxView, useRaf } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null

interface Stop {
  id: string
  name: string
  center: [number, number]
  zoom: number
  pitch: number
  bearing: number
  note: string
}

const STOPS: Stop[] = [
  { id: 'cbd', name: '中央商务区', center: [120.2145, 30.2452], zoom: 14.5, pitch: 62, bearing: -28, note: '楼宇能耗 / 人流密度' },
  { id: 'expo', name: '钱江世纪城', center: [120.2488, 30.2331], zoom: 14.2, pitch: 58, bearing: 42, note: '场馆客流 / 停车饱和度' },
  { id: 'binjiang', name: '滨江高新', center: [120.2085, 30.1902], zoom: 14.3, pitch: 61, bearing: 16, note: '园区设备 / 用能监测' },
  { id: 'westlake', name: '西湖景区', center: [120.1425, 30.2418], zoom: 13.8, pitch: 54, bearing: -74, note: '客流热力 / 水上安全' },
]

const FLY = 2.6 // 飞行秒数
const DWELL = 2.8 // 停留秒数

const HOME = {
  center: STOPS[0].center,
  zoom: STOPS[0].zoom,
  pitch: STOPS[0].pitch,
  bearing: STOPS[0].bearing,
}
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const auto = ref(true)
const idx = ref(0)
/** 当前阶段进度 0→1，进度环直接读它 */
const progress = ref(0)
let phase: 'fly' | 'dwell' = 'fly'
let t = 0

function build() {
  if (!map) return
  addCanvasImage(map, 'tour-core', 96, radial(96, 'rgba(210,245,255,0.95)'))

  map.addSource('tour-zone', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: ZONES.map((z) => ({
        type: 'Feature' as const,
        properties: { id: z.id, name: z.name, value: z.value },
        geometry: { type: 'Polygon' as const, coordinates: [nGon(z.center, z.radiusKm, 36, z.value)] },
      })),
    },
  })
  map.addLayer({
    id: 'tour-fill',
    type: 'fill',
    source: 'tour-zone',
    paint: { 'fill-color': '#4fc3ff', 'fill-opacity': 0.05 },
  })
  map.addLayer({
    id: 'tour-glow',
    type: 'line',
    source: 'tour-zone',
    paint: { 'line-color': '#7ce8ff', 'line-width': 8, 'line-blur': 7, 'line-opacity': 0.5 },
  })
  map.addLayer({
    id: 'tour-edge',
    type: 'line',
    source: 'tour-zone',
    paint: { 'line-color': '#c8f4ff', 'line-width': 1.4, 'line-opacity': 0.9 },
  })

  map.addSource('tour-poi', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: STOPS.map((s) => ({
        type: 'Feature' as const,
        properties: { id: s.id, name: s.name },
        geometry: { type: 'Point' as const, coordinates: s.center },
      })),
    },
  })
  map.addLayer({
    id: 'tour-beam',
    type: 'symbol',
    source: 'tour-poi',
    filter: ['==', ['get', 'id'], STOPS[0].id],
    layout: { 'icon-image': 'tour-core', 'icon-size': 0.5, 'icon-allow-overlap': true },
    paint: { 'icon-opacity': 0.85 },
  })
  map.addLayer({
    id: 'tour-name',
    type: 'symbol',
    source: 'tour-poi',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [MB_FONT],
      'text-size': 11.5,
      'text-offset': [0, 1.8],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#eaf8ff', 'text-halo-color': 'rgba(3,10,20,0.9)', 'text-halo-width': 1.5 },
  })

  highlight(STOPS[0].id)
}

function highlight(id: string) {
  if (!map) return
  map.setFilter('tour-beam', ['==', ['get', 'id'], id] as never)
  map.setFilter('tour-edge', ['==', ['get', 'id'], id] as never)
  map.setFilter('tour-glow', ['==', ['get', 'id'], id] as never)
}

function flyTo(i: number, instant = false) {
  idx.value = i
  t = 0
  phase = 'fly'
  progress.value = 0
  const s = STOPS[i]
  if (!map) return
  highlight(s.id)
  map.flyTo({
    center: s.center,
    zoom: s.zoom,
    pitch: s.pitch,
    bearing: s.bearing,
    duration: instant ? 0 : FLY * 1000,
    curve: 1.42,
    speed: 0.9,
    essential: true,
  })
}

useRaf((dt) => {
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
  // 停留结束前 0.6 秒就起飞，衔接更顺（flyTo 自己有起步缓动）
  if (t >= DWELL - 0.6) {
    flyTo((idx.value + 1) % STOPS.length)
  }
})

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  map.once('load', () => {
    dimBasemap(map!)
    build()
    flyTo(0, true)
  })
})
onBeforeUnmount(() => {
  map?.remove()
  map = null
})

const current = () => STOPS[idx.value]
const RING = 2 * Math.PI * 15
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>

    <div class="scr-overlay">
      <div class="scr-frame"><i></i><i></i><i></i><i></i></div>
      <div class="scr-top">
        <div class="scr-title">重点区域轮巡</div>
        <div class="scr-sub">CAMERA TOUR · AUTO PATROL</div>
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
            <b>{{ s.zoom.toFixed(1) }}z</b>
          </div>
        </div>
        <div class="scr-btn-row">
          <button class="scr-btn" :class="{ on: auto }" @click="auto = !auto">
            {{ auto ? '自动轮巡' : '已暂停' }}
          </button>
          <button class="scr-btn" @click="flyTo((idx + 1) % STOPS.length)">下一站</button>
        </div>
      </div>

      <!-- 右下角：当前站点 + 进度环 -->
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
            <div class="scr-num">{{ current().zoom.toFixed(1) }}<small>z</small></div>
            <div class="scr-label">缩放</div>
          </div>
          <div class="scr-kpi">
            <div class="scr-num">{{ Math.round(current().bearing) }}<small>°</small></div>
            <div class="scr-label">方位角</div>
          </div>
        </div>
      </div>

      <div class="scr-tip">flyTo 平滑插值 2.6s + 停留 2.8s · 进度环读 rAF 状态机，不依赖 flyTo 回调</div>
    </div>

    <MapControls
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
  </div>
</template>

<style scoped>
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
