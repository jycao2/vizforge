<script setup lang="ts">
/**
 * 分级统计专题图（Choropleth）
 * ===========================================================================
 * 同一份数据，换一种分级方法，图会完全不同 —— 这是专题图最容易被忽略、
 * 也最容易被误读的一点。所以这个示例把三种分级方法并排放出来：
 *
 *   等间距 Equal Interval —— 按数值等分，极值会把大部分压进最低一级
 *   分位数 Quantile       —— 每级要素数相同，但同级内部差异可能很大
 *   Jenks 自然断点        —— 最小化组内方差，拐点落在数据真实间隙上
 *
 * 数据来自内置 OGC 服务的 city:builtup（67 个面），字段可切人口/面积。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import GeoJSON from 'ol/format/GeoJSON'
import Style from 'ol/style/Style'
import Fill from 'ol/style/Fill'
import Stroke from 'ol/style/Stroke'
import type Feature from 'ol/Feature'
import type { FeatureLike } from 'ol/Feature'
import type { MapBrowserEvent } from 'ol'
import { transformExtent } from 'ol/proj'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'
import { createMeasureTip } from '@/components/measureShared'
import { EXTENT, getFeature } from '@/examples/shared/ogc'

/* ------------------------------ 配置 ------------------------------ */

type Method = 'equal' | 'quantile' | 'jenks'

const METHODS: Array<{ id: Method; label: string; note: string }> = [
  { id: 'equal', label: '等间距', note: '数值等分，极值主导' },
  { id: 'quantile', label: '分位数', note: '每级要素数相同' },
  { id: 'jenks', label: '自然断点', note: '组内方差最小' },
]

const FIELDS: Array<{ id: string; label: string; unit: string }> = [
  { id: 'population', label: '人口', unit: '万人' },
  { id: 'area_km2', label: '面积', unit: 'km²' },
]

/** 顺序色带（YlOrRd）：低值浅、高值深，符合"越多越重"的直觉 */
const RAMP = ['#ffeda0', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026']

const method = ref<Method>('jenks')
const field = ref('population')
const classes = ref(5)

/* ------------------------------ 分级算法 ------------------------------ */

/** 在色带上按位置取色（t ∈ [0,1]） */
function sampleRamp(t: number): string {
  const k = Math.max(0, Math.min(1, t)) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(k))
  const f = k - i
  const p = (h: string) => [1, 3, 5].map((s) => parseInt(h.slice(s, s + 2), 16))
  const [r1, g1, b1] = p(RAMP[i])
  const [r2, g2, b2] = p(RAMP[i + 1])
  return `rgb(${Math.round(r1 + (r2 - r1) * f)},${Math.round(g1 + (g2 - g1) * f)},${Math.round(
    b1 + (b2 - b1) * f,
  )})`
}

/**
 * Fisher-Jenks 自然断点（动态规划）。
 * 思路：把有序数组切成 k 段，使「各段内方差之和」最小。
 * 复杂度 O(k·n²)，67 个要素瞬间出结果，不需要近似成 k-means。
 */
function jenksBreaks(values: number[], k: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  if (n <= k) return sorted.slice(-k)
  const lower = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(0))
  const varMat = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(Infinity))
  for (let i = 1; i <= k; i++) {
    lower[1][i] = 1
    varMat[1][i] = 0
  }
  for (let l = 2; l <= n; l++) {
    let s1 = 0
    let s2 = 0
    let w = 0
    let variance = 0
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1
      const val = sorted[i3 - 1]
      s2 += val * val
      s1 += val
      w += 1
      variance = s2 - (s1 * s1) / w
      const i4 = i3 - 1
      if (i4 !== 0) {
        for (let j = 2; j <= k; j++) {
          if (varMat[l][j] >= variance + varMat[i4][j - 1]) {
            lower[l][j] = i3
            varMat[l][j] = variance + varMat[i4][j - 1]
          }
        }
      }
    }
    lower[l][1] = 1
    varMat[l][1] = variance
  }
  const bounds = new Array<number>(k + 1)
  bounds[k] = sorted[n - 1]
  bounds[0] = sorted[0]
  let count = k
  let idx = n
  while (count >= 2) {
    const id = lower[idx][count] - 2
    bounds[count - 1] = sorted[id]
    idx = lower[idx][count] - 1
    count -= 1
  }
  return bounds
}

/** 三种方法统一返回「每级上界」数组 */
function computeBreaks(values: number[], m: Method, n: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  if (max - min < 1e-9) return Array.from({ length: n }, () => max)
  if (m === 'equal') {
    const step = (max - min) / n
    return Array.from({ length: n }, (_, i) => min + step * (i + 1))
  }
  if (m === 'quantile') {
    return Array.from({ length: n }, (_, i) => {
      const pos = Math.min(sorted.length - 1, Math.floor(((i + 1) / n) * sorted.length) - 1)
      return sorted[Math.max(0, pos)]
    })
  }
  return jenksBreaks(values, n).slice(1)
}

/* ------------------------------ 状态 ------------------------------ */

interface Level {
  lo: number
  hi: number
  color: string
  count: number
}

const levels = ref<Level[]>([])
const stats = ref({ count: 0, min: 0, max: 0, mean: 0, cv: 0 })
const hover = ref<{ name: string; value: number } | null>(null)

/* ------------------------------ 地图 ------------------------------ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: OlMap | null = null
let source: VectorSource | null = null
let layer: VectorLayer<Feature> | null = null
let tip: ReturnType<typeof createMeasureTip> | null = null

const DATA_EXTENT = transformExtent([EXTENT.w, EXTENT.s, EXTENT.e, EXTENT.n], 'EPSG:4326', 'EPSG:3857')
const { zoomBy, toggleFullscreen } = useOlView(() => map, [0, 0], 7)
const { current: currentBasemap, create, apply } = useOlBasemap('dark')

function reset() {
  const narrow = (wrapRef.value?.clientWidth ?? 1200) < 900
  map?.getView().fit(DATA_EXTENT, { padding: narrow ? [24, 24, 24, 24] : [26, 40, 30, 330], duration: 320 })
}

/** 按当前分级把某个值映射到颜色 */
function colorOf(value: number): string {
  const lv = levels.value
  if (!lv.length) return '#666'
  for (const l of lv) {
    if (value <= l.hi) return l.color
  }
  return lv[lv.length - 1].color
}

function styleFor(f: FeatureLike): Style {
  const v = Number(f.get(field.value) ?? 0)
  const c = colorOf(v)
  return new Style({
    fill: new Fill({ color: c }),
    stroke: new Stroke({ color: 'rgba(10, 16, 24, 0.55)', width: 1 }),
  })
}

/* ------------------------------ 分级与重绘 ------------------------------ */

function rebuild() {
  if (!source) return
  const feats = source.getFeatures()
  const values = feats.map((f) => Number(f.get(field.value) ?? 0)).filter((v) => Number.isFinite(v))
  if (!values.length) return

  const n = classes.value
  const breaks = computeBreaks(values, method.value, n)
  const min = Math.min(...values)
  const max = Math.max(...values)

  const next: Level[] = []
  let lo = min
  for (let i = 0; i < n; i++) {
    const hi = i === n - 1 ? max : breaks[i]
    const cnt = values.filter((v) => (i === 0 ? v <= hi : v > breaks[i - 1] && v <= hi)).length
    next.push({ lo, hi, color: sampleRamp(i / (n - 1)), count: cnt })
    lo = hi
  }
  levels.value = next

  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
  stats.value = { count: values.length, min, max, mean, cv: mean ? sd / mean : 0 }

  layer?.changed()
}

/* ------------------------------ 数据 ------------------------------ */

function load() {
  if (!source) return
  const res = getFeature('city:builtup')
  const gj = new GeoJSON()
  const feats = gj.readFeatures(
    { type: 'FeatureCollection', features: res.features as never },
    { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' },
  )
  for (const f of feats) f.setId(String(f.getId()))
  source.clear()
  source.addFeatures(feats)
  rebuild()
}

function setMethod(m: Method) {
  method.value = m
  rebuild()
}

function setField(f: string) {
  field.value = f
  rebuild()
}

function setClasses(n: number) {
  classes.value = n
  rebuild()
}

/* ------------------------------ 悬停 ------------------------------ */

const unit = computed(() => FIELDS.find((f) => f.id === field.value)?.unit ?? '')

function onMove(evt: MapBrowserEvent<PointerEvent>) {
  if (!map || !tip) return
  // 回调里赋值会被 TS 收窄成 never，先收集再取
  const found: Feature[] = []
  map.forEachFeatureAtPixel(evt.pixel, (f) => {
    found.push(f as Feature)
    return true
  })
  const hit = found[0]
  if (hit) {
    const name = String(hit.get('name') ?? '—')
    const v = Number(hit.get(field.value) ?? 0)
    const fmt = field.value === 'population' ? v.toFixed(0) : v.toFixed(1)
    const idx = levels.value.findIndex((l) => v <= l.hi)
    hover.value = { name, value: v }
    // 副标题给「值 + 落在第几级」，比只说"最低级"更有信息量，也不会留下空占位
    tip.set(name, `${fmt} ${unit.value} · 第 ${idx < 0 ? levels.value.length : idx + 1} 级`)
    const p = map.getPixelFromCoordinate(evt.coordinate)
    if (p) tip.moveTo(p[0], p[1])
  } else {
    hover.value = null
    tip.hide()
  }
}

function onLeave() {
  hover.value = null
  tip?.hide()
}

/* ------------------------------ 生命周期 ------------------------------ */

onMounted(() => {
  const base = create()
  source = new VectorSource()
  layer = new VectorLayer({ source, style: styleFor as (f: FeatureLike) => Style })

  map = new OlMap({
    target: container.value!,
    layers: [base, layer],
    view: new View({ center: [0, 0], zoom: 7, minZoom: 5, maxZoom: 14 }),
  })
  reset()

  tip = createMeasureTip(container.value!)
  map.on('pointermove', onMove)
  map.getViewport().addEventListener('pointerleave', onLeave)

  load()
})

onBeforeUnmount(() => {
  map?.getViewport().removeEventListener('pointerleave', onLeave)
  tip?.destroy()
  map?.setTarget(undefined)
  map = null
  source = null
  layer = null
})

/* ------------------------------ 展示 ------------------------------ */

function fmt(v: number): string {
  if (field.value === 'population') return v >= 100 ? v.toFixed(0) : v.toFixed(0)
  return v.toFixed(1)
}
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="ol-container"></div>

    <MapControls
      :basemaps="OL_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="apply"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <!-- 左上：字段与分级方法 -->
    <div class="panel controls">
      <div class="head">
        <span>分级统计图</span>
        <span class="src">city:builtup · 67 面</span>
      </div>

      <div class="label">字段</div>
      <div class="segs">
        <button
          v-for="f in FIELDS"
          :key="f.id"
          class="seg"
          :class="{ on: field === f.id }"
          @click="setField(f.id)"
        >
          {{ f.label }}<i>{{ f.unit }}</i>
        </button>
      </div>

      <div class="label">分级方法</div>
      <div class="methods">
        <button
          v-for="m in METHODS"
          :key="m.id"
          class="method"
          :class="{ on: method === m.id }"
          @click="setMethod(m.id)"
        >
          <b>{{ m.label }}</b>
          <span>{{ m.note }}</span>
        </button>
      </div>

      <div class="label">级数</div>
      <div class="segs">
        <button
          v-for="n in [3, 4, 5, 6, 7]"
          :key="n"
          class="seg small"
          :class="{ on: classes === n }"
          @click="setClasses(n)"
        >
          {{ n }}
        </button>
      </div>

      <div class="stats">
        <div class="c"><b>{{ stats.count }}</b><span>要素</span></div>
        <div class="c"><b>{{ fmt(stats.max) }}</b><span>最大值</span></div>
        <div class="c"><b>{{ (stats.cv * 100).toFixed(0) }}%</b><span>变异系数</span></div>
      </div>

      <div class="tip">换一种分级方法，同一份数据会画出不同的图 —— 专题图的结论取决于分级。</div>
    </div>

    <!-- 左下：图例 -->
    <div class="panel legend">
      <div class="head">
        <span>图例</span>
        <span class="unit">{{ FIELDS.find((f) => f.id === field)?.label }} / {{ unit }}</span>
      </div>
      <div v-for="(l, i) in levels" :key="i" class="row">
        <span class="swatch" :style="{ background: l.color }"></span>
        <span class="range">{{ fmt(l.lo) }} – {{ fmt(l.hi) }}</span>
        <span class="cnt">{{ l.count }}</span>
      </div>
      <div class="foot">悬停任一区域查看数值</div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.ol-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  z-index: 20;
  border-radius: 11px;
  background: rgba(14, 20, 29, 0.92);
  border: 1px solid rgba(90, 112, 138, 0.4);
  color: #d7e2ee;
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.28);
  font-size: 12px;
}

/* ---------------- 控制面板 ---------------- */
.controls {
  left: 14px;
  top: 14px;
  width: 288px;
  padding: 11px 12px 12px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12px;
  color: #eaf2fb;
  font-weight: 600;
  padding-bottom: 9px;
  border-bottom: 1px solid rgba(90, 112, 138, 0.25);
}
.src {
  font-size: 9.5px;
  color: #6f8296;
  font-weight: 400;
}
.label {
  margin: 10px 0 6px;
  font-size: 10px;
  color: #7d8fa3;
  letter-spacing: 0.04em;
}
.segs {
  display: flex;
  gap: 5px;
}
.seg {
  flex: 1;
  padding: 5px 0;
  border-radius: 6px;
  border: 1px solid rgba(90, 112, 138, 0.38);
  background: transparent;
  color: #c3cfdb;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.seg i {
  font-style: normal;
  font-size: 9px;
  color: #5d7186;
  margin-left: 3px;
}
.seg:hover {
  border-color: rgba(79, 157, 255, 0.5);
}
.seg.on {
  background: rgba(79, 157, 255, 0.16);
  border-color: rgba(79, 157, 255, 0.62);
  color: #eaf2fb;
}
.seg.on i {
  color: #7bbcff;
}
.seg.small {
  font-variant-numeric: tabular-nums;
}

.methods {
  display: flex;
  gap: 5px;
}
.method {
  flex: 1;
  padding: 6px 5px;
  border-radius: 7px;
  border: 1px solid rgba(90, 112, 138, 0.35);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}
.method b {
  display: block;
  font-size: 11px;
  color: #c3cfdb;
  font-weight: 600;
}
.method span {
  display: block;
  font-size: 9px;
  color: #6f8296;
  margin-top: 2px;
  line-height: 1.35;
}
.method:hover {
  border-color: rgba(79, 157, 255, 0.5);
}
.method.on {
  background: rgba(79, 157, 255, 0.16);
  border-color: rgba(79, 157, 255, 0.62);
}
.method.on b {
  color: #eaf2fb;
}

.stats {
  display: flex;
  gap: 6px;
  margin-top: 11px;
}
.c {
  flex: 1;
  padding: 5px 7px;
  border-radius: 6px;
  background: rgba(28, 38, 52, 0.75);
  border: 1px solid rgba(90, 112, 138, 0.22);
}
.c b {
  display: block;
  font-size: 13px;
  color: #7ee2b8;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}
.c span {
  font-size: 9px;
  color: #7d8fa3;
}
.tip {
  margin-top: 9px;
  font-size: 10px;
  line-height: 1.45;
  color: #6f8296;
}

/* ---------------- 图例 ---------------- */
.legend {
  left: 14px;
  bottom: 14px;
  width: 288px;
  padding: 9px 11px 10px;
}
.legend .head {
  padding-bottom: 7px;
  font-weight: 500;
  font-size: 10.5px;
  color: #9db6cd;
}
.unit {
  font-size: 9px;
  color: #5d7186;
  font-weight: 400;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 10.5px;
  color: #a9bccf;
}
.swatch {
  width: 22px;
  height: 11px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  flex: none;
}
.range {
  flex: 1;
  font-variant-numeric: tabular-nums;
}
.cnt {
  color: #7ee2b8;
  font-variant-numeric: tabular-nums;
  font-size: 10px;
}
.foot {
  margin-top: 5px;
  padding-top: 6px;
  border-top: 1px dashed rgba(90, 112, 138, 0.22);
  font-size: 9.5px;
  color: #5d7186;
}
</style>
