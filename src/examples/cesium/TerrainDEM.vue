<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import {
  VIEWER_OPTIONS,
  enableTerrainScene,
  sampleGroundHeight,
  useCesiumBasemap,
  useCesiumView,
} from './useCesium'
import { buildTerrainGeometry, makeImageMaterial, makeTextureUploader } from './demMesh'
import {
  HYPSOMETRIC,
  SLOPE_RAMP,
  contourLine,
  hillshade,
  lonLatToUV,
  makeDEM,
  sampleH,
  slopeAt,
  type DEM,
  type DemShape,
} from '@/examples/shared/terrain'

/* ============================================================
 * 三维地形 · 高程分析
 *  - DEM：分形噪声合成的高程场（山脊 ridged / 河谷刻蚀 / 闭合洼地），真值已知可验证
 *  - 几何：高程数组 → 三角网（三角带索引 + 椭球法线 + st），一次建成，之后只换贴图
 *  - 着色：分层设色 / 坡度 / 坡向 / 纯晕渲 四种模式，晕渲强度连续可调
 *  - 等高线：Marching Squares 在 uv 空间追踪，索引曲线（每 5 条）加粗
 *  - 交互：鼠标位置实时反算经纬度和高程 / 坡度（射线步进 + 二分求交）
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 110.42
const LAT = 30.86
const SPAN = 12000 // 区域边长（米）
const RELIEF = 900 // 高差（米）

/* ---------------- 参数 ---------------- */
type Mode = 'elev' | 'slope' | 'aspect' | 'shade'
const MODES: Array<{ id: Mode; label: string }> = [
  { id: 'elev', label: '高程分层' },
  { id: 'slope', label: '坡度' },
  { id: 'aspect', label: '坡向' },
  { id: 'shade', label: '纯晕渲' },
]
const SHAPES: Array<{ id: DemShape; label: string; relief: number }> = [
  { id: 'mountain', label: '山地', relief: 900 },
  { id: 'valley', label: '河谷', relief: 620 },
  { id: 'rolling', label: '缓丘', relief: 220 },
]

const mode = ref<Mode>('elev')
const shape = ref<DemShape>('mountain')
const exag = ref(1.6) // 垂直夸张
const sunAz = ref(315) // 太阳方位角（正北为 0）
const sunAlt = ref(42) // 太阳高度角
const shadeMix = ref(0.75) // 晕渲强度
const contourGap = ref(100) // 等高距（米）
const showContour = ref(true)
const cursorText = ref('将鼠标移到地形上查看高程')
const slopeText = ref('—')
const aspectText = ref('—')
const stats = ref({ max: 0, min: 0, mean: 0, relief: 0, area: 0 })

/* ---------------- DEM ---------------- */
const TEX = 720
const canvas = document.createElement('canvas')
canvas.width = TEX
canvas.height = TEX
const ctx = canvas.getContext('2d')!

/** 真实地面海拔：开了全球地形后要把自定义地形整体抬到地面上 */
let groundOffset = 0
let dem: DEM = makeDEM({ lon: LON, lat: LAT, span: SPAN, relief: RELIEF, shape: 'mountain' })
let shadeArr = hillshade(dem, sunAz.value, sunAlt.value, exag.value)

function rebuildDem() {
  const relief = SHAPES.find((s) => s.id === shape.value)?.relief ?? RELIEF
  dem = makeDEM({ lon: LON, lat: LAT, span: SPAN, relief, shape: shape.value })
  shadeArr = hillshade(dem, sunAz.value, sunAlt.value, exag.value)
  let sum = 0
  for (let i = 0; i < dem.h.length; i++) sum += dem.h[i]
  stats.value = {
    max: dem.max + groundOffset,
    min: dem.min + groundOffset,
    mean: sum / dem.h.length + groundOffset,
    relief: dem.max - dem.min,
    area: (SPAN / 1000) * (SPAN / 1000),
  }
}

/* ---------------- 着色 ---------------- */
/** 坡向色环：0°=北 用青色，顺时针转一圈色相 */
function aspectColor(aspDeg: number, shade: number): [number, number, number] {
  const h = ((aspDeg + 180) % 360) / 60 // 0..6
  const x = (1 - Math.abs((h % 2) - 1)) * 255
  let r = 0
  let g = 0
  let b = 0
  const seg = Math.floor(h) % 6
  if (seg === 0) {
    r = 255
    g = x
  } else if (seg === 1) {
    r = x
    g = 255
  } else if (seg === 2) {
    g = 255
    b = x
  } else if (seg === 3) {
    g = x
    b = 255
  } else if (seg === 4) {
    r = x
    b = 255
  } else {
    r = 255
    b = x
  }
  const k = 0.45 + 0.55 * shade
  return [r * k, g * k, b * k]
}

function bake() {
  const n = dem.n
  const img = ctx.createImageData(TEX, TEX)
  const d = img.data
  const span = dem.max - dem.min || 1
  const mix = shadeMix.value
  const md = mode.value

  for (let py = 0; py < TEX; py++) {
    const v = py / (TEX - 1)
    for (let px = 0; px < TEX; px++) {
      const u = px / (TEX - 1)
      // 双线性取该像素对应的高程与晕渲值（贴图分辨率高于格网，必须插值否则会有台阶）
      const h = sampleH(dem, u, v) + groundOffset
      const gi = u * (n - 1)
      const gj = v * (n - 1)
      const i0 = Math.min(Math.floor(gi), n - 1)
      const j0 = Math.min(Math.floor(gj), n - 1)
      const shade = shadeArr[j0 * n + i0]

      let r: number
      let g: number
      let b: number
      if (md === 'shade') {
        const s = 40 + shade * 205
        r = g = b = s
      } else if (md === 'slope') {
        const { slope } = slopeAt(dem, u, v)
        const c = SLOPE_RAMP(Math.min(slope / 55, 1))
        const k = 1 - mix + mix * (0.45 + 0.55 * shade)
        r = c[0] * k
        g = c[1] * k
        b = c[2] * k
      } else if (md === 'aspect') {
        const { slope, aspect } = slopeAt(dem, u, v)
        // 平地没有坡向，用灰色表示
        const flat = Math.min(slope / 6, 1)
        const c = aspectColor(aspect, shade)
        r = c[0] * flat + 150 * (1 - flat)
        g = c[1] * flat + 152 * (1 - flat)
        b = c[2] * flat + 158 * (1 - flat)
      } else {
        const c = HYPSOMETRIC((h - dem.min) / span)
        const k = 1 - mix + mix * (0.5 + 0.5 * shade)
        r = c[0] * k
        g = c[1] * k
        b = c[2] * k
      }
      const t = (py * TEX + px) << 2
      d[t] = r
      d[t + 1] = g
      d[t + 2] = b
      d[t + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  if (showContour.value) drawContours()
  drawCompass()
}

/** 等高线：uv → 画布像素，索引曲线加粗提亮 */
function drawContours() {
  const gap = contourGap.value
  ctx.save()
  ctx.lineCap = 'round'
  for (let level = Math.ceil(dem.min / gap) * gap; level < dem.max; level += gap) {
    const isIndex = Math.round(level / gap) % 5 === 0
    const segs = contourLine(dem, level)
    ctx.strokeStyle = isIndex ? 'rgba(255,236,190,0.85)' : 'rgba(20,24,30,0.42)'
    ctx.lineWidth = isIndex ? 2 : 1
    ctx.beginPath()
    for (let i = 0; i < segs.length; i += 4) {
      ctx.moveTo(segs[i] * TEX, segs[i + 1] * TEX)
      ctx.lineTo(segs[i + 2] * TEX, segs[i + 3] * TEX)
    }
    ctx.stroke()
  }
  ctx.restore()
}

/** 右上角指北针（顺便用来核对贴图没有上下翻转） */
function drawCompass() {
  const cx = TEX - 54
  const cy = 54
  const r = 26
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(12,18,26,0.55)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(230,240,250,0.55)'
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx - 8, cy + 6)
  ctx.lineTo(cx, cy + 1)
  ctx.lineTo(cx + 8, cy + 6)
  ctx.closePath()
  ctx.fillStyle = '#ff6b5e'
  ctx.fill()
  ctx.fillStyle = '#eef4fa'
  ctx.font = '600 13px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('N', cx, cy + 22)
  ctx.restore()
}

/* ---------------- 图元 ---------------- */
let terrainPrim: Cesium.Primitive | null = null
let terrainMat: Cesium.Material | null = null
let stopTerrain: (() => void) | null = null
const uploader = makeTextureUploader()

function buildPrimitive() {
  const scene = viewer?.scene
  if (!scene) return
  if (terrainPrim) {
    scene.primitives.remove(terrainPrim)
    terrainPrim = null
  }
  terrainMat = makeImageMaterial(canvas)
  terrainPrim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: buildTerrainGeometry(dem, exag.value, groundOffset),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: terrainMat,
      translucent: false,
      flat: true,
      closed: false,
    }),
    asynchronous: false,
  })
  scene.primitives.add(terrainPrim)
  uploader.upload(terrainMat, canvas)
}

/** 合并同一帧内的多次重算（拖滑块时） */
let pending = false
function schedule(kind: 'tex' | 'geo') {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    bake()
    if (kind === 'geo') buildPrimitive()
    else uploader.upload(terrainMat, canvas)
  })
}

/* ---------------- 鼠标读取高程 ---------------- */
let cursorEntity: Cesium.Entity | null = null
const carto = new Cesium.Cartographic()

/** 射线步进 + 二分：找到视线与 DEM 的相交点 */
function pickDem(ray: Cesium.Ray): Cesium.Cartesian3 | null {
  if (!dem) return null
  const far = SPAN * 2.4
  const steps = 160
  const a = new Cesium.Cartesian3()
  const b = new Cesium.Cartesian3()
  let prevT = 0
  let prevDiff = Number.NaN
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * far
    Cesium.Cartesian3.multiplyByScalar(ray.direction, t, a)
    Cesium.Cartesian3.add(ray.origin, a, b)
    const c = Cesium.Cartographic.fromCartesian(b, undefined, carto)
    if (!c) break
    const lon = Cesium.Math.toDegrees(c.longitude)
    const lat = Cesium.Math.toDegrees(c.latitude)
    const [u, v] = lonLatToUV(dem, lon, lat)
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      prevDiff = Number.NaN
      prevT = t
      continue
    }
    const diff = c.height - (sampleH(dem, u, v) + groundOffset)
    if (i > 1 && !Number.isNaN(prevDiff) && prevDiff > 0 && diff <= 0) {
      // 二分细化
      let lo = prevT
      let hi = t
      for (let k = 0; k < 18; k++) {
        const mid = (lo + hi) / 2
        Cesium.Cartesian3.multiplyByScalar(ray.direction, mid, a)
        Cesium.Cartesian3.add(ray.origin, a, b)
        const cc = Cesium.Cartographic.fromCartesian(b, undefined, carto)
        if (!cc) break
        const [uu, vv] = lonLatToUV(
          dem,
          Cesium.Math.toDegrees(cc.longitude),
          Cesium.Math.toDegrees(cc.latitude),
        )
        if (cc.height - (sampleH(dem, uu, vv) + groundOffset) > 0) lo = mid
        else hi = mid
      }
      Cesium.Cartesian3.multiplyByScalar(ray.direction, hi, a)
      return Cesium.Cartesian3.add(ray.origin, a, new Cesium.Cartesian3())
    }
    prevDiff = diff
    prevT = t
  }
  return null
}

/* ---------------- 视角 ---------------- */
const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.072, 8200),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-34), roll: 0 },
}
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(() => viewer, () => home)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'imagery')

const statsText = computed(() => ({
  max: stats.value.max.toFixed(0),
  min: stats.value.min.toFixed(0),
  mean: stats.value.mean.toFixed(0),
  relief: stats.value.relief.toFixed(0),
  area: stats.value.area.toFixed(1),
}))

watch([mode, shadeMix, sunAz, sunAlt, contourGap, showContour], () => {
  shadeArr = hillshade(dem, sunAz.value, sunAlt.value, exag.value)
  schedule('tex')
})
watch(exag, () => {
  shadeArr = hillshade(dem, sunAz.value, sunAlt.value, exag.value)
  schedule('geo')
})
watch(shape, () => {
  rebuildDem()
  buildPrimitive()
})

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  const scene = viewer.scene
  scene.globe.enableLighting = false
  // 不开 highDynamicRange：HDR 会启用 czm_tonemapping 分支，部分驱动/软件回退下
  // 该 fragment shader 编译失败，整页黑屏并弹「Rendering has stopped」。

  stopTerrain = enableTerrainScene(viewer)
  rebuildDem()
  bake()
  buildPrimitive()

  // 地形瓦片到位后取真实地面海拔，把 DEM 抬上去重建
  void (async () => {
    const g = await sampleGroundHeight(viewer!, LON, LAT)
    if (viewer && !viewer.isDestroyed() && g > 0) {
      groundOffset = g
      stats.value = { ...stats.value }
      rebuildDem()
      bake()
      buildPrimitive()
    }
  })()

  cursorEntity = viewer.entities.add({
    point: {
      pixelSize: 9,
      color: Cesium.Color.fromCssColorString('#ffd45e'),
      outlineColor: Cesium.Color.fromCssColorString('#101820'),
      outlineWidth: 2,
      disableDepthTestDistance: 0,
    },
    label: {
      text: '',
      font: '600 12px sans-serif',
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#0d1622').withAlpha(0.8),
      backgroundPadding: new Cesium.Cartesian2(5, 3),
      pixelOffset: new Cesium.Cartesian2(0, -18),
      disableDepthTestDistance: 0,
    },
  })

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas)
  handler.setInputAction((mv: { endPosition: Cesium.Cartesian2 }) => {
    const ray = viewer?.camera.getPickRay(mv.endPosition)
    if (!ray || !dem) return
    const hit = pickDem(ray)
    if (!hit || !cursorEntity) {
      cursorEntity && (cursorEntity.show = false)
      cursorText.value = '将鼠标移到地形上查看高程'
      return
    }
    cursorEntity.show = true
    cursorEntity.position = new Cesium.ConstantPositionProperty(hit)
    const c = Cesium.Cartographic.fromCartesian(hit, undefined, carto)
    if (!c) return
    const lon = Cesium.Math.toDegrees(c.longitude)
    const lat = Cesium.Math.toDegrees(c.latitude)
    const [u, v] = lonLatToUV(dem, lon, lat)
    const { slope, aspect } = slopeAt(dem, u, v)
    const h = sampleH(dem, u, v)
    cursorText.value = `${lon.toFixed(5)}°E  ${lat.toFixed(5)}°N`
    ;(cursorEntity.label as Cesium.LabelGraphics).text = new Cesium.ConstantProperty(
      `${h.toFixed(1)} m`,
    )
    slopeText.value = `${slope.toFixed(1)}°`
    aspectText.value = `${aspect.toFixed(0)}°`
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

  viewer.camera.setView(home)
})

onBeforeUnmount(() => {
  stopTerrain?.()
  uploader.dispose()
  terrainMat = null
  terrainPrim = null
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})

function setShape(id: DemShape) {
  shape.value = id
}
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
      <div class="title">三维地形 · 高程分析</div>
      <div class="sub">
        程序化 DEM → 三角网 → 分层设色 / 晕渲 / 坡度 / 坡向 / 等高线
      </div>

      <div class="row btns">
        <button
          v-for="s in SHAPES"
          :key="s.id"
          class="chip"
          :class="{ on: shape === s.id }"
          @click="setShape(s.id)"
        >
          {{ s.label }}
        </button>
      </div>

      <div class="row btns">
        <button
          v-for="m in MODES"
          :key="m.id"
          class="chip"
          :class="{ on: mode === m.id }"
          @click="mode = m.id"
        >
          {{ m.label }}
        </button>
      </div>

      <div class="ctrl">
        <span class="lab">垂直夸张</span>
        <input v-model.number="exag" type="range" min="1" max="4" step="0.1" />
        <b>{{ exag.toFixed(1) }}<i>×</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">晕渲强度</span>
        <input v-model.number="shadeMix" type="range" min="0" max="1" step="0.05" />
        <b>{{ (shadeMix * 100).toFixed(0) }}<i>%</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">太阳方位</span>
        <input v-model.number="sunAz" type="range" min="0" max="360" step="1" />
        <b>{{ sunAz }}<i>°</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">太阳高度</span>
        <input v-model.number="sunAlt" type="range" min="5" max="85" step="1" />
        <b>{{ sunAlt }}<i>°</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">等高距</span>
        <input v-model.number="contourGap" type="range" min="25" max="300" step="25" />
        <b>{{ contourGap }}<i>m</i></b>
      </div>

      <div class="row">
        <button class="chip" :class="{ on: showContour }" @click="showContour = !showContour">
          {{ showContour ? '隐藏等高线' : '显示等高线' }}
        </button>
      </div>

      <div class="stat">
        <div class="item"><span class="k">最高</span><b>{{ statsText.max }}<i>m</i></b></div>
        <div class="item"><span class="k">最低</span><b>{{ statsText.min }}<i>m</i></b></div>
        <div class="item"><span class="k">平均</span><b>{{ statsText.mean }}<i>m</i></b></div>
        <div class="item"><span class="k">起伏</span><b>{{ statsText.relief }}<i>m</i></b></div>
        <div class="item"><span class="k">坡度</span><b>{{ slopeText }}</b></div>
        <div class="item"><span class="k">坡向</span><b>{{ aspectText }}</b></div>
      </div>

      <div class="cursor">{{ cursorText }}</div>

      <div class="tip">
        地形由 ridged fBm（脊化分形噪声）合成：把噪声取
        <code>1-|2n-1|</code> 再平方，得到尖锐山脊而非圆丘；河谷形状额外做了河道刻蚀与两处
        <b>闭合洼地</b>（后面淹没分析会用到）。三角网只建一次，着色结果烘进
        {{ TEX }}×{{ TEX }} 贴图后经 ImageBitmap 换帧，所以拖滑块不会闪。
        晕渲用 Horn 算法：3×3 窗口算坡面法向，再与太阳方向点积。
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
  flex: 0 0 50px;
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
.cursor {
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 7px;
  background: rgba(20, 30, 42, 0.8);
  border: 1px solid rgba(80, 100, 124, 0.3);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #cfe0f0;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
.tip code {
  background: rgba(60, 80, 104, 0.4);
  padding: 0 3px;
  border-radius: 3px;
}
</style>
