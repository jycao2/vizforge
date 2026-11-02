<script setup lang="ts">
/**
 * 分级统计专题图（Choropleth）
 * ===========================================================================
 * 专题制图里用得最多的一种：把统计值映射到面要素的填充色。
 *
 * 关键点：
 *  - 配色用 `step` 而不是 `interpolate` —— 分级图要的是"离散档位"，
 *    连续插值会让相邻区域的细微差别变得不可读；
 *  - 色带取自 ColorBrewer 的 YlGnBu（色盲友好，且明度单调，打印成黑白也分得出档）；
 *  - hover 高亮走 `feature-state`（不是改数据），避免每划过一次就 setData 重传整个集合；
 *    feature-state 需要 source 开 `generateId: true`，否则拿不到要素 id；
 *  - 图例是纯 DOM，和地图里的 stop 用同一份常量，改配色只改一处。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { gridPolygons } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: MbMap | null = null
let popup: maplibregl.Popup | null = null
let hovered: number | null = null

const HOME = { center: [116, 34] as [number, number], zoom: 4.2 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** 档位阈值与色带：地图和图例共用，避免两处不同步 */
const STOPS: Array<[number, string, string]> = [
  [20, '#0b3a63', '< 20'],
  [40, '#12557f', '20 – 40'],
  [60, '#2b7fb8', '40 – 60'],
  [80, '#66b3d9', '60 – 80'],
  [101, '#c7e6f5', '≥ 80'],
]

/** 组装 step 表达式：[≤20 → 色0, ≤40 → 色1, ...] */
function stepExpr(): maplibregl.ExpressionSpecification {
  const expr: unknown[] = ['step', ['get', 'v'], STOPS[0][1]]
  for (let i = 1; i < STOPS.length; i++) expr.push(STOPS[i - 1][0], STOPS[i][1])
  return expr as maplibregl.ExpressionSpecification
}

function build() {
  if (!map) return
  map.addSource('grid', {
    type: 'geojson',
    data: gridPolygons([108, 26, 124, 42], 16, 16),
    generateId: true, // feature-state 必须要要素 id
  })

  map.addLayer({
    id: 'grid-fill',
    type: 'fill',
    source: 'grid',
    paint: {
      'fill-color': stepExpr(),
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        0.95,
        0.72,
      ],
    },
  })
  map.addLayer({
    id: 'grid-line',
    type: 'line',
    source: 'grid',
    paint: {
      'line-color': [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        '#ffffff',
        'rgba(255,255,255,0.18)',
      ],
      'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2, 0.6],
    },
  })

  map.on('mousemove', 'grid-fill', (e) => {
    if (!map || !e.features?.length) return
    const id = e.features[0].id as number | undefined
    if (id === undefined) return
    if (hovered !== null && hovered !== id) {
      map.setFeatureState({ source: 'grid', id: hovered }, { hover: false })
    }
    hovered = id
    map.setFeatureState({ source: 'grid', id }, { hover: true })
    map.getCanvas().style.cursor = 'pointer'
    const v = e.features[0].properties?.v
    popup
      ?.setLngLat(e.lngLat)
      .setHTML(
        `<div class="mb-pop-title">区块 ${e.features[0].properties?.name}</div>` +
          `<div class="mb-pop-row"><span>统计值</span><b>${v}</b></div>`,
      )
      .addTo(map)
  })

  map.on('mouseleave', 'grid-fill', () => {
    if (!map) return
    if (hovered !== null) map.setFeatureState({ source: 'grid', id: hovered }, { hover: false })
    hovered = null
    map.getCanvas().style.cursor = ''
    popup?.remove()
  })

  popup = new maplibregl.Popup({ closeButton: false, offset: 10, maxWidth: '200px' })
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
      <h4>分级图例</h4>
      <div v-for="s in STOPS" :key="s[0]" class="lg-row">
        <i :style="{ background: s[1] }"></i>
        <span>{{ s[2] }}</span>
      </div>
      <div class="hint">step 离散分档 · hover 走 feature-state</div>
    </div>
    <div class="mb-tip">16 × 16 网格统计专题图，悬停高亮当前区块</div>
  </div>
</template>

<style scoped>
.legend {
  top: 14px;
  left: 14px;
  width: 158px;
}
.lg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  font-size: 11.5px;
}
.lg-row i {
  width: 22px;
  height: 12px;
  border-radius: 2px;
  flex: none;
}
.hint {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
