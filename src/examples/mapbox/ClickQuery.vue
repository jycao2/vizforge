<script setup lang="ts">
/**
 * 要素查询与过滤
 * ===========================================================================
 * 数据进地图之后，最常见的两个操作是「筛」和「查」：
 *
 *  1) 过滤：`setFilter(id, expr)` —— 在样式层里按条件筛要素。
 *     注意过滤器走的是 worker 端索引，比自己 setData 重新传一遍数据快一个量级，
 *     而且不会打断正在进行的过渡动画；
 *  2) 查询：`queryRenderedFeatures(point, { layers })` —— 只返回**当前已渲染**
 *     且在给定屏幕范围的要素（可以传像素半径做"点附近"查询）；
 *     要查"数据全集里符合条件的"则用 `querySourceFeatures`。
 *
 * 本例：四类 POI + 一个数值阈值，复选框和滑块都直接翻译成 filter 表达式
 * （用 `all` 把多个条件 AND 起来），右侧实时显示命中条数。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap, FilterSpecification } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { CITIES, fc, feat, mulberry32 } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const kinds = ref<Record<string, boolean>>({ 学校: true, 医院: true, 商场: true, 地铁: true })
const minV = ref(20)
const hits = ref(0)
let map: MbMap | null = null
let popup: maplibregl.Popup | null = null
let selectedId: number | null = null

const HOME = { center: [120.15, 30.26] as [number, number], zoom: 11.6 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const TYPE_COLORS: Record<string, string> = {
  学校: '#4f9dff',
  医院: '#ff6b6b',
  商场: '#ffd166',
  地铁: '#5fd0a8',
}

/** 生成 220 个 POI，围绕城市中心散开 */
function buildData(): GeoJSON.FeatureCollection {
  const rnd = mulberry32(1234)
  const types = Object.keys(TYPE_COLORS)
  const out: GeoJSON.Feature[] = []
  for (let i = 0; i < 220; i++) {
    const c = CITIES[i % CITIES.length]
    const t = types[Math.floor(rnd() * types.length)]
    out.push(
      feat(
        {
          type: 'Point',
          coordinates: [
            c.c[0] + (rnd() - 0.5) * 1.6,
            c.c[1] + (rnd() - 0.5) * 1.2,
          ],
        },
        {
          id: i,
          name: `${t}-${1000 + i}`,
          kind: t,
          v: Math.round(10 + rnd() * 90),
        },
      ),
    )
  }
  return fc(out)
}

function filterExpr(): FilterSpecification {
  const on = Object.entries(kinds.value)
    .filter(([, v]) => v)
    .map(([k]) => k)
  return [
    'all',
    ['match', ['get', 'kind'], on.length ? on : ['__none__'], true, false],
    ['>=', ['get', 'v'], minV.value],
  ] as FilterSpecification
}

/** 文字图层单独一份：只显示数值更高的那批，避免小层级糊成一片 */
function textFilterExpr(): FilterSpecification {
  const on = Object.entries(kinds.value)
    .filter(([, v]) => v)
    .map(([k]) => k)
  return [
    'all',
    ['match', ['get', 'kind'], on.length ? on : ['__none__'], true, false],
    ['>=', ['get', 'v'], Math.max(70, minV.value)],
  ] as FilterSpecification
}

function build() {
  if (!map) return
  map.addSource('poi', { type: 'geojson', data: buildData(), generateId: true })

  map.addLayer({
    id: 'poi',
    type: 'circle',
    source: 'poi',
    paint: {
      'circle-radius': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        11,
        ['interpolate', ['linear'], ['get', 'v'], 10, 3.5, 100, 9],
      ],
      'circle-color': ['match', ['get', 'kind'], '学校', TYPE_COLORS['学校'], '医院', TYPE_COLORS['医院'], '商场', TYPE_COLORS['商场'], TYPE_COLORS['地铁']],
      'circle-opacity': 0.9,
      'circle-stroke-width': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        3,
        1,
      ],
      'circle-stroke-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],
        '#ffffff',
        'rgba(8,14,22,0.7)',
      ],
    },
  })
  map.addLayer({
    id: 'poi-text',
    type: 'symbol',
    source: 'poi',
    minzoom: 12,
    filter: ['>=', ['get', 'v'], 70],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [MB_FONT],
      'text-size': 10.5,
      'text-offset': [0, 1],
      'text-anchor': 'top',
    },
    paint: { 'text-color': '#cddcec', 'text-halo-color': 'rgba(6,12,22,0.9)', 'text-halo-width': 1.2 },
  })

  // 点击查询：给点周围 6px 的容差，避免小圆点难点中
  map.on('click', (e) => {
    if (!map) return
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [e.point.x - 6, e.point.y - 6],
      [e.point.x + 6, e.point.y + 6],
    ]
    const fs = map.queryRenderedFeatures(box, { layers: ['poi'] })
    if (!fs.length) {
      clearSelect()
      return
    }
    const f = fs[0]
    const id = f.id as number
    if (selectedId !== null) {
      map.setFeatureState({ source: 'poi', id: selectedId }, { selected: false })
    }
    selectedId = id
    map.setFeatureState({ source: 'poi', id }, { selected: true })
    const p = f.properties ?? {}
    popup
      ?.setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number])
      .setHTML(
        `<div class="mb-pop-title">${p.name}</div>` +
          `<div class="mb-pop-row"><span>类别</span><b>${p.kind}</b></div>` +
          `<div class="mb-pop-row"><span>数值</span><b>${p.v}</b></div>`,
      )
      .addTo(map)
  })

  map.on('mouseenter', 'poi', () => {
    if (map) map.getCanvas().style.cursor = 'pointer'
  })
  map.on('mouseleave', 'poi', () => {
    if (map) map.getCanvas().style.cursor = ''
  })

  popup = new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '240px' })
  apply()
}

function clearSelect() {
  if (!map) return
  if (selectedId !== null) map.setFeatureState({ source: 'poi', id: selectedId }, { selected: false })
  selectedId = null
  popup?.remove()
}

function apply() {
  if (!map) return
  map.setFilter('poi', filterExpr())
  map.setFilter('poi-text', textFilterExpr())
  // querySourceFeatures 查的是"符合过滤条件的全部要素"，不受当前视口限制
  const n = map.querySourceFeatures('poi', { filter: filterExpr() }).length
  hits.value = n
}

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
      <h4>过滤条件</h4>
      <label v-for="(on, k) in kinds" :key="k" class="mb-row">
        <input v-model="kinds[k]" type="checkbox" @change="apply" />
        <i class="dot" :style="{ background: TYPE_COLORS[k] }"></i>
        <span>{{ k }}</span>
      </label>
      <label class="mb-row">
        <span>数值 ≥</span>
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          :value="minV"
          @input="minV = Number(($event.target as HTMLInputElement).value); apply()"
        />
        <b>{{ minV }}</b>
      </label>
      <div class="stat">命中 {{ hits }} / 220 条</div>
    </div>
    <div class="mb-tip">setFilter 走样式层索引 · queryRenderedFeatures 只查已渲染要素</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 220px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
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
  width: 26px;
  text-align: right;
  color: #eaf2fb;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.stat {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #eaf2fb;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
</style>
