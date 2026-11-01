<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

/* ============================================================
 * 日照阴影分析
 *  - 建筑：以场址的东-北-天局部坐标系定义的长方体（米制），实体挤出
 *  - 光照：viewer.clock 指向 2026-06-21 的真实时刻，Cesium 自行解算太阳位置，
 *          shadowMap 负责投影；enableLighting 让地表也被照亮/压暗
 *  - 采样点：解析射线-长方体求交判断该点是否被建筑遮挡，与视觉阴影互相印证
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 116.391
const LAT = 39.907
const DAY = { year: 2026, month: 5, day: 21 } // 夏至前后，正午太阳高度约 73°

/** 场址局部坐标系（x 东、y 北、z 天） */
const frame = Cesium.Transforms.eastNorthUpToFixedFrame(
  Cesium.Cartesian3.fromDegrees(LON, LAT, 0),
)
const frameInv = Cesium.Matrix4.inverseTransformation(frame, new Cesium.Matrix4())

function toFixed(east: number, north: number, up: number): Cesium.Cartesian3 {
  return Cesium.Matrix4.multiplyByPoint(
    frame,
    new Cesium.Cartesian3(east, north, up),
    new Cesium.Cartesian3(),
  )
}

function toLocal(cartesian: Cesium.Cartesian3): Cesium.Cartesian3 {
  return Cesium.Matrix4.multiplyByPoint(frameInv, cartesian, new Cesium.Cartesian3())
}

/* ---------------- 街区体块 ---------------- */
interface Block {
  x: number
  y: number
  w: number
  d: number
  h: number
  name: string
}

const BLOCKS: Block[] = []
{
  // 6×5 的街坊，中间一列留成中央广场，行列间留 40~50m 街道
  const heights = [58, 34, 92, 46, 71, 39, 110, 52, 64, 87, 30, 45]
  let k = 0
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 6; c++) {
      if (c === 3 && r === 2) continue // 中央广场
      const w = 44 + ((r * 7 + c * 5) % 3) * 13
      const d = 36 + ((r * 5 + c * 11) % 4) * 10
      BLOCKS.push({
        x: -300 + c * 106 + w / 2 - 30,
        y: -208 + r * 98 + d / 2,
        w,
        d,
        h: heights[k++ % heights.length] + (c === 3 ? 26 : 0),
        name: `${String.fromCharCode(65 + r)}${c + 1}`,
      })
    }
  }
}

/* ---------------- 太阳位置（NOAA 简化式） ---------------- */
interface SunVector {
  east: number
  north: number
  up: number
}

/** 由地方真太阳时求太阳单位矢量（ENU），同时返回高度角 / 方位角 */
function solarVector(hourLocal: number) {
  const dec = Cesium.Math.toRadians(23.44) // 夏至赤纬
  const lat = Cesium.Math.toRadians(LAT)
  // 经度时差：每偏离 120°E 一度差 4 分钟
  const solarTime = hourLocal + (LON - 120) / 15
  const H = Cesium.Math.toRadians((solarTime - 12) * 15)

  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H)
  const alt = Math.asin(Cesium.Math.clamp(sinAlt, -1, 1))
  const east = -Math.cos(dec) * Math.sin(H)
  const north = Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(H)

  let az = Cesium.Math.toDegrees(Math.atan2(east, north))
  if (az < 0) az += 360

  const len = Math.hypot(east, north, sinAlt) || 1
  return {
    vec: { east: east / len, north: north / len, up: sinAlt / len } as SunVector,
    altDeg: Cesium.Math.toDegrees(alt),
    azDeg: az,
  }
}

/* ---------------- 射线-长方体求交 ---------------- */
function occluderAt(px: number, py: number, sun: SunVector): Block | null {
  if (sun.up <= 0.01) return null
  const oz = 0.3 // 采样点抬离地面，避免自遮挡误判

  for (const b of BLOCKS) {
    const x0 = b.x - b.w / 2
    const x1 = b.x + b.w / 2
    const y0 = b.y - b.d / 2
    const y1 = b.y + b.d / 2

    let tmin = 0
    let tmax = 1e9
    let miss = false
    const slab = (o: number, dir: number, lo: number, hi: number) => {
      if (Math.abs(dir) < 1e-7) {
        if (o < lo || o > hi) miss = true
        return
      }
      let t1 = (lo - o) / dir
      let t2 = (hi - o) / dir
      if (t1 > t2) {
        const tmp = t1
        t1 = t2
        t2 = tmp
      }
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) miss = true
    }
    slab(px, sun.east, x0, x1)
    slab(py, sun.north, y0, y1)
    slab(oz, sun.up, 0, b.h)
    if (!miss && tmax > 0 && tmin > 0) return b
  }
  return null
}

/* ---------------- 落影烘焙 ---------------- */
/** 场地范围（局部坐标，米） */
const SITE = { x0: -352, x1: 392, y0: -262, y1: 384 }
const CW = 768
const CH = Math.round((CW * (SITE.y1 - SITE.y0)) / (SITE.x1 - SITE.x0))

const plateCanvas = document.createElement('canvas')
plateCanvas.width = CW
plateCanvas.height = CH

/** 凸包（Andrew monotone chain），用于合并「底面 + 顶面投影」共 8 个点 */
function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  if (pts.length < 3) return pts
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Array<[number, number]> = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0)
      lower.pop()
    lower.push(q)
  }
  const upper: Array<[number, number]> = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0)
      upper.pop()
    upper.push(q)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** 绕形心把凸包向外扩 d 米（半影层的近似，metric 局部坐标下各向同性） */
function expandHull(hull: Array<[number, number]>, d: number): Array<[number, number]> {
  if (d <= 0) return hull
  let cx = 0
  let cy = 0
  for (const [x, y] of hull) {
    cx += x
    cy += y
  }
  cx /= hull.length
  cy /= hull.length
  let r = 0
  for (const [x, y] of hull) r += Math.hypot(x - cx, y - cy)
  r /= hull.length
  if (r < 1e-6) return hull
  const k = 1 + d / r
  return hull.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k] as [number, number])
}

/**
 * 把每栋楼沿太阳方向投到地面：顶面四点投影 + 底面四点，取凸包即为落影。
 * 半影不能用 ctx.filter 的 blur —— headless/部分 GPU 合成路径下，滤镜层不保证
 * 进入随后的纹理上传（实测 blur 内容会整块丢失，且时有时无，正是闪烁根源），
 * 改用「核心 + 两层外扩」的低透明度叠加来模拟软边。
 */
function refreshShadows(sun: SunVector) {
  const g = plateCanvas.getContext('2d')!
  const sx = CW / (SITE.x1 - SITE.x0)
  const sy = CH / (SITE.y1 - SITE.y0)
  const toU = (x: number) => (x - SITE.x0) * sx
  const toV = (y: number) => (SITE.y1 - y) * sy

  // 底：沥青路面，太阳低时整体转冷变暗
  const lit = Cesium.Math.clamp(sun.up * 2.2, 0, 1)
  const road = 104 + 24 * lit
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.fillStyle = `rgb(${road | 0},${(road + 2) | 0},${(road + 5) | 0})`
  g.fillRect(0, 0, CW, CH)

  // 每个街坊的混凝土铺装（比建筑外扩 9m，形成人行道）
  for (const b of BLOCKS) {
    const pad = 9
    const u0 = toU(b.x - b.w / 2 - pad)
    const v0 = toV(b.y + b.d / 2 + pad)
    const w = (b.w + pad * 2) * sx
    const h = (b.d + pad * 2) * sy
    const shade = 176 + 20 * lit
    g.fillStyle = `rgb(${shade | 0},${(shade + 3) | 0},${(shade + 8) | 0})`
    g.fillRect(u0, v0, w, h)
  }

  if (sun.up > 0.06) {
    const layers = [
      { d: 0, a: 0.22 },
      { d: 2.6, a: 0.11 },
      { d: 5.4, a: 0.09 },
    ]
    for (const b of BLOCKS) {
      const u = b.w / 2
      const v = b.d / 2
      const dx = (sun.east / sun.up) * b.h
      const dy = (sun.north / sun.up) * b.h
      const bottom: Array<[number, number]> = [
        [b.x - u, b.y - v],
        [b.x + u, b.y - v],
        [b.x + u, b.y + v],
        [b.x - u, b.y + v],
      ]
      const top = bottom.map(([x, y]) => [x - dx, y - dy] as [number, number])
      const hull = convexHull([...bottom, ...top])
      for (const layer of layers) {
        const poly = expandHull(hull, layer.d)
        g.fillStyle = `rgba(28, 37, 50, ${layer.a})`
        g.beginPath()
        poly.forEach(([x, y], i) => {
          const px = toU(x)
          const py = toV(y)
          if (i === 0) g.moveTo(px, py)
          else g.lineTo(px, py)
        })
        g.closePath()
        g.fill()
      }
    }
  }
}

/* 底板：静态几何（RectangleGeometry）+ 只换材质 uniform。
 * 两条前车之鉴：
 *  1) 给 ImageMaterialProperty 反复塞 dataURL，Cesium 会把纹理退回 defaultTexture 再异步
 *     fetchImage，加载完成前的帧渲染成默认白图 → 整块地面闪白；
 *  2) Entity 的材质属性一变，GeometryVisualizer 会按动态材质重建图元，重建那一帧底板不画 → 闪。
 * 所以几何用 Primitive 固定不变，只把 createImageBitmap 的位图塞进材质 uniform：
 * 位图已完全解码，Cesium 在绘制帧内同步建纹理，新旧内容原子替换，既不闪也不重建几何。 */
let plateMat: Cesium.Material | null = null
let liveBmp: ImageBitmap | null = null
let uploadSeq = 0

function uploadPlate() {
  if (!plateMat) return
  const seq = ++uploadSeq
  createImageBitmap(plateCanvas)
    .then((bmp) => {
      if (seq !== uploadSeq) {
        bmp.close()
        return
      }
      const old = liveBmp
      liveBmp = bmp
      plateMat!.uniforms.image = bmp
      old?.close()
    })
    .catch(() => {})
}

/* ---------------- 面板状态 ---------------- */
const hour = ref(15.2)
const playing = ref(false)
const altText = ref('0')
const azText = ref('0')
const ratioText = ref('0')
const sample = ref({ x: -10, y: -46 })
const blockedBy = ref<string | null>(null)
const sunVec = ref<SunVector>({ east: 0, north: 0, up: 1 })

const lit = computed(() => blockedBy.value === null)
const clockText = computed(() => {
  const h = Math.floor(hour.value)
  const m = Math.round((hour.value - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
})
const timeLabel = computed(() => {
  if (sunVec.value.up <= 0) return '夜间'
  return lit.value ? '日照' : '阴影'
})

// 相机放在街区正南 620m、高 530m：整个 700×640m 街区刚好完整入画
const home = {
  destination: toFixed(0, -582, 532),
  orientation: {
    heading: 0,
    pitch: -Math.atan2(532, 622),
    roll: 0,
  },
  focus: {
    center: Cesium.Cartesian3.fromDegrees(LON, LAT, 40),
    radius: 470,
    range: 820,
  },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'imagery')

let sunUniform: Cesium.Cartesian3 | null = null
let marker: Cesium.Entity | null = null
let handler: Cesium.ScreenSpaceEventHandler | null = null
let playTimer = 0

/** 把时刻写进 clock，让 Cesium 自己解算太阳方向并投影阴影 */
function applyClock(h: number) {
  if (!viewer) return
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  // 本地时 UTC+8：转成 UTC 时刻交给 Cesium
  const utc = Date.UTC(DAY.year, DAY.month, DAY.day, hh - 8, mm, 0)
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(utc))
  viewer.clock.shouldAnimate = false
}

/** 采样点标记颜色随遮挡状态变化 */
function paintMarker() {
  if (!marker) return
  const day = sunVec.value.up > 0
  const color = !day
    ? Cesium.Color.fromCssColorString('#5b6b7d')
    : lit.value
      ? Cesium.Color.fromCssColorString('#ffd166')
      : Cesium.Color.fromCssColorString('#4aa3ff')
  marker.position = new Cesium.ConstantPositionProperty(
    toFixed(sample.value.x, sample.value.y, 0.4),
  )
  if (marker.point) marker.point.color = new Cesium.ConstantProperty(color)
}

watch(hour, () => updateSun())

function updateSun() {
  applyClock(hour.value)
  const s = solarVector(hour.value)
  sunVec.value = s.vec

  altText.value = s.altDeg.toFixed(1)
  azText.value = s.azDeg.toFixed(1)
  // 1m 高物体的影长比：影长 = h / tan(alt)
  const altRad = Cesium.Math.toRadians(s.altDeg)
  ratioText.value = s.altDeg > 0.4 ? (1 / Math.tan(altRad)).toFixed(2) : '∞'

  blockedBy.value = s.vec.up > 0 ? (occluderAt(sample.value.x, sample.value.y, s.vec)?.name ?? null) : 'NIGHT'
  // 把太阳矢量（ECEF）同步给建筑材质，立面的明暗与落影同源
  if (sunUniform) {
    Cesium.Cartesian3.normalize(
      Cesium.Matrix4.multiplyByPointAsVector(
        frame,
        new Cesium.Cartesian3(s.vec.east, s.vec.north, s.vec.up),
        Cesium.Cartesian3.clone(sunUniform),
      ),
      sunUniform,
    )
  }

  refreshShadows(s.vec)
  uploadPlate()
  paintMarker()
}

function onPick(evt: Cesium.ScreenSpaceEventHandler.PositionedEvent) {
  if (!viewer) return
  const cart = viewer.scene.pickPosition(evt.position)
  if (!cart) return
  const carto = Cesium.Cartographic.fromCartesian(cart)
  // 只在场址附近允许取点，避免点到几公里外的山上
  if (Math.abs(Cesium.Math.toDegrees(carto.longitude) - LON) > 0.006) return
  if (Math.abs(Cesium.Math.toDegrees(carto.latitude) - LAT) > 0.006) return
  const local = toLocal(cart)
  sample.value = { x: local.x, y: local.y }
  updateSun()
}

function togglePlay() {
  playing.value = !playing.value
  window.clearInterval(playTimer)
  if (!playing.value) return
  playTimer = window.setInterval(() => {
    hour.value = hour.value >= 19.6 ? 5.4 : Math.round((hour.value + 0.06) * 100) / 100
  }, 90)
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)

  const scene = viewer.scene
  scene.globe.enableLighting = false
  scene.globe.depthTestAgainstTerrain = true
  // 阴影贴图对这批 entity 多边形不生效（PerInstanceColor 走 flat 着色，不做 shadow 采样），
  // 因此落影全部由 refreshShadows 解析投影烘焙，立面的明暗仍由太阳光照负责
  viewer.shadows = false
  scene.highDynamicRange = true
  scene.fog.enabled = false

  // 地面底板：底图 + 解析落影都烘进同一张画布。
  // 先烘一帧初始内容再建材质，首帧就有完整底图；之后只换 uniform，几何不动。
  refreshShadows(solarVector(hour.value).vec)
  plateMat = new Cesium.Material({
    fabric: {
      uniforms: { image: plateCanvas },
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
          rectangle: Cesium.Rectangle.fromCartesianArray([
            toFixed(SITE.x0, SITE.y0, 0),
            toFixed(SITE.x1, SITE.y0, 0),
            toFixed(SITE.x1, SITE.y1, 0),
            toFixed(SITE.x0, SITE.y1, 0),
          ]),
          height: 0.12,
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

  /* 建筑体块
   * Cesium 的 PerInstanceColorAppearance 在这条路径上不吃方向光（实测换光源、换时刻像素完全不变），
   * 所以明暗自己算：把太阳矢量作为 uniform 传进 fabric，用 eye 空间法线做兰伯特 + 半球环境光。
   * 这样立面的受光与地面上的解析落影来自同一个太阳矢量，永远不会互相矛盾。*/
  sunUniform = Cesium.Cartesian3.normalize(
    Cesium.Matrix4.multiplyByPointAsVector(
      frame,
      new Cesium.Cartesian3(0, 0, 1),
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  )
  const bldgMaterial = new Cesium.Material({
    fabric: {
      uniforms: {
        uSun: sunUniform,
        uBase: new Cesium.Color(0.93, 0.92, 0.9, 1),
      },
      source: `
        uniform vec3 uSun;
        uniform vec4 uBase;
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          vec3 sunEC = normalize(czm_viewRotation * uSun);
          vec3 n = normalize(materialInput.normalEC);
          float d = max(dot(n, sunEC), 0.0);
          // 半球环境光：朝上的面分到更多天光，背光面不会死黑
          float amb = 0.22 + 0.2 * clamp(n.z, -1.0, 1.0);
          m.diffuse = uBase.rgb * (amb + 0.62 * d);
          return m;
        }`,
    },
    translucent: false,
  })

  const bldgInstances: Cesium.GeometryInstance[] = []
  BLOCKS.forEach((b) => {
    const model = Cesium.Matrix4.multiply(
      frame,
      Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(b.x, b.y, b.h / 2)),
      new Cesium.Matrix4(),
    )
    bldgInstances.push(
      new Cesium.GeometryInstance({
        geometry: Cesium.BoxGeometry.fromDimensions({
          dimensions: new Cesium.Cartesian3(b.w, b.d, b.h),
          vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
        modelMatrix: model,
      }),
    )
  })
  scene.primitives.add(
    new Cesium.Primitive({
      geometryInstances: bldgInstances,
      appearance: new Cesium.MaterialAppearance({
        material: bldgMaterial,
        flat: false,
        translucent: false,
      }),
    }),
  )

  marker = viewer.entities.add({
    position: toFixed(sample.value.x, sample.value.y, 0.4),
    point: { pixelSize: 12, color: Cesium.Color.WHITE },
  })

  handler = new Cesium.ScreenSpaceEventHandler(scene.canvas)
  handler.setInputAction(onPick, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  viewer.camera.setView(home)
  updateSun()
})

onBeforeUnmount(() => {
  window.clearInterval(playTimer)
  uploadSeq++ // 丢弃在途的位图回调
  liveBmp?.close()
  liveBmp = null
  plateMat = null
  handler?.destroy()
  handler = null
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
        <span class="dot" :class="{ day: sunVec.up > 0 }"></span>
        日照阴影分析 · 2026-06-21
      </div>
      <div class="sub">clock 驱动 Cesium 解算太阳位置，落影按解析投影烘焙到地面</div>

      <div class="ctrl">
        <span class="lab">时刻</span>
        <input v-model.number="hour" type="range" min="5" max="20" step="0.05" />
        <b>{{ clockText }}</b>
      </div>

      <div class="row">
        <button class="btn primary" @click="togglePlay">{{ playing ? '暂停' : '时间流逝' }}</button>
        <button class="btn" @click="hour = 15.2; updateSun()">复位</button>
      </div>

      <div class="stat">
        <div class="item">
          <span class="k">太阳高度角</span>
          <b>{{ altText }}<i>°</i></b>
        </div>
        <div class="item">
          <span class="k">方位角</span>
          <b>{{ azText }}<i>°</i></b>
        </div>
        <div class="item">
          <span class="k">影长比</span>
          <b>{{ ratioText }}<i>× 物高</i></b>
        </div>
      </div>

      <div class="probe" :class="{ shade: !lit }">
        <span class="k">采样点</span>
        <b>{{ timeLabel }}</b>
        <span class="desc">
          {{
            timeLabel === '夜间'
              ? '太阳已落山'
              : lit
                ? '无遮挡，可直射采光'
                : `被 ${blockedBy} 栋遮挡`
          }}
        </span>
      </div>

      <div class="tip">
        点击地面移动采样点。遮挡判定与落影用同一套几何：从采样点沿太阳方向做射线与
        建筑长方体求交（slab 法）；落影则由每栋楼的「底面 + 顶面投影」取凸包得到。
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
  width: 330px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(14, 20, 28, 0.88);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
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
  background: #5b6b7d;
}
.dot.day {
  background: #ffd166;
  box-shadow: 0 0 9px #ffd166;
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
  margin-top: 10px;
  font-size: 11px;
}
.ctrl .lab {
  color: #8fa0b3;
  flex: 0 0 auto;
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
.row {
  display: flex;
  gap: 7px;
  margin-top: 9px;
}
.btn {
  flex: 1;
  padding: 6px 0;
  font-size: 11.5px;
  border-radius: 7px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #b9c8d8;
  cursor: pointer;
  transition: all 0.15s;
}
.btn:hover {
  border-color: rgba(120, 165, 220, 0.75);
  color: #e6f0fa;
}
.btn.primary {
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
  font-size: 14px;
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
.probe {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  padding: 6px 9px;
  border-radius: 7px;
  background: rgba(255, 209, 102, 0.12);
  border: 1px solid rgba(255, 209, 102, 0.35);
}
.probe.shade {
  background: rgba(74, 163, 255, 0.12);
  border-color: rgba(74, 163, 255, 0.35);
}
.probe .k {
  font-size: 10.5px;
  color: #8fa0b3;
}
.probe b {
  font-size: 12px;
  color: #e9f1fa;
}
.probe .desc {
  margin-left: auto;
  font-size: 10.5px;
  color: #9fb0c3;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
