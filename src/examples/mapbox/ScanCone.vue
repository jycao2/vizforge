<script setup lang="ts">
/**
 * 扫描光锥（雷达 / 探照灯效果）
 * ===========================================================================
 * 一块绕中心匀速旋转的扇形。三部分叠出来：
 *
 *   · 地面扇面：低透明度填充，交代「扫过的范围」；
 *   · 体光锥：同一份扇形再拉伸 90m 做 fill-extrusion，半透明青色 ——
 *     这是「光」的实体感来源，只有地面涂层的话看起来是平面饼图；
 *   · 刻度圈 + 中心光点：给场景一个「仪表」的参照。
 *
 * 转身子是每帧重算 25 个顶点再 setData —— 这个量级完全没问题，
 * 但如果要做 10 个扫描器就该换成自定义图层（顶点着色器里传角度，一次都不用重传）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { GeoJSONSource, Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { MB_FONT } from './basemaps'
import { HOTSPOTS, circleRing, sector } from '@/examples/shared/screen'
import { addCanvasImage, createMap, radial, useMapboxView, useRaf, dimBasemap } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null

const CENTER = HOTSPOTS[0].center
const R_KM = 2.3

const HOME = { center: [CENTER[0] + 0.004, CENTER[1] - 0.012] as [number, number], zoom: 13.2, pitch: 55, bearing: 0 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const speed = ref(52) // 度/秒
const spread = ref(64) // 扇形张角
const height = ref(90) // 光锥高度（米）
const paused = ref(false)

/** 被扫描的 8 个目标点：扫到就变亮 */
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

function build() {
  if (!map) return
  addCanvasImage(map, 'scan-core', 96, radial(96, 'rgba(220,250,255,0.95)'))
  // 刻度圈（0.55R / 1R 两个虚线圆，给场景一个仪表参照）
  map.addSource('scan-rings', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [0.55, 1].map((k) => ({
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'LineString' as const, coordinates: circleRing(CENTER, R_KM * k, 96) },
      })),
    },
  })
  map.addLayer({
    id: 'scan-rings',
    type: 'line',
    source: 'scan-rings',
    paint: { 'line-color': '#5fd8ff', 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [3, 3] },
  })

  // 扇面（每帧重算）
  map.addSource('scan', {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [sector(CENTER, R_KM, 0, spread.value, 24)] },
    } as never,
  })
  map.addLayer({
    id: 'scan-ground',
    type: 'fill',
    source: 'scan',
    paint: { 'fill-color': '#4fe4ff', 'fill-opacity': 0.16 },
  })
  map.addLayer({
    id: 'scan-body',
    type: 'fill-extrusion',
    source: 'scan',
    paint: {
      'fill-extrusion-height': height.value,
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.17,
      'fill-extrusion-color': '#66ecff',
      'fill-extrusion-vertical-gradient': false,
    },
  })
  map.addLayer({
    id: 'scan-edge',
    type: 'line',
    source: 'scan',
    paint: { 'line-color': '#b6f6ff', 'line-width': 1.2, 'line-opacity': 0.8 },
  })

  // 目标点：常暗 + 命中变亮两层，用 filter 切换，避免每帧改颜色
  map.addSource('scan-targets', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: TARGETS.map((t) => ({
        type: 'Feature' as const,
        properties: { id: t.id, name: t.name },
        geometry: { type: 'Point' as const, coordinates: [t.lon, t.lat] },
      })),
    },
  })
  map.addLayer({
    id: 'target-dim',
    type: 'circle',
    source: 'scan-targets',
    paint: {
      'circle-radius': 3.2,
      'circle-color': '#2b6f96',
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(140,215,255,0.5)',
    },
  })
  map.addLayer({
    id: 'target-hit',
    type: 'circle',
    source: 'scan-targets',
    filter: ['==', ['get', 'id'], -1],
    paint: {
      'circle-radius': 5.4,
      'circle-color': '#ffd166',
      'circle-blur': 0.25,
      'circle-stroke-width': 1.2,
      'circle-stroke-color': '#fff6d8',
    },
  })

  // 中心光点 + 站名
  map.addSource('scan-center', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: CENTER } } as never,
  })
  map.addLayer({
    id: 'scan-center',
    type: 'symbol',
    source: 'scan-center',
    layout: { 'icon-image': 'scan-core', 'icon-size': 0.42, 'icon-allow-overlap': true },
    paint: { 'icon-opacity': 0.9 },
  })
  map.addLayer({
    id: 'scan-center-text',
    type: 'symbol',
    source: 'scan-center',
    layout: {
      'text-field': '监测站 · 滨江',
      'text-font': [MB_FONT],
      'text-size': 11,
      'text-offset': [0, 1.6],
      'text-anchor': 'top',
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#eaf8ff', 'text-halo-color': 'rgba(3,10,20,0.9)', 'text-halo-width': 1.5 },
  })
}

let angle = 0
let hitSig = ''
useRaf((dt) => {
  if (!map || paused.value) return
  const src = map.getSource('scan') as GeoJSONSource | undefined
  if (!src) return
  angle = (angle + dt * speed.value) % 360
  src.setData({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [sector(CENTER, R_KM, angle, spread.value, 24)] },
  } as never)

  // 命中判定：目标方位角是否落在 [angle, angle+spread] 内
  const hits = TARGETS.filter((t) => {
    const dx = (t.lon - CENTER[0]) * Math.cos((CENTER[1] * Math.PI) / 180)
    const dy = t.lat - CENTER[1]
    let a = (Math.atan2(dy, dx) * 180) / Math.PI
    if (a < 0) a += 360
    let d = (a - angle + 360) % 360
    return d <= spread.value
  }).map((t) => t.id)

  const sig = hits.join(',')
  if (sig !== hitSig) {
    hitSig = sig
    map.setFilter('target-hit', ['in', ['get', 'id'], ['literal', hits]] as never)
  }
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

function applyHeight() {
  map?.setPaintProperty('scan-body', 'fill-extrusion-height', height.value)
}
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>

    <div class="scr-overlay">
      <div class="scr-frame"><i></i><i></i><i></i><i></i></div>
      <div class="scr-top">
        <div class="scr-title">园区立体巡检</div>
        <div class="scr-sub">SCAN CONE · 3D SWEEP</div>
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
          <input v-model.number="height" type="range" min="20" max="260" step="10" @input="applyHeight" />
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

      <div class="scr-tip">扇形 polygon 每帧重算 25 个顶点 · 地面涂层 + fill-extrusion 体光锥 · 命中判定走方位角区间</div>
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
  width: 200px;
}
</style>
