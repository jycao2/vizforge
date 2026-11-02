<script setup lang="ts">
/**
 * 边界掩膜（突出关注区域）
 * ===========================================================================
 * 做区域看板时，常要"只让某个行政区亮着，外面压暗"。Mapbox 没有现成的 mask 图层，
 * 标准做法是用一个**带洞的多边形**盖住整个视野：
 *
 *   外环：一个足够大的矩形（这里取经纬度极限范围 [-180,-85] ~ [180,85]）
 *   内环：关注区边界（顶点顺序要和外环相反，否则填充规则会填错）
 *
 * 按 GeoJSON 规范，Polygon 的 coordinates 第一环是外环，后续是内环（洞）。
 * 外环绕向为逆时针、内环顺时针时符合 right-hand rule，Mapbox 会正确地在洞处不填充。
 *
 * 另一个高频需求是"边界发光描边"：用 line 图层配合 blur 画两遍
 * （一遍粗而模糊当辉光，一遍细而实当轮廓），比单纯加粗好看得多。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { MB_FONT } from './basemaps'
import { fc, feat, mulberry32, ring } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const maskOn = ref(true)
const dim = ref(0.72)
const glow = ref(true)
let map: MbMap | null = null

const HOME = { center: [120.15, 30.252] as [number, number], zoom: 12.2 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

/** 关注区边界：一个不规则多边形（模拟西湖景区范围） */
function boundary(): Array<[number, number]> {
  const rnd = mulberry32(77)
  const pts: Array<[number, number]> = []
  const n = 46
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    // 基础半径 + 两组低频扰动，得到自然的湖岸线形状
    const r = 0.016 + Math.sin(t * 3) * 0.0035 + Math.cos(t * 5 + 1) * 0.0022 + rnd() * 0.0008
    pts.push([120.152 + Math.cos(t) * r, 30.253 + Math.sin(t) * r * 0.72])
  }
  pts.push(pts[0])
  return pts
}

function build() {
  if (!map) return
  const b = boundary()

  // 掩膜：外框 + 关注区作洞
  map.addSource('mask', {
    type: 'geojson',
    data: feat({
      type: 'Polygon',
      coordinates: [
        [
          [-180, 85],
          [-180, -85],
          [180, -85],
          [180, 85],
          [-180, 85],
        ],
        [...b].reverse(), // 内环反向，符合 right-hand rule
      ],
    }),
  })
  map.addLayer({
    id: 'mask',
    type: 'fill',
    source: 'mask',
    paint: { 'fill-color': '#05090f', 'fill-opacity': dim.value },
  })

  // 边界：辉光 + 实线两层
  map.addSource('boundary', {
    type: 'geojson',
    data: fc([
      feat({ type: 'Polygon', coordinates: [b] }),
      feat({ type: 'LineString', coordinates: b }),
    ]),
  })
  map.addLayer({
    id: 'boundary-fill',
    type: 'fill',
    source: 'boundary',
    filter: ['==', '$type', 'Polygon'],
    paint: { 'fill-color': '#4f9dff', 'fill-opacity': 0.08 },
  })
  map.addLayer({
    id: 'boundary-glow',
    type: 'line',
    source: 'boundary',
    paint: {
      'line-color': '#4f9dff',
      'line-width': 12,
      'line-blur': 10,
      'line-opacity': 0.5,
    },
  })
  map.addLayer({
    id: 'boundary-line',
    type: 'line',
    source: 'boundary',
    paint: { 'line-color': '#9bd7ff', 'line-width': 2 },
  })

  // 区内的数据点：只有落在关注区里的才显示（用 within 需要 turf，
  // 这里用坐标范围粗筛 + 视觉上边界外的点被掩膜压暗即可）
  const rnd = mulberry32(9)
  const pts: GeoJSON.Feature[] = []
  for (let i = 0; i < 120; i++) {
    const t = rnd() * Math.PI * 2
    const r = Math.sqrt(rnd()) * 0.018
    pts.push(
      feat(
        { type: 'Point', coordinates: [120.152 + Math.cos(t) * r, 30.253 + Math.sin(t) * r * 0.72] },
        { v: Math.round(20 + rnd() * 80) },
      ),
    )
  }
  map.addSource('pts', { type: 'geojson', data: fc(pts) })
  map.addLayer({
    id: 'pts',
    type: 'circle',
    source: 'pts',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'v'], 20, 3, 100, 8],
      'circle-color': '#ffd166',
      'circle-opacity': 0.9,
    },
  })
  map.addLayer({
    id: 'label',
    type: 'symbol',
    source: 'boundary',
    layout: {
      'text-field': '关注区域',
      'text-font': [MB_FONT],
      'text-size': 13,
      'symbol-placement': 'line',
      'text-letter-spacing': 0.2,
    },
    paint: { 'text-color': '#cfe6ff', 'text-halo-color': 'rgba(6,12,22,0.9)', 'text-halo-width': 1.5 },
  })
}

function toggleMask() {
  if (!map) return
  map.setLayoutProperty('mask', 'visibility', maskOn.value ? 'visible' : 'none')
}
function setDim(v: number) {
  dim.value = v
  map?.setPaintProperty('mask', 'fill-opacity', v)
}
function toggleGlow() {
  if (!map) return
  map.setLayoutProperty('boundary-glow', 'visibility', glow.value ? 'visible' : 'none')
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
      <h4>边界掩膜</h4>
      <label class="mb-row">
        <input v-model="maskOn" type="checkbox" @change="toggleMask" />
        <span>外部压暗</span>
      </label>
      <label class="mb-row">
        <span>暗度</span>
        <input
          type="range"
          min="0"
          max="0.95"
          step="0.02"
          :value="dim"
          @input="setDim(Number(($event.target as HTMLInputElement).value))"
        />
        <b>{{ dim.toFixed(2) }}</b>
      </label>
      <label class="mb-row">
        <input v-model="glow" type="checkbox" @change="toggleGlow" />
        <span>边界辉光</span>
      </label>
      <div class="hint">带洞多边形：外框顺时针 + 内环反向</div>
    </div>
    <div class="mb-tip">掩膜层盖住全球，只留关注区的"洞"</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 220px;
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
  font-variant-numeric: tabular-nums;
}
.hint {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #8fa4b9;
  font-size: 10.5px;
}
</style>
