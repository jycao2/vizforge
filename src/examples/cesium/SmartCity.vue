<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, enableTerrainScene, useCesiumBasemap, useCesiumView } from './useCesium'

/* ============================================================
 * 智慧城市 · 运营态势
 *
 * 三个层次：
 *  1) 路网与车流：程序化主干路网（贴地折线），车辆用 PointPrimitiveCollection
 *     批量更新位置 —— 500 辆车只有 1 个 draw call，这是 Cesium 里跑车流的常规做法；
 *     速度低于阈值的路段判定为拥堵，车辆变色。
 *  2) IoT 感知层：信号灯 / 摄像头 / 水位计 / 空气质量站，带脉冲光环，
 *     点击可看实时读数，超阈值即进入告警队列。
 *  3) KPI 面板：在线车辆、平均车速、拥堵路段、告警数，随时间滚动。
 *
 * 注意：Entity API 每帧改位置会触发大量属性更新，几百个实体就开始掉帧；
 * 车辆这类高频更新的对象一律走 Primitive（PointPrimitiveCollection）。
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 116.455
const LAT = 39.915
const SPAN = 4200 // 米

/* ---------------- KPI ---------------- */
const kpi = ref({ vehicles: 0, avgSpeed: 0, jams: 0, alarms: 0, devices: 0 })
const clockText = ref('')
const playing = ref(true)
const alertList = ref<Array<{ time: string; text: string; level: 'warn' | 'info' }>>([])

/* ---------------- 路网 ---------------- */
interface Road {
  a: [number, number] // 起点（米，局部坐标）
  b: [number, number]
  name: string
  jam: number // 0~1 拥堵程度
}
const ROADS: Road[] = []
const ROAD_NAMES = ['长安街', '建国路', '朝阳北路', '东三环', '东四环', '金台路', '光华路', '日坛路']

/* 车辆（primitive 层） */
interface Car {
  road: number
  t: number // 0~1 沿路段进度
  dir: 1 | -1
  speed: number // m/s
  lane: number // 横向偏移（米）
}
let cars: Car[] = []
const CAR_COLORS = [
  Cesium.Color.fromCssColorString('#7fd0ff'),
  Cesium.Color.fromCssColorString('#a9e5a0'),
  Cesium.Color.fromCssColorString('#ffe08a'),
]
const JAM_COLOR = Cesium.Color.fromCssColorString('#ff5c46')
let pointCollection: Cesium.PointPrimitiveCollection | null = null
const carPoints: Cesium.PointPrimitive[] = []

/* 设备 */
interface Device {
  name: string
  kind: '信号灯' | '摄像头' | '水位计' | '空气站'
  x: number
  z: number
  value: number
  unit: string
  limit: number
  alarm: boolean
}
const devices: Device[] = []
let deviceEntities: Cesium.Entity[] = []

/* ---------------- 坐标换算 ---------------- */
let lon0 = 0
let lat0 = 0
let mPerDegLon = 0
const mPerDegLat = 110540

function toLonLat(x: number, z: number): [number, number] {
  return [lon0 + x / mPerDegLon, lat0 - z / mPerDegLat]
}

/* ---------------- 建场景 ---------------- */
function buildRoads() {
  if (!viewer) return
  const half = SPAN / 2
  const step = SPAN / 5
  // 南北向 3 条 + 东西向 3 条主干路，外圈二环
  for (let i = 0; i < 3; i++) {
    const x = -half + step * (i + 1)
    ROADS.push({ a: [x, -half], b: [x, half], name: ROAD_NAMES[i], jam: 0 })
  }
  for (let i = 0; i < 3; i++) {
    const z = -half + step * (i + 1)
    ROADS.push({ a: [-half, z], b: [half, z], name: ROAD_NAMES[3 + i], jam: 0 })
  }
  // 外环
  ROADS.push({ a: [-half, -half], b: [half, -half], name: ROAD_NAMES[6], jam: 0 })
  ROADS.push({ a: [-half, half], b: [half, half], name: ROAD_NAMES[7], jam: 0 })

  for (const r of ROADS) {
    const [lonA, latA] = toLonLat(r.a[0], r.a[1])
    const [lonB, latB] = toLonLat(r.b[0], r.b[1])
    viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([lonA, latA, lonB, latB]),
        width: 4.2,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: Cesium.Color.fromCssColorString('#57b6dd').withAlpha(0.9),
          glowPower: 0.16,
        }),
        clampToGround: true,
      },
    })
  }
}

function buildDevices() {
  if (!viewer) return
  const defs: Array<Omit<Device, 'value' | 'alarm'>> = [
    { name: '国贸桥信号灯', kind: '信号灯', x: -420, z: -260, unit: 's', limit: 120 },
    { name: '建国门摄像头', kind: '摄像头', x: 260, z: -520, unit: '辆/min', limit: 90 },
    { name: '通惠河水位计', kind: '水位计', x: 620, z: 340, unit: 'm', limit: 3.2 },
    { name: '日坛空气站', kind: '空气站', x: -680, z: 420, unit: 'μg/m³', limit: 75 },
    { name: '光华路信号灯', kind: '信号灯', x: 120, z: 260, unit: 's', limit: 120 },
    { name: '东三环摄像头', kind: '摄像头', x: -260, z: 620, unit: '辆/min', limit: 90 },
  ]
  for (const d of defs) {
    devices.push({ ...d, value: d.limit * 0.55, alarm: false })
  }

  for (const d of devices) {
    const [lon, lat] = toLonLat(d.x, d.z)
    const ent = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 18),
      point: {
        pixelSize: 8,
        color: Cesium.Color.fromCssColorString('#5ce1ff'),
        outlineColor: Cesium.Color.fromCssColorString('#04141c'),
        outlineWidth: 2,
        disableDepthTestDistance: 3000,
      },
      label: {
        text: d.name,
        font: '600 11px sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0a1a24').withAlpha(0.75),
        backgroundPadding: new Cesium.Cartesian2(5, 2),
        pixelOffset: new Cesium.Cartesian2(0, -14),
        scaleByDistance: new Cesium.NearFarScalar(1.5e3, 1.1, 1.2e4, 0.7),
        disableDepthTestDistance: 3000,
      },
    })
    deviceEntities.push(ent)
    // 脉冲光圈
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 6),
      ellipse: {
        // 长短轴必须同源：两个回调各读一次 performance.now() 会算出不同的相位，
        // Cesium 校验 semiMajor ≥ semiMinor 时直接抛 DeveloperError，整页停止渲染。
        semiMinorAxis: new Cesium.CallbackProperty(() => {
          const ph = (pulseNow + d.x * 0.01) % 2
          return 30 + ph * 70
        }, false),
        semiMajorAxis: new Cesium.CallbackProperty(() => {
          const ph = (pulseNow + d.x * 0.01) % 2
          return 30 + ph * 70
        }, false),
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(() => {
            const ph = (pulseNow + d.x * 0.01) % 2
            const a = Math.max(0, 0.5 - ph * 0.25)
            return d.alarm
              ? Cesium.Color.fromCssColorString('#ff6b4a').withAlpha(a)
              : Cesium.Color.fromCssColorString('#3fe0ff').withAlpha(a)
          }, false) as unknown as Cesium.Color,
        ),
        height: 4,
      },
    })
  }
}

function buildCars(count: number) {
  if (!viewer) return
  if (pointCollection) viewer.scene.primitives.remove(pointCollection)
  carPoints.length = 0
  pointCollection = new Cesium.PointPrimitiveCollection()
  for (let i = 0; i < count; i++) {
    const road = Math.floor(Math.random() * ROADS.length)
    const p = pointCollection.add({
      position: Cesium.Cartesian3.fromDegrees(0, 0, 8),
      pixelSize: 4.5,
      color: CAR_COLORS[i % CAR_COLORS.length],
      disableDepthTestDistance: 2500,
    })
    carPoints.push(p)
    cars.push({
      road,
      t: Math.random(),
      dir: Math.random() > 0.5 ? 1 : -1,
      speed: 8 + Math.random() * 9,
      lane: (Math.random() - 0.5) * 9,
    })
  }
  viewer.scene.primitives.add(pointCollection)
}

/* ---------------- 每帧推进 ---------------- */
let last = 0
let clock = 0
/** 脉冲相位：每帧算一次，供所有 CallbackProperty 读取（各自取 time 会算出长短轴不一致） */
let pulseNow = 0
function tick(now: number) {
  if (!viewer) return
  const dt = Math.min((now - last) / 1000, 0.06)
  last = now
  if (!playing.value || !dt) return
  clock += dt
  pulseNow = performance.now() / 1000

  // 拥堵程度随时间缓慢起伏（模拟早晚高峰）
  let jamSum = 0
  for (let i = 0; i < ROADS.length; i++) {
    const phase = clock * 0.18 + i * 1.7
    ROADS[i].jam = 0.5 + 0.45 * Math.sin(phase)
    jamSum += ROADS[i].jam
  }

  // 车辆推进
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i]
    const r = ROADS[c.road]
    const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1])
    const factor = 1 - r.jam * 0.82
    const v = c.speed * factor
    c.t += (c.dir * v * dt) / len
    if (c.t > 1) c.t -= 1
    if (c.t < 0) c.t += 1
    const x = r.a[0] + (r.b[0] - r.a[0]) * c.t + (r.b[1] === r.a[1] ? 0 : c.lane)
    const z = r.a[1] + (r.b[1] - r.a[1]) * c.t + (r.b[1] === r.a[1] ? c.lane : 0)
    const [lon, lat] = toLonLat(x, z)
    const p = carPoints[i]
    p.position = Cesium.Cartesian3.fromDegrees(lon, lat, 8)
    // 拥堵转红、恢复后要还原（只改不还原的话，跑过一次拥堵就永远是红的）
    p.color = r.jam > 0.62 ? JAM_COLOR : CAR_COLORS[i % CAR_COLORS.length]
  }

  // KPI 每 0.5s 刷一次，避免 DOM 抖动
  if (Math.floor(clock * 2) !== Math.floor((clock - dt) * 2)) {
    let speedSum = 0
    let jams = 0
    for (let i = 0; i < ROADS.length; i++) {
      const r = ROADS[i]
      speedSum += 60 * (1 - r.jam * 0.82)
      if (r.jam > 0.62) jams++
    }
    kpi.value = {
      vehicles: cars.length,
      avgSpeed: Math.round(speedSum / ROADS.length),
      jams,
      alarms: devices.filter((d) => d.alarm).length,
      devices: devices.length,
    }
    const t = 8 * 3600 + Math.floor(clock * 30) // 08:00 起，30 倍速
    const hh = String(Math.floor((t / 3600) % 24)).padStart(2, '0')
    const mm = String(Math.floor((t / 60) % 60)).padStart(2, '0')
    const ss = String(t % 60).padStart(2, '0')
    clockText.value = `${hh}:${mm}:${ss}`

    // 设备读数与告警
    for (const d of devices) {
      const noise = (Math.sin(clock * 0.8 + d.x * 0.01) + Math.sin(clock * 0.45 + d.z * 0.02)) * 0.5
      const target = Math.max(0, d.limit * (0.55 + 0.3 * noise + 0.45 * Math.max(0, Math.sin(clock * 0.12 + d.z * 0.002))))
      // 一阶低通 + 滞回：读数抖动时不要在阈值上下反复横跳，
      // 否则告警数会一直闪 0/1/2，事件列表刷屏却对不上 KPI
      d.value += (target - d.value) * 0.25
      const wasAlarm = d.alarm
      d.alarm = d.alarm ? d.value > d.limit * 0.92 : d.value > d.limit
      if (d.alarm && !wasAlarm) pushAlert(`${d.name} 超过阈值（${d.value.toFixed(1)}${d.unit}）`, 'warn')
      else if (!d.alarm && wasAlarm) pushAlert(`${d.name} 已恢复（${d.value.toFixed(1)}${d.unit}）`, 'info')
    }
    for (let i = 0; i < devices.length; i++) {
      const d = devices[i]
      const ent = deviceEntities[i]
      if (!ent?.point) continue
      ;(ent.point as Cesium.PointGraphics).color = new Cesium.ConstantProperty(
        d.alarm ? Cesium.Color.fromCssColorString('#ff6b4a') : Cesium.Color.fromCssColorString('#5ce1ff'),
      )
    }
  }
  requestAnimationFrame(tick)
}

function pushAlert(text: string, level: 'warn' | 'info') {
  const now = clockText.value || '08:00:00'
  alertList.value.unshift({ time: now, text, level })
  if (alertList.value.length > 5) alertList.value.pop()
}

/* ---------------- 视角 ---------------- */
const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.032, 4200),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-42), roll: 0 },
}
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(() => viewer, () => home)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'imagery')

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  enableTerrainScene(viewer)

  mPerDegLon = 111320 * Math.cos((LAT * Math.PI) / 180)
  lon0 = LON
  lat0 = LAT

  buildRoads()
  buildDevices()
  buildCars(520)
  viewer.camera.setView(home)

  pushAlert('系统启动，路网 8 条主干道接入', 'info')
  last = performance.now()
  requestAnimationFrame(tick)

  // 点设备看读数
  new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas).setInputAction(
    (mv: { position: Cesium.Cartesian2 }) => {
      const picked = viewer?.scene.pick(mv.position)
      if (!picked?.id) return
      const ent = picked.id as Cesium.Entity
      const name = (ent.label?.text as Cesium.ConstantProperty)?.getValue?.()
      const d = devices.find((x) => x.name === name)
      if (d) pushAlert(`${d.name}：${d.value.toFixed(1)}${d.unit}`, d.alarm ? 'warn' : 'info')
    },
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  )
})

onBeforeUnmount(() => {
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
  pointCollection = null
  carPoints.length = 0
  cars = []
  ROADS.length = 0
  devices.length = 0
  deviceEntities = []
})

const jamText = computed(() => (kpi.value.jams === 0 ? '畅通' : `${kpi.value.jams} 段拥堵`))
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
        <span class="dot" :class="{ live: playing }"></span>
        智慧城市 · 运营态势
      </div>
      <div class="sub">路网车流 · IoT 感知 · 告警联动 · {{ clockText }}</div>

      <div class="kpi">
        <div class="cell">
          <b>{{ kpi.vehicles }}</b>
          <span>在线车辆</span>
        </div>
        <div class="cell">
          <b>{{ kpi.avgSpeed }}<i>km/h</i></b>
          <span>平均车速</span>
        </div>
        <div class="cell" :class="{ warn: kpi.jams > 0 }">
          <b>{{ kpi.jams }}</b>
          <span>拥堵路段</span>
        </div>
        <div class="cell" :class="{ warn: kpi.alarms > 0 }">
          <b>{{ kpi.alarms }}<i>/{{ kpi.devices }}</i></b>
          <span>设备告警</span>
        </div>
      </div>

      <div class="row">
        <button class="chip primary" @click="playing = !playing">
          {{ playing ? '⏸ 暂停' : '▶ 继续' }}
        </button>
        <button class="chip" @click="pushAlert('人工巡检任务已下发', 'info')">派发巡检</button>
      </div>

      <div class="alerts">
        <div class="head">实时事件 · {{ jamText }}</div>
        <div v-for="(a, i) in alertList" :key="i" class="alert" :class="a.level">
          <span class="t">{{ a.time }}</span>
          <span class="x">{{ a.text }}</span>
        </div>
        <div v-if="!alertList.length" class="empty">暂无事件</div>
      </div>

      <div class="tip">
        车辆走 <b>PointPrimitiveCollection</b>（500+ 辆只 1 个 draw call）；
        路网用 <b>clampToGround</b> 折线贴地；Entity 每帧改属性会拖慢帧率，高频对象一律走 Primitive。
        拥堵阈值 0.62，设备超限自动入告警队列。
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
  width: 300px;
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
  background: #6b7783;
}
.dot.live {
  background: #3ddc84;
  box-shadow: 0 0 9px #3ddc84;
}
.sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: #7d8fa2;
}
.kpi {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid rgba(88, 108, 132, 0.28);
}
.cell {
  text-align: center;
}
.cell b {
  display: block;
  font-size: 16px;
  font-weight: 600;
  color: #e9f2fb;
  font-variant-numeric: tabular-nums;
}
.cell b i {
  font-style: normal;
  font-size: 9px;
  color: #6d8098;
  margin-left: 1px;
}
.cell span {
  display: block;
  margin-top: 1px;
  font-size: 9.5px;
  color: #7f92a6;
}
.cell.warn b {
  color: #ff8a5c;
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
.alerts {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.28);
}
.head {
  font-size: 10px;
  color: #7f92a6;
  margin-bottom: 5px;
}
.alert {
  display: flex;
  gap: 6px;
  font-size: 10.5px;
  line-height: 1.5;
  color: #a9bccf;
}
.alert .t {
  color: #5f7286;
  font-variant-numeric: tabular-nums;
}
.alert.warn .x {
  color: #ffb27a;
}
.empty {
  font-size: 10.5px;
  color: #5f7286;
}
.tip {
  margin-top: 8px;
  font-size: 10px;
  line-height: 1.55;
  color: #6d8098;
}
.tip b {
  color: #9fb6cc;
}
</style>
