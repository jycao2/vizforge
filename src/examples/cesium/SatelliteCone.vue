<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import * as Cesium from 'cesium'
import type { Viewer } from 'cesium'
import { useCesiumView, VIEWER_OPTIONS } from './useCesium'
import { applyCesiumBasemap } from './basemaps'

/* ============================================================
 * 卫星成像视锥（遥感过境可视化）
 *  - 卫星在 550km 圆轨道上运动（倾角 60°，ECEF 直接算位置，不引 SGP4）
 *  - 视场锥：卫星位置 → 地面四个角点，四条棱 + 四个半透明侧面
 *  - 地面足迹：4 角点矩形，随 FOV 变化；中心点 + 星下点虚线
 *  - 全部位置用 CallbackProperty 每帧算，Cesium 只负责画
 * ============================================================ */

const container = ref<HTMLDivElement>()
const viewerRef = shallowRef<Viewer | null>(null)
const DEFAULTS = { fov: 28, speed: 1 } // 半视场角（度，决定地面足迹大小）/ 轨道速度倍率
const fov = ref(DEFAULTS.fov)
const speed = ref(DEFAULTS.speed)
const showOrbit = ref(true)
const showCone = ref(true)
const info = ref('')

const R = 6378137
const ALT = 550000
const INC = Cesium.Math.toRadians(60)
let theta = 0.4
let raf = 0

function getViewer() {
  return viewerRef.value
}

const { reset } = useCesiumView(getViewer, () => ({
  destination: Cesium.Cartesian3.fromDegrees(110, 18, 1.35e7),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-72), roll: 0 },
}))

/** 轨道参数 t → ECEF 位置（半径 R+alt 的圆，绕 z 轴转，倾角 60°） */
function orbitPos(t: number, radius = R + ALT): Cesium.Cartesian3 {
  const x = radius * Math.cos(t)
  const y = radius * Math.sin(t) * Math.cos(INC)
  const z = radius * Math.sin(t) * Math.sin(INC)
  return new Cesium.Cartesian3(x, y, z)
}

/** ECEF → 经纬度（度） */
function toLonLat(p: Cesium.Cartesian3): [number, number] {
  const c = Cesium.Cartographic.fromCartesian(p)
  return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)]
}

/** 某经纬度处正上方 height 米的位置 */
function above(lon: number, lat: number, h: number) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, h)
}

/** 视场四角：以星下点为中心，按「高度 × tan(半视场角)」估算足迹半径（近似） */
function footprintCorners(lon: number, lat: number): Array<[number, number]> {
  // 斜视时足迹被拉长，这里用中心星下点的正下方地面点估算（教学简化）
  const groundR = ALT * Math.tan(Cesium.Math.toRadians(fov.value))
  const dLat = groundR / 110540
  const dLon = groundR / (111320 * Math.cos(Cesium.Math.toRadians(lat)) || 1)
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat],
  ]
}

let satEntity: Cesium.Entity | null = null
let coneEntities: Cesium.Entity[] = []
let footEntity: Cesium.Entity | null = null
let nadirEntity: Cesium.Entity | null = null
let orbitEntity: Cesium.Entity | null = null

function buildScene(viewer: Viewer) {
  // 卫星本体（发光球 + 光晕 billboard 用 canvas 生成）
  const cv = document.createElement('canvas')
  cv.width = 64
  cv.height = 64
  const ctx = cv.getContext('2d')!
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 31)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(120,220,255,0.9)')
  grad.addColorStop(1, 'rgba(60,160,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 64, 64)

  satEntity = viewer.entities.add({
    position: new Cesium.CallbackPositionProperty(() => orbitPos(theta), false),
    billboard: {
      image: cv.toDataURL(),
      scale: 0.9,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: 'SAT-07  遥感卫星',
      font: '13px monospace',
      fillColor: Cesium.Color.fromCssColorString('#9fe8ff'),
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#0b1622').withAlpha(0.75),
      pixelOffset: new Cesium.Cartesian2(0, -30),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  })

  // 轨道线：一整圈采样
  const ring: Cesium.Cartesian3[] = []
  for (let i = 0; i <= 360; i++) ring.push(orbitPos((i / 360) * Math.PI * 2))
  orbitEntity = viewer.entities.add({
    polyline: {
      positions: ring,
      width: 1.6,
      material: new Cesium.PolylineGlowMaterialProperty({
        color: Cesium.Color.fromCssColorString('#3d8bff').withAlpha(0.55),
        glowPower: 0.22,
      }),
    },
  })

  // 地面足迹：4 角点矩形（半透明填充 + 发光边）
  footEntity = viewer.entities.add({
    polygon: {
      hierarchy: new Cesium.CallbackProperty(() => {
        const [, lat] = toLonLat(orbitPos(theta))
        const [lon] = toLonLat(orbitPos(theta))
        const corners = footprintCorners(lon, lat)
        return new Cesium.PolygonHierarchy(corners.map(([x, y]) => above(x, y, 15)))
      }, false),
      material: Cesium.Color.fromCssColorString('#2ad4ff').withAlpha(0.22),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#6ef0ff'),
      outlineWidth: 2.4,
      classificationType: Cesium.ClassificationType.TERRAIN,
    },
  })

  // 星下点虚线
  nadirEntity = viewer.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        const p = orbitPos(theta)
        const [lon, lat] = toLonLat(p)
        return [p, above(lon, lat, 20)]
      }, false),
      width: 1.4,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString('#7ce8ff').withAlpha(0.7),
        dashLength: 14,
      }),
    },
  })

  // 视锥：四条棱 + 四个侧面
  const edgeColor = Cesium.Color.fromCssColorString('#4fd0ff').withAlpha(0.85)
  for (let i = 0; i < 4; i++) {
    const e = viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const p = orbitPos(theta)
          const [lon, lat] = toLonLat(p)
          const corners = footprintCorners(lon, lat)
          const [x, y] = corners[i]
          return [p, above(x, y, 15)]
        }, false),
        width: 1.8,
        material: new Cesium.PolylineGlowMaterialProperty({ color: edgeColor, glowPower: 0.18 }),
      },
    })
    coneEntities.push(e)
  }
  for (let i = 0; i < 4; i++) {
    const e = viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.CallbackProperty(() => {
          const p = orbitPos(theta)
          const [lon, lat] = toLonLat(p)
          const corners = footprintCorners(lon, lat)
          const a = corners[i]
          const b = corners[(i + 1) % 4]
          return new Cesium.PolygonHierarchy([
            p,
            above(a[0], a[1], 15),
            above(b[0], b[1], 15),
          ])
        }, false),
        material: Cesium.Color.fromCssColorString('#39c8ff').withAlpha(0.07),
        perPositionHeight: true,
        outline: false,
      },
    })
    coneEntities.push(e)
  }
}

/** 复位要连参数一起还原：只飞相机的话，调过滑杆的用户点下去画面纹丝不动，像按钮坏了 */
function resetAll() {
  fov.value = DEFAULTS.fov
  speed.value = DEFAULTS.speed
  showOrbit.value = true
  showCone.value = true
  reset()
}


onMounted(() => {
  const el = container.value
  if (!el) return
  const viewer = new Cesium.Viewer(el, { ...VIEWER_OPTIONS, shouldAnimate: true })
  viewerRef.value = viewer
  applyCesiumBasemap(viewer, 'imagery', null)
  viewer.scene.globe.depthTestAgainstTerrain = false

  // 深空背景，卫星在暗背景上更醒目
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a1520')

  buildScene(viewer)

  let last = performance.now()
  const loop = () => {
    raf = requestAnimationFrame(loop)
    const now = performance.now()
    const dt = Math.min((now - last) / 1000, 0.1)
    last = now
    // 演示速度：1x ≈ 20 秒一圈（真实 95 分钟，可视化没必要）
    theta += dt * 0.31 * speed.value
    if (theta > Math.PI * 2) theta -= Math.PI * 2

    if (orbitEntity) orbitEntity.show = showOrbit.value
    for (const e of coneEntities) e.show = showCone.value
    if (footEntity) footEntity.show = showCone.value
    if (nadirEntity) nadirEntity.show = showCone.value

    const p = orbitPos(theta)
    const [lon, lat] = toLonLat(p)
    const groundR = (ALT * Math.tan(Cesium.Math.toRadians(fov.value))) / 1000
    info.value = `星下点 ${lon.toFixed(2)}°, ${lat.toFixed(2)}° · 幅宽 ≈ ${(groundR * 2).toFixed(0)} km`
  }
  loop()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  const v = viewerRef.value
  if (v && !v.isDestroyed()) v.destroy()
  viewerRef.value = null
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="cesium-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">半视场角</span>
        <input
          class="range"
          type="range"
          min="6"
          max="48"
          step="1"
          :value="fov"
          @input="fov = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ fov }}°</span>
      </div>
      <div class="row">
        <span class="label">时间倍率</span>
        <input
          class="range"
          type="range"
          min="0"
          max="6"
          step="0.5"
          :value="speed"
          @input="speed = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ speed }}×</span>
      </div>
      <div class="row">
        <button class="btn" :class="{ active: showCone }" @click="showCone = !showCone">视锥</button>
        <button class="btn" :class="{ active: showOrbit }" @click="showOrbit = !showOrbit">轨道</button>
        <button class="btn" @click="resetAll()">复位</button>
      </div>
      <div class="meta">{{ info }}</div>
      <div class="tip">
        550km 圆轨道（倾角 60°）直接用 ECEF 圆参数算位置；视锥 = 卫星到地面四角点的棱与侧面，
        地面足迹随半视场角实时变化。位置全部由 CallbackProperty 每帧驱动。
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
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
  z-index: 5;
  width: 320px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.label {
  font-size: 12px;
  color: #9fb0c2;
  white-space: nowrap;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  font-size: 12px;
  color: #7ee787;
  width: 40px;
  text-align: right;
}
.meta {
  font-size: 11.5px;
  color: #7ee787;
  margin: 2px 0 4px;
}
.tip {
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
.btn {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.5);
  background: rgba(30, 42, 60, 0.7);
  color: #9fd0ff;
  cursor: pointer;
}
.btn.active {
  background: #1f5c9e;
  color: #fff;
  border-color: #4f9dff;
}
</style>
