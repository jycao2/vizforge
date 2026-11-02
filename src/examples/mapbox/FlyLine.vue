<script setup lang="ts">
/**
 * 飞线（OD 弧线 + 流动光带）
 * ===========================================================================
 * 最常见的"迁徙/调度"可视化。实现上有三个关键：
 *
 *  1) 弧线本身：屏幕上是直线会很呆，用二次贝塞尔在经纬度空间外推一个控制点
 *     （bezierArc，见 useMapbox.ts），拱起方向由南北向决定，视觉上统一在一侧；
 *  2) 流动光带：靠 `line-gradient`。它要求 source 开 `lineMetrics: true`，
 *     Mapbox 会为每条线算出 0~1 的沿线进度，然后就能用 gradient 的 stop
 *     把"亮的一段"沿路径推着走 —— 每帧只改一个 paint 属性，非常廉价；
 *  3) 底下的暗线 + 上面的亮带：两个图层叠同一份 source，暗线负责"路线"，
 *     亮带负责"流向"。
 *
 * 弧线的颜色按起点的数值分级；点击某条线弹出 OD 详情。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { CITIES, fc, feat } from './data'
import { bezierArc, createMap, radial, addCanvasImage, useMapboxView, useRaf } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const speed = ref(0.35)
let map: MbMap | null = null
let popup: maplibregl.Popup | null = null

const HOME = { center: [113.6, 32.4] as [number, number], zoom: 3.9, pitch: 42 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** 终点集合：都往北京/上海/广深汇聚，形成放射状 OD */
const HUBS = ['北京', '上海', '深圳']
const ODS: Array<{ from: string; to: string; v: number }> = []
CITIES.forEach((c, i) => {
  if (HUBS.includes(c.name)) return
  ODS.push({ from: c.name, to: HUBS[i % HUBS.length], v: Math.round(20 + ((i * 37) % 80)) })
})

function coord(name: string): [number, number] {
  return (CITIES.find((c) => c.name === name) ?? CITIES[0]).c
}

function buildData(): GeoJSON.FeatureCollection {
  return fc(
    ODS.map((o) =>
      feat(
        { type: 'LineString', coordinates: bezierArc(coord(o.from), coord(o.to), 0.22, 72) },
        { from: o.from, to: o.to, v: o.v },
      ),
    ),
  )
}

function build() {
  if (!map) return
  addCanvasImage(map, 'glow', 64, radial(64, 'rgba(255,255,255,0.95)'))

  map.addSource('od', { type: 'geojson', data: buildData(), lineMetrics: true })

  // 底层暗线：常驻，表示"有这条联系"
  map.addLayer({
    id: 'od-base',
    type: 'line',
    source: 'od',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'match',
        ['get', 'to'],
        '北京',
        '#ff6b6b',
        '上海',
        '#4f9dff',
        '#ffd166',
      ],
      'line-width': 1.1,
      'line-opacity': 0.28,
    },
  })

  // 流动的亮带：line-gradient 的 stop 每帧往前挪
  map.addLayer({
    id: 'od-flow',
    type: 'line',
    source: 'od',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['get', 'v'], 20, 1.6, 100, 4.2],
      'line-gradient': gradient(0),
      'line-blur': 0.6,
    },
  })

  // 端点
  map.addSource('nodes', {
    type: 'geojson',
    data: fc(
      CITIES.map((c) =>
        feat({ type: 'Point', coordinates: c.c }, { name: c.name, v: c.v }),
      ),
    ),
  })
  map.addLayer({
    id: 'nodes-glow',
    type: 'symbol',
    source: 'nodes',
    layout: {
      'icon-image': 'glow',
      'icon-size': ['interpolate', ['linear'], ['get', 'v'], 20, 0.12, 100, 0.42],
      'icon-allow-overlap': true,
    },
    paint: { 'icon-opacity': 0.55 },
  })
  map.addLayer({
    id: 'nodes-text',
    type: 'symbol',
    source: 'nodes',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [MB_FONT],
      'text-size': 11.5,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
    },
    paint: {
      'text-color': '#eaf2fb',
      'text-halo-color': 'rgba(6,12,22,0.9)',
      'text-halo-width': 1.4,
    },
  })

  map.on('click', 'od-base', (e) => {
    const p = e.features?.[0]?.properties
    if (!p || !map) return
    popup
      ?.setLngLat(e.lngLat)
      .setHTML(
        `<div class="mb-pop-title">${p.from} → ${p.to}</div>` +
          `<div class="mb-pop-row"><span>流量</span><b>${p.v}</b></div>`,
      )
      .addTo(map)
  })
  map.on('mouseenter', 'od-base', () => {
    if (map) map.getCanvas().style.cursor = 'pointer'
  })
  map.on('mouseleave', 'od-base', () => {
    if (map) map.getCanvas().style.cursor = ''
  })

  popup = new maplibregl.Popup({ closeButton: false, offset: 10, maxWidth: '220px' })
}

/**
 * 光带渐变：把 [head-tail, head] 这一段设成高亮色，其余透明。
 * head 每帧前进，就形成"一颗光点沿线跑"的效果。
 */
function gradient(head: number): maplibregl.ExpressionSpecification {
  // 上限 0.97：保证 h + 0.02 严格小于结尾的 1，stop 顺序才合法
  const h = Math.max(0.001, Math.min(0.97, head))
  const t0 = Math.max(0, h - 0.16)
  const t1 = t0 + (h - t0) * 0.3 // 前导渐亮段，保证严格落在 (t0, h) 内
  const stops: unknown[] = ['interpolate', ['linear'], ['line-progress']]
  // interpolate 的 stop 必须严格递增：t0 为 0 时不能再塞一个 0
  if (t0 > 0) stops.push(0, 'rgba(255,255,255,0)')
  stops.push(t0, 'rgba(255,255,255,0)', t1, 'rgba(255,255,255,0.35)', h, '#ffffff')
  if (h < 0.97) stops.push(h + 0.02, 'rgba(255,255,255,0)')
  stops.push(1, 'rgba(255,255,255,0)')
  return stops as maplibregl.ExpressionSpecification
}

let t = 0
useRaf((dt) => {
  if (!map || !map.getLayer('od-flow')) return
  t = (t + dt * speed.value) % 1.25
  map.setPaintProperty('od-flow', 'line-gradient', gradient(Math.min(1, t)))
})

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
})

onBeforeUnmount(() => {
  popup?.remove()
  map?.remove()
  map = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>
    <MapControls
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="mb-panel ctrl">
      <h4>飞线</h4>
      <label class="mb-row">
        <span>速度</span>
        <input v-model.number="speed" type="range" min="0.05" max="1.2" step="0.05" />
        <b>{{ speed.toFixed(2) }}</b>
      </label>
      <div class="hint">{{ ODS.length }} 条 OD 弧 · line-gradient 逐帧推进</div>
    </div>
    <div class="mb-tip">点击弧线查看 OD 详情 · 光带靠 lineMetrics + line-gradient 实现</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 216px;
}
.mb-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
}
.mb-row input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: #4f9dff;
}
.mb-row b {
  width: 34px;
  text-align: right;
  color: #eaf2fb;
  font-variant-numeric: tabular-nums;
}
.hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
