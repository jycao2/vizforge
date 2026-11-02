<script setup lang="ts">
/**
 * GeoJSON 图层
 * ===========================================================================
 * Mapbox 的核心数据模型：一切要素都是 GeoJSON source + 图层样式。
 * 本例用一份内联 GeoJSON（杭州西湖一带：面 / 线 / 点三类几何）演示：
 *
 *  - 一个 source 可以喂给多个图层，靠 `filter` 按几何类型或属性分流；
 *  - 面：fill + line 两个图层配合（fill 只填充不描边，描边要单独一层 line）；
 *  - 线：line-width 用 zoom 插值，放大时变粗；
 *  - 点：circle + symbol 双图层，点带文字；
 *  - 属性读取统一走 `['get', '字段名']`，这是 Mapbox 表达式里最常用的取值方式。
 *
 * 真实项目里把 `data` 换成后端接口返回的 GeoJSON 即可，其余代码不用动。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { fc, feat, mulberry32, ring } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const picked = ref<Record<string, unknown> | null>(null)
let map: MbMap | null = null
let popup: maplibregl.Popup | null = null

const HOME = { center: [120.148, 30.252] as [number, number], zoom: 13.4 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** 造一份「像真实数据」的内联 GeoJSON：湖面、绿地、环路、景点 */
function buildData(): GeoJSON.FeatureCollection {
  const rnd = mulberry32(21)
  const lake = ring([120.146, 30.252], 0.012, 84)
  const features: GeoJSON.Feature[] = [
    feat({ type: 'Polygon', coordinates: [lake] }, {
      name: '西湖',
      type: 'water',
      area: '6.39 km²',
    }),
    feat({ type: 'Polygon', coordinates: [ring([120.163, 30.266], 0.006, 48)] }, {
      name: '城北公园',
      type: 'green',
      area: '0.42 km²',
    }),
    feat(
      {
        type: 'LineString',
        coordinates: [
          [120.138, 30.242],
          [120.146, 30.248],
          [120.155, 30.249],
          [120.163, 30.256],
          [120.171, 30.263],
          [120.178, 30.271],
        ],
      },
      { name: '环湖路', type: 'road', level: '主干道', lanes: 4 },
    ),
    feat(
      {
        type: 'LineString',
        coordinates: [
          [120.141, 30.258],
          [120.15, 30.26],
          [120.159, 30.258],
          [120.168, 30.259],
        ],
      },
      { name: '湖滨步行街', type: 'road', level: '步行', lanes: 0 },
    ),
  ]

  const pois: Array<[string, number, number, string]> = [
    ['断桥', 120.1487, 30.2587, '景点'],
    ['雷峰塔', 120.1489, 30.2436, '景点'],
    ['三潭印月', 120.1445, 30.2472, '景点'],
    ['音乐喷泉', 120.1571, 30.2537, '设施'],
    ['北山码头', 120.1456, 30.2598, '设施'],
    ['南山路入口', 120.1552, 30.2431, '设施'],
  ]
  pois.forEach(([name, lon, lat, kind], i) => {
    features.push(
      feat({ type: 'Point', coordinates: [lon, lat] }, {
        name,
        type: 'poi',
        kind,
        star: Math.round((3.5 + rnd() * 1.5) * 10) / 10,
        id: `P${100 + i}`,
      }),
    )
  })
  return fc(features)
}

function build() {
  if (!map) return
  map.addSource('hz', { type: 'geojson', data: buildData() })

  // 面：先填色再描边（fill 图层不画轮廓）
  map.addLayer({
    id: 'area-fill',
    type: 'fill',
    source: 'hz',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': [
        'match',
        ['get', 'type'],
        'water',
        '#1f6feb',
        'green',
        '#2f9e5f',
        '#7a8798',
      ],
      'fill-opacity': ['match', ['get', 'type'], 'water', 0.55, 'green', 0.35, 0.2],
    },
  })
  map.addLayer({
    id: 'area-line',
    type: 'line',
    source: 'hz',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'line-color': ['match', ['get', 'type'], 'water', '#6fb0ff', '#5fc98d'],
      'line-width': 1.6,
    },
  })

  // 线：宽度随层级插值，步行街用虚线
  map.addLayer({
    id: 'road',
    type: 'line',
    source: 'hz',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffd166',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 7],
      'line-dasharray': ['case', ['==', ['get', 'level'], '步行'], ['literal', [2, 2]], ['literal', [1]]],
    },
  })
  map.addLayer({
    id: 'road-label',
    type: 'symbol',
    source: 'hz',
    filter: ['==', ['geometry-type'], 'LineString'],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'name'],
      'text-font': [MB_FONT],
      'text-size': 12,
      'text-max-angle': 35,
    },
    paint: {
      'text-color': '#ffe9b0',
      'text-halo-color': 'rgba(6,12,22,0.9)',
      'text-halo-width': 1.4,
    },
  })

  // 点：圆形 + 文字
  map.addLayer({
    id: 'poi',
    type: 'circle',
    source: 'hz',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 6,
      'circle-color': ['match', ['get', 'kind'], '景点', '#ff6b6b', '#4f9dff'],
      'circle-stroke-width': 2,
      'circle-stroke-color': 'rgba(8,14,22,0.85)',
    },
  })
  map.addLayer({
    id: 'poi-label',
    type: 'symbol',
    source: 'hz',
    filter: ['==', ['geometry-type'], 'Point'],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': [MB_FONT],
      'text-size': 12.5,
      'text-offset': [0, 1],
      'text-anchor': 'top',
    },
    paint: {
      'text-color': '#eaf2fb',
      'text-halo-color': 'rgba(6,12,22,0.92)',
      'text-halo-width': 1.5,
    },
  })

  // 点击任意要素：弹窗 + 右侧属性表
  const onClick = (e: maplibregl.MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (!f || !map) return
    picked.value = (f.properties ?? {}) as Record<string, unknown>
    popup?.remove()
    const rows = Object.entries(f.properties ?? {})
      .map(([k, v]) => `<div class="mb-pop-row"><span>${k}</span><b>${v}</b></div>`)
      .join('')
    popup = new maplibregl.Popup({ offset: 12, maxWidth: '240px' })
      .setLngLat(e.lngLat)
      .setHTML(`<div class="mb-pop-title">${(f.properties?.name as string) ?? '要素'}</div>${rows}`)
      .addTo(map)
  }
  ;['area-fill', 'road', 'poi'].forEach((id) => map!.on('click', id, onClick))
  ;['area-fill', 'road', 'poi'].forEach((id) => {
    map!.on('mouseenter', id, () => {
      if (map) map.getCanvas().style.cursor = 'pointer'
    })
    map!.on('mouseleave', id, () => {
      if (map) map.getCanvas().style.cursor = ''
    })
  })
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
    <div class="mb-panel legend">
      <h4>图例</h4>
      <div class="lg-row"><i style="background: #1f6feb"></i>水域（面）</div>
      <div class="lg-row"><i style="background: #2f9e5f"></i>绿地（面）</div>
      <div class="lg-row"><i style="background: #ffd166"></i>道路（线）</div>
      <div class="lg-row"><i style="background: #ff6b6b"></i>POI（点）</div>
    </div>
    <div v-if="picked" class="mb-panel attrs">
      <h4>选中属性</h4>
      <div v-for="(v, k) in picked" :key="k" class="mb-pop-row">
        <span>{{ k }}</span><b>{{ v }}</b>
      </div>
    </div>
    <div class="mb-tip">点击要素查看属性 · 一个 source 供 5 个图层，按几何类型分流</div>
  </div>
</template>

<style scoped>
.legend {
  top: 14px;
  left: 14px;
  width: 150px;
}
.lg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  font-size: 11.5px;
}
.lg-row i {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex: none;
}
.attrs {
  right: 60px;
  top: 14px;
  width: 190px;
  max-height: 60%;
  overflow: auto;
}
</style>
