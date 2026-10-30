<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import OlMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import ImageLayer from 'ol/layer/Image'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import ImageStatic from 'ol/source/ImageStatic'
import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import { Fill, Stroke, Circle as CircleStyle, Style, Text } from 'ol/style'
import { fromLonLat } from 'ol/proj'
import type OlBase from 'ol/Map'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'
import { marchingSquares } from '@/examples/shared/terrain'

/* ============================================================
 * 降雨量空间插值（IDW 反距离加权）
 *
 *  IDW:  z(p) = Σ wᵢ·zᵢ / Σ wᵢ,   wᵢ = 1 / dᵢᵖ
 *  - 幂参数 p 越大 → 距离权重越"陡"，插值面越接近"泰森多边形"（坑坑洼洼）；
 *    p 越小 → 面越平滑，但局部极值被抹平。p=2 是最常用缺省。
 *  - 只取最近 k 个站而不是全部站，避免远处的站"隔着山说雨"。
 *  - 参数好不好不是靠感觉：用**留一交叉验证**（LOO-CV）——
 *    轮流把每个站藏起来、用剩下的站插值它，统计 MAE / RMSE，
 *    你拖动 p、k 时误差实时变化，能直接看到"过拟合/欠平滑"的权衡。
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let map: OlBase | null = null

const LON = 99.9
const LAT = 24.6
const SPAN_X = 64000
const SPAN_Y = 50000

const CENTER = fromLonLat([LON, LAT])
const HOME_ZOOM = 9.6

const { current: currentBasemap, create: createBase, apply: applyBasemap } = useOlBasemap('light')
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, CENTER, HOME_ZOOM)

/* ---------------- 雨量站（合成：西北迎风坡大，东南少） ---------------- */
interface Station {
  name: string
  lon: number
  lat: number
  x: number
  y: number
  value: number
}
const STATIONS: Station[] = (() => {
  let a = 20260601
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0
    return a / 4294967296
  }
  const out: Station[] = []
  const names = [
    '沧源', '双江', '耿马', '澜沧', '西盟', '孟连', '景谷', '镇沅', '景东', '云县',
    '临沧', '凤庆', '永德', '昌宁', '施甸', '龙陵', '腾冲', '梁河', '盈江', '陇川',
    '瑞丽', '芒市', '遮放', '打洛', '勐满', '勐仑', '易武', '江城', '绿春', '元阳',
    '金平', '宁洱', '思茅', '普洱', '景洪', '勐海', '勐腊', '红河', '墨江', '镇康',
    '永平', '云龙',
  ]
  for (let i = 0; i < 42; i++) {
    const u = 0.06 + rnd() * 0.88
    const v = 0.06 + rnd() * 0.88
    // 地形驱动：西北角高（多雨），加两团"局地暴雨中心"
    const orog = 1 - u * 0.75 - v * 0.35
    const hot1 = Math.exp(-(((u - 0.3) ** 2 + (v - 0.32) ** 2) / 0.012)) * 0.9
    const hot2 = Math.exp(-(((u - 0.74) ** 2 + (v - 0.62) ** 2) / 0.02)) * 0.7
    const val = 320 + orog * 980 + (hot1 + hot2) * 820 + (rnd() - 0.5) * 160
    out.push({
      name: (names[i] ?? `站${i}`) + '站',
      lon: LON - SPAN_X / 2 + u * SPAN_X,
      lat: LAT + SPAN_Y / 2 - v * SPAN_Y,
      x: u,
      y: v,
      value: Math.round(val),
    })
  }
  return out
})()

/* ---------------- 插值 ---------------- */
const power = ref(2) // 幂参数 p
const kNN = ref(8) // 最近站数 k
const showContour = ref(true)
const showStations = ref(true)

const NX = 160
const NY = 125
const field = new Float32Array(NX * NY)
const stat = ref({ mae: 0, rmse: 0, min: 0, max: 0, mean: 0 })

/** 对归一化 uv 点做 IDW（stations 里排除 exclude） */
function idwAt(u: number, v: number, p: number, k: number, exclude = -1): number {
  // 计算距离并取最近 k 个（站数只有 42，直接选择排序前 k）
  const dists: Array<[number, number]> = []
  for (let i = 0; i < STATIONS.length; i++) {
    if (i === exclude) continue
    const s = STATIONS[i]
    const d2 = (s.x - u) ** 2 + (s.y - v) ** 2
    dists.push([d2, s.value])
  }
  dists.sort((a, b) => a[0] - b[0])
  let sw = 0
  let acc = 0
  const n = Math.min(k, dists.length)
  for (let i = 0; i < n; i++) {
    const w = 1 / Math.pow(Math.sqrt(dists[i][0]) + 1e-4, p)
    sw += w
    acc += w * dists[i][1]
  }
  return acc / sw
}

function computeField() {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (let j = 0; j < NY; j++) {
    const v = j / (NY - 1)
    for (let i = 0; i < NX; i++) {
      const z = idwAt(i / (NX - 1), v, power.value, kNN.value)
      field[j * NX + i] = z
      if (z < min) min = z
      if (z > max) max = z
      sum += z
    }
  }
  // 留一交叉验证
  let se = 0
  let ae = 0
  for (let i = 0; i < STATIONS.length; i++) {
    const est = idwAt(STATIONS[i].x, STATIONS[i].y, power.value, kNN.value, i)
    const err = est - STATIONS[i].value
    ae += Math.abs(err)
    se += err * err
  }
  stat.value = {
    mae: ae / STATIONS.length,
    rmse: Math.sqrt(se / STATIONS.length),
    min,
    max,
    mean: sum / field.length,
  }
}

/* ---------------- 渲染 ---------------- */
const TEX = 720
const TH = Math.round((TEX * SPAN_Y) / SPAN_X)

function bakeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = TEX
  canvas.height = TH
  const g = canvas.getContext('2d')!
  const img = g.createImageData(TEX, TH)
  const d = img.data
  const lo = stat.value.min
  const hi = Math.max(stat.value.max, lo + 1)
  const stops: Array<[number, number[]]> = [
    [0, [236, 244, 250]],
    [0.22, [172, 216, 232]],
    [0.42, [120, 190, 168]],
    [0.6, [240, 220, 110]],
    [0.78, [234, 150, 76]],
    [1, [190, 56, 48]],
  ]
  const ramp = (t: number) => {
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i]
      const [t1, c1] = stops[i + 1]
      if (t <= t1) {
        const k = (t - t0) / (t1 - t0)
        return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
      }
    }
    return stops[stops.length - 1][1]
  }
  for (let py = 0; py < TH; py++) {
    const fj = Math.round((py / (TH - 1)) * (NY - 1))
    for (let px = 0; px < TEX; px++) {
      const fi = Math.round((px / (TEX - 1)) * (NX - 1))
      const t = (field[fj * NX + fi] - lo) / (hi - lo)
      const c = ramp(t)
      const k = (py * TEX + px) << 2
      d[k] = c[0]
      d[k + 1] = c[1]
      d[k + 2] = c[2]
      d[k + 3] = 200
    }
  }
  g.putImageData(img, 0, 0)
  if (showContour.value) {
    const step = 100
    for (let level = Math.ceil(lo / step) * step; level < hi; level += step) {
      const segs = marchingSquares(field, NX, level)
      g.strokeStyle = 'rgba(30,34,40,0.55)'
      g.lineWidth = 1.2
      g.beginPath()
      for (let i = 0; i < segs.length; i += 4) {
        g.moveTo((segs[i] / (NX - 1)) * TEX, (segs[i + 1] / (NY - 1)) * TH)
        g.lineTo((segs[i + 2] / (NX - 1)) * TEX, (segs[i + 3] / (NY - 1)) * TH)
      }
      g.stroke()
    }
  }
  return canvas
}

let imageLayer: ImageLayer<ImageStatic> | null = null
let stLayer: VectorLayer<Feature> | null = null

// ImageStatic 需要 [minX, minY, maxX, maxY]（西南、东北角）
const extent = fromLonLat([LON - SPAN_X / 2, LAT - SPAN_Y / 2]).concat(
  fromLonLat([LON + SPAN_X / 2, LAT + SPAN_Y / 2]),
) as [number, number, number, number]

function drawStations() {
  const srcV = stLayer?.getSource()
  if (!srcV) return
  srcV.clear()
  if (!showStations.value) return
  const lo = stat.value.min
  const hi = Math.max(stat.value.max, lo + 1)
  for (const s of STATIONS) {
    const f = new Feature(new Point(fromLonLat([s.lon, s.lat])))
    f.set('name', s.name)
    const t = (s.value - lo) / (hi - lo)
    f.setStyle(
      new Style({
        image: new CircleStyle({
          radius: 4 + t * 4,
          fill: new Fill({ color: 'rgba(255,255,255,0.85)' }),
          stroke: new Stroke({ color: '#14202c', width: 2 }),
        }),
        text: new Text({
          text: `${s.value}`,
          offsetY: -12,
          font: '600 10px ui-monospace, monospace',
          fill: new Fill({ color: '#101820' }),
          stroke: new Stroke({ color: 'rgba(255,255,255,0.85)', width: 3 }),
        }),
      }),
    )
    srcV.addFeature(f)
  }
}

function refresh() {
  computeField()
  if (map && imageLayer) {
    map.removeLayer(imageLayer)
    imageLayer = new ImageLayer({
      source: new ImageStatic({
        url: bakeCanvas().toDataURL('image/png'),
        imageExtent: extent,
        projection: 'EPSG:3857',
      }),
      zIndex: 1,
    })
    map.getLayers().insertAt(1, imageLayer)
  }
  drawStations()
}

const qualityText = computed(() =>
  stat.value.mae < 45 ? '很好' : stat.value.mae < 80 ? '一般' : '偏差',
)

onMounted(() => {
  map = new OlMap({
    target: container.value,
    layers: [createBase()],
    view: new View({ center: CENTER, zoom: HOME_ZOOM, maxZoom: 17 }),
  })
  imageLayer = new ImageLayer({
    source: new ImageStatic({
      url: bakeCanvas().toDataURL('image/png'),
      imageExtent: extent,
      projection: 'EPSG:3857',
    }),
    zIndex: 1,
  })
  map.addLayer(imageLayer)
  stLayer = new VectorLayer({ source: new VectorSource(), zIndex: 8 })
  map.addLayer(stLayer)
  computeField()
  drawStations()
})

watch([power, kNN, showContour, showStations], refresh)
watch(currentBasemap, applyBasemap)

onBeforeUnmount(() => {
  map?.setTarget(undefined)
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
      <div class="title">降雨量空间插值 · IDW</div>
      <div class="sub">反距离加权 + 等雨量线 + 留一交叉验证评分</div>

      <div class="ctrl">
        <span class="lab">幂参数 p</span>
        <input v-model.number="power" type="range" min="0.5" max="5" step="0.5" />
        <b>{{ power.toFixed(1) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">邻站数 k</span>
        <input v-model.number="kNN" type="range" min="3" max="16" step="1" />
        <b>{{ kNN }}<i>站</i></b>
      </div>

      <div class="row">
        <button class="chip" :class="{ on: showContour }" @click="showContour = !showContour">
          {{ showContour ? '✓ 等雨量线（100mm）' : '等雨量线（100mm）' }}
        </button>
        <button class="chip" :class="{ on: showStations }" @click="showStations = !showStations">
          {{ showStations ? '✓ 雨量站' : '雨量站' }}
        </button>
      </div>

      <div class="stat">
        <div class="item"><span class="k">多年均值</span><b>{{ stat.mean.toFixed(0) }}<i>mm</i></b></div>
        <div class="item"><span class="k">最大</span><b>{{ stat.max.toFixed(0) }}<i>mm</i></b></div>
        <div class="item"><span class="k">最小</span><b>{{ stat.min.toFixed(0) }}<i>mm</i></b></div>
        <div class="item good"><span class="k">交叉验证 MAE</span><b>{{ stat.mae.toFixed(1) }}</b></div>
        <div class="item good"><span class="k">RMSE</span><b>{{ stat.rmse.toFixed(1) }}</b></div>
        <div class="item"><span class="k">插值质量</span><b>{{ qualityText }}</b></div>
      </div>

      <div class="tip">
        IDW 公式：z(p) = Σ(1/dᵢᵖ)·zᵢ ÷ Σ(1/dᵢᵖ)。把 p 拉到 5，插值面会碎成"牛眼"
        （每个站周围一个圈，等价于泰森多边形）；拉到 0.5 又糊成一片 ——
        <b>留一交叉验证</b>（轮流藏起一个站用其余站估计它）会用 MAE / RMSE 告诉你哪个参数真的更好，
        而不是看起来更漂亮。站点数据按"西北迎风坡多雨 + 两个暴雨中心"合成，真值已知。
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
  flex: 0 0 52px;
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
  flex: 0 0 44px;
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
.item.good {
  border-color: rgba(110, 200, 140, 0.5);
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
.item b i {
  font-size: 9.5px;
  font-style: normal;
  color: #7f90a3;
  margin-left: 2px;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
