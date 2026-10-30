<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, enableTerrainScene, useCesiumBasemap, useCesiumView } from './useCesium'
import { makeImageMaterial, makeRectanglePrimitive, makeTextureUploader } from './demMesh'

/* ============================================================
 * 掩膜裁剪
 *
 * 两套裁剪手段，各管一层：
 *  1) 影像掩膜：把形状烘成一张 SDF（signed distance field，带符号距离场）
 *     纹理 —— R 通道存"到边界的有符号距离"，材质里按距离做 smoothstep，
 *     于是"羽化边"只是一个 smoothstep 宽度参数，边缘亮线就是 |d| < 45m 的带。
 *     换形状 / 改大小 / 转角度都只是重烘一遍 512² 的距离场，几何完全不动。
 *  2) 地形裁剪：globe.clippingPlanes。多边形的每条边生成一个 ClippingPlane，
 *     法线朝外 → 平面的 INSIDE（正法线一侧）被裁掉，保留下来的正好是内部；
 *     全部法线反向就是"挖除内部"。这就是 GIS 里的"矢量掩膜裁剪"，
 *     Cesium 用平面集合近似实现（凸多边形精确，凹多边形会被近似）。
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null
let stopTerrain: (() => void) | null = null

const LON = 116.32
const LAT = 40.06
const SPAN_X = 36000 // 米
const SPAN_Y = 28000 // 米
// 米 → 度（矩形图元、点击反算都用度）
const DLON = SPAN_X / (111320 * Math.cos((LAT * Math.PI) / 180))
const DLAT = SPAN_Y / 110540

/* ---------------- 参数 ---------------- */
type Shape = 'rect' | 'circle' | 'poly'
const SHAPES: Array<{ id: Shape; label: string }> = [
  { id: 'rect', label: '矩形' },
  { id: 'circle', label: '圆形' },
  { id: 'poly', label: '多边形' },
]
type ClipMode = 'keep' | 'hole' | 'band'
const MODES: Array<{ id: ClipMode; label: string }> = [
  { id: 'keep', label: '保留内部' },
  { id: 'hole', label: '挖除内部' },
  { id: 'band', label: '仅边界带' },
]

const shape = ref<Shape>('poly')
const mode = ref<ClipMode>('keep')
const sizeKm = ref(9) // 特征尺寸（矩形半宽 / 半径 / 外接半径）
const sides = ref(6) // 多边形边数
const rotDeg = ref(18) // 旋转角
const feather = ref(1200) // 羽化带宽（米）
const clipTerrain = ref(false) // 地形裁剪开关
const areaText = ref('—')
const posText = ref('点击地图移动掩膜中心')

const centerUV = ref({ u: 0.5, v: 0.5 })

/** 掩膜中心经纬度 */
function centerLonLat(): [number, number] {
  return [
    LON - DLON / 2 + centerUV.value.u * DLON,
    LAT + DLAT / 2 - centerUV.value.v * DLAT,
  ]
}

/* ---------------- SDF 烘焙 ---------------- */
const TEX = 512
const canvas = document.createElement('canvas')
canvas.width = canvas.height = TEX
const ctx = canvas.getContext('2d')!

const RANGE = 6000 // SDF 编码半径：|d| 超过 6km 按 ±6km 截断

function sdShape(xm: number, ym: number): number {
  const r = sizeKm.value * 1000
  const cx = (centerUV.value.u - 0.5) * SPAN_X
  const cy = (0.5 - centerUV.value.v) * SPAN_Y
  if (shape.value === 'circle') {
    return Math.hypot(xm - cx, ym - cy) - r
  }
  if (shape.value === 'rect') {
    const dx = Math.abs(xm - cx) - r * 0.82
    const dy = Math.abs(ym - cy) - r * 0.55
    const ax = Math.max(dx, 0)
    const ay = Math.max(dy, 0)
    return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0)
  }
  // 正多边形（中心对称）：极坐标下到"最靠近的那条边"的距离
  const ang = Math.atan2(ym - cy, xm - cx) - (rotDeg.value * Math.PI) / 180
  const seg = (Math.PI * 2) / sides.value
  const rr = Math.hypot(xm - cx, ym - cy)
  const apothem = r * Math.cos(Math.PI / sides.value)
  const local = ((ang % seg) + seg) % seg
  return rr * Math.cos(local - seg / 2) - apothem
}

function bakeSDF() {
  const img = ctx.createImageData(TEX, TEX)
  const d = img.data
  for (let py = 0; py < TEX; py++) {
    const v = py / (TEX - 1)
    const ym = (0.5 - v) * SPAN_Y
    for (let px = 0; px < TEX; px++) {
      const u = px / (TEX - 1)
      const xm = (u - 0.5) * SPAN_X
      const dist = sdShape(xm, ym)
      const enc = 0.5 + 0.5 * Math.max(-1, Math.min(1, dist / RANGE))
      const t = (py * TEX + px) << 2
      d[t] = enc * 255
      d[t + 1] = enc * 255
      d[t + 2] = enc * 255
      d[t + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

function updateArea() {
  const r = sizeKm.value
  let a: number
  if (shape.value === 'circle') a = Math.PI * r * r
  else if (shape.value === 'rect') a = 4 * r * 0.82 * r * 0.55
  else a = 0.5 * sides.value * r * r * Math.sin((Math.PI * 2) / sides.value)
  areaText.value = a.toFixed(1)
}

/* ---------------- 图元 ---------------- */
let prim: Cesium.Primitive | null = null
let mat: Cesium.Material | null = null
const uploader = makeTextureUploader()

function buildPrimitive() {
  const scene = viewer?.scene
  if (!scene) return
  if (prim) scene.primitives.remove(prim)
  mat = new Cesium.Material({
    fabric: {
      uniforms: {
        image: canvas,
        uRange: RANGE,
        uFeather: feather.value,
        uMode: MODES.findIndex((m) => m.id === mode.value),
        uEdge: new Cesium.Color(0.28, 0.85, 0.95, 1),
      },
      source: `
        uniform sampler2D image;
        uniform float uRange;
        uniform float uFeather;
        uniform float uMode;
        uniform vec4 uEdge;
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          vec2 st = materialInput.st;
          float d = (texture(image, st).r - 0.5) * 2.0 * uRange; // 到边界的带符号距离（米）
          float aa = clamp(uFeather, 10.0, uRange);
          float inside = smoothstep(-aa, aa, d);                  // 羽化的"内部"掩膜
          float edge = 1.0 - smoothstep(0.0, 60.0, abs(d));       // 边界亮线
          vec3 dark = vec3(0.035, 0.05, 0.065);
          if (uMode < 0.5) {
            // 保留内部：区域外压暗
            float a = (1.0 - inside) * 0.86;
            m.diffuse = mix(dark, uEdge.rgb, edge * 0.9);
            m.alpha = max(a, edge * 0.95);
          } else if (uMode < 1.5) {
            // 挖除内部：区域内压暗
            float a = inside * 0.86;
            m.diffuse = mix(dark, uEdge.rgb, edge * 0.9);
            m.alpha = max(a, edge * 0.95);
          } else {
            // 只显示边界带
            float band = (1.0 - smoothstep(0.0, aa, abs(d)));
            m.diffuse = uEdge.rgb;
            m.alpha = band * 0.55;
          }
          return m;
        }`,
    },
    translucent: true,
    minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
  })
  prim = makeRectanglePrimitive(
    {
      lon0: LON - DLON / 2,
      lat0: LAT - DLAT / 2,
      lon1: LON + DLON / 2,
      lat1: LAT + DLAT / 2,
    } as never,
    mat,
    60,
  )
  scene.primitives.add(prim)
  uploader.upload(mat, canvas)
}

/* ---------------- 地形裁剪（globe.clippingPlanes） ---------------- */
let clipCollection: Cesium.ClippingPlaneCollection | null = null

/** 形状边界采样成多边形顶点（局部米制坐标，然后转世界坐标） */
function boundaryPoints(): Array<[number, number]> {
  const r = sizeKm.value * 1000
  const pts: Array<[number, number]> = []
  const cx = (centerUV.value.u - 0.5) * SPAN_X
  const cy = (0.5 - centerUV.value.v) * SPAN_Y
  if (shape.value === 'circle') {
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  } else if (shape.value === 'rect') {
    const rx = r * 0.82
    const ry = r * 0.55
    pts.push([cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry])
  } else {
    for (let i = 0; i < sides.value; i++) {
      const a = (i / sides.value) * Math.PI * 2 + (rotDeg.value * Math.PI) / 180
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  return pts
}

function applyTerrainClip() {
  const globe = viewer?.scene.globe
  if (!globe) return
  if (!clipTerrain.value) {
    if (clipCollection) clipCollection.enabled = false
    return
  }
  const [clon, clat] = centerLonLat()
  // 局部米 → 经纬度
  const toLL = (xm: number, ym: number): [number, number] => [
    clon + (xm / (SPAN_X / 2)) * (SPAN_X / 2) / (111320 * Math.cos((LAT * Math.PI) / 180)),
    clat + ym / 110540,
  ]
  const pts = boundaryPoints().map(([xm, ym]) => {
    const [lon, lat] = toLL(xm, ym)
    return Cesium.Cartesian3.fromDegrees(lon, lat)
  })
  const center = Cesium.Cartesian3.fromDegrees(clon, clat)
  const planes: Cesium.ClippingPlane[] = []
  const keepInside = mode.value === 'keep'
  const mid = new Cesium.Cartesian3()
  const e1 = new Cesium.Cartesian3()
  const up = new Cesium.Cartesian3()
  const nrm = new Cesium.Cartesian3()
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    Cesium.Cartesian3.midpoint(a, b, mid)
    Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(mid, up)
    Cesium.Cartesian3.subtract(b, a, e1)
    Cesium.Cartesian3.normalize(e1, e1)
    Cesium.Cartesian3.cross(e1, up, nrm)
    Cesium.Cartesian3.normalize(nrm, nrm)
    // 保证法线指向多边形"外侧"（与 指向中心 的方向相反）
    Cesium.Cartesian3.subtract(mid, center, e1)
    if (Cesium.Cartesian3.dot(nrm, e1) < 0) Cesium.Cartesian3.negate(nrm, nrm)
    if (!keepInside) Cesium.Cartesian3.negate(nrm, nrm)
    planes.push(new Cesium.ClippingPlane(Cesium.Cartesian3.clone(nrm), -Cesium.Cartesian3.dot(nrm, a)))
  }
  if (!clipCollection) {
    clipCollection = new Cesium.ClippingPlaneCollection({ planes, unionClippingRegions: false })
    globe.clippingPlanes = clipCollection
  } else {
    clipCollection.removeAll()
    for (const p of planes) clipCollection.add(p)
    clipCollection.enabled = true
  }
}

let pending = false
function refresh(rebuild = false) {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    bakeSDF()
    updateArea()
    if (rebuild || !mat) buildPrimitive()
    else uploader.upload(mat, canvas)
    applyTerrainClip()
  })
}

/* ---------------- 交互 ---------------- */
const carto = new Cesium.Cartographic()
function pickUV(winPos: Cesium.Cartesian2): [number, number] | null {
  const ray = viewer?.camera.getPickRay(winPos)
  if (!ray) return null
  const a = new Cesium.Cartesian3()
  const b = new Cesium.Cartesian3()
  for (let i = 1; i <= 220; i++) {
    const t = (i / 220) * SPAN_X * 2.2
    Cesium.Cartesian3.multiplyByScalar(ray.direction, t, a)
    Cesium.Cartesian3.add(ray.origin, a, b)
    const c = Cesium.Cartographic.fromCartesian(b, undefined, carto)
    if (!c) break
    const lon = Cesium.Math.toDegrees(c.longitude)
    const lat = Cesium.Math.toDegrees(c.latitude)
    const u = (lon - (LON - DLON / 2)) / DLON
    const v = (LAT + DLAT / 2 - lat) / DLAT
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return [u, v]
  }
  return null
}

/* ---------------- 视角 ---------------- */
const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.055, 34000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-58), roll: 0 },
}
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(() => viewer, () => home)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'imagery')

watch([shape, sizeKm, sides, rotDeg, feather, mode], () => refresh(false))
watch(clipTerrain, () => applyTerrainClip())

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  const scene = viewer.scene
  scene.globe.enableLighting = false

  // 真实地形 + 雾：裁剪挖开的坑能看到山体剖面，掩膜效果才立体
  stopTerrain = enableTerrainScene(viewer)

  bakeSDF()
  updateArea()
  buildPrimitive()

  new Cesium.ScreenSpaceEventHandler(scene.canvas).setInputAction(
    (mv: { position: Cesium.Cartesian2 }) => {
      const uv = pickUV(mv.position)
      if (uv) {
        centerUV.value = { u: uv[0], v: uv[1] }
        posText.value = `中心 ${centerLonLat()[0].toFixed(4)}°E ${centerLonLat()[1].toFixed(4)}°N`
        refresh()
      }
    },
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  )

  viewer.camera.setView(home)
})

onBeforeUnmount(() => {
  stopTerrain?.()
  uploader.dispose()
  clipCollection = null
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
      <div class="title">掩膜裁剪 · 矢量掩膜</div>
      <div class="sub">SDF 距离场羽化影像 + 裁剪平面切地形，点击地图移动掩膜</div>

      <div class="row btns">
        <button
          v-for="s in SHAPES"
          :key="s.id"
          class="chip"
          :class="{ on: shape === s.id }"
          @click="shape = s.id"
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
        <span class="lab">尺寸</span>
        <input v-model.number="sizeKm" type="range" min="2" max="13" step="0.5" />
        <b>{{ sizeKm.toFixed(1) }}<i>km</i></b>
      </div>
      <div v-if="shape === 'poly'" class="ctrl">
        <span class="lab">边数</span>
        <input v-model.number="sides" type="range" min="3" max="12" step="1" />
        <b>{{ sides }}<i>边</i></b>
      </div>
      <div v-if="shape === 'poly'" class="ctrl">
        <span class="lab">旋转</span>
        <input v-model.number="rotDeg" type="range" min="0" max="90" step="1" />
        <b>{{ rotDeg }}<i>°</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">羽化带宽</span>
        <input v-model.number="feather" type="range" min="0" max="4000" step="100" />
        <b>{{ feather }}<i>m</i></b>
      </div>

      <div class="row">
        <button class="chip" :class="{ on: clipTerrain }" @click="clipTerrain = !clipTerrain">
          {{ clipTerrain ? '✓ 地形裁剪（裁剪平面）' : '地形裁剪（裁剪平面）' }}
        </button>
      </div>

      <div class="stat">
        <div class="item"><span class="k">掩膜面积</span><b>{{ areaText }}<i>km²</i></b></div>
        <div class="item"><span class="k">SDF 纹理</span><b>{{ TEX }}<i>px</i></b></div>
      </div>

      <div class="hint">{{ posText }}</div>

      <div class="tip">
        影像掩膜烘的是一张 <b>SDF</b>（带符号距离场）：R 通道存"到边界的距离"，
        保留/挖除/羽化全是材质里对距离做 smoothstep —— 换形状只重烘 512² 的一张小图，几何不动。
        打开「地形裁剪」后改用 <b>ClippingPlaneCollection</b>：多边形每条边生成一个裁剪平面，
        法线朝外保留内部、朝内则挖除内部，地表会被真正"切掉"而不只是变暗。
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
  grid-template-columns: repeat(2, 1fr);
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
