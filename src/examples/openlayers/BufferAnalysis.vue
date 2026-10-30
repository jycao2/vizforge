<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import LineString from 'ol/geom/LineString'
import Polygon from 'ol/geom/Polygon'
import Circle from 'ol/geom/Circle'
import Draw from 'ol/interaction/Draw'
import Select from 'ol/interaction/Select'
import { Fill, Stroke, Circle as CircleStyle, Text, Style } from 'ol/style'
import { getArea, getLength } from 'ol/sphere'
import { fromLonLat, toLonLat } from 'ol/proj'
import type { Coordinate } from 'ol/coordinate'
import type { FeatureLike } from 'ol/Feature'
import type OlBase from 'ol/Map'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

/* ============================================================
 * 缓冲区分析
 *  - 点缓冲：ol/sphere 的 circular() 在球面上按大地线画 256 边形（比"投影坐标里画圆"准）
 *  - 线缓冲：逐线段左右两侧做法向平移（miter join）+ 端点半圆帽，拼成一个闭合多边形
 *  - 叠加统计：梗多边形用 geometry.intersectsCoordinate 逐一判断点位是否落入，
 *    面积/长度分别用 getArea / getLength —— 这两个函数是椭球面上的真值，不是投影平面的
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: OlBase | null = null

const CENTER = fromLonLat([116.391, 39.907])
const HOME_ZOOM = 11.4

const { current: currentBasemap, create: createBase, apply: applyBasemap } = useOlBasemap('light')
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, HOME_ZOOM)

/* ---------------- 参数 ---------------- */
const radius = ref(1500) // 缓冲半径（米）
const mode = ref<'point' | 'line'>('point')
const affectText = ref('暂无缓冲区')
const areaText = ref('—')
const lenText = ref('—')

/* ---------------- 数据：合成的兴趣点 ---------------- */
type Kind = '学校' | '医院' | '商业' | '公园'
const KIND_COLOR: Record<Kind, string> = {
  学校: '#4aa3ff',
  医院: '#ff6b6b',
  商业: '#ffd166',
  公园: '#4ade80',
}
interface Poi {
  coord: number[]
  name: string
  kind: Kind
}
const POIS: Poi[] = (() => {
  const rnd = (() => {
    let a = 97531
    return () => {
      a = (a * 1103515245 + 12345) & 0x7fffffff
      return a / 0x7fffffff
    }
  })()
  const kinds: Kind[] = ['学校', '医院', '商业', '公园']
  const out: Poi[] = []
  // 中心密集簇：保证默认 1.5km 缓冲就能圈中一批
  for (let i = 0; i < 46; i++) {
    const lon = 116.391 + (rnd() - 0.5) * 0.024
    const lat = 39.907 + (rnd() - 0.5) * 0.02
    out.push({
      coord: fromLonLat([lon, lat]),
      name: `${kinds[i % 4]}${i + 1}号`,
      kind: kinds[i % 4],
    })
  }
  // 外围 4 个小簇 + 散点：让「区外」也有足够多的点
  for (let i = 0; i < 120; i++) {
    const cluster = i % 4
    const cl = [116.32, 116.48, 116.36, 116.44][cluster]
    const ca = [39.96, 39.85, 39.83, 40.0][cluster]
    const nearCenter = i % 11 === 0
    const lon = (nearCenter ? 116.391 : cl) + (rnd() - 0.5) * (nearCenter ? 0.01 : 0.16)
    const lat = (nearCenter ? 39.907 : ca) + (rnd() - 0.5) * (nearCenter ? 0.009 : 0.14)
    out.push({
      coord: fromLonLat([lon, lat]),
      name: `${kinds[i % 4]}${i + 47}号`,
      kind: kinds[i % 4],
    })
  }
  return out
})()

const poiSrc = new VectorSource()
POIS.forEach((p) => {
  poiSrc.addFeature(
    new Feature({ geometry: new Point(p.coord), name: p.name, kind: p.kind, hit: false }),
  )
})

const bufferSrc = new VectorSource()
const axisSrc = new VectorSource() // 参与分析的源几何（点或线）

/* ---------------- 几何：线缓冲 ---------------- */
/** 线段左右两侧法向平移 + 端点半圆帽，拼成闭合多边形（输入为投影坐标） */
function lineBuffer(coords: Coordinate[], dist: number, caps = 12): Coordinate[] {
  if (coords.length < 2) return coords
  const left: Coordinate[] = []
  const right: Coordinate[] = []

  for (let i = 0; i < coords.length; i++) {
    // 每个顶点取其相邻两段的方向均值（miter 法向量的算法），端点退化成单段法向
    const prev = coords[Math.max(0, i - 1)]
    const next = coords[Math.min(coords.length - 1, i + 1)]
    let nx = 0
    let ny = 0
    const segs: Array<[Coordinate, Coordinate]> = [
      [coords[i], next],
      [prev, coords[i]],
    ]
    for (const [a, b] of segs) {
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) continue
      // 左手法向
      nx += -dy / len
      ny += dx / len
    }
    const l = Math.hypot(nx, ny) || 1
    // miter 长度修正：夹角越小，偏移越长，否则内侧会出现缺口
    const miter = Math.min(1 / Math.max(0.35, l / 2), 2.2)
    left.push([coords[i][0] + (nx / l) * dist * miter, coords[i][1] + (ny / l) * dist * miter] as Coordinate)
    right.push([
      coords[i][0] - (nx / l) * dist * miter,
      coords[i][1] - (ny / l) * dist * miter,
    ] as Coordinate)
  }

  const ring: Coordinate[] = [...left]
  // 终点半圆帽
  const last = coords[coords.length - 1]
  const prevLast = coords[coords.length - 2]
  const inAng = Math.atan2(last[1] - prevLast[1], last[0] - prevLast[0])
  for (let k = 1; k < caps; k++) {
    const a = inAng - Math.PI / 2 + (Math.PI * k) / caps
    ring.push([last[0] + Math.cos(a) * dist, last[1] + Math.sin(a) * dist] as Coordinate)
  }
  ring.push(...right.reverse())
  // 起点半圆帽
  const first = coords[0]
  const nextFirst = coords[1]
  const outAng = Math.atan2(first[1] - nextFirst[1], first[0] - nextFirst[0])
  for (let k = 1; k < caps; k++) {
    const a = outAng + Math.PI / 2 + (Math.PI * k) / caps
    ring.push([first[0] + Math.cos(a) * dist, first[1] + Math.sin(a) * dist] as Coordinate)
  }
  ring.push(left[0])
  return ring
}

/**
 * 点缓冲：自己按球面大地线推一圈点位。
 * OL 9 已经移除了 ol/sphere 的 circular()，而在投影坐标系（Web Mercator）里直接画圆会在
 * 高纬明显失真 —— 北京这种中纬城市靠 centre-mercator 拉伸也有约 30% 的纵向夸长，
 * 所以这里按「已知起点 + 方位角 + 距离求终点」的球面公式逐点推算，再转回投影坐标。
 */
function pointBuffer(coord: Coordinate, dist: number, sides = 256): Polygon {
  const R = 6371008.8
  const [lon0, lat0] = toLonLat(coord)
  const fi0 = (lat0 * Math.PI) / 180
  const la0 = (lon0 * Math.PI) / 180
  const d = dist / R
  const sinD = Math.sin(d)
  const cosD = Math.cos(d)
  const ring: number[] = []
  for (let i = 0; i <= sides; i++) {
    const brg = ((i % sides) / sides) * Math.PI * 2
    const fi = Math.asin(Math.sin(fi0) * cosD + Math.cos(fi0) * sinD * Math.cos(brg))
    const la =
      la0 +
      Math.atan2(
        Math.sin(brg) * sinD * Math.cos(fi0),
        cosD - Math.sin(fi0) * Math.sin(fi),
      )
    const ll: [number, number] = [(la * 180) / Math.PI, (fi * 180) / Math.PI]
    ring.push(...fromLonLat(ll))
  }
  // fromLonLat 返回 [x, y]，Polygon 需要 Coordinate[]
  const coords: Coordinate[] = []
  for (let i = 0; i < ring.length; i += 2) coords.push([ring[i], ring[i + 1]])
  return new Polygon([coords])
}

/* ---------------- 分析流程 ---------------- */
const bufferLayer = new VectorLayer({
  source: bufferSrc,
  style: new Style({
    fill: new Fill({ color: 'rgba(58, 141, 255, 0.22)' }),
    stroke: new Stroke({ color: 'rgba(90, 170, 255, 0.95)', width: 2, lineDash: [6, 4] }),
  }),
})

const axisLayer = new VectorLayer({
  source: axisSrc,
  style: (f: FeatureLike) => {
    const isLine = f.getGeometry()?.getType() === 'LineString'
    return [
      new Style({
        stroke: new Stroke({ color: '#ffd166', width: 3 }),
        image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#ffd166' }), stroke: new Stroke({ color: '#1b2430', width: 2 }) }),
        text: isLine
          ? undefined
          : new Text({
              text: '分析点',
              offsetY: -16,
              font: '500 11px "Microsoft YaHei", sans-serif',
              fill: new Fill({ color: '#ffe9a8' }),
              stroke: new Stroke({ color: 'rgba(0,0,0,0.7)', width: 3 }),
            }),
      }),
    ]
  },
})

const poiLayer = new VectorLayer({
  source: poiSrc,
  style: (f: FeatureLike) => {
    const hit = f.get('hit') === true
    const kind = f.get('kind') as Kind
    return new Style({
      image: new CircleStyle({
        radius: hit ? 6 : 4,
        fill: new Fill({ color: KIND_COLOR[kind] ?? '#9fb0c2' }),
        stroke: new Stroke({
          color: hit ? '#ffffff' : 'rgba(10,16,24,0.7)',
          width: hit ? 2 : 1,
        }),
      }),
      // 命中点很多时会互相压成墨团，这里只做白圈高亮，具体名单交给面板统计
      text: undefined,
    })
  },
})

let draw: Draw | null = null

function clearAll() {
  bufferSrc.clear()
  axisSrc.clear()
  poiSrc.getFeatures().forEach((f) => f.set('hit', false))
  affectText.value = '暂无缓冲区'
  areaText.value = '—'
  lenText.value = '—'
}

function analyze() {
  const feats = axisSrc.getFeatures()
  if (!feats.length) return
  const g = feats[0].getGeometry()
  if (!g) return

  bufferSrc.clear()
  let polys: Polygon[] = []
  if (g.getType() === 'Point') {
    const c = (g as Point).getCoordinates()
    polys = [pointBuffer(c, radius.value)]
  } else if (g.getType() === 'LineString') {
    const coords = (g as LineString).getCoordinates()
    polys = [new Polygon([lineBuffer(coords, radius.value)])]
  } else if (g.getType() === 'Circle') {
    const ci = g as Circle
    polys = [pointBuffer(ci.getCenter(), ci.getRadius())]
  }
  polys.forEach((p) => bufferSrc.addFeature(new Feature({ geometry: p })))

  // 叠加统计：逐个点判断是否落在任一缓冲区内
  let hit = 0
  const byKind: Record<string, number> = { 学校: 0, 医院: 0, 商业: 0, 公园: 0 }
  poiSrc.getFeatures().forEach((f) => {
    const pc = (f.getGeometry() as Point).getCoordinates()
    const inside = polys.some((p) => p.intersectsCoordinate(pc))
    f.set('hit', inside)
    if (inside) {
      hit++
      byKind[f.get('kind') as string] = (byKind[f.get('kind') as string] ?? 0) + 1
    }
  })

  const areaKm2 = polys.reduce((s, p) => s + getArea(p), 0) / 1e6
  areaText.value = `${areaKm2.toFixed(2)} km²`
  const detail = Object.entries(byKind)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}${v}`)
    .join(' · ')
  affectText.value = hit ? `影响 ${hit} 处：${detail}` : '缓冲区内暂无兴趣点'
  lenText.value =
    g.getType() === 'LineString'
      ? `${(getLength(g) / 1000).toFixed(2)} km`
      : `半径 ${(radius.value / 1000).toFixed(2)} km`
}

function startDraw() {
  if (!map || draw) return
  draw = new Draw({
    source: axisSrc,
    type: mode.value === 'point' ? 'Point' : 'LineString',
    freehand: false,
  })
  draw.on('drawend', () => {
    stopDraw()
    analyze()
  })
  map.addInteraction(draw)
}

function stopDraw() {
  if (map && draw) map.removeInteraction(draw)
  draw = null
}

function placeCenter(coord: Coordinate) {
  axisSrc.clear()
  axisSrc.addFeature(new Feature({ geometry: new Point(coord) }))
  analyze()
}

const select = new Select({ layers: [poiLayer] })

const modeLabel = computed(() => (mode.value === 'point' ? '点缓冲' : '线缓冲'))

watch([radius, mode], () => {
  stopDraw()
  analyze()
})

onMounted(() => {
  map = new OlMap({
    target: container.value,
    layers: [createBase(), bufferLayer, poiLayer, axisLayer],
    view: new View({ center: CENTER, zoom: HOME_ZOOM, maxZoom: 17 }),
  })
  map.addInteraction(select)
  select.on('select', (e) => {
    const f = e.selected[0]
    if (!f) return
    mode.value = 'point'
    placeCenter((f.getGeometry() as Point).getCoordinates())
    const name = f.get('name') as string
    const kind = f.get('kind') as Kind
    // placeCenter 内部会跑一次统计，这里只把标题拼得更具体
    affectText.value = `以「${name}（${kind}）」为中心 ${(radius.value / 1000).toFixed(1)} km 缓冲 · ${affectText.value.replace('影响 ', '')}`
    select.getFeatures().clear()
  })

  // 默认：以市中心做一个示范缓冲
  setTimeout(() => {
    axisSrc.clear()
    axisSrc.addFeature(new Feature({ geometry: new Point(fromLonLat([116.391, 39.907])) }))
    analyze()
  }, 200)

})

onBeforeUnmount(() => {
  stopDraw()
  map?.removeInteraction(select)
  if (map) map.setTarget(undefined)
  map = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="ol-container"></div>

    <MapControls
      :basemaps="OL_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="panel">
      <div class="title">缓冲区分析 · {{ modeLabel }}</div>
      <div class="sub">球面大地线画点缓冲，法向平移走线缓冲，再叠加统计受影响点位</div>

      <div class="row">
        <span class="lab">缓冲半径</span>
        <input v-model.number="radius" type="range" min="300" max="6000" step="100" />
        <b>{{ (radius / 1000).toFixed(1) }}<i>km</i></b>
      </div>

      <div class="row btns">
        <button class="chip" :class="{ on: mode === 'point' }" @click="mode = 'point'">点缓冲</button>
        <button class="chip" :class="{ on: mode === 'line' }" @click="mode = 'line'">线缓冲</button>
        <button class="chip primary" @click="startDraw">画{{ mode === 'point' ? '点' : '线' }}</button>
        <button class="chip" @click="clearAll">清空</button>
      </div>

      <div class="stat">
        <div class="item"><span class="k">缓冲面积</span><b>{{ areaText }}</b></div>
        <div class="item"><span class="k">源几何</span><b>{{ lenText }}</b></div>
      </div>

      <div class="affect">{{ affectText }}</div>

      <div class="legend">
        <span v-for="(c, k) in KIND_COLOR" :key="k" class="lg">
          <i :style="{ background: c }"></i>{{ k }}
        </span>
        <span class="hint">白圈=落入缓冲区</span>
      </div>

      <div class="tip">
        点击任意兴趣点即以它为中心作缓冲；也可以在地图上画一条折线做线缓冲。
        点缓冲用 <code>circular()</code> 沿球面大地线取 256 个点（投影坐标系里画圆在高纬会失真），
        线缓冲则用相邻段的平均法向做 miter 平移，配合端点半圆帽闭合。
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.ol-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  width: 344px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(13, 19, 27, 0.9);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.sub {
  margin-top: 3px;
  font-size: 11px;
  color: #7d8fa2;
  line-height: 1.5;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 11px;
}
.row .lab {
  color: #8fa0b3;
  flex: 0 0 52px;
}
.row input[type='range'] {
  flex: 1;
  accent-color: #4f9dff;
}
.row b {
  flex: 0 0 52px;
  text-align: right;
  font-family: ui-monospace, monospace;
  color: #ffd479;
  font-size: 11.5px;
}
.row b i {
  font-size: 9.5px;
  font-style: normal;
  color: #7f90a3;
  margin-left: 1px;
}
.btns {
  gap: 6px;
}
.chip {
  padding: 5px 9px;
  font-size: 11px;
  border-radius: 7px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #b9c8d8;
  cursor: pointer;
  transition: all 0.15s;
}
.chip:hover {
  border-color: rgba(120, 165, 220, 0.75);
  color: #e6f0fa;
}
.chip.on {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.chip.primary {
  background: linear-gradient(180deg, rgba(56, 148, 92, 0.95), rgba(38, 108, 68, 0.95));
  border-color: rgba(108, 200, 140, 0.6);
  color: #eafff2;
}
.stat {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 10px;
}
.item {
  padding: 6px 8px;
  border-radius: 7px;
  background: rgba(28, 38, 50, 0.75);
  border: 1px solid rgba(80, 100, 124, 0.3);
}
.item .k {
  display: block;
  font-size: 10px;
  color: #7f90a3;
}
.item b {
  font-size: 13px;
  font-weight: 600;
  color: #e9f1fa;
  font-family: ui-monospace, monospace;
}
.affect {
  margin-top: 8px;
  padding: 6px 9px;
  border-radius: 7px;
  background: rgba(74, 163, 255, 0.12);
  border: 1px solid rgba(74, 163, 255, 0.35);
  font-size: 11px;
  color: #cfe6ff;
}
.legend {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 8px;
  font-size: 10.5px;
  color: #9fb0c3;
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lg i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.legend .hint {
  margin-left: auto;
  color: #7f90a3;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
.tip code {
  background: rgba(80, 100, 124, 0.28);
  border-radius: 3px;
  padding: 0 3px;
  color: #a9c6e6;
}
</style>
