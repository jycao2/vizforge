<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

/* ============================================================
 * 城市热力图（自绘栅格 + 自定义图层）
 *  - 密度场：每个样本点画一团「径向渐变的灰度」并叠加混合，得到一张灰度密度图
 *  - 着色：把灰度值当作色带的索引，逐像素查 256 级色带，得到最终 RGBA
 *  - 落图：红色一张 Primitive（RectangleGeometry + 自定义材质），更新时只换材质上的
 *          ImageBitmap，几何不变 —— 既不重建图元也不会像 dataURL 那样闪白
 *  - 数据：围绕若干通勤热点合成的高斯分布样本，City 尺度（约 46km），
 *          曲面高差约 40m，所以底板抬到 90m 保证不被地球表面吃掉
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 116.391
const LAT = 39.907

/** 覆盖范围（正负都按公里换算成纬度），约 46km × 40km 的城市尺度 */
const SPAN_X = 23000 // 米
const SPAN_Y = 20000
const SITE = {
  lon0: LON - Cesium.Math.toDegrees(SPAN_X / 6371000 / Math.cos(Cesium.Math.toRadians(LAT))),
  lon1: LON + Cesium.Math.toDegrees(SPAN_X / 6371000 / Math.cos(Cesium.Math.toRadians(LAT))),
  lat0: LAT - Cesium.Math.toDegrees(SPAN_Y / 6371000),
  lat1: LAT + Cesium.Math.toDegrees(SPAN_Y / 6371000),
}
const PLATE_H = 90 // 底板离地高度（米）

const CW = 720
const CH = Math.round((CW * (SITE.lat1 - SITE.lat0)) / (SITE.lon1 - SITE.lon0))

/* ---------------- 色带 ---------------- */
interface Ramp {
  id: string
  label: string
  stops: Array<[number, string]>
}
const RAMPS: Ramp[] = [
  {
    id: 'warm',
    label: '晨昏 (蓝→红)',
    stops: [
      [0, 'rgba(8, 24, 58, 0)'],
      [0.18, 'rgba(20, 84, 160, 0.5)'],
      [0.42, 'rgba(60, 200, 170, 0.72)'],
      [0.62, 'rgba(240, 220, 80, 0.85)'],
      [0.82, 'rgba(250, 130, 40, 0.93)'],
      [1, 'rgba(226, 42, 46, 0.98)'],
    ],
  },
  {
    id: 'night',
    label: '夜灯 (黑→白)',
    stops: [
      [0, 'rgba(0, 0, 0, 0)'],
      [0.25, 'rgba(48, 74, 130, 0.55)'],
      [0.55, 'rgba(122, 168, 220, 0.8)'],
      [0.8, 'rgba(232, 226, 200, 0.92)'],
      [1, 'rgba(255, 255, 245, 1)'],
    ],
  },
  {
    id: 'eco',
    label: '生态 (青→黄)',
    stops: [
      [0, 'rgba(0, 20, 30, 0)'],
      [0.22, 'rgba(16, 96, 112, 0.5)'],
      [0.5, 'rgba(48, 160, 120, 0.75)'],
      [0.74, 'rgba(160, 210, 90, 0.88)'],
      [1, 'rgba(246, 246, 150, 0.98)'],
    ],
  },
]

/** 把色带烘成 256×1 的查找表 */
function bakeRamp(ramp: Ramp): Uint8ClampedArray {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 1
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 256, 0)
  ramp.stops.forEach(([at, color]) => grad.addColorStop(at, color))
  g.fillStyle = grad
  g.fillRect(0, 0, 256, 1)
  return g.getImageData(0, 0, 256, 1).data
}

/* ---------------- 数据：若干热点叠加高斯散布 ---------------- */
interface Hot {
  name: string
  dLon: number
  dLat: number
  n: number
  sigma: number
}
const HOTSPOTS: Hot[] = [
  { name: '国贸', dLon: 0.026, dLat: -0.012, n: 320, sigma: 0.016 },
  { name: '中关村', dLon: -0.062, dLat: 0.032, n: 260, sigma: 0.018 },
  { name: '望京', dLon: 0.048, dLat: 0.062, n: 220, sigma: 0.015 },
  { name: '西二旗', dLon: -0.058, dLat: 0.078, n: 200, sigma: 0.014 },
  { name: '金融街', dLon: -0.008, dLat: 0.006, n: 180, sigma: 0.011 },
  { name: '亦庄', dLon: 0.03, dLat: -0.09, n: 150, sigma: 0.02 },
  { name: '通州', dLon: 0.13, dLat: -0.03, n: 140, sigma: 0.022 },
]

/** 固定种子的伪随机，保证每次打开图形一致 */
function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Sample {
  lon: number
  lat: number
  w: number
}
const SAMPLES: Sample[] = (() => {
  const rnd = mulberry(20260621)
  const out: Sample[] = []
  for (const h of HOTSPOTS) {
    for (let i = 0; i < h.n; i++) {
      // Box-Muller：两个均匀分布转出一个正态分布
      const u1 = Math.max(rnd(), 1e-6)
      const u2 = rnd()
      const r = Math.sqrt(-2 * Math.log(u1))
      const t = 2 * Math.PI * u2
      const dx = r * Math.cos(t) * h.sigma
      const dy = r * Math.sin(t) * h.sigma * 0.72
      const sc = SPAN_X / 111320
      out.push({
        lon: LON + h.dLon + dx * sc * 0.9,
        lat: LAT + h.dLat + dy * (SPAN_Y / 110540),
        w: 0.35 + rnd() * 0.65,
      })
    }
  }
  // 再撒一层背景通勤散点
  for (let i = 0; i < 420; i++) {
    out.push({
      lon: LON + (rnd() - 0.5) * (SITE.lon1 - SITE.lon0) * 0.98,
      lat: LAT + (rnd() - 0.5) * (SITE.lat1 - SITE.lat0) * 0.98,
      w: 0.12 + rnd() * 0.2,
    })
  }
  return out
})()
const TOTAL = SAMPLES.length

/* ---------------- 参数 ---------------- */
const radius = ref(26) // 单个样本的影响半径（画布像素）
const boost = ref(1.15) // 强度（>1 提亮低密度区，<1 突出核心）
const opacity = ref(0.95)
const rampId = ref('warm')
const showPoints = ref(false)
const maxValue = ref(0)

const ramp = computed(() => RAMPS.find((r) => r.id === rampId.value) ?? RAMPS[0])

/* ---------------- 画布 ---------------- */
const densityCanvas = document.createElement('canvas')
densityCanvas.width = CW
densityCanvas.height = CH
const outCanvas = document.createElement('canvas')
outCanvas.width = CW
outCanvas.height = CH

/** 灰度积累层（只画一次？半径可调，所以每次参数变化都要重画） */
function drawDensity() {
  const g = densityCanvas.getContext('2d')!
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, CW, CH)
  const sx = CW / (SITE.lon1 - SITE.lon0)
  const sy = CH / (SITE.lat1 - SITE.lat0)
  const toU = (lon: number) => (lon - SITE.lon0) * sx
  const toV = (lat: number) => (SITE.lat1 - lat) * sy

  // 径向渐变模板：中心白、边缘透明
  const r = radius.value
  const stamp = document.createElement('canvas')
  stamp.width = stamp.height = r * 2
  const sg = stamp.getContext('2d')!
  const grad = sg.createRadialGradient(r, r, 0, r, r, r)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.62)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  sg.fillStyle = grad
  sg.fillRect(0, 0, r * 2, r * 2)

  g.globalCompositeOperation = 'lighter'
  for (const s of SAMPLES) {
    g.globalAlpha = s.w * 0.55
    g.drawImage(stamp, toU(s.lon) - r, toV(s.lat) - r)
  }
  g.globalAlpha = 1
  g.globalCompositeOperation = 'source-over'
}

/** 灰度 → 色带查表 */
function colorize() {
  const src = densityCanvas.getContext('2d')!.getImageData(0, 0, CW, CH)
  const lut = bakeRamp(ramp.value)
  const dst = outCanvas.getContext('2d')!.createImageData(CW, CH)
  const d = src.data
  const o = dst.data
  let peak = 0
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255 // 叠加后的 alpha 即密度
    if (a > peak) peak = a
  }
  // 用峰值做归一，参数不变时视觉稳定
  const inv = peak > 1e-4 ? 1 / peak : 0
  for (let i = 0; i < d.length; i += 4) {
    const a = (d[i + 3] / 255) * inv
    const v = Math.pow(a, 1 / boost.value)
    const idx = Math.min(255, Math.max(0, Math.round(v * 255))) << 2
    o[i] = lut[idx]
    o[i + 1] = lut[idx + 1]
    o[i + 2] = lut[idx + 2]
    o[i + 3] = Math.min(255, lut[idx + 3] * opacity.value)
  }
  outCanvas.getContext('2d')!.putImageData(dst, 0, 0)
  maxValue.value = peak
}

function refresh() {
  drawDensity()
  colorize()
  if (showPoints.value) drawDots()
  uploadPlate()
}

/** 拖动滑块时把同一帧内的多次请求合并，避免重复全幅重算 */
let pending = false
function scheduleRefresh() {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    refresh()
  })
}

function drawDots() {
  const g = outCanvas.getContext('2d')!
  const sx = CW / (SITE.lon1 - SITE.lon0)
  const sy = CH / (SITE.lat1 - SITE.lat0)
  g.save()
  g.fillStyle = 'rgba(255,255,255,0.5)'
  for (const s of SAMPLES) {
    g.fillRect((s.lon - SITE.lon0) * sx, (SITE.lat1 - s.lat) * sy, 1.4, 1.4)
  }
  g.restore()
}

/* ---------------- 落图：Primitive + 只换材质 uniform ---------------- */
let plateMat: Cesium.Material | null = null
let liveBmp: ImageBitmap | null = null
let uploadSeq = 0

/** canvas → ImageBitmap → uniform：位图已解码，Cesium 在绘制帧内同步换纹理，无闪白 */
function uploadPlate() {
  if (!plateMat) return
  const seq = ++uploadSeq
  createImageBitmap(outCanvas).then((bmp) => {
    if (seq !== uploadSeq) {
      bmp.close()
      return
    }
    const old = liveBmp
    liveBmp = bmp
    plateMat!.uniforms.image = bmp
    old?.close()
  })
}

const statusText = ref('')
const legendSrc = ref('')
function refreshLegend() {
  const lut = bakeRamp(ramp.value)
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 12
  const g = c.getContext('2d')!
  const img = g.createImageData(256, 12)
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 256; x++) {
      const s = x << 2
      const t = (y * 256 + x) << 2
      img.data[t] = lut[s]
      img.data[t + 1] = lut[s + 1]
      img.data[t + 2] = lut[s + 2]
      img.data[t + 3] = 255
    }
  }
  g.putImageData(img, 0, 0)
  legendSrc.value = c.toDataURL('image/png')
}

const peakText = computed(() => (maxValue.value * 100).toFixed(0))

const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.028, 46000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-72), roll: 0 },
}
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

watch([radius, boost, opacity, rampId, showPoints], () => {
  scheduleRefresh()
  refreshLegend()
}, { flush: 'post' })

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  const scene = viewer.scene
  scene.globe.enableLighting = false
  scene.fog.enabled = false
  scene.highDynamicRange = true

  refresh()
  refreshLegend()

  plateMat = new Cesium.Material({
    fabric: {
      uniforms: { image: outCanvas },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          vec4 c = texture(image, materialInput.st);
          m.diffuse = c.rgb;
          m.alpha = c.a;
          return m;
        }`,
    },
    translucent: true,
    minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
  })

  scene.primitives.add(
    new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(SITE.lon0, SITE.lat0, SITE.lon1, SITE.lat1),
          height: PLATE_H,
          vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
      }),
      appearance: new Cesium.MaterialAppearance({
        material: plateMat,
        translucent: true,
        flat: true,
      }),
      asynchronous: false,
    }),
  )

  // 热点标注（可选）
  HOTSPOTS.forEach((h) => {
    viewer!.entities.add({
      position: Cesium.Cartesian3.fromDegrees(LON + h.dLon, LAT + h.dLat, 200),
      label: {
        text: h.name,
        font: '500 11px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#e9f2ff'),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0c1522').withAlpha(0.62),
        backgroundPadding: new Cesium.Cartesian2(5, 2),
        scaleByDistance: new Cesium.NearFarScalar(1.2e4, 1.1, 1.6e5, 0.75),
        translucencyByDistance: new Cesium.NearFarScalar(1.2e4, 1, 2.2e5, 0),
        disableDepthTestDistance: 4000,
      },
    })
  })

  viewer.camera.setView(home)
  statusText.value = `${TOTAL} 个样本 · ${HOTSPOTS.length} 个热点`
})

onBeforeUnmount(() => {
  uploadSeq++
  liveBmp?.close()
  liveBmp = null
  plateMat = null
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>

    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="panel">
      <div class="title">城市热力图 · 通勤密度</div>
      <div class="sub">径向渐变叠加成密度场 → 256 级色带查表 → 自定义图层贴到球面</div>

      <div class="ctrl">
        <span class="lab">半径</span>
        <input v-model.number="radius" type="range" min="6" max="60" step="1" />
        <b>{{ radius }}<i>px</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">强度</span>
        <input v-model.number="boost" type="range" min="0.6" max="2.6" step="0.05" />
        <b>{{ boost.toFixed(2) }}<i>×</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">透明度</span>
        <input v-model.number="opacity" type="range" min="0.2" max="1" step="0.02" />
        <b>{{ (opacity * 100).toFixed(0) }}<i>%</i></b>
      </div>

      <div class="row">
        <button
          v-for="r in RAMPS"
          :key="r.id"
          class="chip"
          :class="{ on: rampId === r.id }"
          @click="rampId = r.id"
        >
          {{ r.label }}
        </button>
      </div>
      <div class="row">
        <button class="chip" :class="{ on: showPoints }" @click="showPoints = !showPoints">
          {{ showPoints ? '隐藏样本点' : '显示样本点' }}
        </button>
      </div>

      <div class="legend">
        <img v-if="legendSrc" :src="legendSrc" alt="图例" />
        <div class="ends"><span>低</span><span>高</span></div>
      </div>

      <div class="stat">
        <div class="item"><span class="k">样本数</span><b>{{ TOTAL }}</b></div>
        <div class="item"><span class="k">峰值密度</span><b>{{ peakText }}<i>%</i></b></div>
        <div class="item"><span class="k">栅格</span><b>{{ CW }}×{{ CH }}</b></div>
      </div>

      <div class="tip">
        {{ statusText }}
        <br />
        热点由「二维高斯」合成：两个均匀分布经 Box-Muller 变换得到正态偏移，愈近中心样本愈密。
        密度以 lighter 混合累加进位图的 alpha 通道，再按 1/boost 做伽马拉伸后查 256 级色带；
        底板是 RectangleGeometry + 自定义材质，更新只换 ImageBitmap，几何与图层都不动。
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
.cesium-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 20;
  width: 336px;
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
  flex: 0 0 44px;
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
  flex: 0 0 46px;
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
.legend img {
  display: block;
  width: 100%;
  height: 12px;
  margin-top: 10px;
  border-radius: 3px;
}
.legend .ends {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #7f90a3;
  margin-top: 2px;
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
