<script setup lang="ts">
/**
 * 大屏总览 · 城市运营（MapLibre 版）
 * ===========================================================================
 * 大屏 3D 地图的「标准答案」，把之前几个示例的手段拼成一屏：
 *
 *  1) 机位：pitch 55°~60° + 固定 bearing。这个角度是 2.5D 的甜点 ——
 *     既能看到楼块立面，又不会因为太斜把远处的瓦片糊掉；
 *  2) 楼块：fill-extrusion 一次拉起数百栋，颜色按楼高插值（低矮偏深蓝、超高层偏青），
 *     远景自然堆出天际线；
 *  3) 片区：填充压到 5% + 两层描边（宽而模糊的当辉光、细而亮的当实线）；
 *  4) 飞线：同一份 source 上叠「暗线 + line-gradient 流动亮带」；
 *  5) HUD：标题条 / 四角装饰 / 左右数据卡 / 底部说明，纯 DOM 叠在 canvas 上 ——
 *     大屏的信息层永远是 HTML，不要让引擎去画字。
 *
 * 自动巡航每帧只改 bearing，不做 flyTo：连续动画用 jumpTo 才不会互相排队。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { MB_FONT } from './basemaps'
import { ZONES, ODS, buildings, nGon, countUp, fmt } from '@/examples/shared/screen'
import {
  addCanvasImage,
  bezierArc,
  createMap,
  flowGradient,
  radial,
  useMapboxView,
  useRaf,
  dimBasemap,
} from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null

const HOME = { center: [120.214, 30.2385] as [number, number], zoom: 13.15, pitch: 57, bearing: -17 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const rotate = ref(true)
const showFlow = ref(true)

/** 100 秒跑完一圈，够慢才像「监控」，快了像在转盘 */
const BEARING_SPEED = 3.6 // 度/秒

const zoneOf = (id: string) => ZONES.find((z) => z.id === id)!
const BUILDINGS = buildings()

const POINTS = 1_284_637
const kpis = computed(() => [
  { label: '在线设备', value: 8642, unit: '台' },
  { label: '今日告警', value: 37, unit: '条' },
  { label: '平均响应', value: 42, unit: '秒' },
  { label: '在线率', value: 99, unit: '%' },
])
/** KPI 入场的滚动进度 0→1 */
const bootT = ref(0)

function build() {
  if (!map) return
  const m = map

  addCanvasImage(m, 'scr-glow', 96, radial(96, 'rgba(190,240,255,0.95)'))

  /* ---------- 楼块 ---------- */
  m.addSource('bld', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: BUILDINGS.map((b) => ({
        type: 'Feature' as const,
        properties: { h: b.height },
        geometry: { type: 'Polygon' as const, coordinates: [b.ring] },
      })),
    },
  })
  m.addLayer({
    id: 'bld',
    type: 'fill-extrusion',
    source: 'bld',
    paint: {
      'fill-extrusion-height': ['get', 'h'],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.92,
      // 低矮楼偏深蓝、超高层偏青：高度本身成了第二层信息
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['get', 'h'],
        20,
        '#123049',
        60,
        '#1c4a6e',
        120,
        '#2f7ba8',
        200,
        '#63c4e8',
      ],
    },
  })

  /* ---------- 片区填充 + 双层描边 ---------- */
  m.addSource('zone', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: ZONES.map((z) => ({
        type: 'Feature' as const,
        properties: { name: z.name, value: z.value },
        geometry: { type: 'Polygon' as const, coordinates: [nGon(z.center, z.radiusKm, 36, z.value)] },
      })),
    },
  })
  m.addLayer({
    id: 'zone-fill',
    type: 'fill',
    source: 'zone',
    paint: {
      'fill-color': '#4fc3ff',
      'fill-opacity': ['interpolate', ['linear'], ['get', 'value'], 30, 0.02, 100, 0.085],
    },
  })
  // 宽而模糊的一层当辉光，窄而亮的一层当实线 —— 两层的成本远低于后期 bloom
  m.addLayer({
    id: 'zone-glow',
    type: 'line',
    source: 'zone',
    paint: { 'line-color': '#57d6ff', 'line-width': 7, 'line-blur': 6, 'line-opacity': 0.55 },
  })
  m.addLayer({
    id: 'zone-edge',
    type: 'line',
    source: 'zone',
    paint: { 'line-color': '#a9ecff', 'line-width': 1.4, 'line-opacity': 0.95 },
  })

  /* ---------- 飞线 ---------- */
  m.addSource('od', {
    type: 'geojson',
    lineMetrics: true,
    data: {
      type: 'FeatureCollection',
      features: ODS.map((o) => ({
        type: 'Feature' as const,
        properties: { v: o.v },
        geometry: {
          type: 'LineString' as const,
          coordinates: bezierArc(zoneOf(o.from).center, zoneOf(o.to).center, 0.3, 64),
        },
      })),
    },
  })
  m.addLayer({
    id: 'od-base',
    type: 'line',
    source: 'od',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#3f9fd8',
      'line-width': ['interpolate', ['linear'], ['get', 'v'], 40, 0.8, 100, 1.9],
      'line-opacity': 0.22,
    },
  })
  m.addLayer({
    id: 'od-flow',
    type: 'line',
    source: 'od',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['get', 'v'], 40, 1.6, 100, 3.4],
      'line-gradient': flowGradient(0, '#e8faff'),
      'line-blur': 1.1,
    },
  })

  /* ---------- 片区名 + 数值 ---------- */
  m.addSource('zone-label', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: ZONES.map((z) => ({
        type: 'Feature' as const,
        properties: { name: z.name, value: z.value },
        geometry: { type: 'Point' as const, coordinates: z.center },
      })),
    },
  })
  m.addLayer({
    id: 'zone-dot',
    type: 'symbol',
    source: 'zone-label',
    layout: { 'icon-image': 'scr-glow', 'icon-size': 0.22, 'icon-allow-overlap': true },
    paint: { 'icon-opacity': 0.9 },
  })
  m.addLayer({
    id: 'zone-text',
    type: 'symbol',
    source: 'zone-label',
    layout: {
      'text-field': ['concat', ['get', 'name'], '  ', ['to-string', ['get', 'value']], '%'],
      'text-font': [MB_FONT],
      'text-size': 11.5,
      'text-offset': [0, 1.15],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#dff2ff',
      'text-halo-color': 'rgba(4,12,22,0.92)',
      'text-halo-width': 1.6,
    },
  })
}

let bearing: number | null = null
let flowT = 0
useRaf((dt) => {
  if (!map) return
  // KPI 入场：1.1 秒滚完，只跑一次
  if (bootT.value < 1) bootT.value = Math.min(1, bootT.value + dt / 1.1)
  if (rotate.value) {
    bearing = (bearing ?? map.getBearing()) + dt * BEARING_SPEED
    map.jumpTo({ bearing })
  } else {
    bearing = null
  }
  if (showFlow.value && map.getLayer('od-flow')) {
    flowT = (flowT + dt * 0.42) % 1.25
    map.setPaintProperty('od-flow', 'line-gradient', flowGradient(Math.min(1, flowT), '#e8faff'))
  }
})

function toggleFlow() {
  showFlow.value = !showFlow.value
  if (!map?.getLayer('od-flow')) return
  map.setLayoutProperty('od-flow', 'visibility', showFlow.value ? 'visible' : 'none')
}

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
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>

    <div class="scr-overlay">
      <div class="scr-frame"><i></i><i></i><i></i><i></i></div>

      <div class="scr-top">
        <div class="scr-title">城市运行监测大屏</div>
        <div class="scr-sub">URBAN OPERATION · REAL-TIME TWIN</div>
      </div>

      <!-- 左：KPI + 片区排名 -->
      <div class="scr-card left">
        <div class="scr-h">运行总览 <em class="scr-live">LIVE</em></div>
        <div class="scr-kpi-row">
          <div v-for="k in kpis" :key="k.label" class="scr-kpi">
            <div class="scr-num">{{ countUp(k.value, bootT) }}<small>{{ k.unit }}</small></div>
            <div class="scr-label">{{ k.label }}</div>
          </div>
        </div>
        <div class="scr-h" style="margin-top: 11px">片区负荷</div>
        <div class="scr-list">
          <div v-for="z in ZONES" :key="z.id" class="scr-item">
            <span>{{ z.name }}</span>
            <b>{{ z.value }}%</b>
            <div class="scr-bar" :class="{ warn: z.value > 90 }">
              <i :style="{ width: `${countUp(z.value, bootT)}%` }"></i>
            </div>
          </div>
        </div>
      </div>

      <!-- 右：告警 + 控制 -->
      <div class="scr-card right">
        <div class="scr-h">实时告警 <em>{{ 37 }} 条</em></div>
        <div class="scr-list">
          <div class="scr-item">
            <span>滨江·泵站液位超限</span>
            <b style="color: #ffb0a0">19:42</b>
          </div>
          <div class="scr-item">
            <span>CBD·能耗环比 +18%</span>
            <b style="color: #ffd08a">19:38</b>
          </div>
          <div class="scr-item">
            <span>九堡·摄像头离线 3 台</span>
            <b style="color: #a9c4dc">19:31</b>
          </div>
        </div>
        <div class="scr-h" style="margin-top: 11px">
          控制 <em>共 {{ fmt(POINTS) }} 点位</em>
        </div>
        <div class="scr-btn-row">
          <button class="scr-btn" :class="{ on: rotate }" @click="rotate = !rotate">自动巡航</button>
          <button class="scr-btn" :class="{ on: showFlow }" @click="toggleFlow">飞线光带</button>
        </div>
      </div>

      <div class="scr-tip">
        {{ BUILDINGS.length }} 栋楼块 · fill-extrusion 按楼高着色 · 片区双层描边当辉光 · 飞线 line-gradient 逐帧推进
      </div>
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
  top: 74px;
  left: 16px;
  width: 208px;
}
.right {
  top: 74px;
  right: 16px;
  width: 208px;
}
</style>
