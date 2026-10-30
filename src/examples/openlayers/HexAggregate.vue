<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import Polygon from 'ol/geom/Polygon'
import { Fill, Stroke, Style, Text } from 'ol/style'
import { fromLonLat } from 'ol/proj'
import type { Coordinate } from 'ol/coordinate'
import type OlBase from 'ol/Map'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

/* ============================================================
 * 蜂窝聚合分析（Hexbin）
 *
 * 为什么用六边形不用方格：六边形网格里任意点到中心的距离差更小（近圆形），
 * 且所有 6 个邻胞都是"共边"邻接（方格有共角/共边两种），做密度统计
 * 和空间自相关时偏差更小 —— 这就是共享单车/打车热力图都用 hexbin 的原因。
 *
 *  - 轴坐标系（axial coordinate, pointy-top）：像素 → 轴坐标 → 立方坐标取整
 *    （cube rounding：把 XYZ 舍入后修正误差最大的那个分量，保证映射回合法六边形）
 *  - 聚合：每个点的坐标换算成 (q, r)，Map 计数
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: OlBase | null = null

const LON = 104.07
const LAT = 30.67
const CENTER = fromLonLat([LON, LAT])
const HOME_ZOOM = 11.8
const SPAN_M = 26000 // 分析范围（米，正方形，3857 平面近似）

const { current: currentBasemap, create: createBase, apply: applyBasemap } = useOlBasemap('light')
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, HOME_ZOOM)

/* ---------------- 合成数据：共享单车骑行起点 ---------------- */
interface Trip {
  x: number
  y: number
}
const TRIPS: Trip[] = (() => {
  let a = 20261024
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0
    return a / 4294967296
  }
  const gauss = () => {
    const u = Math.max(rnd(), 1e-6)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
  }
  const out: Trip[] = []
  // 热点：市中心 CBD、两个地铁站、大学城、软件园
  const hotspots: Array<[number, number, number, number]> = [
    [0, 0, 1500, 620], // 春熙路
    [-5200, 3100, 1100, 420], // 地铁站 A
    [4600, -3600, 1300, 500], // 地铁站 B
    [-6800, -5200, 900, 300], // 大学城
    [7200, 4800, 1000, 360], // 软件园
  ]
  for (const [hx, hy, sx, sy] of hotspots) {
    for (let i = 0; i < 560; i++) {
      out.push({ x: hx + gauss() * sx, y: hy + gauss() * sy })
    }
  }
  // 沿"道路"散布：横竖网格线附近 ±120m
  for (let i = 0; i < 900; i++) {
    const alongRoad = rnd() < 0.5
    const line = Math.round((rnd() - 0.5) * 9) * 2600
    const pos = (rnd() - 0.5) * SPAN_M
    out.push(alongRoad ? { x: pos, y: line + gauss() * 120 } : { x: line + gauss() * 120, y: pos })
  }
  // 背景噪声
  for (let i = 0; i < 340; i++) {
    out.push({ x: (rnd() - 0.5) * SPAN_M, y: (rnd() - 0.5) * SPAN_M })
  }
  return out
})()

/* ---------------- Hexbin（pointy-top 轴坐标系） ---------------- */
const hexSize = ref(420) // 六边形外接圆半径（米）
const showCount = ref(true)

/** 像素 → 轴坐标（pointy-top）→ 立方取整 */
function pixelToHex(x: number, y: number, size: number): [number, number] {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size
  const r = ((2 / 3) * y) / size
  // 立方坐标取整
  let cx = q
  let cz = r
  let cy = -cx - cz
  const rx = Math.round(cx)
  const ry = Math.round(cy)
  const rz = Math.round(cz)
  const dx = Math.abs(rx - cx)
  const dy = Math.abs(ry - cy)
  const dz = Math.abs(rz - cz)
  if (dx > dy && dx > dz) cx = -ry - rz
  else if (dy > dz) cy = -rx - rz
  else cz = -rx - ry
  return [cx, cz]
}

/** 轴坐标 → 中心像素（pointy-top） */
function hexToPixel(q: number, r: number, size: number): [number, number] {
  return [size * Math.sqrt(3) * (q + r / 2), size * (3 / 2) * r]
}

/* ---------------- 渲染 ---------------- */
const stat = ref({ cells: 0, max: 0, top: '' })

let hexLayer: VectorLayer<Feature> | null = null

onMounted(() => {
  map = new OlMap({
    target: container.value,
    layers: [createBase()],
    view: new View({ center: CENTER, zoom: HOME_ZOOM, maxZoom: 17 }),
  })
  hexLayer = new VectorLayer({ source: new VectorSource(), zIndex: 5 })
  map.addLayer(hexLayer)
  drawInMapCoords()
})

/** 聚合与绘制都在 3857 平面坐标系进行（示例尺度下误差可接受） */
function drawInMapCoords() {
  const srcV = hexLayer?.getSource()
  if (!srcV) return
  srcV.clear()
  // 局部米 → 3857 坐标（一次性）
  const c0 = fromLonLat([LON, LAT])
  const pts = TRIPS.map((t) => [c0[0] + t.x, c0[1] + t.y] as [number, number])
  const size = hexSize.value
  const cells = new Map<string, { cx: number; cy: number; count: number }>()
  for (const [x, y] of pts) {
    const [q, r] = pixelToHex(x - c0[0], y - c0[1], size)
    const key = `${q},${r}`
    let cell = cells.get(key)
    if (!cell) {
      const [hx, hy] = hexToPixel(q, r, size)
      cell = { cx: hx + c0[0], cy: hy + c0[1], count: 0 }
      cells.set(key, cell)
    }
    cell.count++
  }
  const arr = [...cells.values()].sort((a, b) => b.count - a.count)
  const max = Math.max(arr[0]?.count ?? 1, 1)
  stat.value = {
    cells: arr.length,
    max,
    top: arr.length
      ? `${((arr[0].cx - c0[0]) / 1000).toFixed(1)}kmE ${((c0[1] - arr[0].cy) / 1000).toFixed(1)}kmS · ${arr[0].count} 次`
      : '—',
  }
  const color = (c: number) => {
    const t = Math.pow(c / max, 0.55)
    if (t < 0.5) {
      const k = t / 0.5
      return `rgba(${40 + k * 215}, ${110 + k * 110}, ${220 - k * 130}, 0.82)`
    }
    const k = (t - 0.5) / 0.5
    return `rgba(255, ${220 - k * 140}, ${90 - k * 60}, 0.88)`
  }
  for (const cell of arr) {
    const corners: Coordinate[] = []
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30)
      corners.push([cell.cx + size * Math.cos(a), cell.cy + size * Math.sin(a)])
    }
    corners.push(corners[0])
    const f = new Feature(new Polygon([corners]))
    f.setStyle(
      new Style({
        fill: new Fill({ color: color(cell.count) }),
        stroke: new Stroke({ color: 'rgba(20,28,38,0.5)', width: 1 }),
        text:
          showCount.value && (cell.count > max * 0.25 || size > 300)
            ? new Text({
                text: String(cell.count),
                font: '600 10px ui-monospace, monospace',
                fill: new Fill({ color: 'rgba(255,255,255,0.95)' }),
                stroke: new Stroke({ color: 'rgba(10,16,24,0.7)', width: 3 }),
                overflow: true,
              })
            : undefined,
      }),
    )
    srcV.addFeature(f)
  }
}

onBeforeUnmount(() => {
  map?.setTarget(undefined)
  map = null
})

watch([hexSize, showCount], drawInMapCoords)
watch(currentBasemap, applyBasemap)
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
      <div class="title">蜂窝聚合 · 共享单车热力</div>
      <div class="sub">Hexbin 分箱统计 —— 六边形比方格"更圆、邻接更均匀"</div>

      <div class="ctrl">
        <span class="lab">六边形尺寸</span>
        <input v-model.number="hexSize" type="range" min="180" max="900" step="30" />
        <b>{{ hexSize }}<i>m</i></b>
      </div>
      <div class="row">
        <button class="chip" :class="{ on: showCount }" @click="showCount = !showCount">
          {{ showCount ? '✓ 显示计数' : '显示计数' }}
        </button>
      </div>

      <div class="stat">
        <div class="item"><span class="k">轨迹点</span><b>{{ TRIPS.length }}</b></div>
        <div class="item"><span class="k">占用蜂窝</span><b>{{ stat.cells }}</b></div>
        <div class="item"><span class="k">单格峰值</span><b>{{ stat.max }}</b></div>
      </div>
      <div class="hint">最热蜂窝：{{ stat.top }}</div>

      <div class="tip">
        轨迹起点由「5 个高斯热点 + 沿街网格 + 背景噪声」合成。分箱用 <b>pointy-top 轴坐标系</b>：
        像素坐标先转轴坐标 (q, r)，再经<b>立方取整</b>（round 后修正偏差最大的分量）映射回合法六边形 ——
        这是 hexbin 的标准做法。把格子调大能看出热点从"五个孤岛"连成"组团"；
        调小则每个街区独立计数。城市尺度下的密度制图几乎都选六边形：任一点到格心距离更均匀、
        六邻域共边，空间统计偏差更小。
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
  width: 340px;
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
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 11px;
}
.ctrl .lab {
  color: #8fa0b3;
  flex: 0 0 58px;
}
.ctrl input[type='range'] {
  flex: 1;
  height: 3px;
  appearance: none;
  background: rgba(96, 116, 140, 0.5);
  border-radius: 2px;
  outline: none;
}
.ctrl input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #6fb3f2;
  border: 2px solid #0e141c;
  cursor: pointer;
}
.ctrl b {
  flex: 0 0 48px;
  text-align: right;
  font-family: ui-monospace, monospace;
  color: #ffd479;
  font-size: 11.5px;
}
.ctrl b i {
  font-size: 9.5px;
  font-style: normal;
  color: #7f90a3;
  margin-left: 1px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.chip {
  padding: 5px 8px;
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
.stat {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
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
.hint {
  margin-top: 8px;
  font-size: 11px;
  color: #9fb2c6;
  font-family: ui-monospace, monospace;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
