<script setup lang="ts">
/**
 * 动态 Canvas 图层
 * ===========================================================================
 * 有些效果样式层做不了（雷达扫描、余晖拖尾、粒子流场），
 * 这时候最快的办法不是写 custom WebGL layer，而是**自己拿一张 2D canvas 盖在地图上**：
 *
 *  - 地理坐标 → 屏幕像素：`map.project([lng, lat])`，地图一动就重画；
 *  - 分辨率：canvas 的 width/height 要乘 devicePixelRatio，否则高分屏发虚；
 *  - 刷新时机：监听 `render`（地图每帧渲染都会触发）比自己开 rAF 更省，
 *    地图静止时不会空转；
 *  - 余晖：不清屏，而是每帧盖一层半透明背景，老像素逐渐变暗 —— 拖尾的经典做法。
 *
 * 本例画一个雷达站：扫描扇 + 同心距离圈 + 目标回波（带余晖拖尾）。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { Map as MbMap } from 'maplibre-gl'
import MapControls from '@/components/MapControls.vue'
import { mulberry32 } from './data'
import { createMap, useMapboxView } from './useMapbox'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
const trails = ref(true)
const targets = ref(28)
const info = ref('')
let map: MbMap | null = null
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null

const RADAR: [number, number] = [120.15, 30.26]
const HOME = { center: RADAR, zoom: 11 }
const { zoomBy, reset, toggleFullscreen } = useMapboxView(() => map, HOME)

interface Target {
  lng: number
  lat: number
  speed: number
  heading: number
  last: number
}
const fleet: Target[] = []
let sweep = 0

function build() {
  if (!map) return
  canvas = document.createElement('canvas')
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '5',
  } as Partial<CSSStyleDeclaration>)
  container.value!.appendChild(canvas)
  ctx = canvas.getContext('2d')

  resize()
  makeFleet()
  // 地图每帧渲染都会触发 render；静止时不触发，省电
  map.on('render', draw)
  map.on('resize', resize)
}

function resize() {
  if (!map || !canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = map.getCanvas().clientWidth
  const h = map.getCanvas().clientHeight
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function makeFleet() {
  const rnd = mulberry32(31)
  fleet.length = 0
  for (let i = 0; i < 40; i++) {
    const ang = rnd() * Math.PI * 2
    const r = 0.01 + rnd() * 0.055
    fleet.push({
      lng: RADAR[0] + Math.cos(ang) * r,
      lat: RADAR[1] + Math.sin(ang) * r * 0.72,
      speed: 0.00004 + rnd() * 0.00012,
      heading: rnd() * Math.PI * 2,
      last: -1,
    })
  }
}

function draw() {
  if (!map || !ctx || !canvas) return
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  sweep = (sweep + 0.012) % (Math.PI * 2)

  // 余晖：半透明覆盖而不是 clearRect，老像素慢慢暗下去形成拖尾
  if (trails.value) {
    ctx.fillStyle = 'rgba(7,12,20,0.14)'
    ctx.fillRect(0, 0, w, h)
  } else {
    ctx.clearRect(0, 0, w, h)
  }

  const c = map.project(RADAR)
  const edge = map.project([RADAR[0] + 0.06, RADAR[1]])
  const rPx = Math.abs(edge.x - c.x)

  // 距离圈
  ctx.strokeStyle = 'rgba(95,208,168,0.35)'
  ctx.lineWidth = 1
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath()
    ctx.arc(c.x, c.y, (rPx * i) / 4, 0, Math.PI * 2)
    ctx.stroke()
  }
  // 十字准线
  ctx.beginPath()
  ctx.moveTo(c.x - rPx, c.y)
  ctx.lineTo(c.x + rPx, c.y)
  ctx.moveTo(c.x, c.y - rPx)
  ctx.lineTo(c.x, c.y + rPx)
  ctx.stroke()

  // 扫描扇：用一个渐变扇形模拟余晖
  const grad = ctx.createConicGradient
    ? (ctx.createConicGradient(sweep, c.x, c.y) as CanvasGradient)
    : null
  ctx.beginPath()
  ctx.moveTo(c.x, c.y)
  ctx.arc(c.x, c.y, rPx, sweep - 0.55, sweep)
  ctx.closePath()
  if (grad) {
    grad.addColorStop(0, 'rgba(95,208,168,0.32)')
    grad.addColorStop(1, 'rgba(95,208,168,0)')
    ctx.fillStyle = grad
  } else {
    ctx.fillStyle = 'rgba(95,208,168,0.18)'
  }
  ctx.fill()
  // 扫描线
  ctx.strokeStyle = 'rgba(150,255,215,0.85)'
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(c.x, c.y)
  ctx.lineTo(c.x + Math.cos(sweep) * rPx, c.y + Math.sin(sweep) * rPx)
  ctx.stroke()

  // 目标回波：只有被扫描线扫过时点亮，之后逐渐衰减
  let visible = 0
  for (let i = 0; i < Math.min(targets.value, fleet.length); i++) {
    const t = fleet[i]
    t.heading += (Math.random() - 0.5) * 0.06
    t.lng += Math.cos(t.heading) * t.speed
    t.lat += Math.sin(t.heading) * t.speed * 0.72
    const p = map.project([t.lng, t.lat])
    const ang = Math.atan2(p.y - c.y, p.x - c.x)
    let d = sweep - ang
    while (d < 0) d += Math.PI * 2
    while (d > Math.PI * 2) d -= Math.PI * 2
    if (d < 0.12) t.last = performance.now()
    const age = (performance.now() - t.last) / 1600
    if (age > 1) continue
    visible++
    const alpha = Math.max(0, 1 - age)
    ctx.fillStyle = `rgba(255,209,102,${alpha.toFixed(3)})`
    ctx.beginPath()
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2)
    ctx.fill()
    // 速度矢量短线
    ctx.strokeStyle = `rgba(255,209,102,${(alpha * 0.6).toFixed(3)})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
    ctx.lineTo(p.x + Math.cos(t.heading) * 12, p.y + Math.sin(t.heading) * 12)
    ctx.stroke()
  }
  info.value = `扫描中 · 回波 ${visible} / ${Math.min(targets.value, fleet.length)}`
}

onMounted(() => {
  map = createMap(container.value!, { ...HOME })
  // style 是异步加载的：addSource/addLayer 必须等 load，否则抛 "Style is not done loading"
  map.once('load', build)
})

onBeforeUnmount(() => {
  canvas?.remove()
  map?.remove()
  map = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="mb-container"></div>
    <MapControls
      @zoom-in="zoomBy(1)"
      @zoom-out="zoomBy(-1)"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
    <div class="mb-panel ctrl">
      <h4>雷达扫描</h4>
      <label class="mb-row">
        <input v-model="trails" type="checkbox" />
        <span>余晖拖尾</span>
      </label>
      <label class="mb-row">
        <span>目标数</span>
        <input v-model.number="targets" type="range" min="4" max="40" step="2" />
        <b>{{ targets }}</b>
      </label>
      <div class="stat">{{ info }}</div>
    </div>
    <div class="mb-tip">自绘 2D canvas 叠在地图上 · map.project 做经纬度→像素换算</div>
  </div>
</template>

<style scoped>
.ctrl {
  top: 14px;
  left: 14px;
  width: 216px;
}
.mb-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
}
.mb-row input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: #4f9dff;
}
.mb-row b {
  width: 26px;
  text-align: right;
  color: #eaf2fb;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.stat {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: #eaf2fb;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
</style>
