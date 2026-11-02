<script setup lang="ts">
/**
 * 路网路径规划（Dijkstra）
 * ===========================================================================
 * 真实路网 + 最短路径，和"两点连直线"完全不是一回事。本例：
 *
 *  1) 数据：杭州西湖东侧的路网（OSM 导出后精简，nodes + edges 见 data/），
 *     1394 个节点 / 1538 条边；
 *  2) 建图：邻接表存「邻居 + 边长」，边长用 Haversine 球面距离算，
 *     不能用经纬度差的平面距离（纬度 30° 处经度方向会被压掉约 13%）；
 *  3) 求解：Dijkstra + 二叉堆。1.4k 节点规模下 A* 和 Dijkstra 差别不大，
 *     这里用最直白的写法，重点是把「优先队列 + 前驱数组 + 回溯路径」讲清楚；
 *  4) 交互：点击地图就近吸附到路网节点，两次点击算出路径；
 *     起点/终点用不同颜色的 symbol 标记，路径用粗亮线压在路网之上。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap, MapMouseEvent, GeoJSONSource } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import osmData from '../openlayers/data/hangzhou-roadnet.json'
import { createMap, useMapboxView } from './useMapbox'
import { fc, feat } from './data'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const hint = ref('点击地图选择起点')
const result = ref('')
let map: MbMap | null = null

type LL = [number, number]
const NODES = osmData.nodes as LL[]
const EDGES = osmData.edges as number[][]
const HOME = { center: [120.16, 30.259] as LL, zoom: 14.2 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/* ---------- 建图 ---------- */

function haversine(a: LL, b: LL): number {
  const R = 6378137
  const rad = Math.PI / 180
  const dLat = (b[1] - a[1]) * rad
  const dLon = (b[0] - a[0]) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

const adj: Array<Array<[number, number]>> = NODES.map(() => [])
for (const e of EDGES) {
  const [a, b] = e
  if (a == null || b == null || !NODES[a] || !NODES[b]) continue
  const w = haversine(NODES[a], NODES[b])
  adj[a].push([b, w])
  adj[b].push([a, w]) // 城市道路默认双向
}

/** 最近节点：1.4k 个点线性扫描完全够用，上规模再换网格索引 */
function nearest(p: LL): number {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < NODES.length; i++) {
    const d = haversine(NODES[i], p)
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

/** 二叉最小堆：Dijkstra 的性能关键，用数组排序会退化到 O(n² log n) */
class MinHeap {
  private a: Array<[number, number]> = [] // [dist, node]
  get size() {
    return this.a.length
  }
  push(x: [number, number]) {
    this.a.push(x)
    let i = this.a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.a[p][0] <= this.a[i][0]) break
      ;[this.a[p], this.a[i]] = [this.a[i], this.a[p]]
      i = p
    }
  }
  pop(): [number, number] | undefined {
    if (!this.a.length) return undefined
    const top = this.a[0]
    const last = this.a.pop()!
    if (this.a.length) {
      this.a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < this.a.length && this.a[l][0] < this.a[m][0]) m = l
        if (r < this.a.length && this.a[r][0] < this.a[m][0]) m = r
        if (m === i) break
        ;[this.a[m], this.a[i]] = [this.a[i], this.a[m]]
        i = m
      }
    }
    return top
  }
}

function dijkstra(s: number, t: number): { path: number[]; dist: number } {
  const dist = new Float64Array(NODES.length).fill(Infinity)
  const prev = new Int32Array(NODES.length).fill(-1)
  const done = new Uint8Array(NODES.length)
  dist[s] = 0
  const q = new MinHeap()
  q.push([0, s])
  while (q.size) {
    const top = q.pop()!
    const [d, u] = top
    if (done[u]) continue
    done[u] = 1
    if (u === t) break
    for (const [v, w] of adj[u]) {
      const nd = d + w
      if (nd < dist[v]) {
        dist[v] = nd
        prev[v] = u
        q.push([nd, v])
      }
    }
  }
  if (!Number.isFinite(dist[t])) return { path: [], dist: Infinity }
  const path: number[] = []
  for (let at = t; at !== -1; at = prev[at]) path.push(at)
  path.reverse()
  return { path, dist: dist[t] }
}

/* ---------- 地图 ---------- */

let startIdx: number | null = null
let endIdx: number | null = null

function build() {
  if (!map) return
  map.addSource('net', {
    type: 'geojson',
    data: fc(
      EDGES.filter((e) => NODES[e[0]] && NODES[e[1]]).map((e) =>
        feat({ type: 'LineString', coordinates: [NODES[e[0]], NODES[e[1]]] }),
      ),
    ),
  })
  map.addLayer({
    id: 'net',
    type: 'line',
    source: 'net',
    paint: {
      'line-color': 'rgba(150,175,200,0.45)',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 17, 3.5],
    },
  })
  map.addSource('route', {
    type: 'geojson',
    data: fc([]),
  })
  map.addLayer({
    id: 'route-glow',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': 'rgba(79,157,255,0.35)', 'line-width': 12, 'line-blur': 6 },
  })
  map.addLayer({
    id: 'route',
    type: 'line',
    source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#4f9dff', 'line-width': 4 },
  })
  map.addSource('ends', { type: 'geojson', data: fc([]) })
  map.addLayer({
    id: 'ends',
    type: 'circle',
    source: 'ends',
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'kind'], 'start', '#5fd0a8', '#ff6b6b'],
      'circle-stroke-width': 2,
      'circle-stroke-color': 'rgba(8,14,22,0.9)',
    },
  })
  map.addLayer({
    id: 'ends-text',
    type: 'symbol',
    source: 'ends',
    layout: {
      'text-field': ['get', 'kind'],
      'text-font': [MB_FONT],
      'text-size': 11,
      'text-offset': [0, 1.1],
      'text-anchor': 'top',
    },
    paint: { 'text-color': '#eaf2fb', 'text-halo-color': 'rgba(6,12,22,0.9)', 'text-halo-width': 1.3 },
  })

  map.on('click', onMapClick)
}

function onMapClick(e: MapMouseEvent) {
  if (!map) return
  const p: LL = [e.lngLat.lng, e.lngLat.lat]
  const idx = nearest(p)
  if (startIdx === null || endIdx !== null) {
    // 重新开始一轮
    startIdx = idx
    endIdx = null
    hint.value = '再点一次选择终点'
    result.value = ''
    map.getSource('route') &&
      (map.getSource('route') as GeoJSONSource).setData(fc([]))
  } else {
    endIdx = idx
    hint.value = '点击地图开始新一轮'
    solve()
  }
  drawEnds()
}

function drawEnds() {
  if (!map) return
  const f: GeoJSON.Feature[] = []
  if (startIdx !== null) {
    f.push(feat({ type: 'Point', coordinates: NODES[startIdx] }, { kind: 'start' }))
  }
  if (endIdx !== null) {
    f.push(feat({ type: 'Point', coordinates: NODES[endIdx] }, { kind: 'end' }))
  }
  ;(map.getSource('ends') as GeoJSONSource).setData(fc(f))
}

function solve() {
  if (!map || startIdx === null || endIdx === null) return
  const t0 = performance.now()
  const { path, dist } = dijkstra(startIdx, endIdx)
  const ms = performance.now() - t0
  if (!path.length) {
    result.value = '两点不在同一连通分量内'
    return
  }
  const coords = path.map((i) => NODES[i])
  ;(map.getSource('route') as GeoJSONSource).setData(
    feat({ type: 'LineString', coordinates: coords }),
  )
  // 步行 4.8km/h、骑行 15km/h 两个参考值
  const km = dist / 1000
  result.value =
    `${km.toFixed(2)} km · ${path.length} 个节点 · 求解 ${ms.toFixed(1)}ms · ` +
    `步行约 ${Math.round((km / 4.8) * 60)} 分钟`
  const b = new maplibregl.LngLatBounds(coords[0], coords[0])
  coords.forEach((c) => b.extend(c))
  map.fitBounds(b, { padding: 70, duration: 700 })
}

function clearAll() {
  startIdx = null
  endIdx = null
  hint.value = '点击地图选择起点'
  result.value = ''
  if (!map) return
  ;(map.getSource('route') as GeoJSONSource).setData(fc([]))
  drawEnds()
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
      <h4>路径规划</h4>
      <div class="hint">{{ hint }}</div>
      <div v-if="result" class="stat">{{ result }}</div>
      <button class="mb-btn" style="margin-top: 8px" @click="clearAll">清空</button>
    </div>
    <div class="mb-tip">杭州西湖东侧真实路网 · {{ NODES.length }} 节点 / {{ EDGES.length }} 边 · Dijkstra + 二叉堆</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 226px;
}
.hint {
  color: #8fa4b9;
  font-size: 11px;
  line-height: 1.5;
}
.stat {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #eaf2fb;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}
</style>
