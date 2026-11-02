<script setup lang="ts">
/**
 * 三维数据柱（大屏「指标对比」的经典形态）
 * ===========================================================================
 * 柱子就是 fill-extrusion 的一个特例：底面是固定大小的方块，高度 = 指标 × 系数。
 * 三个要点：
 *
 *  1) 柱子要有「厚度感」：`fill-extrusion-vertical-gradient: true` 让侧壁从底部
 *     到顶部有个明暗过渡，否则一整根纯色柱子看起来像纸片；
 *  2) 入场动画不要重传数据：高度表达式写成 `['*', ['get','h'], factor]`，
 *     每帧只改 factor 一个数，500 根柱子也是零成本；
 *  3) 数值标注贴在地面上（柱子旁边）而不是柱顶 —— Mapbox 没有「离地标注」，
 *     硬要贴顶只能上 DOM Marker，还要按 pitch 反算像素偏移，得不偿失。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { MB_FONT } from './basemaps'
import { bars, easeOutCubic } from '@/examples/shared/screen'
import { createMap, useMapboxView, useRaf, dimBasemap } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null

const HOME = { center: [120.2245, 30.2425] as [number, number], zoom: 13.35, pitch: 58, bearing: 24 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const scale = ref(1)
const showValue = ref(true)
const BARS = bars()
const MAX = Math.max(...BARS.map((b) => b.value))

/** 入场进度 0→1；按「重播」时清零重跑 */
const grow = ref(0)
let replay = false

function colorByValue(): unknown[] {
  return [
    'step',
    ['get', 'v'],
    '#2b8bff',
    50,
    '#2fd3c0',
    70,
    '#ffd166',
    85,
    '#ff7a5c',
  ]
}

function build() {
  if (!map) return
  map.addSource('bar', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: BARS.map((b) => ({
        type: 'Feature' as const,
        properties: { v: b.value, h: (b.value / MAX) * 320, rank: b.value },
        geometry: { type: 'Polygon' as const, coordinates: [b.ring] },
      })),
    },
  })
  map.addLayer({
    id: 'bar',
    type: 'fill-extrusion',
    source: 'bar',
    paint: {
      'fill-extrusion-height': ['*', ['get', 'h'], 0],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.95,
      'fill-extrusion-color': colorByValue() as never,
      'fill-extrusion-vertical-gradient': true,
    },
  })

  // 柱底投影：一圈很淡的填充，让柱子「落」在地上而不是浮着
  map.addLayer({
    id: 'bar-foot',
    type: 'fill',
    source: 'bar',
    paint: { 'fill-color': '#4fc3ff', 'fill-opacity': 0.18, 'fill-outline-color': 'rgba(150,230,255,0.5)' },
  })

  map.addSource('bar-label', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: BARS.map((b) => ({
        type: 'Feature' as const,
        properties: { v: b.value },
        geometry: { type: 'Point' as const, coordinates: b.center },
      })),
    },
  })
  map.addLayer({
    id: 'bar-label',
    type: 'symbol',
    source: 'bar-label',
    layout: {
      'text-field': ['to-string', ['get', 'v']],
      'text-font': [MB_FONT],
      'text-size': 12,
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#eaf8ff',
      'text-halo-color': 'rgba(3,10,20,0.92)',
      'text-halo-width': 1.8,
    },
  })
}

function replayAnim() {
  grow.value = 0
  replay = true
}

useRaf((dt) => {
  if (!map || !map.getLayer('bar')) return
  if (grow.value < 1) grow.value = Math.min(1, grow.value + dt / 1.6)
  const f = easeOutCubic(grow.value) * scale.value
  map.setPaintProperty('bar', 'fill-extrusion-height', ['*', ['get', 'h'], f] as never)
  if (replay && grow.value >= 1) replay = false
})

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  map.once('load', () => {
  dimBasemap(map!)
  build()
})
})
onBeforeUnmount(() => {
  map?.remove()
  map = null
})

function toggleValue() {
  showValue.value = !showValue.value
  map?.setLayoutProperty('bar-label', 'visibility', showValue.value ? 'visible' : 'none')
}
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>

    <div class="scr-overlay">
      <div class="scr-frame"><i></i><i></i><i></i><i></i></div>
      <div class="scr-top">
        <div class="scr-title">区块指标对比</div>
        <div class="scr-sub">3D BAR · FILL-EXTRUSION</div>
      </div>

      <div class="scr-card left">
        <div class="scr-h">展示参数</div>
        <label class="scr-slider">
          <span>夸张倍数</span>
          <input v-model.number="scale" type="range" min="0.4" max="2.2" step="0.1" />
          <b>×{{ scale.toFixed(1) }}</b>
        </label>
        <div class="scr-btn-row">
          <button class="scr-btn" @click="replayAnim">重播入场</button>
          <button class="scr-btn" :class="{ on: showValue }" @click="toggleValue">数值标注</button>
        </div>
        <div class="scr-tip-inline">柱高 = 指标 / 最大值 × 320m，入场靠每帧改一个系数</div>
      </div>

      <div class="scr-card right">
        <div class="scr-h">指标 Top 5 <em>{{ BARS.length }} 根柱</em></div>
        <div class="scr-list">
          <div v-for="(b, i) in [...BARS].sort((a, c) => c.value - a.value).slice(0, 5)" :key="i" class="scr-item">
            <span>{{ i + 1 }}. {{ b.zone === 'cbd' ? '中央商务区' : b.zone === 'expo' ? '钱江世纪城' : '滨江高新' }}</span>
            <b>{{ b.value }}</b>
            <div class="scr-bar" :class="{ warn: b.value > 85 }"><i :style="{ width: `${b.value}%` }"></i></div>
          </div>
        </div>
      </div>

      <div class="scr-tip">12 根柱 · 按指标四档着色 · vertical-gradient 让侧壁有明暗过渡</div>
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
  width: 214px;
}
.right {
  top: 76px;
  right: 16px;
  width: 214px;
}
.scr-tip-inline {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(140, 180, 210, 0.85);
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
