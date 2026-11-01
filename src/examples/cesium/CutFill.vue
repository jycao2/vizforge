<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import {
  VIEWER_OPTIONS,
  enableTerrainScene,
  sampleTerrainGrid,
  useCesiumBasemap,
  useCesiumView,
  waitRealTerrain,
} from './useCesium'
import {
  demRectangle,
  makeDrapedPrimitive,
  makeImageMaterial,
  makeTextureUploader,
} from './demMesh'
import { applyRealHeights, contourLine, makeDEM, type DEM } from '@/examples/shared/terrain'

/* ============================================================
 * 场地平整 · 挖填方分析
 *  - 设计面：基准标高 + X/Y 双向排水坡度（‰），真实工程里"找坡"就长这样
 *  - 差值场：d = 地面高程 - 设计高程，d>0 挖（红）、d<0 填（蓝），零线即挖填分界线
 *  - 土方量：格网柱体法 Σ|d|·cell²（设计面在格网内近似取中心值，格网够密误差 <1%）
 *  - 平衡标高：挖=填 的标高用二分法求 —— 挖方量随标高单调降、填方单调升，
 *             天然满足二分条件，比"逐格试算"优雅得多
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null
/** 分析基底直接取真实地形高程，结果再贴回地形表面（不再抬高成"悬空块"） */
let stopTerrain: (() => void) | null = null

const LON = 116.35
const LAT = 40.08
const SPAN = 2400
const N = 129

/* ---------------- 参数 ---------------- */
const baseH = ref(60) // 设计基准标高（米）
const slopeX = ref(4) // 东西向坡度（‰）
const slopeY = ref(0) // 南北向坡度（‰）
const showGrid = ref(true) // 方格网
const showZero = ref(true) // 挖填零线
const showPlane = ref(true) // 设计面

const priceCut = 14 // 挖方单价（元/m³，含装运）
const priceFill = 22 // 填方单价（元/m³，含碾压）

const result = ref({
  cut: 0,
  fill: 0,
  net: 0,
  cutArea: 0,
  fillArea: 0,
  maxCut: 0,
  maxFill: 0,
  cost: 0,
})

/** 设计高程（uv 空间，u 向东） */
function designH(u: number, v: number): number {
  const span = SPAN
  return (
    baseH.value +
    ((u - 0.5) * span * slopeX.value) / 1000 +
    ((0.5 - v) * span * slopeY.value) / 1000
  )
}

/* ---------------- DEM 与差值场 ---------------- */
const TEX = 720
const canvas = document.createElement('canvas')
canvas.width = TEX
canvas.height = TEX
const ctx = canvas.getContext('2d')!

const dem: DEM = makeDEM({
  lon: LON,
  lat: LAT,
  span: SPAN,
  n: N,
  relief: 42,
  base: 38,
  shape: 'rolling',
  seed: 7712,
})
const diff = new Float32Array(N * N) // 每格网中心的高差

function computeDiff() {
  for (let j = 0; j < N; j++) {
    const v = j / (N - 1)
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1)
      diff[j * N + i] = dem.h[j * N + i] - designH(u, v)
    }
  }
}

function computeStats() {
  const cellA = dem.cell * dem.cell
  let cut = 0
  let fill = 0
  let cutArea = 0
  let fillArea = 0
  let maxCut = 0
  let maxFill = 0
  for (let k = 0; k < diff.length; k++) {
    const d = diff[k]
    if (d > 0) {
      cut += d * cellA
      cutArea += cellA
      if (d > maxCut) maxCut = d
    } else if (d < 0) {
      fill += -d * cellA
      fillArea += cellA
      if (-d > maxFill) maxFill = -d
    }
  }
  result.value = {
    cut: cut / 1000,
    fill: fill / 1000,
    net: (cut - fill) / 1000,
    cutArea: cutArea / 1e6,
    fillArea: fillArea / 1e6,
    maxCut,
    maxFill,
    cost: (cut * priceCut + fill * priceFill) / 10000,
  }
}

/** 二分求挖填平衡标高：把基准标高在 [min-50, max+50] 之间搜到净方量变号 */
function balance() {
  let lo = dem.min - 60
  let hi = dem.max + 60
  const evalNet = (h: number) => {
    let net = 0
    for (let j = 0; j < N; j++) {
      const v = j / (N - 1)
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1)
        const d = dem.h[j * N + i] - (h + ((u - 0.5) * SPAN * slopeX.value) / 1000 + ((0.5 - v) * SPAN * slopeY.value) / 1000)
        net += d * dem.cell * dem.cell
      }
    }
    return net
  }
  // 净方量随设计标高单调递减：net > 0（挖多于填）说明标高还可再抬 → lo 上移。
  // 之前写反（net>0 时收 hi），净值一旦为负就一路把 lo 推到上界，结果跳到 dem.max+60。
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2
    if (evalNet(mid) > 0) lo = mid
    else hi = mid
  }
  const balanced = (lo + hi) / 2
  baseH.value = Math.round(Cesium.Math.clamp(balanced, dem.min, dem.max) * 100) / 100
}

/* ---------------- 着色 ---------------- */
function bake() {
  const img = ctx.createImageData(TEX, TEX)
  const d = img.data
  const scaleCut = Math.max(result.value.maxCut, 4)
  const scaleFill = Math.max(result.value.maxFill, 4)

  for (let py = 0; py < TEX; py++) {
    const v = py / (TEX - 1)
    for (let px = 0; px < TEX; px++) {
      const u = px / (TEX - 1)
      const h = dem.h[Math.round(v * (N - 1)) * N + Math.round(u * (N - 1))]
      const dif = h - designH(u, v)
      let r: number
      let g: number
      let b: number
      if (dif > 0.15) {
        // 挖方：浅黄 → 深红
        const t = Math.min(dif / scaleCut, 1)
        r = 255
        g = 226 - t * 160
        b = 150 - t * 110
      } else if (dif < -0.15) {
        // 填方：浅青 → 深蓝
        const t = Math.min(-dif / scaleFill, 1)
        r = 190 - t * 140
        g = 232 - t * 130
        b = 255
      } else {
        r = 148
        g = 158
        b = 150 // 挖填平衡带
      }
      const t = (py * TEX + px) << 2
      d[t] = r
      d[t + 1] = g
      d[t + 2] = b
      // 半透明：地面影像透出来，色块才像"画在"地形上而不是盖了块板
      d[t + 3] = dif > 0.15 || dif < -0.15 ? 190 : 90
    }
  }
  ctx.putImageData(img, 0, 0)

  if (showGrid.value) {
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.lineWidth = 1
    const step = 8
    for (let k = 0; k <= N; k += step) {
      const p = (k / (N - 1)) * TEX
      ctx.beginPath()
      ctx.moveTo(p, 0)
      ctx.lineTo(p, TEX)
      ctx.moveTo(0, p)
      ctx.lineTo(TEX, p)
      ctx.stroke()
    }
  }
  if (showZero.value) {
    // 零线 = 差值场的 0 等值线：直接把差值场伪装成 DEM 复用 Marching Squares
    const segs = contourLine({ ...dem, h: diff, min: -1, max: 1 }, 0)
    ctx.strokeStyle = 'rgba(12,14,18,0.95)'
    ctx.lineWidth = 2.2
    ctx.setLineDash([7, 4])
    ctx.beginPath()
    for (let i = 0; i < segs.length; i += 4) {
      ctx.moveTo(segs[i] * TEX, segs[i + 1] * TEX)
      ctx.lineTo(segs[i + 2] * TEX, segs[i + 3] * TEX)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }
}

/* ---------------- 图元 ---------------- */
let terrainPrim: Cesium.GroundPrimitive | null = null
let terrainMat: Cesium.Material | null = null
let planePrim: Cesium.Primitive | null = null
const uploader = makeTextureUploader()

function buildTerrain() {
  const scene = viewer?.scene
  if (!scene) return
  if (terrainPrim) scene.groundPrimitives.remove(terrainPrim)
  terrainMat = makeImageMaterial(canvas)
  // 贴地：用 GroundPrimitive 分类渲染，色块随真实地形起伏，缩放不分离
  terrainPrim = makeDrapedPrimitive(demRectangle(dem), terrainMat, true)
  scene.groundPrimitives.add(terrainPrim)
  uploader.upload(terrainMat, canvas)
}

/**
 * 设计面：直接按设计高程建在世界坐标（33×33 网格，顶点高程 = 基准标高 + 坡度项）。
 * 不用"局部坐标 + modelMatrix"——Cesium 的 projectTo2D 对含原点的局部坐标会抛
 * DeveloperError（Could not project point (0,0,0) to 2D），世界坐标没有这个问题。
 */
function buildPlane() {
  const scene = viewer?.scene
  if (!scene) return
  if (planePrim) {
    scene.primitives.remove(planePrim)
    planePrim = null
  }
  if (!showPlane.value) return
  const pn = 33
  const count = pn * pn
  const positions = new Float64Array(count * 3)
  const normals = new Float32Array(count * 3)
  const st = new Float32Array(count * 2)
  const indices = new Uint32Array((pn - 1) * (pn - 1) * 6)
  const tmp = new Cesium.Cartesian3()
  const nrm = new Cesium.Cartesian3()
  for (let j = 0; j < pn; j++) {
    const v = j / (pn - 1)
    for (let i = 0; i < pn; i++) {
      const u = i / (pn - 1)
      const k = j * pn + i
      const lon = dem.lon0 + (dem.lon1 - dem.lon0) * u
      const lat = dem.lat1 - (dem.lat1 - dem.lat0) * v
      Cesium.Cartesian3.fromDegrees(lon, lat, designH(u, v), undefined, tmp)
      positions[k * 3] = tmp.x
      positions[k * 3 + 1] = tmp.y
      positions[k * 3 + 2] = tmp.z
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(tmp, nrm)
      normals[k * 3] = nrm.x
      normals[k * 3 + 1] = nrm.y
      normals[k * 3 + 2] = nrm.z
      st[k * 2] = u
      st[k * 2 + 1] = 1 - v
    }
  }
  let p = 0
  for (let j = 0; j < pn - 1; j++) {
    for (let i = 0; i < pn - 1; i++) {
      const a = j * pn + i
      const b = a + 1
      const c = a + pn
      const d = a + pn + 1
      indices[p++] = a
      indices[p++] = b
      indices[p++] = c
      indices[p++] = b
      indices[p++] = d
      indices[p++] = c
    }
  }
  const attr = new Cesium.GeometryAttributes()
  attr.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: positions,
  })
  attr.normal = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: normals,
  })
  attr.st = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.FLOAT,
    componentsPerAttribute: 2,
    values: st,
  })
  const mat = new Cesium.Material({
    fabric: {
      uniforms: {},
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          // 黄色网格线设计面：用 st 的分形网格画线
          vec2 g = fract(materialInput.st * 16.0);
          float line = min(min(g.x, g.y), min(1.0 - g.x, 1.0 - g.y));
          float edge = 1.0 - smoothstep(0.0, 0.045, line);
          m.diffuse = mix(vec3(0.95, 0.82, 0.25), vec3(0.55, 0.45, 0.1), edge);
          m.alpha = 0.10 + 0.22 * edge;
          return m;
        }`,
    },
    translucent: true,
  })
  planePrim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.Geometry({
        attributes: attr,
        indices,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: mat,
      translucent: true,
      flat: true,
    }),
    asynchronous: false,
  })
  scene.primitives.add(planePrim)
}

let pending = false
function schedule(kind: 'tex' | 'plane') {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    computeDiff()
    computeStats()
    bake()
    uploader.upload(terrainMat, canvas)
    if (kind === 'plane') buildPlane()
  })
}

/* ---------------- 视角 ---------------- */
const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.024, 3900),
  orientation: { heading: Cesium.Math.toRadians(-18), pitch: Cesium.Math.toRadians(-41), roll: 0 },
  // 场地 2.4km 见方，焦点取场地中心
  focus: {
    center: Cesium.Cartesian3.fromDegrees(LON, LAT),
    radius: SPAN * 0.72,
    range: 4300,
  },
}
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(() => viewer, () => home)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'imagery')

watch([baseH, slopeX, slopeY, showGrid, showZero], () => schedule('tex'))
watch(showPlane, () => schedule('plane'))

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  const scene = viewer.scene
  scene.globe.enableLighting = false

  stopTerrain = enableTerrainScene(viewer)

  computeDiff()
  computeStats()
  bake()
  viewer.camera.setView(home)

  // 等真实地形就位再渲染：避免先画一版程序化高程、再跳变到真实地面的闪烁
  void (async () => {
    const ready = await waitRealTerrain(viewer)
    const grid = ready ? await sampleTerrainGrid(viewer, dem.lon0, dem.lat0, dem.lon1, dem.lat1, 65, 12) : null
    if (!viewer || viewer.isDestroyed()) return
    if (!grid) {
      buildTerrain()
      buildPlane()
      return
    }
    applyRealHeights(dem, grid, 65)
    // 设计标高改到真实地面的量纲（滑块区间同步）
    // 默认取均值再求一次平衡标高，挖填都有量，色块才不会整片单色
    baseH.value = Math.round(((dem.min + dem.max) / 2) * 10) / 10
    computeDiff()
    balance()
    computeDiff()
    computeStats()
    bake()
    buildTerrain()
    buildPlane()
  })()
})

onBeforeUnmount(() => {
  stopTerrain?.()
  uploader.dispose()
  terrainMat = null
  terrainPrim = null
  planePrim = null
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
      <div class="title">场地平整 · 挖填方分析</div>
      <div class="sub">设计面找坡 → 差值场红挖蓝填 → 格网柱体法算土方，零线即挖填分界</div>

      <div class="ctrl">
        <span class="lab">设计标高</span>
        <input
          v-model.number="baseH"
          type="range"
          :min="Math.round(dem.min)"
          :max="Math.round(dem.max)"
          step="0.5"
        />
        <b>{{ baseH.toFixed(1) }}<i>m</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">东西坡度</span>
        <input v-model.number="slopeX" type="range" min="0" max="20" step="0.5" />
        <b>{{ slopeX.toFixed(1) }}<i>‰</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">南北坡度</span>
        <input v-model.number="slopeY" type="range" min="0" max="20" step="0.5" />
        <b>{{ slopeY.toFixed(1) }}<i>‰</i></b>
      </div>

      <div class="row btns">
        <button class="chip primary" @click="balance">土方平衡标高</button>
        <button class="chip" :class="{ on: showPlane }" @click="showPlane = !showPlane">设计面</button>
        <button class="chip" :class="{ on: showGrid }" @click="showGrid = !showGrid">方格网</button>
        <button class="chip" :class="{ on: showZero }" @click="showZero = !showZero">零线</button>
      </div>

      <div class="stat">
        <div class="item cut"><span class="k">挖方</span><b>{{ result.cut.toFixed(0) }}<i>千m³</i></b></div>
        <div class="item fill"><span class="k">填方</span><b>{{ result.fill.toFixed(0) }}<i>千m³</i></b></div>
        <div class="item"><span class="k">净方</span><b>{{ result.net.toFixed(0) }}<i>千m³</i></b></div>
        <div class="item"><span class="k">挖方面积</span><b>{{ result.cutArea.toFixed(2) }}<i>km²</i></b></div>
        <div class="item"><span class="k">填方面积</span><b>{{ result.fillArea.toFixed(2) }}<i>km²</i></b></div>
        <div class="item"><span class="k">造价</span><b>{{ result.cost.toFixed(0) }}<i>万元</i></b></div>
      </div>

      <div class="legend">
        <span class="lg"><i class="sw cut"></i>挖方（最深 {{ result.maxCut.toFixed(1) }}m）</span>
        <span class="lg"><i class="sw fill"></i>填方（最深 {{ result.maxFill.toFixed(1) }}m）</span>
        <span class="lg"><i class="sw zero"></i>零线</span>
      </div>

      <div class="tip">
        土方量用<b>格网柱体法</b>：Σ|地面高程 − 设计高程| × 格网面积。设计面 = 基准标高 +
        双向排水坡度（工程上"找坡"就是这么算的），黄色半透明面就是它，和地形相交处即零线。
        「土方平衡标高」用<b>二分法</b>求挖 = 填的基准标高 —— 挖方量随标高单调下降、填方单调上升，
        净方量天然变号，60 次迭代收敛到毫米级。造价按挖方 {{ priceCut }} 元/m³、填方 {{ priceFill }} 元/m³ 估算。
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
  flex: 0 0 52px;
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
.chip.primary {
  background: linear-gradient(180deg, rgba(226, 122, 44, 0.95), rgba(186, 84, 24, 0.95));
  border-color: rgba(248, 150, 70, 0.7);
  color: #fff3e6;
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
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 9px;
  font-size: 10.5px;
  color: #8fa0b3;
}
.lg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sw {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  display: inline-block;
}
.sw.cut {
  background: linear-gradient(90deg, #ffe296, #ff5a32);
}
.sw.fill {
  background: linear-gradient(90deg, #bee8ff, #2e6bff);
}
.sw.zero {
  background: repeating-linear-gradient(90deg, #101418 0 4px, transparent 4px 7px);
  border: 1px solid rgba(255, 255, 255, 0.2);
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
