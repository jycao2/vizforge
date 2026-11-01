<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import { demRectangle, makeDrapedPrimitive, makeTextureUploader } from './demMesh'
import {
  applyRealHeights,
  lonLatToUV,
  makeDEM,
  sampleH,
  uvToLonLat,
  type DEM,
} from '@/examples/shared/terrain'

/* ============================================================
 * 水污染扩散模拟
 *
 * 物理：二维对流-扩散-降解方程
 *   ∂C/∂t + u·∇C = K∇²C − λC + S
 *  - 对流 u：风生流（湖面表层流方向≈风向，约 2% 风速）+ 地形约束
 *  - 扩散 K：涡动扩散系数（m²/s），显式格式需 K·dt/dx² < 0.25
 *  - 降解 λ：污染物半衰期折算（ln2 / T½）
 *  - 源项 S：排污口按设定速率注入
 * 数值：半拉格朗日回溯（对流，无条件稳定）+ 五点差分（扩散）+ 指数衰减
 *
 * 显示：浓度场烘成纹理，用 GroundPrimitive 分类渲染贴到真实地表 —
 * 湖面、岛屿、岸线都跟着真实地形走，放大缩小不会分离。
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 120.03
const LAT = 31.16
const SPAN = 12000 // 米
const N = 160 // 网格边长
const TEX = 512 // 贴图分辨率：羽流边缘只有几格宽，256 会把细尾糊掉

/* ---------------- 参数 ---------------- */
const release = ref(120) // 排放强度（相对单位/秒）
const windSpeed = ref(7.5) // 风速 m/s（表层流≈4%V）
const windDir = ref(255) // 风来向（度，气象习惯：风的来向）→ 羽流向东漂，横穿画面
const diffK = ref(14) // 涡动扩散系数 m²/s（对流占主导羽流才呈舌状，扩散过大就糊成一片）
const halfLife = ref(18) // 降解半衰期（小时）
const playing = ref(true)
const speedMul = ref(1) // 时间倍速

/* ---------------- 统计 ---------------- */
const stat = ref({ area: 0, peak: 0, alarms: 0, minutes: 0 })
const THRESHOLD = 12 // 浓度阈值（相对单位）

/* ---------------- 地形与场 ---------------- */
const dem: DEM = makeDEM({ lon: LON, lat: LAT, span: SPAN, n: N, relief: 6, base: 0, shape: 'rolling' })
let waterLevel = 2.2
let waterMask: Uint8Array = new Uint8Array(N * N)
let conc = new Float32Array(N * N)
let concNext = new Float32Array(N * N)
let flowU = new Float32Array(N * N)
let flowV = new Float32Array(N * N)
/** 污染源（uv 空间） */
const source = ref({ u: 0.46, v: 0.46 })
let simMinutes = 0

/** 取水口：位于湖内/岸边的取水点，浓度超标即报警 */
const INTAKES = [
  { name: '一号取水口', u: 0.62, v: 0.42 },
  { name: '二号取水口', u: 0.74, v: 0.6 },
  { name: '三号取水口', u: 0.3, v: 0.36 },
  { name: '四号取水口', u: 0.52, v: 0.76 },
  { name: '五号取水口', u: 0.22, v: 0.66 },
]
const intakeState = ref<
  Array<{ name: string; u: number; v: number; lon: number; lat: number; c: number; alarm: boolean }>
>([])

/* ---------------- 贴图与图元 ---------------- */
const canvas = document.createElement('canvas')
canvas.width = canvas.height = TEX
const ctx = canvas.getContext('2d')!
const uploader = makeTextureUploader()
let polymat: Cesium.Material | null = null
let draped: Cesium.GroundPrimitive | null = null
let stopTerrain: (() => void) | null = null
let raf = 0
let lastMs = 0
let frame = 0

/* ---------------- 网格工具 ---------------- */
const cellM = SPAN / (N - 1)
const idx = (i: number, j: number) => j * N + i

/** 双线性采样浓度场（网格坐标，越界返回 0） */
function sampleField(f: Float32Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x > N - 1.001 || y > N - 1.001) return 0
  const i0 = Math.floor(x)
  const j0 = Math.floor(y)
  const tx = x - i0
  const ty = y - j0
  const a = f[idx(i0, j0)]
  const b = f[idx(i0 + 1, j0)]
  const c = f[idx(i0, j0 + 1)]
  const d = f[idx(i0 + 1, j0 + 1)]
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

/** 依据地形重建水域掩膜和风生流场 */
function rebuildWater() {
  waterMask = new Uint8Array(N * N)
  flowU = new Float32Array(N * N)
  flowV = new Float32Array(N * N)

  // 水域：低于水位的地形
  for (let k = 0; k < dem.h.length; k++) {
    if (dem.h[k] < waterLevel) waterMask[k] = 1
  }

  // 只保留最大的连通水域（主湖）。太湖周边全是鱼塘/河渠，
  // 排污口一旦"就近吸附"到小水塘，羽流就被困在几格里，看起来像没动。
  {
    const label = new Int32Array(N * N).fill(-1)
    const sizes: number[] = []
    const stack: number[] = []
    for (let start = 0; start < N * N; start++) {
      if (!waterMask[start] || label[start] >= 0) continue
      const id = sizes.length
      let size = 0
      stack.length = 0
      stack.push(start)
      label[start] = id
      while (stack.length) {
        const k = stack.pop()!
        size++
        const i = k % N
        const j = (k / N) | 0
        if (i > 0 && waterMask[k - 1] && label[k - 1] < 0) (label[k - 1] = id), stack.push(k - 1)
        if (i < N - 1 && waterMask[k + 1] && label[k + 1] < 0) (label[k + 1] = id), stack.push(k + 1)
        if (j > 0 && waterMask[k - N] && label[k - N] < 0) (label[k - N] = id), stack.push(k - N)
        if (j < N - 1 && waterMask[k + N] && label[k + N] < 0) (label[k + N] = id), stack.push(k + N)
      }
      sizes.push(size)
    }
    let best = 0
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i
    for (let k = 0; k < waterMask.length; k++) {
      if (waterMask[k] && label[k] !== best) waterMask[k] = 0
    }
  }

  // 风生流：表层流 ≈ 4% 风速（湖面实测 2~5%），方向取风去向
  const to = (((windDir.value + 180) % 360) * Math.PI) / 180
  const dirX = Math.sin(to) * 1.0 // 东向分量
  const dirZ = -Math.cos(to) * 1.0 // 北为 -z
  const baseSpeed = Math.max(0.06, windSpeed.value * 0.04)

  let wet = 0
  let maxU = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = idx(i, j)
      if (waterMask[k]) wet++
      if (!waterMask[k]) continue
      // 浅水摩擦：水深越浅流速越低
      const depth = waterLevel - dem.h[k]
      const friction = clamp(depth / 1.6, 0.25, 1)
      // 加一点绕岛的偏转（用地形梯度做个旋度感）
      const gx = sampleH(dem, Math.min(1, (i + 1) / (N - 1)), j / (N - 1)) - sampleH(dem, Math.max(0, (i - 1) / (N - 1)), j / (N - 1))
      const gz = sampleH(dem, i / (N - 1), Math.min(1, (j + 1) / (N - 1))) - sampleH(dem, i / (N - 1), Math.max(0, (j - 1) / (N - 1)))
      const swirl = 0.35 * (depth > 0.4 ? 1 : 0.4)
      flowU[k] = (dirX * baseSpeed * friction - gz * swirl) / 1
      flowV[k] = (dirZ * baseSpeed * friction + gx * swirl) / 1
    }
  }
  void wet
  void maxU
}

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v
}

/**
 * 把排污口吸附到最近的水域格。
 * 否则点在陆地上时注入会被 waterMask 全部跳过，模拟看起来"什么都没发生"。
 */
function snapSourceToWater() {
  const si = Math.round(source.value.u * (N - 1))
  const sj = Math.round(source.value.v * (N - 1))
  if (waterMask[idx(si, sj)]) return
  for (let r = 1; r < N; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const i = si + dx
        const j = sj + dz
        if (i < 0 || j < 0 || i >= N || j >= N) continue
        if (!waterMask[idx(i, j)]) continue
        source.value = { u: i / (N - 1), v: j / (N - 1) }
        return
      }
    }
  }
}

/* ---------------- 数值推进 ---------------- */
function step(dt: number) {
  const K = diffK.value
  const lambda = Math.LN2 / (halfLife.value * 3600)
  // 显式扩散稳定性：K·dt/dx² ≤ 0.2
  const maxDt = (0.2 * cellM * cellM) / Math.max(K, 1e-6)
  const sub = Math.min(4, Math.max(1, Math.ceil(dt / maxDt)))
  const h = dt / sub

  // 源项：按 uv 落到网格
  const si = Math.round(source.value.u * (N - 1))
  const sj = Math.round(source.value.v * (N - 1))

  for (let s = 0; s < sub; s++) {
    // 对流：半拉格朗日回溯
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const k = idx(i, j)
        if (!waterMask[k]) {
          concNext[k] = 0
          continue
        }
        const bx = i - (flowU[k] * h) / cellM
        const by = j - (flowV[k] * h) / cellM
        concNext[k] = sampleField(conc, bx, by)
      }
    }
    // 扩散 + 降解
    const alpha = (K * h) / (cellM * cellM)
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const k = idx(i, j)
        if (!waterMask[k]) {
          conc[k] = 0
          continue
        }
        const c = concNext[k]
        const lap =
          concNext[k - 1] + concNext[k + 1] + concNext[k - N] + concNext[k + N] - 4 * c
        let v = c + alpha * lap
        v *= Math.exp(-lambda * h)
        conc[k] = v
      }
    }
    // 注入（源格及其 8 邻域）
    for (let dz = -1; dz <= 1; dz++) {
      for (let di = -1; di <= 1; di++) {
        const i = si + di
        const j = sj + dz
        if (i < 1 || j < 1 || i > N - 2 || j > N - 2) continue
        const k = idx(i, j)
        if (!waterMask[k]) continue
        conc[k] += (release.value * h) / 9
      }
    }
    simMinutes += h / 60
  }
}

/* ---------------- 渲染 ---------------- */
const RAMP: Array<[number, number, number, number]> = [
  // [阈值比例, r, g, b]：琥珀 → 橙 → 红。
  // 别用黄绿系——湖水本身就是绿色的，低浓度羽流会直接"隐身"。
  [0.0, 0xff, 0xd1, 0x66],
  [0.3, 0xff, 0xa5, 0x3d],
  [0.65, 0xf9, 0x62, 0x2c],
  [1.0, 0xd2, 0x1c, 0x3a],
]

function rampColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i][0]) {
      const [t0, r0, g0, b0] = RAMP[i - 1]
      const [t1, r1, g1, b1] = RAMP[i]
      const f = (x - t0) / (t1 - t0 || 1)
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f]
    }
  }
  return [RAMP[RAMP.length - 1][1], RAMP[RAMP.length - 1][2], RAMP[RAMP.length - 1][3]]
}

function bake() {
  const img = ctx.createImageData(TEX, TEX)
  const d = img.data
  for (let py = 0; py < TEX; py++) {
    const v = py / (TEX - 1)
    const gj = v * (N - 1)
    for (let px = 0; px < TEX; px++) {
      const u = px / (TEX - 1)
      const c = sampleField(conc, u * (N - 1), gj)
      const t = (px + py * TEX) << 2
      // 只画超标区（低于阈值的稀薄晕染一律透明），画面才看得懂
      if (c < THRESHOLD) {
        d[t + 3] = 0
        continue
      }
      // 只显示阈值 15% 以上的浓度，并在线性区间内上色：
      // sqrt 拉伸会把稀薄的外围晕染全部点亮，整片湖变成一层"雾"。
      // 幂次映射：峰值能到 1e4 量级，线性映射会让整片区域瞬间满色，看不出梯度
      const k = Math.min(1, Math.pow(c / (THRESHOLD * 22), 0.42))
      const [r, g, b] = rampColor(k)
      d[t] = r
      d[t + 1] = g
      d[t + 2] = b
      d[t + 3] = Math.round(170 + 70 * k)
    }
  }
  ctx.putImageData(img, 0, 0)
  if (polymat) uploader.upload(polymat, canvas)
}

function buildDraped() {
  const scene = viewer?.scene
  if (!scene) return
  if (draped) scene.groundPrimitives.remove(draped)
  polymat = new Cesium.Material({
    fabric: {
      uniforms: { image: canvas },
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
  })
  draped = makeDrapedPrimitive(demRectangle(dem), polymat, true)
  scene.groundPrimitives.add(draped)
  uploader.upload(polymat, canvas)
}

/* ---------------- 统计与取水口 ---------------- */
function refreshIntakes() {
  let alarms = 0
  for (const it of intakeState.value) {
    const c = sampleField(conc, it.u * (N - 1), it.v * (N - 1))
    it.c = c
    it.alarm = c >= THRESHOLD
    if (it.alarm) alarms++
    const ent = intakeEntities.get(it.name)
    if (ent?.label) {
      ;(ent.label as Cesium.LabelGraphics).fillColor = new Cesium.ConstantProperty(
        it.alarm ? Cesium.Color.fromCssColorString('#ff6b6b') : Cesium.Color.WHITE,
      )
      ;(ent.label as Cesium.LabelGraphics).text = new Cesium.ConstantProperty(
        `${it.name} ${c.toFixed(1)}`,
      )
    }
  }
  stat.value = { ...stat.value, alarms }
}

const intakeEntities = new Map<string, Cesium.Entity>()

/* ---------------- 循环 ---------------- */
function tick(now: number) {
  raf = requestAnimationFrame(tick)
  if (!playing.value) {
    lastMs = now
    return
  }
  const dtReal = Math.min((now - lastMs) / 1000, 0.05)
  lastMs = now
  if (!dtReal) return
  // 1 现实秒 ≈ 2 分钟模拟：太快的话羽流几秒就糊满全湖，看不出扩散过程
  const dtSim = dtReal * 120 * speedMul.value
  step(dtSim)
  frame++
  if (frame % 2 === 0) {
    bake()
    refreshIntakes()
    stat.value = {
      area: statArea(),
      peak: peakConc(),
      alarms: stat.value.alarms,
      minutes: simMinutes,
    }
  }
}

function statArea() {
  let area = 0
  for (let k = 0; k < conc.length; k++) {
    if (waterMask[k] && conc[k] >= THRESHOLD) area += cellM * cellM
  }
  return area / 1e6
}
function peakConc() {
  let p = 0
  for (let k = 0; k < conc.length; k++) if (waterMask[k] && conc[k] > p) p = conc[k]
  return p
}

/* ---------------- 交互 ---------------- */
const carto = new Cesium.Cartographic()
function pickUV(winPos: Cesium.Cartesian2): [number, number] | null {
  const ray = viewer?.camera.getPickRay(winPos)
  if (!ray) return null
  const a = new Cesium.Cartesian3()
  const b = new Cesium.Cartesian3()
  for (let i = 1; i <= 160; i++) {
    const t = (i / 160) * SPAN * 2.2
    Cesium.Cartesian3.multiplyByScalar(ray.direction, t, a)
    Cesium.Cartesian3.add(ray.origin, a, b)
    const c = Cesium.Cartographic.fromCartesian(b, undefined, carto)
    if (!c) break
    const lon = Cesium.Math.toDegrees(c.longitude)
    const lat = Cesium.Math.toDegrees(c.latitude)
    const [u, v] = lonLatToUV(dem, lon, lat)
    if (u < 0 || u > 1 || v < 0 || v > 1) continue
    if (c.height <= sampleH(dem, u, v) + 2) return [u, v]
  }
  return null
}

let cursorEntity: Cesium.Entity | null = null
function syncSourceMarker() {
  if (!cursorEntity) return
  const [lon, lat] = uvToLonLat(dem, source.value.u, source.value.v)
  cursorEntity.position = new Cesium.ConstantPositionProperty(
    Cesium.Cartesian3.fromDegrees(lon, lat, waterLevel + 6),
  )
}

/* ---------------- 视角 ---------------- */
/**
 * 视角对准排污口：羽流只有 1~2km，固定在场地中心会把画面压在角落里看不清。
 */
function homeView() {
  const [slon, slat] = uvToLonLat(dem, source.value.u, source.value.v)
  // 俯角 -42°：视线落地在相机正北 h/tanθ 处，所以相机放在排污口正南同样距离的位置。
  // 5.4km 高 ≈ 3.5km 视野，1~2km 的羽流正好占画面 1/3，既能看清形态又带上下文。
  return {
    destination: Cesium.Cartesian3.fromDegrees(slon, slat - 0.054, 5400),
    orientation: { heading: Cesium.Math.toRadians(-8), pitch: Cesium.Math.toRadians(-42), roll: 0 },
    // 焦点跟着排污口走：羽流只有 1~2km，缩放时不能把镜头锚到几百公里外
    focus: {
      center: Cesium.Cartesian3.fromDegrees(slon, slat, waterLevel),
      radius: 1800,
      range: 5600,
    },
  }
}
const { zoomIn, zoomOut, toggleFullscreen } = useCesiumView(() => viewer, () => homeView())
const reset = () => viewer?.camera.setView(homeView())
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'imagery')

watch([windDir, windSpeed], () => rebuildWater())
watch(release, () => undefined)

onMounted(async () => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  const scene = viewer.scene
  scene.globe.enableLighting = false
  stopTerrain = enableTerrainScene(viewer)

  viewer.camera.setView(homeView())
  raf = requestAnimationFrame(tick)
  lastMs = performance.now()

  // 真实地形就位后：换成真实高程，重建水域与流场
  const ready = await waitRealTerrain(viewer)
  const grid = ready
    ? await sampleTerrainGrid(viewer, dem.lon0, dem.lat0, dem.lon1, dem.lat1, 97, 12)
    : null
  if (!viewer || viewer.isDestroyed()) return
  if (grid) {
    applyRealHeights(dem, grid, 97)
    // 水位取 45% 分位：湖面覆盖约一半范围，岸线形状来自真实地形
    const sorted = Float32Array.from(dem.h).sort()
    waterLevel = sorted[Math.floor(sorted.length * 0.45)]
    rebuildWater()
  } else {
    waterLevel = dem.min + (dem.max - dem.min) * 0.45
    rebuildWater()
  }

  snapSourceToWater()
  // 排污口被吸附到主湖后，镜头要重新对准它（否则一直在看原来的空地）
  viewer.camera.setView(homeView())
  buildDraped()

  // 取水口标注
  for (const it of INTAKES) {
    const [lon, lat] = uvToLonLat(dem, it.u, it.v)
    const ent = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, waterLevel + 4),
      point: {
        pixelSize: 7,
        color: Cesium.Color.fromCssColorString('#7fe7ff'),
        outlineColor: Cesium.Color.fromCssColorString('#0a1a22'),
        outlineWidth: 2,
        disableDepthTestDistance: 6000,
      },
      label: {
        text: `${it.name} 0.0`,
        font: '600 11px sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0d1622').withAlpha(0.72),
        backgroundPadding: new Cesium.Cartesian2(5, 2),
        pixelOffset: new Cesium.Cartesian2(0, -13),
        scaleByDistance: new Cesium.NearFarScalar(3e3, 1.1, 3e4, 0.7),
        disableDepthTestDistance: 6000,
      },
    })
    intakeEntities.set(it.name, ent)
    intakeState.value.push({ name: it.name, u: it.u, v: it.v, lon, lat, c: 0, alarm: false })
  }

  // 排污口标记
  cursorEntity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
    point: {
      pixelSize: 11,
      color: Cesium.Color.fromCssColorString('#ff5a4a'),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: 8000,
    },
    label: {
      text: '排污口',
      font: '600 11px sans-serif',
      fillColor: Cesium.Color.fromCssColorString('#ffd0c8'),
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#2a0f0c').withAlpha(0.8),
      backgroundPadding: new Cesium.Cartesian2(5, 2),
      pixelOffset: new Cesium.Cartesian2(0, -15),
      disableDepthTestDistance: 8000,
    },
  })
  syncSourceMarker()

  new Cesium.ScreenSpaceEventHandler(scene.canvas).setInputAction(
    (mv: { position: Cesium.Cartesian2 }) => {
      const uv = pickUV(mv.position)
      if (!uv) return
      // 只允许把排污口放在水域内
      const k = idx(Math.round(uv[0] * (N - 1)), Math.round(uv[1] * (N - 1)))
      if (!waterMask[k]) {
        // 点到岸上：吸附到最近水域
        source.value = { u: uv[0], v: uv[1] }
        snapSourceToWater()
      } else {
        source.value = { u: uv[0], v: uv[1] }
      }
      syncSourceMarker()
    },
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  )
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  stopTerrain?.()
  uploader.dispose()
  intakeEntities.clear()
  polymat = null
  draped = null
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})

function resetSim() {
  conc.fill(0)
  concNext.fill(0)
  simMinutes = 0
  stat.value = { area: 0, peak: 0, alarms: 0, minutes: 0 }
  bake()
  refreshIntakes()
}

const timeText = computed(() => {
  const m = Math.floor(stat.value.minutes)
  const hh = Math.floor(m / 60)
  const mm = m % 60
  return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`
})
const windText = computed(() => {
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  const i = Math.round(((windDir.value % 360) / 45)) % 8
  return `${dirs[i]}风 ${windSpeed.value.toFixed(1)} m/s`
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
      <div class="title">水污染扩散 · 平流-扩散模拟</div>
      <div class="sub">
        太湖西岸真实地形 · 风生流 {{ windText }} · 点击湖面移动排污口
      </div>

      <div class="ctrl">
        <span class="lab">排放强度</span>
        <input v-model.number="release" type="range" min="10" max="200" step="5" />
        <b>{{ release }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">风向</span>
        <input v-model.number="windDir" type="range" min="0" max="355" step="5" />
        <b>{{ windDir }}°</b>
      </div>
      <div class="ctrl">
        <span class="lab">风速</span>
        <input v-model.number="windSpeed" type="range" min="0.5" max="9" step="0.1" />
        <b>{{ windSpeed.toFixed(1) }}<i>m/s</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">扩散系数</span>
        <input v-model.number="diffK" type="range" min="2" max="60" step="1" />
        <b>{{ diffK }}<i>m²/s</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">降解半衰期</span>
        <input v-model.number="halfLife" type="range" min="6" max="96" step="2" />
        <b>{{ halfLife }}<i>h</i></b>
      </div>

      <div class="row">
        <button class="chip primary" @click="playing = !playing">
          {{ playing ? '⏸ 暂停' : '▶ 继续' }}
        </button>
        <button class="chip" @click="resetSim">重置</button>
      </div>

      <div class="stat">
        <div class="item">
          <span class="k">污染面积</span><b>{{ stat.area.toFixed(2) }}<i>km²</i></b>
        </div>
        <div class="item">
          <span class="k">峰值浓度</span><b>{{ stat.peak.toFixed(0) }}</b>
        </div>
        <div class="item" :class="{ warn: stat.alarms > 0 }">
          <span class="k">超标取水口</span><b>{{ stat.alarms }}<i>/{{ intakeState.length }}</i></b>
        </div>
      </div>

      <div class="time">
        模拟时长 <b>{{ timeText }}</b> · 阈值 {{ THRESHOLD }} · 浓度超阈值即报警
      </div>

      <div class="tip">
        对流用半拉格朗日回溯（无条件稳定），扩散用五点差分（显式格式需
        <b>K·dt/dx² &lt; 0.25</b>，代码里自动细分时间步），降解按 ln2/T½ 指数衰减。
        浓度场烘成纹理后由 GroundPrimitive 分类渲染，湖面/岛屿/岸线都跟着真实地形走。
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
  width: 292px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(14, 20, 28, 0.87);
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
  font-size: 10.5px;
  color: #7d8fa2;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 11px;
  color: #93a5b8;
}
.lab {
  width: 62px;
  flex: none;
}
.ctrl input {
  flex: 1;
  height: 3px;
  accent-color: #4f9dff;
}
.ctrl b {
  width: 52px;
  text-align: right;
  color: #cfe0f2;
  font-variant-numeric: tabular-nums;
}
.ctrl i {
  font-style: normal;
  margin-left: 2px;
  color: #6d8098;
  font-size: 9.5px;
}
.row {
  display: flex;
  gap: 7px;
  margin-top: 10px;
}
.chip {
  flex: 1;
  padding: 6px 0;
  font-size: 11.5px;
  border-radius: 7px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #b9c8d8;
  cursor: pointer;
}
.chip.primary {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.stat {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid rgba(88, 108, 132, 0.28);
}
.item {
  display: flex;
  align-items: baseline;
  gap: 3px;
  font-size: 9.5px;
  white-space: nowrap;
  color: #8b9cb0;
}
.item b {
  font-size: 15px;
  font-weight: 600;
  color: #e9f2fb;
  font-variant-numeric: tabular-nums;
}
.item.warn b {
  color: #ff7a5c;
}
.item i {
  font-style: normal;
  font-size: 9.5px;
  color: #6d8098;
}
.time {
  margin-top: 8px;
  font-size: 10.5px;
  color: #7f92a6;
}
.time b {
  color: #cfe0f2;
}
.tip {
  margin-top: 7px;
  font-size: 10px;
  line-height: 1.55;
  color: #6d8098;
}
.tip b {
  color: #9fb6cc;
}
</style>
