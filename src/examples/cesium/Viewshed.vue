<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import {
  VIEWER_OPTIONS,
  clipGlobeRectangle,
  enableTerrainScene,
  sampleMaxGroundHeight,
  useCesiumBasemap,
  useCesiumView,
  waitRealTerrain,
} from './useCesium'
import {
  buildSkirtGeometry,
  buildTerrainGeometry,
  makeImageMaterial,
  makeSkirtMaterial,
  makeTextureUploader,
} from './demMesh'
import { HYPSOMETRIC, hillshade, makeDEM, sampleH, uvToLonLat, type DEM } from '@/examples/shared/terrain'

/* ============================================================
 * 可视域分析（Viewshed / 通视分析）
 *
 * 原理：对每个格网中心，从观察点出发沿视线做多段插值 ——
 *   rayH(s) = 眼高 + (目标高 - 眼高)·s
 *   若中途某点的地面高程 > rayH(s)，视线被地形挡住 → 该点不可见。
 * 这是最朴素的"视线遮挡"判定，也是 ArcGIS Viewshed 的核心思想；
 * 地球曲率在大尺度时可乘 0.13 折减系数（本例 9km 尺度忽略）。
 *
 * 水平视场角（FOV）< 360° 时只有扇区内的格网参与判定 —— 监控探头、
 * 烽火台、雷达覆盖都这么算。
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null
/** 真实地面海拔偏移 + 裙边侧壁：分析块嵌进真实地形（延庆北山地区，约 484~760m） */
let groundOffset = 0
let stopTerrain: (() => void) | null = null
let skirtPrim: Cesium.Primitive | null = null

// 延庆北（北京延庆与赤城交界）：真实中低山，幅差约 276m，瞭望塔选址的典型场景
const LON = 116.05
const LAT = 40.45
const SPAN = 9000
const N = 129

/* ---------------- 参数 ---------------- */
const eyeH = ref(24) // 视高（米，观察塔/瞭望塔高度）
const radius = ref(4200) // 最大视距（米）
const heading = ref(0) // 主方位角（正北 0）
const fov = ref(360) // 水平视场角
const result = ref({ rate: 0, area: 0, farthest: 0 })

const dem: DEM = makeDEM({
  lon: LON,
  lat: LAT,
  span: SPAN,
  n: N,
  relief: 820,
  shape: 'mountain',
  seed: 20260402,
})

/* 观察点（uv 空间） */
const obs = ref({ u: 0.47, v: 0.71 })
const visible = new Uint8Array(N * N) // 0 未评估 / 1 可见 / 2 被挡

function computeViewshed() {
  visible.fill(0)
  const spanM = SPAN
  const u0 = obs.value.u
  const v0 = obs.value.v
  const h0 = sampleH(dem, u0, v0) + eyeH.value
  const obsI = Math.round(u0 * (N - 1))
  const obsJ = Math.round(v0 * (N - 1))
  let visCount = 0
  let area = 0
  let farthest = 0
  const cellA = dem.cell * dem.cell
  const halfFov = fov.value / 2

  for (let j = 0; j < N; j++) {
    const v = j / (N - 1)
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1)
      const east = (u - u0) * spanM
      const north = (v0 - v) * spanM
      const dist = Math.hypot(east, north)
      if (dist > radius.value || dist < dem.cell) continue
      // 方位角与视场角过滤
      let bear = (Math.atan2(east, north) * 180) / Math.PI
      if (bear < 0) bear += 360
      let dB = Math.abs(bear - heading.value)
      if (dB > 180) dB = 360 - dB
      if (fov.value < 360 && dB > halfFov) continue

      const ht = dem.h[j * N + i]
      const steps = Math.max(2, Math.min(72, Math.ceil(dist / dem.cell)))
      let vis = 1
      for (let s = 1; s < steps; s++) {
        const f = s / steps
        const ground = sampleH(dem, u0 + (u - u0) * f, v0 + (v - v0) * f)
        const rayH = h0 + (ht - h0) * f
        if (ground > rayH + 0.35) {
          vis = 2
          break
        }
      }
      visible[j * N + i] = vis
      if (vis === 1) {
        visCount++
        area += cellA
        if (dist > farthest) farthest = dist
      }
    }
  }
  // 观察点自身恒可见
  if (obsI >= 0 && obsI < N && obsJ >= 0 && obsJ < N) visible[obsJ * N + obsI] = 1
  const evaluated = visible.reduce((a, b) => a + (b ? 1 : 0), 0)
  result.value = {
    rate: evaluated ? (visCount / evaluated) * 100 : 0,
    area: area / 1e6,
    farthest,
  }
}

/* ---------------- 纹理 ---------------- */
const TEX = 720
const canvas = document.createElement('canvas')
canvas.width = canvas.height = TEX
const ctx = canvas.getContext('2d')!

/** 底图（地形分层设色 + 晕渲）只烘一次，可视域叠加层随参数重烘 */
let baseImg: ImageData | null = null

function bakeBase() {
  const shade = hillshade(dem, 320, 44, 1.4)
  baseImg = ctx.createImageData(TEX, TEX)
  const d = baseImg.data
  const span = dem.max - dem.min || 1
  for (let py = 0; py < TEX; py++) {
    const v = py / (TEX - 1)
    for (let px = 0; px < TEX; px++) {
      const u = px / (TEX - 1)
      const h = sampleH(dem, u, v)
      const c = HYPSOMETRIC((h - dem.min) / span)
      const gi = Math.min(Math.floor(u * (N - 1)), N - 1)
      const gj = Math.min(Math.floor(v * (N - 1)), N - 1)
      const s = 0.42 + 0.58 * shade[gj * N + gi]
      const t = (py * TEX + px) << 2
      d[t] = c[0] * s
      d[t + 1] = c[1] * s
      d[t + 2] = c[2] * s
      d[t + 3] = 255
    }
  }
}

function bake() {
  if (!baseImg) return
  const img = new ImageData(new Uint8ClampedArray(baseImg.data), TEX, TEX)
  const d = img.data
  for (let py = 0; py < TEX; py++) {
    const j = Math.round((py / (TEX - 1)) * (N - 1))
    for (let px = 0; px < TEX; px++) {
      const i = Math.round((px / (TEX - 1)) * (N - 1))
      const vis = visible[j * N + i]
      if (!vis) continue
      const t = (py * TEX + px) << 2
      if (vis === 1) {
        // 可见：亮绿叠加
        d[t] = d[t] * 0.25 + 70
        d[t + 1] = d[t + 1] * 0.25 + 190
        d[t + 2] = d[t + 2] * 0.25 + 90
      } else {
        // 被挡：压暗 + 泛红
        d[t] = d[t] * 0.55 + 70
        d[t + 1] = d[t + 1] * 0.4
        d[t + 2] = d[t + 2] * 0.4
      }
    }
  }
  ctx.putImageData(img, 0, 0)
}

/* ---------------- 图元 ---------------- */
let prim: Cesium.Primitive | null = null
let mat: Cesium.Material | null = null
const uploader = makeTextureUploader()

function buildPrimitive() {
  const scene = viewer?.scene
  if (!scene) return
  if (prim) scene.primitives.remove(prim)
  if (skirtPrim) scene.primitives.remove(skirtPrim)
  mat = makeImageMaterial(canvas)
  prim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      // exag 必须是 1：通视计算用的是 DEM 原始高程，渲染抬高会让视线判定失真
      geometry: buildTerrainGeometry(dem, 1, groundOffset),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: mat,
      translucent: false,
      flat: true,
    }),
    asynchronous: false,
  })
  scene.primitives.add(prim)
  skirtPrim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: buildSkirtGeometry(dem, 1, groundOffset, 1100),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: makeSkirtMaterial(),
      translucent: false,
      flat: true,
    }),
    asynchronous: false,
  })
  scene.primitives.add(skirtPrim)
  uploader.upload(mat, canvas)
}

/* ---------------- 观察点标记 ---------------- */
let obsEntity: Cesium.Entity | null = null

function syncObserver() {
  if (!obsEntity) return
  const [lon, lat] = uvToLonLat(dem, obs.value.u, obs.value.v)
  const ground = sampleH(dem, obs.value.u, obs.value.v)
  obsEntity.position = new Cesium.ConstantPositionProperty(
    Cesium.Cartesian3.fromDegrees(lon, lat, ground + eyeH.value + 12 + groundOffset),
  )
  ;(obsEntity.label as Cesium.LabelGraphics).text = new Cesium.ConstantProperty(
    `观察点 · 视高 ${eyeH.value}m`,
  )
}

let pending = false
function refresh() {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    computeViewshed()
    bake()
    uploader.upload(mat, canvas)
    syncObserver()
  })
}

/* ---------------- 交互：点击设置观察点 ---------------- */
const carto = new Cesium.Cartographic()

/** 射线步进 + 二分：屏幕点击 → 地形交点 → uv */
function pickUV(winPos: Cesium.Cartesian2): [number, number] | null {
  const ray = viewer?.camera.getPickRay(winPos)
  if (!ray) return null
  const far = SPAN * 2.4
  const steps = 200
  const a = new Cesium.Cartesian3()
  const b = new Cesium.Cartesian3()
  let prevDiff = Number.NaN
  let prevT = 0
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * far
    Cesium.Cartesian3.multiplyByScalar(ray.direction, t, a)
    Cesium.Cartesian3.add(ray.origin, a, b)
    const c = Cesium.Cartographic.fromCartesian(b, undefined, carto)
    if (!c) break
    const lon = Cesium.Math.toDegrees(c.longitude)
    const lat = Cesium.Math.toDegrees(c.latitude)
    const u = (lon - dem.lon0) / (dem.lon1 - dem.lon0)
    const v = (dem.lat1 - lat) / (dem.lat1 - dem.lat0)
    if (u < 0 || u > 1 || v < 0 || v > 1) {
      prevDiff = Number.NaN
      prevT = t
      continue
    }
    const diff = c.height - (sampleH(dem, u, v) + groundOffset)
    if (i > 1 && !Number.isNaN(prevDiff) && prevDiff > 0 && diff <= 0) {
      // 落点即交点附近，直接线性取
      return [u, v]
    }
    prevDiff = diff
    prevT = t
  }
  return null
}

/* ---------------- 视角 ---------------- */
const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.095, 15500),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
}
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(() => viewer, () => home)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'imagery')

watch([eyeH, radius, heading, fov, obs], refresh, { deep: true })

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  const scene = viewer.scene
  scene.globe.enableLighting = false

  stopTerrain = enableTerrainScene(viewer)

  bakeBase()
  computeViewshed()
  bake()
  buildPrimitive()

  const [olon, olat] = uvToLonLat(dem, obs.value.u, obs.value.v)
  obsEntity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(olon, olat, 200),
    point: {
      pixelSize: 11,
      color: Cesium.Color.fromCssColorString('#ffd45e'),
      outlineColor: Cesium.Color.fromCssColorString('#101820'),
      outlineWidth: 2,
      disableDepthTestDistance: 8000,
    },
    label: {
      font: '600 12px sans-serif',
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#0d1622').withAlpha(0.8),
      backgroundPadding: new Cesium.Cartesian2(6, 3),
      pixelOffset: new Cesium.Cartesian2(0, -16),
      disableDepthTestDistance: 8000,
    },
  })
  syncObserver()

  new Cesium.ScreenSpaceEventHandler(scene.canvas).setInputAction(
    (mv: { position: Cesium.Cartesian2 }) => {
      const uv = pickUV(mv.position)
      if (uv) obs.value = { u: uv[0], v: uv[1] }
    },
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  )

  viewer.camera.setView(home)

  // 真实地形就位后，把分析块抬到实际高程带并重建
  void (async () => {
    if (!viewer || !(await waitRealTerrain(viewer))) return
    const realMax = await sampleMaxGroundHeight(viewer, dem.lon0, dem.lat0, dem.lon1, dem.lat1)
    if (viewer && !viewer.isDestroyed() && realMax > 0) {
      groundOffset = Math.max(0, realMax - dem.min + 6)
      buildPrimitive()
      syncObserver()
      clipGlobeRectangle(viewer, dem.lon0, dem.lat0, dem.lon1, dem.lat1)
    }
  })()
})

onBeforeUnmount(() => {
  stopTerrain?.()
  skirtPrim = null
  uploader.dispose()
  mat = null
  prim = null
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
      <div class="title">可视域分析 · 瞭望塔选址</div>
      <div class="sub">视线逐格插值判定遮挡 —— 绿可见 / 红被挡 / 灰未覆盖</div>

      <div class="ctrl">
        <span class="lab">视高</span>
        <input v-model.number="eyeH" type="range" min="2" max="80" step="1" />
        <b>{{ eyeH }}<i>m</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">最大视距</span>
        <input v-model.number="radius" type="range" min="800" max="8000" step="100" />
        <b>{{ (radius / 1000).toFixed(1) }}<i>km</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">主方位角</span>
        <input v-model.number="heading" type="range" min="0" max="360" step="5" />
        <b>{{ heading }}<i>°</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">视场角</span>
        <input v-model.number="fov" type="range" min="10" max="360" step="10" />
        <b>{{ fov }}<i>°</i></b>
      </div>

      <div class="hint">在地图上<b>点击任意位置</b>即可搬移观察点</div>

      <div class="stat">
        <div class="item"><span class="k">可视率</span><b>{{ result.rate.toFixed(1) }}<i>%</i></b></div>
        <div class="item"><span class="k">可视面积</span><b>{{ result.area.toFixed(2) }}<i>km²</i></b></div>
        <div class="item"><span class="k">最远可视</span><b>{{ (result.farthest / 1000).toFixed(2) }}<i>km</i></b></div>
      </div>

      <div class="tip">
        对扇区内每个格网中心做<b>视线插值</b>：从眼高到目标高线性推进，中途任一点的地面高程
        超过视线高即判定遮挡。视场角 360° 是全向瞭望，收窄到 30° 就是定向监控探头 ——
        拖动主方位角可以"转动探头"。把视高拉到 2m 再对比 80m，能直观体会"登高望远"的价值。
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
.hint {
  margin-top: 9px;
  font-size: 11px;
  color: #9fb2c6;
}
.hint b {
  color: #ffd479;
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
