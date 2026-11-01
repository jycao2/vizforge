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

/**
 * 地形剖切 · 地下管廊
 *
 * 两种「看见地下」的姿势，都基于 globe.clippingPlanes：
 *  基坑模式：4 个朝外的竖直裁剪面取交集，正好挖掉一块矩形地面；再用 WallGraphics
 *            沿四边补出井壁、RectangleGraphics 补出坑底，坑才「有深度」而不是一个洞。
 *  剖切模式：单个竖直面按方位角与平移量切掉半块地，看的是断面。
 *
 * 另外两个必须踩过的坑：
 *  - 管线不能用 clampToGround（会被贴回地表），必须逐顶点采样真实高程再减埋深；
 *  - globe.depthTestAgainstTerrain 默认 false，地下管线会直接画在地表之上像穿模。
 */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 106.5791
const LAT = 29.5628
const EXT = 380 // 管网铺开的半边长 m（比基坑大一圈，地下模式才看得出全局布线）
const PIT = 200 // 基坑半边长 m
const GRID = 49 // 地形采样网格 49 × 49

// 机位在拿到真实高程后再算（见 frameSite）：高程差几百米，硬编码高度会钻到地下
const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.0032, 480),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-38), roll: 0 },
}

/** 按「相机离地面 300 m、水平退 380 m」定机位，pitch 由两者算出，框住整个基坑 */
function frameSite(v: Cesium.Viewer) {
  const g = groundAt(0, 0)
  const south = 560
  const up = 700
  v.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(LON, LAT - south / 110540, g + up),
    orientation: { heading: 0, pitch: -Math.atan2(up, south), roll: 0 },
  })
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

/* ---------------- 参数 ---------------- */

type Mode = 'pit' | 'slice'

const mode = ref<Mode>('pit')
const underOn = ref(false)
const pipesOn = ref(true)
const pitDepth = ref(34)
const azimuth = ref(28)
const offset = ref(0)
const depth = ref(8)
const stats = ref({ km: '0.00', nodes: 0, terrain: '采样中…', floor: 0 })

/* ---------------- 高程 ---------------- */

let grid: Float32Array | null = null
let siteMin = 0

function offsetLonLat(dx: number, dy: number): [number, number] {
  return [LON + dx / (111320 * Math.cos(Cesium.Math.toRadians(LAT))), LAT + dy / 110540]
}

/** 双线性采样高程网格（第 0 行是北边） */
function groundAt(dx: number, dy: number): number {
  if (!grid) return 0
  const u = ((dx + EXT) / (2 * EXT)) * (GRID - 1)
  const v = ((EXT - dy) / (2 * EXT)) * (GRID - 1)
  const i0 = Math.max(0, Math.min(GRID - 2, Math.floor(u)))
  const j0 = Math.max(0, Math.min(GRID - 2, Math.floor(v)))
  const tx = Math.min(1, Math.max(0, u - i0))
  const ty = Math.min(1, Math.max(0, v - j0))
  const a = grid[j0 * GRID + i0]
  const b = grid[j0 * GRID + i0 + 1]
  const c = grid[(j0 + 1) * GRID + i0]
  const d = grid[(j0 + 1) * GRID + i0 + 1]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

/** 离线兜底：造一道缓坡，断网时示例仍然可用 */
function fallbackGrid(): Float32Array {
  const out = new Float32Array(GRID * GRID)
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const x = ((i / (GRID - 1)) * 2 - 1) * EXT
      const y = ((j / (GRID - 1)) * 2 - 1) * EXT
      out[j * GRID + i] = 252 + 14 * Math.sin(x / 130) + 9 * Math.cos(y / 90)
    }
  }
  return out
}

/* ---------------- 管网 ---------------- */

const PIPE_STYLES = [
  { name: '给水', color: '#3ea8ff', radius: 6 },
  { name: '污水', color: '#c08a52', radius: 8 },
  { name: '燃气', color: '#ffc94a', radius: 5 },
  { name: '电力', color: '#b07dff', radius: 7 },
]

const pipes: Cesium.Entity[] = []
const wells: Array<{ entity: Cesium.Entity; dx: number; dy: number }> = []
const MAINS = [-266, -89, 89, 266]

function buildPipes(v: Cesium.Viewer) {
  let total = 0

  const addPipe = (pts: Array<[number, number]>, k: number) => {
    const st = PIPE_STYLES[k % 4]
    const entity = v.entities.add({
      polyline: {
        // 每帧按当前埋深重算，拖滑块时管线跟着往下走
        positions: new Cesium.CallbackProperty(() => {
          const flat: number[] = []
          for (const [dx, dy] of pts) {
            const [lon, lat] = offsetLonLat(dx, dy)
            flat.push(lon, lat, groundAt(dx, dy) - depth.value)
          }
          return Cesium.Cartesian3.fromDegreesArrayHeights(flat)
        }, false),
        width: st.radius,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.22,
          color: Cesium.Color.fromCssColorString(st.color),
        }),
      },
    })
    pipes.push(entity)
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    }
  }

  MAINS.forEach((y, k) => addPipe([[-EXT + 16, y], [EXT - 16, y]], k))
  MAINS.forEach((x, k) => addPipe([[x, -EXT + 16], [x, EXT - 16]], k + 2))
  // 联络管：主干之间拉斜线，让管网不是一个死板的正交网格
  for (let k = 0; k < 3; k++) {
    addPipe([[-280 + k * 70, MAINS[k]], [-200 + k * 70, MAINS[k + 1]]], k + 1)
    addPipe([[MAINS[k], 280 - k * 70], [MAINS[k + 1], 200 - k * 70]], k)
  }

  // 检查井：圆柱，顶盖略高出地面
  let nodes = 0
  for (const y of MAINS) {
    for (const x of MAINS) {
      const [lon, lat] = offsetLonLat(x, y)
      const g = groundAt(x, y)
      const st = PIPE_STYLES[(nodes + 1) % 4]
      const entity = v.entities.add({
        cylinder: {
          length: depth.value + 6,
          topRadius: 3.2,
          bottomRadius: 3.2,
          material: Cesium.Color.fromCssColorString(st.color).withAlpha(0.5),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString(st.color),
        },
        position: Cesium.Cartesian3.fromDegrees(lon, lat, g - (depth.value + 6) / 2),
      })
      wells.push({ entity, dx: x, dy: y })
      nodes++
    }
  }

  stats.value.km = (total / 1000).toFixed(2)
  stats.value.nodes = nodes
}

function refreshWells() {
  const len = depth.value + 6
  for (const w of wells) {
    const g = groundAt(w.dx, w.dy)
    if (w.entity.cylinder) w.entity.cylinder.length = new Cesium.ConstantProperty(len)
    const [lon, lat] = offsetLonLat(w.dx, w.dy)
    w.entity.position = new Cesium.ConstantPositionProperty(
      Cesium.Cartesian3.fromDegrees(lon, lat, g - len / 2),
    )
  }
}

/* ---------------- 基坑井壁与坑底 ---------------- */

const pitParts: Cesium.Entity[] = []

function buildPit(v: Cesium.Viewer) {
  const floor = siteMin - pitDepth.value
  const seg = 6 // 每条边分几段，井壁顶边才能跟着地形起伏

  const edges: Array<Array<[number, number]>> = [
    Array.from({ length: seg + 1 }, (_, i) => [-PIT + (2 * PIT * i) / seg, -PIT] as [number, number]),
    Array.from({ length: seg + 1 }, (_, i) => [PIT, -PIT + (2 * PIT * i) / seg] as [number, number]),
    Array.from({ length: seg + 1 }, (_, i) => [PIT - (2 * PIT * i) / seg, PIT] as [number, number]),
    Array.from({ length: seg + 1 }, (_, i) => [-PIT, PIT - (2 * PIT * i) / seg] as [number, number]),
  ]

  for (const edge of edges) {
    const pos = edge.map(([dx, dy]) => {
      const [lon, lat] = offsetLonLat(dx, dy)
      return Cesium.Cartesian3.fromDegrees(lon, lat)
    })
    const tops = edge.map(([dx, dy]) => Math.max(groundAt(dx, dy), floor + 2))
    pitParts.push(
      v.entities.add({
        wall: {
          positions: pos,
          maximumHeights: tops,
          minimumHeights: tops.map(() => floor),
          // 分层土：条纹材质当「土层」，比纯色更像剖面
          material: new Cesium.StripeMaterialProperty({
            evenColor: Cesium.Color.fromCssColorString('#6d5947'),
            oddColor: Cesium.Color.fromCssColorString('#54443a'),
            repeat: 7,
            orientation: Cesium.StripeOrientation.HORIZONTAL,
          }),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#9c8168').withAlpha(0.85),
        },
      }),
    )
  }

  // 坑底：矩形面，比井壁暗一档
  const corners = [
    offsetLonLat(-PIT, -PIT),
    offsetLonLat(PIT, -PIT),
    offsetLonLat(PIT, PIT),
    offsetLonLat(-PIT, PIT),
  ]
  pitParts.push(
    v.entities.add({
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(
          Math.min(...corners.map((c) => c[0])),
          Math.min(...corners.map((c) => c[1])),
          Math.max(...corners.map((c) => c[0])),
          Math.max(...corners.map((c) => c[1])),
        ),
        height: floor,
        material: Cesium.Color.fromCssColorString('#2b231b'),
      },
    }),
  )
  stats.value.floor = Math.round(floor)
}

let sliceWall: Cesium.Entity | null = null

/** 剖切模式：沿切面补一道土壁，否则看到的是「世界少了一半」而不是「剖面」 */
function buildSliceWall(v: Cesium.Viewer) {
  if (sliceWall) {
    v.entities.remove(sliceWall)
    sliceWall = null
  }
  if (mode.value !== 'slice') return
  const az = Cesium.Math.toRadians(azimuth.value)
  const cx = Math.cos(az) * offset.value
  const cy = Math.sin(az) * offset.value
  const dx = -Math.sin(az) * EXT
  const dy = Math.cos(az) * EXT
  const floor = siteMin - pitDepth.value - 10
  const seg = 16
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= seg; i++) {
    const t = i / seg
    pts.push([cx - dx + 2 * dx * t, cy - dy + 2 * dy * t])
  }
  const pos = pts.map(([px, py]) => {
    const [lon, lat] = offsetLonLat(px, py)
    return Cesium.Cartesian3.fromDegrees(lon, lat)
  })
  const tops = pts.map(([px, py]) => Math.max(groundAt(px, py), floor + 4))
  sliceWall = v.entities.add({
    wall: {
      positions: pos,
      maximumHeights: tops,
      minimumHeights: tops.map(() => floor),
      material: new Cesium.StripeMaterialProperty({
        evenColor: Cesium.Color.fromCssColorString('#6d5947'),
        oddColor: Cesium.Color.fromCssColorString('#54443a'),
        repeat: 7,
        orientation: Cesium.StripeOrientation.HORIZONTAL,
      }),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#9c8168').withAlpha(0.85),
    },
  })
}

function refreshPit(v: Cesium.Viewer) {
  for (const e of pitParts) v.entities.remove(e)
  pitParts.length = 0
  buildPit(v)
}

/* ---------------- 裁剪面 ---------------- */

let clip: Cesium.ClippingPlaneCollection | null = null

/** 局部方向向量 → ECEF 法线 */
function normalOf(enu: Cesium.Matrix4, dir: Cesium.Cartesian3): Cesium.Cartesian3 {
  const n = Cesium.Matrix4.multiplyByPointAsVector(enu, dir, new Cesium.Cartesian3())
  return Cesium.Cartesian3.normalize(n, n)
}

/** 过点 p0、法线 n 的平面：n·x + d = 0，Cesium 丢弃 n·x + d < 0 的一侧 */
function planeAt(n: Cesium.Cartesian3, p0: Cesium.Cartesian3): Cesium.ClippingPlane {
  return new Cesium.ClippingPlane(Cesium.Cartesian3.clone(n), -Cesium.Cartesian3.dot(n, p0))
}

function buildPlanes(): Cesium.ClippingPlane[] {
  const center = Cesium.Cartesian3.fromDegrees(LON, LAT)
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center)
  const toWorld = (dx: number, dy: number) =>
    Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(dx, dy, 0), new Cesium.Cartesian3())

  if (mode.value === 'pit') {
    // 四个法线朝外的竖直面：交集正好是基坑内部 → 被挖掉
    const e = normalOf(enu, new Cesium.Cartesian3(1, 0, 0))
    const w = normalOf(enu, new Cesium.Cartesian3(-1, 0, 0))
    const n = normalOf(enu, new Cesium.Cartesian3(0, 1, 0))
    const s = normalOf(enu, new Cesium.Cartesian3(0, -1, 0))
    return [
      planeAt(e, toWorld(PIT, 0)),
      planeAt(w, toWorld(-PIT, 0)),
      planeAt(n, toWorld(0, PIT)),
      planeAt(s, toWorld(0, -PIT)),
    ]
  }

  // 剖切：方位角决定法线方向，平移量沿法线推平面
  const az = Cesium.Math.toRadians(azimuth.value)
  const normal = normalOf(enu, new Cesium.Cartesian3(Math.cos(az), Math.sin(az), 0))
  const p0 = Cesium.Cartesian3.add(
    center,
    Cesium.Cartesian3.multiplyByScalar(normal, offset.value, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  return [planeAt(normal, p0)]
}

function applyClip() {
  if (!viewer) return
  const globe = viewer.scene.globe
  const planes = buildPlanes()
  if (!clip) {
    clip = new Cesium.ClippingPlaneCollection({
      planes,
      edgeColor: Cesium.Color.fromCssColorString('#7fe3ff').withAlpha(0.9),
      edgeWidth: 2,
      unionClippingRegions: false,
    })
    globe.clippingPlanes = clip
  } else {
    clip.removeAll()
    for (const p of planes) clip.add(p)
    clip.enabled = true
  }
}

/**
 * 地表半透明：不切开也能看见地下。
 * 半透明地表仍然写深度，这时必须关掉 depthTestAgainstTerrain，否则管线还是被挡。
 */
function applyTranslucency() {
  if (!viewer) return
  const t = viewer.scene.globe.translucency
  const on = underOn.value
  t.enabled = on
  t.frontFaceAlpha = on ? 0.42 : 1
  t.backFaceAlpha = 1
  viewer.scene.globe.depthTestAgainstTerrain = !on
}

watch(mode, (m) => {
  for (const e of pitParts) e.show = m === 'pit'
  if (viewer) buildSliceWall(viewer)
  applyClip()
})
watch(azimuth, () => {
  if (viewer) buildSliceWall(viewer)
  applyClip()
})
watch(offset, () => {
  if (viewer) buildSliceWall(viewer)
  applyClip()
})
watch(underOn, applyTranslucency)
watch(depth, refreshWells)
watch(pitDepth, () => {
  if (viewer && mode.value === 'pit') {
    refreshPit(viewer)
    applyClip()
  } else if (viewer) {
    buildSliceWall(viewer)
  }
})
watch(pipesOn, (on) => {
  for (const p of pipes) p.show = on
  for (const w of wells) w.entity.show = on
})

/* ---------------- 生命周期 ---------------- */

let stopTerrain: (() => void) | null = null

onMounted(async () => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  viewer.camera.setView(home)
  viewer.scene.globe.depthTestAgainstTerrain = true

  stopTerrain = enableTerrainScene(viewer)
  const real = await waitRealTerrain(viewer, 15000)
  const dLon = EXT / (111320 * Math.cos(Cesium.Math.toRadians(LAT)))
  const dLat = EXT / 110540
  const sampled = real
    ? await sampleTerrainGrid(viewer, LON - dLon, LAT - dLat, LON + dLon, LAT + dLat, GRID, 12)
    : null
  grid = sampled ?? fallbackGrid()
  siteMin = grid.reduce((m, h) => Math.min(m, h), Infinity)
  stats.value.terrain = sampled ? 'Esri 真实高程' : '程序化兜底'

  if (viewer.isDestroyed()) return
  buildPipes(viewer)
  buildPit(viewer)
  buildSliceWall(viewer)
  applyClip()
  frameSite(viewer)
})

onBeforeUnmount(() => {
  if (stopTerrain) stopTerrain()
  pipes.length = 0
  wells.length = 0
  pitParts.length = 0
  sliceWall = null
  grid = null
  clip = null
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
      <div class="title">
        <span class="dot live"></span>
        地形剖切 · 地下管廊
      </div>
      <div class="sub">重庆渝中 · 基坑 {{ PIT * 2 }} m · 管网 {{ EXT * 2 }} m · {{ stats.terrain }}</div>

      <div class="kpi">
        <div class="cell">
          <b>{{ stats.km }}<i>km</i></b>
          <span>管线总长</span>
        </div>
        <div class="cell">
          <b>{{ stats.nodes }}</b>
          <span>检查井</span>
        </div>
        <div class="cell">
          <b>{{ stats.floor }}<i>m</i></b>
          <span>坑底高程</span>
        </div>
      </div>

      <div class="row">
        <button class="chip" :class="{ on: mode === 'pit' }" @click="mode = 'pit'">基坑</button>
        <button class="chip" :class="{ on: mode === 'slice' }" @click="mode = 'slice'">剖切</button>
        <button class="chip" :class="{ on: underOn }" @click="underOn = !underOn">地下模式</button>
        <button class="chip" :class="{ on: pipesOn }" @click="pipesOn = !pipesOn">管网</button>
      </div>

      <div v-if="mode === 'pit'" class="ctrl">
        <span class="lab">基坑深度</span>
        <input v-model.number="pitDepth" type="range" min="16" max="60" step="1" />
        <b>{{ pitDepth }}<i>m</i></b>
      </div>
      <template v-else>
        <div class="ctrl">
          <span class="lab">剖切方位</span>
          <input v-model.number="azimuth" type="range" min="0" max="360" step="2" />
          <b>{{ azimuth }}<i>°</i></b>
        </div>
        <div class="ctrl">
          <span class="lab">剖切位置</span>
          <input v-model.number="offset" type="range" min="-300" max="300" step="5" />
          <b>{{ offset }}<i>m</i></b>
        </div>
      </template>
      <div class="ctrl">
        <span class="lab">管线埋深</span>
        <input v-model.number="depth" type="range" min="3" max="24" step="1" />
        <b>{{ depth }}<i>m</i></b>
      </div>

      <div class="legend">
        <span v-for="s in PIPE_STYLES" :key="s.name" class="lg">
          <i :style="{ background: s.color }"></i>{{ s.name }}
        </span>
      </div>

      <div class="tip">
        <b>基坑</b>是四个法线朝外的竖直裁剪面取交集，正好挖掉矩形地面；Cesium 只切面不留壁，
        所以井壁和坑底要用 <b>WallGraphics</b> / <b>RectangleGraphics</b> 自己补。
        管线不能 <b>clampToGround</b>（会被贴回地表），必须逐顶点采样真实高程再减埋深。
        裁剪面只作用于 globe，管线不会跟着被切 —— 所以剖切模式下切口处会看到悬空管线，
        想看「在土里的管线」用基坑或地下模式。地下模式靠 <b>translucency</b>，此时要关掉
        depthTestAgainstTerrain，否则管线仍被地表挡住。
      </div>
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
.cesium-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 318px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(12, 18, 26, 0.9);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
}
.title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6b7783;
}
.dot.live {
  background: #7fe3ff;
  box-shadow: 0 0 9px #7fe3ff;
}
.sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: #7d8fa2;
}
.kpi {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid rgba(88, 108, 132, 0.28);
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.cell b {
  font-size: 15px;
  font-weight: 600;
  color: #e8f4ff;
  font-family: ui-monospace, monospace;
}
.cell b i {
  font-style: normal;
  font-size: 9.5px;
  color: #6f8296;
  margin-left: 1px;
}
.cell span {
  font-size: 9.5px;
  color: #7d8fa2;
}
.row {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.chip {
  padding: 3px 9px;
  font-size: 11px;
  color: #b7c6d6;
  background: rgba(38, 50, 64, 0.9);
  border: 1px solid rgba(96, 116, 140, 0.4);
  border-radius: 6px;
  cursor: pointer;
  transition: 0.15s;
}
.chip:hover {
  border-color: rgba(127, 227, 255, 0.5);
  color: #e6f4ff;
}
.chip.on {
  color: #06121a;
  background: #7fe3ff;
  border-color: #7fe3ff;
  font-weight: 600;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.lab {
  flex: 0 0 58px;
  font-size: 11px;
  color: #8fa0b3;
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
  background: #7fe3ff;
  border: 2px solid #0b1119;
  cursor: pointer;
}
.ctrl b {
  flex: 0 0 46px;
  text-align: right;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #cfe4f5;
  font-weight: 500;
}
.ctrl b i {
  font-style: normal;
  font-size: 9.5px;
  color: #6f8296;
  margin-left: 1px;
}
.legend {
  display: flex;
  gap: 10px;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.24);
}
.lg {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #93a4b6;
}
.lg i {
  width: 12px;
  height: 3px;
  border-radius: 2px;
}
.tip {
  margin-top: 8px;
  font-size: 10.5px;
  line-height: 1.6;
  color: #7b8b9d;
}
.tip b {
  color: #cfe4f5;
  font-weight: 600;
}
</style>
