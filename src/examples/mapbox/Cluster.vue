<script setup lang="ts">
/**
 * 点聚合（Cluster）
 * ===========================================================================
 * 上万点直接画会糊成一片，也拖慢渲染。Mapbox 的做法是在 source 上开聚合：
 *
 *   cluster: true          —— source 在 worker 里按屏幕格网做聚合
 *   clusterRadius          —— 聚合半径（像素），越大聚得越狠
 *   clusterMaxZoom         —— 超过这个层级就不再聚合
 *   clusterProperties      —— 自定义聚合统计（这里是求和与求最大，用于"聚合块显示总量"）
 *
 * 聚合结果被 Mapbox 拆成两类要素，必须用 filter 分开渲染：
 *   - 有 `point_count` 的 → 聚合圈（cluster 图层）
 *   - 没有的             → 原始点（unclustered-point 图层）
 *
 * 点击聚合圈的正确处理：不要直接 zoomIn 一级，而是用 getClusterExpansionZoom
 * 拿到"刚好能散开这一簇"的层级再 flyTo，否则会出现「点了好几下还在聚合」的体验问题。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { GeoJSONSource } from 'maplibre-gl'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { scatter } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const stat = ref('')
let map: MbMap | null = null

const HOME = { center: [114.2, 31.4] as [number, number], zoom: 3.8 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const COUNT = 8000

function build() {
  if (!map) return
  const data = scatter(99, COUNT, [
    [116.39, 39.91],
    [121.47, 31.23],
    [113.26, 23.13],
    [120.15, 30.27],
    [104.07, 30.57],
    [108.94, 34.34],
  ], 1.4)

  map.addSource('pts', {
    type: 'geojson',
    data,
    cluster: true,
    clusterRadius: 52,
    clusterMaxZoom: 10,
    // 聚合时把各点的 v 累加，聚合圈上就能直接显示"总量"
    clusterProperties: {
      sum: ['+', ['get', 'v']],
      max: ['max', ['get', 'v']],
    },
  })

  // 聚合圈：半径与颜色都按点数量分档
  map.addLayer({
    id: 'clusters',
    type: 'circle',
    source: 'pts',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': [
        'step',
        ['get', 'point_count'],
        '#4f9dff',
        80,
        '#5fd0a8',
        400,
        '#ffd166',
        1200,
        '#ff8c42',
      ],
      'circle-radius': ['step', ['get', 'point_count'], 14, 80, 20, 400, 27, 1200, 34],
      'circle-opacity': 0.78,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': 'rgba(240,248,255,0.65)',
    },
  })

  // 聚合圈上的数量文字；用 format 表达式把数字加粗显示
  map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: 'pts',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['format', ['get', 'point_count_abbreviated'], { 'font-scale': 1.15 }],
      'text-font': [MB_FONT],
      'text-size': 12,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#08121e' },
  })

  // 未聚合的原始点
  map.addLayer({
    id: 'unclustered',
    type: 'circle',
    source: 'pts',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': '#ffd166',
      'circle-radius': 4,
      'circle-stroke-width': 1,
      'circle-stroke-color': 'rgba(8,14,22,0.85)',
    },
  })

  map.on('click', 'clusters', async (e) => {
    const f = e.features?.[0]
    if (!f || !map) return
    const src = map.getSource('pts') as GeoJSONSource
    const clusterId = f.properties?.cluster_id as number
    // 问 source「这一簇散开需要多少级」，而不是无脑 +1（回调式 API，包成 Promise）
    const zoom = await src.getClusterExpansionZoom(clusterId)
    const c = f.geometry as GeoJSON.Point
    map.easeTo({
      center: c.coordinates as [number, number],
      zoom: zoom + 0.2,
      duration: 700,
    })
  })

  map.on('mouseenter', 'clusters', () => {
    if (map) map.getCanvas().style.cursor = 'pointer'
  })
  map.on('mouseleave', 'clusters', () => {
    if (map) map.getCanvas().style.cursor = ''
  })

  // 聚合统计：渲染完读一次当前视口的簇数
  const refresh = () => {
    if (!map) return
    const feats = map.queryRenderedFeatures({ layers: ['clusters'] })
    let maxCount = 0
    feats.forEach((f) => {
      const n = (f.properties?.point_count as number) ?? 0
      if (n > maxCount) maxCount = n
    })
    stat.value = `当前视口 ${feats.length} 个聚合块 · 最大 ${maxCount} 点 / 共 ${COUNT} 点`
  }
  map.on('idle', refresh)
  map.on('moveend', refresh)
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
})

onBeforeUnmount(() => {
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
      <h4>聚合</h4>
      <div class="hint">clusterRadius 52px · clusterMaxZoom 10</div>
      <div class="stat">{{ stat || '统计中…' }}</div>
    </div>
    <div class="mb-tip">点击聚合块自动展开到"刚好散开"的层级 · 继续放大看原始点</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 216px;
}
.hint {
  color: #8fa4b9;
  font-size: 10.5px;
  line-height: 1.5;
}
.stat {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #eaf2fb;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
</style>
