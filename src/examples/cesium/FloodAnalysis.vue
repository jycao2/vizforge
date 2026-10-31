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
 * 水库淹没分析
 *
 * 「全域」与「连通」的区别是淹没分析的灵魂：
 *  - 全域：所有高程低于水位的地方都变水 —— 山背后的洼地、与河道不连通的坑
 *          全都会被"灌满"，这是简化算法，结果偏大；
 *  - 连通：从河道种子点做洪水填充（BFS / four-connectivity），只有与水源
 *          连通的洼地才会被淹 —— 这才是真正的淹没范围。
 * 场景里特意埋了两个"山后闭合洼地"（DEM 生成时的 rim 保证了闭合）：
 * 切到全域模式它们会突然被灌满，直观展示两种算法的差别。
 *
 * 水面图元：局部 ENU 网格 + modelMatrix 抬升 —— 水位变化只改矩阵不改几何；
 * 水体颜色/透明度烘在 256² 掩膜纹理里（浅水青、深水蓝），随水位每帧重烘也毫无压力。
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null
/** 真实地面海拔偏移 + 裙边侧壁：库区模型嵌进真实地形（千岛湖，约 103~323m） */
let groundOffset = 0
let stopTerrain: (() => void) | null = null
let skirtPrim: Cesium.Primitive | null = null

// 千岛湖（浙江淳安）：真实地形为岛屿丘陵，幅差约 220m，水库淹没的天然背景板
const LON = 119.0
const LAT = 29.6
const SPAN = 14000

/* ---------------- 参数 ---------------- */
const level = ref(210) // 库水位（米）
const mode = ref<'conn' | 'all'>('conn')
const playing = ref(false)
const riseRate = ref(2.4) // 米/秒（演示用）

const stat = ref({ area: 0, volume: 0, maxDepth: 0, villages: 0 })

/* ---------------- DEM ---------------- */
const N = 161
const dem: DEM = makeDEM({
  lon: LON,
  lat: LAT,
  span: SPAN,
  n: N,
  relief: 520,
  base: 150,
  shape: 'valley',
  seed: 31415,
})

/** 找河道种子点：中央条带内的最低格网（水从主河道往上涨） */
function findSeed(): number {
  let best = -1
  let bestH = Infinity
  for (let j = 0; j < N; j++) {
    const v = j / (N - 1)
    if (Math.abs(v - 0.5) > 0.16) continue
    for (let i = 0; i < N; i++) {
      const idx = j * N + i
      if (dem.h[idx] < bestH) {
        bestH = dem.h[idx]
        best = idx
      }
    }
  }
  return best
}
const SEED = findSeed()

/** 村庄：河边的会先被淹，山后的洼地只有"全域"模式才淹，山上的永远安全 */
interface Village {
  name: string
  u: number
  v: number
  lon: number
  lat: number
}
const VILLAGES: Village[] = [
  { name: '渡口镇', u: 0.42, v: 0.52, lon: 0, lat: 0 },
  { name: '河湾村', u: 0.22, v: 0.47, lon: 0, lat: 0 },
  { name: '柳林村', u: 0.66, v: 0.55, lon: 0, lat: 0 },
  { name: '塬上村', u: 0.24, v: 0.3, lon: 0, lat: 0 },
  { name: '石门村', u: 0.76, v: 0.7, lon: 0, lat: 0 },
  { name: '望岳庄', u: 0.52, v: 0.1, lon: 0, lat: 0 },
].map((x) => {
  const [lon, lat] = uvToLonLat(dem, x.u, x.v)
  return { ...x, lon, lat }
})

/* ---------------- 淹没计算 ---------------- */
const flood = new Uint8Array(N * N) // 1 = 被淹
const depthArr = new Float32Array(N * N)

function computeFlood() {
  const lv = level.value
  flood.fill(0)
  depthArr.fill(0)
  if (mode.value === 'all') {
    for (let k = 0; k < dem.h.length; k++) {
      const d = lv - dem.h[k]
      if (d > 0) {
        flood[k] = 1
        depthArr[k] = d
      }
    }
  } else {
    // 洪水填充：从河道种子点出发，只沿四邻扩散（不翻山）
    if (dem.h[SEED] >= lv) return
    const stack = new Int32Array(N * N)
    let sp = 0
    stack[sp++] = SEED
    flood[SEED] = 1
    while (sp > 0) {
      const k = stack[--sp]
      depthArr[k] = lv - dem.h[k]
      const j = (k / N) | 0
      const i = k - j * N
      if (i > 0 && !flood[k - 1] && dem.h[k - 1] < lv) {
        flood[k - 1] = 1
        stack[sp++] = k - 1
      }
      if (i < N - 1 && !flood[k + 1] && dem.h[k + 1] < lv) {
        flood[k + 1] = 1
        stack[sp++] = k + 1
      }
      if (j > 0 && !flood[k - N] && dem.h[k - N] < lv) {
        flood[k - N] = 1
        stack[sp++] = k - N
      }
      if (j < N - 1 && !flood[k + N] && dem.h[k + N] < lv) {
        flood[k + N] = 1
        stack[sp++] = k + N
      }
    }
  }
}

function computeStats() {
  const cellA = dem.cell * dem.cell
  let area = 0
  let vol = 0
  let maxD = 0
  for (let k = 0; k < flood.length; k++) {
    if (!flood[k]) continue
    area += cellA
    vol += depthArr[k] * cellA
    if (depthArr[k] > maxD) maxD = depthArr[k]
  }
  let hit = 0
  for (const vil of VILLAGES) {
    const u = (vil.lon - dem.lon0) / (dem.lon1 - dem.lon0)
    const v = (dem.lat1 - vil.lat) / (dem.lat1 - dem.lat0)
    const i = Math.round(u * (N - 1))
    const j = Math.round(v * (N - 1))
    if (flood[j * N + i]) hit++
  }
  stat.value = { area: area / 1e6, volume: vol / 1e6, maxDepth: maxD, villages: hit }
}

/* ---------------- 纹理 ---------------- */
const TEX = 720
const terrainCanvas = document.createElement('canvas')
terrainCanvas.width = terrainCanvas.height = TEX
const tctx = terrainCanvas.getContext('2d')!

function bakeTerrain() {
  const shade = hillshade(dem, 315, 45, 1.4)
  const img = tctx.createImageData(TEX, TEX)
  const d = img.data
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
  tctx.putImageData(img, 0, 0)
}

/** 水体掩膜：256²，RGB = 随深度渐变的蓝，A = 是否被淹（边缘平滑） */
const MASK = 256
const waterCanvas = document.createElement('canvas')
waterCanvas.width = waterCanvas.height = MASK
const wctx = waterCanvas.getContext('2d')!

function bakeWater() {
  const img = wctx.createImageData(MASK, MASK)
  const d = img.data
  for (let py = 0; py < MASK; py++) {
    const v = py / (MASK - 1)
    for (let px = 0; px < MASK; px++) {
      const u = px / (MASK - 1)
      const i = Math.round(u * (N - 1))
      const j = Math.round(v * (N - 1))
      const k = j * N + i
      const t = (py * MASK + px) << 2
      if (!flood[k]) {
        d[t + 3] = 0
        continue
      }
      const dep = Math.min(depthArr[k] / 16, 1) // 16m 以上算深水
      d[t] = 40 + 40 * (1 - dep)
      d[t + 1] = 120 + 70 * (1 - dep)
      d[t + 2] = 190 + 55 * (1 - dep)
      d[t + 3] = 255
    }
  }
  wctx.putImageData(img, 0, 0)
}

/* ---------------- 图元 ---------------- */
let terrainPrim: Cesium.Primitive | null = null
let terrainMat: Cesium.Material | null = null
let waterPrim: Cesium.Primitive | null = null
let waterMat: Cesium.Material | null = null
const uploader = makeTextureUploader()

/**
 * 水面材质只建一次（纹理随淹没范围重上传），几何随水位重建 ——
 * 用 24×24 的粗网格就够（水面是平的），世界坐标直接给高度，
 * 避免局部坐标里出现原点（Cesium 的 projectTo2D 对原点会抛 DeveloperError）。
 */
const WATER_N = 24

function buildWater() {
  const scene = viewer?.scene
  if (!scene) return
  if (waterPrim) {
    scene.primitives.remove(waterPrim)
    waterPrim = null
  }
  if (!waterMat) {
    waterMat = new Cesium.Material({
      fabric: {
        uniforms: { image: waterCanvas, uTime: 0 },
        source: `
          czm_material czm_getMaterial(czm_materialInput materialInput) {
            czm_material m = czm_getDefaultMaterial(materialInput);
            vec2 st = materialInput.st;
            // 两列不同相位的正弦叠加，模拟水面细波纹
            float w = sin(st.x * 160.0 + uTime * 2.1) * sin(st.y * 130.0 - uTime * 1.6);
            vec4 c = texture(image, st);
            m.diffuse = c.rgb * (0.94 + 0.1 * w);
            m.alpha = c.a * (0.78 + 0.08 * w);
            return m;
          }`,
      },
      translucent: true,
    })
  }
  const count = WATER_N * WATER_N
  const positions = new Float64Array(count * 3)
  const normals = new Float32Array(count * 3)
  const st = new Float32Array(count * 2)
  const indices = new Uint32Array((WATER_N - 1) * (WATER_N - 1) * 6)
  const tmp = new Cesium.Cartesian3()
  for (let j = 0; j < WATER_N; j++) {
    const v = j / (WATER_N - 1)
    for (let i = 0; i < WATER_N; i++) {
      const u = i / (WATER_N - 1)
      const lon = dem.lon0 + (dem.lon1 - dem.lon0) * u
      const lat = dem.lat1 - (dem.lat1 - dem.lat0) * v
      const k = j * WATER_N + i
      Cesium.Cartesian3.fromDegrees(lon, lat, level.value + groundOffset, undefined, tmp)
      positions[k * 3] = tmp.x
      positions[k * 3 + 1] = tmp.y
      positions[k * 3 + 2] = tmp.z
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(tmp, tmp)
      normals[k * 3] = tmp.x
      normals[k * 3 + 1] = tmp.y
      normals[k * 3 + 2] = tmp.z
      st[k * 2] = u
      st[k * 2 + 1] = 1 - v
    }
  }
  let p = 0
  for (let j = 0; j < WATER_N - 1; j++) {
    for (let i = 0; i < WATER_N - 1; i++) {
      const a = j * WATER_N + i
      const b = a + 1
      const c = a + WATER_N
      const d = a + WATER_N + 1
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
  waterPrim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.Geometry({
        attributes: attr,
        indices,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: waterMat,
      translucent: true,
      flat: true,
    }),
    asynchronous: false,
  })
  scene.primitives.add(waterPrim)
}

/**
 * 库区模型 = 顶面（贴图 DEM，exag=1 保证水位映射精确）+ 独立岩层裙边。
 * 真实地形在矩形内被 clipGlobeRectangle 挖掉，模型以自身高程嵌入，四周由裙边封口。
 */
function buildAll() {
  const scene = viewer?.scene
  if (!scene) return
  if (terrainPrim) scene.primitives.remove(terrainPrim)
  if (skirtPrim) scene.primitives.remove(skirtPrim)
  terrainMat = makeImageMaterial(terrainCanvas)
  terrainPrim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: buildTerrainGeometry(dem, 1, groundOffset),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: terrainMat,
      translucent: false,
      flat: true,
    }),
    asynchronous: false,
  })
  scene.primitives.add(terrainPrim)
  skirtPrim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: buildSkirtGeometry(dem, 1, groundOffset, 1400),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: makeSkirtMaterial(),
      translucent: false,
      flat: true,
    }),
    asynchronous: false,
  })
  scene.primitives.add(skirtPrim)
  uploader.upload(terrainMat, terrainCanvas)
  buildWater()
}

let pending = false
function refresh() {
  if (pending) return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    computeFlood()
    computeStats()
    bakeWater()
    uploader.upload(waterMat, waterCanvas)
    buildWater()
  })
}

/* ---------------- 水位动画 ---------------- */
let raf = 0
let last = 0
/**
 * 播放水位上涨。
 * 注意：增量必须累加到一个"未取整"的浮点量上——直接把 level.value（已四舍五入到 0.1m）
 * 当累加基准时，每帧只涨 2.4*0.016≈0.04m，round 回去永远是同一个值，动画会卡死不动。
 */
let levelAcc = 0
function tick(now: number) {
  if (playing.value) {
    if (!last) {
      last = now
      levelAcc = level.value
    }
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    levelAcc += riseRate.value * dt
    if (levelAcc > dem.max) levelAcc = dem.min + 5
    level.value = Math.round(levelAcc * 10) / 10
  } else {
    last = 0
    levelAcc = level.value
  }
  raf = requestAnimationFrame(tick)
}

/* ---------------- 视角 ---------------- */
const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.1607, 13000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-36), roll: 0 },
}
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(() => viewer, () => home)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'imagery')

watch([level, mode], refresh)
watch(playing, (on) => {
  last = 0
  void on
})

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  const scene = viewer.scene
  scene.globe.enableLighting = false

  stopTerrain = enableTerrainScene(viewer)

  computeFlood()
  computeStats()
  bakeTerrain()
  bakeWater()
  buildAll()

  for (const vil of VILLAGES) {
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(
        vil.lon,
        vil.lat,
        sampleH(dem, (vil.lon - dem.lon0) / (dem.lon1 - dem.lon0), (dem.lat1 - vil.lat) / (dem.lat1 - dem.lat0)) +
          groundOffset +
          30,
      ),
      label: {
        text: vil.name,
        font: '600 12px sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0d1622').withAlpha(0.78),
        backgroundPadding: new Cesium.Cartesian2(6, 3),
        pixelOffset: new Cesium.Cartesian2(0, -14),
        scaleByDistance: new Cesium.NearFarScalar(8e3, 1.1, 6e4, 0.6),
        disableDepthTestDistance: 4000,
      },
      point: {
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString('#ffd45e'),
        outlineColor: Cesium.Color.fromCssColorString('#101820'),
        outlineWidth: 2,
        disableDepthTestDistance: 4000,
      },
    })
  }

  // 波纹时间 uniform 走 preRender，每帧推进
  const removePre = scene.preRender.addEventListener(() => {
    if (waterMat) waterMat.uniforms.uTime = performance.now() / 1000
  })
  void removePre

  raf = requestAnimationFrame(tick)
  viewer.camera.setView(home)

  // 真实地形就位后，把库区模型抬到实际高程带并重建
  void (async () => {
    if (!viewer || !(await waitRealTerrain(viewer))) return
    const realMax = await sampleMaxGroundHeight(viewer, dem.lon0, dem.lat0, dem.lon1, dem.lat1)
    if (viewer && !viewer.isDestroyed() && realMax > 0) {
      groundOffset = Math.max(0, realMax - dem.min + 6)
      buildAll()
      clipGlobeRectangle(viewer, dem.lon0, dem.lat0, dem.lon1, dem.lat1)
    }
  })()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  stopTerrain?.()
  skirtPrim = null
  uploader.dispose()
  terrainMat = null
  waterMat = null
  terrainPrim = null
  waterPrim = null
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
      <div class="title">水库淹没分析</div>
      <div class="sub">连通 = 从河道种子洪水填充；全域 = 所有低于水位的洼地（含山后洼地）</div>

      <div class="ctrl">
        <span class="lab">库水位</span>
        <input v-model.number="level" type="range" :min="Math.round(dem.min + 4)" :max="Math.round(dem.max)" step="1" />
        <b>{{ level.toFixed(0) }}<i>m</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">上涨速度</span>
        <input v-model.number="riseRate" type="range" min="0.5" max="12" step="0.5" />
        <b>{{ riseRate.toFixed(1) }}<i>m/s</i></b>
      </div>

      <div class="row btns">
        <button class="chip" :class="{ on: mode === 'conn' }" @click="mode = 'conn'">连通淹没</button>
        <button class="chip" :class="{ on: mode === 'all' }" @click="mode = 'all'">全域淹没</button>
        <button class="chip primary" @click="playing = !playing">
          {{ playing ? '⏸ 暂停' : '▶ 水位上涨' }}
        </button>
      </div>

      <div class="stat">
        <div class="item"><span class="k">淹没面积</span><b>{{ stat.area.toFixed(2) }}<i>km²</i></b></div>
        <div class="item"><span class="k">蓄水量</span><b>{{ stat.volume.toFixed(1) }}<i>百万m³</i></b></div>
        <div class="item"><span class="k">最大水深</span><b>{{ stat.maxDepth.toFixed(1) }}<i>m</i></b></div>
        <div class="item warn"><span class="k">受淹村庄</span><b>{{ stat.villages }}<i>/{{ VILLAGES.length }}</i></b></div>
      </div>

      <div class="tip">
        河道用一条蜿蜒正弦线刻蚀，水位从河道最低点起算 —— 低于它时连通模式一滴水都不会出现。
        两处<b>山后闭合洼地</b>（塬上村 / 石门村旁）在「连通」模式下永远不会被淹，
        切到「全域」就会突然灌满，这就是两种算法的差别。
        水面是局部 ENU 网格 + modelMatrix 抬升：水位变化只改一个矩阵，波纹用 uTime 驱动。
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
  background: linear-gradient(180deg, rgba(40, 150, 96, 0.95), rgba(24, 104, 66, 0.95));
  border-color: rgba(90, 210, 150, 0.7);
  color: #eafff4;
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
.item.warn {
  border-color: rgba(226, 92, 74, 0.5);
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
.item.warn b {
  color: #ff9d8a;
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
