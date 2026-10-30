<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Map from 'ol/Map'
import View from 'ol/View'
import { fromLonLat, toLonLat } from 'ol/proj'
import MapControls from '@/components/MapControls.vue'
import { OL_BASEMAPS } from './basemaps'
import { useOlBasemap, useOlView } from './useOl'

/* ============================================================
 * 风场粒子流（Windy 风格）
 *  - 风场：中纬度西风带 + 3 个涡旋（气旋/反气旋）+ 低频扰动，程序化生成
 *  - 网格：把屏幕划分成 64×44 格，逐格点反算经纬度得到风矢量，粒子双线性插值查表
 *  - 渲染：独立 canvas 叠加，destination-out 做拖尾衰减，按风速分三档着色
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const fxRef = ref<HTMLCanvasElement>()

const playing = ref(true)
const count = ref(3600)
const speedScale = ref(1)
const showFlow = ref(true)
const fps = ref(0)

const { current: currentBasemap, create: createBasemap, apply: applyBasemap } = useOlBasemap('dark')
const HOME = fromLonLat([112, 33])
const homeZoom = 4.1
const { zoomBy, reset, toggleFullscreen } = useOlView(() => map, HOME, homeZoom)

let map: Map | null = null
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null
let raf = 0

/* ---------------- 风场模型 ---------------- */
interface Vortex {
  cx: number
  cy: number
  s: number
  r: number
}
const VORTICES: Vortex[] = [
  { cx: 123.5, cy: 26.5, s: 30, r: 6.2 }, // 东海气旋
  { cx: 107, cy: 41.5, s: -20, r: 7.4 }, // 华北反气旋
  { cx: 134, cy: 42, s: 18, r: 8.5 },
  { cx: 98, cy: 29, s: -13, r: 6.8 },
]

/** 返回某经纬度处的风矢量（m/s，u 东向 / v 北向） */
function windAt(lon: number, lat: number): [number, number] {
  // 中纬度西风急流：38°N 附近最强
  let u = 4.2 + 8.6 * Math.exp(-Math.pow((lat - 38) / 12, 2))
  let v = -1.8 * Math.sin(((lon - 110) * Math.PI) / 26) * Math.sin((lat * Math.PI) / 22)

  for (const vo of VORTICES) {
    const dx = lon - vo.cx
    const dy = lat - vo.cy
    const d = Math.hypot(dx, dy) + 1e-4
    const f = vo.s * Math.exp(-(d * d) / (2 * vo.r * vo.r))
    u += (-dy / d) * f
    v += (dx / d) * f
  }

  // 低频扰动，避免流线过于规整
  u += 2.4 * Math.sin(lon * 0.19 + lat * 0.11) * Math.cos(lat * 0.07)
  v += 2.0 * Math.cos(lon * 0.15 - lat * 0.17)
  return [u, v]
}

/* ---------------- 屏幕风场网格 ---------------- */
const GW = 64
const GH = 44
const gvx = new Float32Array(GW * GH)
const gvy = new Float32Array(GW * GH)

function rebuildGrid() {
  if (!map || !canvas) return
  const w = canvas.clientWidth || 1
  const h = canvas.clientHeight || 1
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const px = ((i + 0.5) / GW) * w
      const py = ((j + 0.5) / GH) * h
      const coord = map.getCoordinateFromPixel([px, py])
      const [lon, lat] = toLonLat(coord)
      const [u, v] = windAt(lon, lat)
      const k = j * GW + i
      gvx[k] = u
      gvy[k] = v
    }
  }
}

/** 双线性插值：返回像素坐标处的风矢量 */
function sampleWind(x: number, y: number, w: number, h: number): [number, number] {
  const fx = (x / w) * (GW - 1)
  const fy = (y / h) * (GH - 1)
  const i0 = Math.max(0, Math.min(GW - 2, Math.floor(fx)))
  const j0 = Math.max(0, Math.min(GH - 2, Math.floor(fy)))
  const tx = Math.max(0, Math.min(1, fx - i0))
  const ty = Math.max(0, Math.min(1, fy - j0))
  const a = j0 * GW + i0
  const b = a + 1
  const c = a + GW
  const d = c + 1
  const u00 = gvx[a] + (gvx[b] - gvx[a]) * tx
  const u01 = gvx[c] + (gvx[d] - gvx[c]) * tx
  const v00 = gvy[a] + (gvy[b] - gvy[a]) * tx
  const v01 = gvy[c] + (gvy[d] - gvy[c]) * tx
  return [u00 + (u01 - u00) * ty, v00 + (v01 - v00) * ty]
}

/* ---------------- 粒子 ---------------- */
interface Particle {
  x: number
  y: number
  age: number // 秒
  life: number // 秒
}
let particles: Particle[] = []

function spawn(p: Particle, w: number, h: number) {
  p.x = Math.random() * w
  p.y = Math.random() * h
  p.age = 0
  p.life = 2.2 + Math.random() * 2.6
}

function resetParticles() {
  if (!canvas) return
  const w = canvas.clientWidth || 1
  const h = canvas.clientHeight || 1
  particles = Array.from({ length: count.value }, () => {
    const p: Particle = { x: 0, y: 0, age: 0, life: 0 }
    spawn(p, w, h)
    p.age = Math.random() * p.life // 错开寿命，避免集体重生
    return p
  })
}

/* ---------------- 渲染循环 ---------------- */
const PX_PER_SEC = 9.5 // 风速 1 m/s 每秒移动的像素数（视觉标定值）
let lastT = 0
let fpsAcc = 0
let fpsFrames = 0

function frame(now: number) {
  raf = requestAnimationFrame(frame)
  if (!canvas || !ctx) return

  const dt = Math.min(now - lastT, 60)
  lastT = now

  fpsAcc += dt
  fpsFrames++
  if (fpsAcc > 500) {
    fps.value = Math.round((fpsFrames * 1000) / fpsAcc)
    fpsAcc = 0
    fpsFrames = 0
  }

  const w = canvas.clientWidth || 1
  const h = canvas.clientHeight || 1
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pw = Math.floor(w * dpr)
  const ph = Math.floor(h * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw
    canvas.height = ph
    rebuildGrid()
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  // 拖尾衰减：擦除一部分旧像素而不是整屏清空
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = 'rgba(0,0,0,0.028)'
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'source-over'

  if (!playing.value || !showFlow.value) return

  // 三档风速配色
  const slow = new Path2D()
  const mid = new Path2D()
  const fast = new Path2D()

  const step = (dt / 1000) * PX_PER_SEC * speedScale.value

  for (const p of particles) {
    const [u, v] = sampleWind(p.x, p.y, w, h)
    const spd = Math.hypot(u, v)
    const px = p.x
    const py = p.y
    p.x += u * step
    p.y -= v * step
    p.age += dt / 1000

    if (p.x < 0 || p.x > w || p.y < 0 || p.y > h || p.age > p.life) {
      spawn(p, w, h)
      continue
    }
    const path = spd < 6 ? slow : spd < 13 ? mid : fast
    path.moveTo(px, py)
    path.lineTo(p.x, p.y)
  }

  ctx.lineCap = 'round'
  ctx.lineWidth = 1.15
  ctx.strokeStyle = 'rgba(96, 186, 255, 0.5)'
  ctx.stroke(slow)
  ctx.strokeStyle = 'rgba(214, 240, 255, 0.66)'
  ctx.stroke(mid)
  ctx.lineWidth = 1.35
  ctx.strokeStyle = 'rgba(255, 206, 112, 0.82)'
  ctx.stroke(fast)
}

/* ---------------- 地图初始化 ---------------- */
onMounted(() => {
  canvas = fxRef.value ?? null
  if (!canvas) return
  ctx = canvas.getContext('2d')

  map = new Map({
    target: container.value!,
    layers: [createBasemap()],
    view: new View({ center: HOME, zoom: homeZoom, minZoom: 3, maxZoom: 12 }),
    controls: [],
  })

  const onMoveEnd = () => {
    rebuildGrid()
    if (ctx && canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }
  map.on('moveend', onMoveEnd)

  // 首帧等底图渲染完再建网格
  map.once('rendercomplete', () => {
    rebuildGrid()
    resetParticles()
    lastT = performance.now()
    raf = requestAnimationFrame(frame)
  })

  window.addEventListener('resize', onResize)
})

let resizeTimer = 0
function onResize() {
  window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(() => {
    rebuildGrid()
  }, 220)
}

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.clearTimeout(resizeTimer)
  window.removeEventListener('resize', onResize)
  map?.setTarget(undefined)
  map = null
})

/* ---------------- 交互 ---------------- */
function setBasemap(id: string) {
  applyBasemap(id)
  // 底图切换会重绘，重建一次网格保证粒子与地图对齐
  window.setTimeout(rebuildGrid, 120)
}

function togglePlay() {
  playing.value = !playing.value
}

function applyCount() {
  resetParticles()
}

/** 图例：风速分档 */
const legend = computed(() => [
  { label: '< 6', color: 'rgba(96,186,255,0.9)' },
  { label: '6–13', color: 'rgba(206,236,255,0.95)' },
  { label: '> 13', color: 'rgba(255,214,128,0.95)' },
])
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="ol-container"></div>
    <canvas ref="fxRef" class="fx-layer"></canvas>

    <MapControls
      :basemaps="OL_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="setBasemap"
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="panel">
      <div class="title">
        <span class="dot" :class="{ live: playing }"></span>
        全球风场 · 粒子流
      </div>
      <div class="sub">{{ particles.length }} 个粒子 · {{ GW }}×{{ GH }} 风场网格</div>

      <div class="row">
        <button class="btn primary" @click="togglePlay">{{ playing ? '暂停' : '继续' }}</button>
        <button class="btn" @click="resetParticles">重生粒子</button>
      </div>

      <div class="ctrl">
        <span class="lab">粒子</span>
        <input
          v-model.number="count"
          type="range"
          min="800"
          max="9000"
          step="200"
          @change="applyCount"
        />
        <b>{{ (count / 1000).toFixed(1) }}k</b>
      </div>
      <div class="ctrl">
        <span class="lab">风速</span>
        <input v-model.number="speedScale" type="range" min="0.3" max="2.6" step="0.1" />
        <b>{{ speedScale.toFixed(1) }}×</b>
      </div>

      <label class="check">
        <input v-model="showFlow" type="checkbox" />
        <span>显示风场</span>
        <span class="fps">{{ fps }} FPS</span>
      </label>

      <div class="legend">
        <span class="lg-title">风速 m/s</span>
        <span v-for="l in legend" :key="l.label" class="lg-item">
          <i :style="{ background: l.color }"></i>{{ l.label }}
        </span>
      </div>

      <div class="tip">
        风场由「西风急流 + 4 个涡旋 + 低频扰动」程序化合成；粒子在屏幕空间沿插值风矢量移动，
        用 destination-out 逐帧擦除形成拖尾。拖动地图后网格自动重建。
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
.ol-container {
  position: absolute;
  inset: 0;
}
.fx-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 5;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 22;
  width: 268px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(11, 17, 25, 0.84);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(10px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
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
  font-size: 11px;
  color: #7d8fa2;
}
.row {
  display: flex;
  gap: 7px;
  margin-top: 10px;
}
.btn {
  flex: 1;
  padding: 6px 0;
  font-size: 11.5px;
  border-radius: 7px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(24, 33, 44, 0.9);
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
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 11px;
  color: #93a5b8;
}
.ctrl .lab {
  width: 26px;
  flex: none;
}
.ctrl input {
  flex: 1;
  height: 3px;
  accent-color: #61b6ff;
}
.ctrl b {
  width: 32px;
  text-align: right;
  color: #cfe0f2;
  font-variant-numeric: tabular-nums;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 11.5px;
  color: #a9bccf;
  cursor: pointer;
}
.check input {
  accent-color: #61b6ff;
}
.check .fps {
  margin-left: auto;
  font-size: 10.5px;
  color: #7ee787;
  font-variant-numeric: tabular-nums;
}
.legend {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.26);
  font-size: 10.5px;
  color: #8496a8;
}
.lg-title {
  color: #6f8296;
}
.lg-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.lg-item i {
  width: 12px;
  height: 3px;
  border-radius: 2px;
}
.tip {
  margin-top: 8px;
  font-size: 10.5px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
