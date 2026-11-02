<script setup lang="ts">
/**
 * WMS / OGC 服务图层
 * ===========================================================================
 * WMS 返回的是"服务端画好的图"，前端只负责拼 URL。和 WMTS 的区别：
 *  - WMS：一次请求一张图，BBOX 由前端当前视口决定（任意范围）；
 *  - WMTS：预切的金字塔瓦片，只能按固定网格取。
 *
 * Mapbox 的 raster source 支持 `{bbox-epsg-3857}` 占位符，会自动替换成当前瓦片
 * 在 Web Mercator 下的 bbox，正好对上 WMS 的 BBOX 参数 —— 这是接 WMS 最省事的写法。
 *
 * 本例做了两件实用的事：
 *  1) 两个 WMS 图层叠加：OSM-WMS 当底图，TOPO-WMS 半透明压在上面；
 *  2) GetFeatureInfo：点击地图按 WMS 规范反查要素属性（用当前视口 bbox +
 *     点击点的像素坐标拼请求），这是 WMS 唯一能"查属性"的入口。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import * as maplibregl from 'maplibre-gl'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { blankStyle } from './basemaps'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const baseOn = ref(true)
const topoOn = ref(true)
const topoOpacity = ref(0.55)
const querying = ref(false)
const info = ref('')
let map: MbMap | null = null
let popup: maplibregl.Popup | null = null

const HOME = { center: [120.155, 30.255] as [number, number], zoom: 13 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

const WMS = 'https://ows.terrestris.de/osm/service'

/**
 * 拼 GetMap 模板；STYLES 参数必须给（哪怕是空），否则服务报 500。
 * 注意不能走 URLSearchParams：它会把 {bbox-epsg-3857} 编码成 %7B…%7D，
 * MapLibre 就认不出占位符了 —— BBOX 必须保持未编码的字面量。
 */
function wmsUrl(layers: string, transparent = true): string {
  return (
    `${WMS}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layers}&STYLES=` +
    `&FORMAT=image%2Fpng&SRS=EPSG%3A3857&WIDTH=256&HEIGHT=256` +
    `&BBOX={bbox-epsg-3857}` +
    (transparent ? '&TRANSPARENT=true' : '')
  )
}

function build() {
  if (!map) return
  map.addSource('osm-wms', {
    type: 'raster',
    tiles: [wmsUrl('OSM-WMS', false), wmsUrl('OSM-WMS', false).replace('&WIDTH=256', '&WIDTH=512')],
    tileSize: 256,
    attribution: '© OpenStreetMap contributors（terrestris WMS）',
  })
  map.addLayer({
    id: 'osm-wms',
    type: 'raster',
    source: 'osm-wms',
    paint: { 'raster-opacity': 1 },
  })

  map.addSource('topo-wms', {
    type: 'raster',
    tiles: [wmsUrl('TOPO-WMS')],
    tileSize: 256,
  })
  map.addLayer({
    id: 'topo-wms',
    type: 'raster',
    source: 'topo-wms',
    paint: { 'raster-opacity': topoOpacity.value },
  })

  popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px' })
  map.on('click', queryFeature)
}

function toggleBase() {
  if (!map) return
  map.setLayoutProperty('osm-wms', 'visibility', baseOn.value ? 'visible' : 'none')
}
function toggleTopo() {
  if (!map) return
  map.setLayoutProperty('topo-wms', 'visibility', topoOn.value ? 'visible' : 'none')
}
function setTopoOpacity(v: number) {
  topoOpacity.value = v
  map?.setPaintProperty('topo-wms', 'raster-opacity', v)
}

/**
 * GetFeatureInfo：WMS 规范要求传「地图范围 + 图片尺寸 + 点击像素」，
 * 这里用当前视口的 bbox 与 canvas 尺寸算，服务端据此反算地理坐标。
 */
async function queryFeature(e: maplibregl.MapMouseEvent) {
  if (!map) return
  querying.value = true
  info.value = '查询中…'
  try {
    const canvas = map.getCanvas()
    const b = map.getBounds()
    const sw = maplibregl.MercatorCoordinate.fromLngLat([b.getWest(), b.getSouth()])
    const ne = maplibregl.MercatorCoordinate.fromLngLat([b.getEast(), b.getNorth()])
    // MercatorCoordinate 是 0~1 归一化值，乘地球周长（米）就是 EPSG:3857 坐标
    const E = 40075016.686
    const p = new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.1.1',
      REQUEST: 'GetFeatureInfo',
      LAYERS: 'OSM-WMS',
      QUERY_LAYERS: 'OSM-WMS',
      STYLES: '',
      SRS: 'EPSG:3857',
      FORMAT: 'image/png',
      INFO_FORMAT: 'application/json',
      WIDTH: String(Math.round(canvas.width / (window.devicePixelRatio || 1))),
      HEIGHT: String(Math.round(canvas.height / (window.devicePixelRatio || 1))),
      X: String(Math.round(e.point.x)),
      Y: String(Math.round(e.point.y)),
      BBOX: [
        (sw.x - 0.5) * E,
        (0.5 - ne.y) * E,
        (ne.x - 0.5) * E,
        (0.5 - sw.y) * E,
      ]
        .map((v) => v.toFixed(2))
        .join(','),
    })
    const res = await fetch(`${WMS}?${p.toString()}`)
    const json = (await res.json()) as GeoJSON.FeatureCollection
    const feats = json.features ?? []
    if (!feats.length) {
      info.value = '该位置无要素'
      popup?.remove()
      return
    }
    info.value = `命中 ${feats.length} 个要素`
    const rows = feats
      .slice(0, 3)
      .map((f) =>
        Object.entries(f.properties ?? {})
          .slice(0, 4)
          .map(([k, v]) => `<div class="mb-pop-row"><span>${k}</span><b>${v}</b></div>`)
          .join(''),
      )
      .join('<hr style="border:0;border-top:1px solid rgba(255,255,255,.12);margin:6px 0">')
    popup?.setLngLat(e.lngLat).setHTML(`<div class="mb-pop-title">WMS 要素</div>${rows}`).addTo(map)
  } catch (err) {
    info.value = `查询失败：${(err as Error).message}`
  } finally {
    querying.value = false
  }
}

onMounted(() => {
  // WMS 自带底图，用空样式避免再叠一层栅格
  map = createMap(container.value!, { ...HOME, style: blankStyle('#0a121c') })
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
      <h4>WMS 图层</h4>
      <label class="mb-row">
        <input v-model="baseOn" type="checkbox" @change="toggleBase" />
        <span>OSM-WMS（底图）</span>
      </label>
      <label class="mb-row">
        <input v-model="topoOn" type="checkbox" @change="toggleTopo" />
        <span>TOPO-WMS（叠加）</span>
      </label>
      <label class="mb-row">
        <span>叠加透明</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="topoOpacity"
          @input="setTopoOpacity(Number(($event.target as HTMLInputElement).value))"
        />
        <b>{{ topoOpacity.toFixed(2) }}</b>
      </label>
      <div class="hint">点击地图发起 GetFeatureInfo 查询</div>
      <div class="stat">{{ querying ? '…' : info }}</div>
    </div>
    <div class="mb-tip">raster source + {bbox-epsg-3857} 占位符直接接 OGC WMS</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 236px;
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
  width: 32px;
  text-align: right;
  color: #eaf2fb;
  font-size: 11px;
  font-variant-numeric: tab-nums;
}
.hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
}
.stat {
  margin-top: 4px;
  color: #eaf2fb;
  font-size: 11px;
}
</style>
