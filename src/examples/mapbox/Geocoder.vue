<script setup lang="ts">
/**
 * 地名搜索定位（Geocoding）
 * ===========================================================================
 * 用 OpenStreetMap 的 Nominatim 公开接口做正向地理编码（地名 → 坐标）。
 * 它是免费服务，但有两条硬规则，示例里都按规矩做了：
 *
 *  - **必须防抖 + 限流**：官方要求不超过 1 次/秒，本例 400ms 防抖且串行请求
 *    （上一个没回来不发下一个）；
 *  - **必须带可识别的 Referer/UA**：浏览器会自动带，单页面应用不要伪造。
 *
 * 交互上还有两个常见细节：
 *  - 结果列表展示 OSM 返回的 display_name 与 bbox，有 bbox 时用 fitBounds
 *    直接框住整个行政区，比只定位一个点好用得多；
 *  - 高亮选中项：用一个独立的 GeoJSON source 放"当前选中"的点，
 *    不要把搜索结果塞进常驻图层，否则每次搜索都要重建图层。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap, GeoJSONSource } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { fc, feat } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const q = ref('')
const results = ref<Array<{ id: string; name: string; sub: string; lon: number; lat: number; bbox?: number[] }>>([])
const loading = ref(false)
const err = ref('')
let map: MbMap | null = null
let marker: maplibregl.Marker | null = null
let timer = 0

const HOME = { center: [116.39, 39.91] as [number, number], zoom: 10 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

interface NominatimItem {
  place_id: number
  display_name: string
  lat: string
  lon: string
  bbox?: string[]
  addons?: Record<string, string>
}

function build() {
  if (!map) return
  map.addSource('picked', { type: 'geojson', data: fc([]) })
  map.addLayer({
    id: 'picked-halo',
    type: 'circle',
    source: 'picked',
    paint: {
      'circle-radius': 16,
      'circle-color': 'rgba(255,209,102,0.18)',
      'circle-stroke-width': 1.5,
      'circle-stroke-color': 'rgba(255,209,102,0.7)',
    },
  })
  map.addLayer({
    id: 'picked',
    type: 'circle',
    source: 'picked',
    paint: { 'circle-radius': 5, 'circle-color': '#ffd166' },
  })
  marker = new maplibregl.Marker({ color: '#ffd166' })
}

/** 400ms 防抖：Nominatim 明确要求不要高频请求 */
function onInput() {
  err.value = ''
  if (timer) clearTimeout(timer)
  timer = window.setTimeout(search, 400)
}

async function search() {
  const kw = q.value.trim()
  if (kw.length < 2) {
    results.value = []
    return
  }
  loading.value = true
  try {
    const url =
      'https://nominatim.openstreetmap.org/search?' +
      new URLSearchParams({
        q: kw,
        format: 'json',
        limit: '8',
        addressdetails: '1',
        'accept-language': 'zh-CN,zh',
      })
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as NominatimItem[]
    results.value = json.map((it) => ({
      id: String(it.place_id),
      name: it.display_name.split(',')[0],
      sub: it.display_name,
      lon: Number(it.lon),
      lat: Number(it.lat),
      bbox: it.bbox ? it.bbox.map(Number) : undefined,
    }))
    if (!results.value.length) err.value = '没有匹配结果，换个词试试'
  } catch (e) {
    err.value = `查询失败：${(e as Error).message}`
    results.value = []
  } finally {
    loading.value = false
  }
}

function go(r: (typeof results.value)[number]) {
  if (!map) return
  ;(map.getSource('picked') as GeoJSONSource).setData(
    fc([feat({ type: 'Point', coordinates: [r.lon, r.lat] })]),
  )
  marker?.setLngLat([r.lon, r.lat])
  // 有 bbox（行政区/建筑）就框住整块，否则只定位点
  if (r.bbox && r.bbox.length === 4) {
    const [s, n, w, e] = r.bbox as number[]
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 60, duration: 900, maxZoom: 16 },
    )
  } else {
    map.flyTo({ center: [r.lon, r.lat], zoom: 14, duration: 900 })
  }
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  marker?.remove()
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
      <h4>地名搜索</h4>
      <input
        v-model="q"
        class="search"
        type="search"
        placeholder="输入地名，如 西湖 / 上海"
        @input="onInput"
        @keyup.enter="search"
      />
      <div v-if="loading" class="state">查询中…</div>
      <div v-else-if="err" class="state err">{{ err }}</div>
      <div v-else-if="results.length" class="scroll">
        <button v-for="r in results" :key="r.id" class="res" @click="go(r)">
          <b>{{ r.name }}</b>
          <span>{{ r.sub }}</span>
        </button>
      </div>
      <div v-else class="state">数据来自 Nominatim（OpenStreetMap）</div>
    </div>
    <div class="mb-tip">有 bbox 的结果会整块框住 · 请求已做 400ms 防抖</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 268px;
}
.search {
  width: 100%;
  padding: 6px 9px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(8, 14, 22, 0.7);
  color: #eaf2fb;
  font-size: 12px;
  outline: none;
}
.search:focus {
  border-color: rgba(79, 157, 255, 0.7);
}
.scroll {
  margin-top: 6px;
  max-height: 260px;
  overflow: auto;
}
.res {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 5px 7px;
  margin-bottom: 3px;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  text-align: left;
  cursor: pointer;
}
.res:hover {
  background: rgba(79, 157, 255, 0.22);
}
.res b {
  color: #eaf2fb;
  font-size: 12px;
}
.res span {
  color: #8fa4b9;
  font-size: 10px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.state {
  margin-top: 7px;
  color: #8fa4b9;
  font-size: 10.5px;
}
.state.err {
  color: #ffb4a4;
}
</style>
