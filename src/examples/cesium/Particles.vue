<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import {
  VIEWER_OPTIONS,
  enableTerrainScene,
  useCesiumBasemap,
  useCesiumView,
  waitRealTerrain,
  sampleGroundHeight,
} from './useCesium'

/**
 * 粒子系统（ParticleSystem）
 *
 * 三个场景共用一套控制：火炬（火焰 + 黑烟）、喷泉（球形发射器）、烟羽（锥形发射器）。
 * 要点：
 *  - 一个 ParticleSystem 只有一种颜色/速度/寿命曲线，火焰那种层次要用多个系统叠加；
 *  - gravity 是世界坐标，想要「垂直下落」得先求当地法线，不能直接写 (0,0,-9.8)；
 *  - 贴图用 canvas 现场画（径向渐变），不依赖任何外部图片资源。
 */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 121.845
const LAT = 29.912

const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.00181, 110),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-14), roll: 0 },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

/* ---------------- 参数 ---------------- */

type Scene = 'flare' | 'fountain' | 'plume'
type Shape = 'circle' | 'sphere' | 'cone' | 'box'

const scene = ref<Scene>('flare')
const shape = ref<Shape>('circle')
const rate = ref(320)
const scale = ref(1)
const life = ref(1.4)
const wind = ref(6)
const paused = ref(false)
const fps = ref(0)

const SCENES: Array<{ id: Scene; label: string }> = [
  { id: 'flare', label: '火炬' },
  { id: 'fountain', label: '喷泉' },
  { id: 'plume', label: '烟羽' },
]
const SHAPES: Array<{ id: Shape; label: string }> = [
  { id: 'circle', label: '圆形' },
  { id: 'sphere', label: '球形' },
  { id: 'cone', label: '锥形' },
  { id: 'box', label: '立方' },
]

const sceneTip = computed(
  () =>
    ({
      flare: '火炬 = 火核 + 火焰 + 黑烟三个系统叠加：单个系统只有一条颜色/速度曲线，做不出层次。',
      fountain: '球形发射器向上抛，重力取当地法线反方向；风速直接叠加到 gravity 的水平分量。',
      plume: '锥形发射器的方向是局部 -Z，配 modelMatrix 指向天空就是一股上升烟柱。',
    })[scene.value],
)

/* ---------------- 贴图：canvas 现场画 ---------------- */

const softSprite = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  rg.addColorStop(0, 'rgba(255,255,255,1)')
  rg.addColorStop(0.35, 'rgba(255,255,255,0.75)')
  rg.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = rg
  g.fillRect(0, 0, 64, 64)
  return c.toDataURL()
})()

/** 烟用：随机扰动边缘，避免规则圆看起来像贴纸 */
const smokeSprite = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  for (let i = 0; i < 26; i++) {
    const r = 8 + Math.random() * 16
    const x = 20 + Math.random() * 24
    const y = 20 + Math.random() * 24
    const rg = g.createRadialGradient(x, y, 0, x, y, r)
    rg.addColorStop(0, 'rgba(255,255,255,0.42)')
    rg.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = rg
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
  return c.toDataURL()
})()

/* ---------------- 场景数据 ---------------- */

interface Site {
  lon: number
  lat: number
  ground: number
  up: Cesium.Cartesian3
  east: Cesium.Cartesian3
  north: Cesium.Cartesian3
}

const sites: Record<string, Site> = {}

async function makeSite(lon: number, lat: number): Promise<Site> {
  const ground = viewer ? await sampleGroundHeight(viewer, lon, lat) : 0
  const cart = Cesium.Cartesian3.fromDegrees(lon, lat, ground)
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(cart, new Cesium.Cartesian3())
  const east = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, up, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  const north = Cesium.Cartesian3.cross(up, east, new Cesium.Cartesian3())
  return { lon, lat, ground, up, east, north }
}

/** 世界坐标重力 = 竖直向下 + 顺风水平分量（ParticleSystem 的 gravity 是世界向量） */
function gravityAt(s: Site, g = 9.8): Cesium.Cartesian3 {
  const az = Cesium.Math.toRadians(58)
  const dir = Cesium.Cartesian3.add(
    Cesium.Cartesian3.multiplyByScalar(s.east, Math.cos(az), new Cesium.Cartesian3()),
    Cesium.Cartesian3.multiplyByScalar(s.north, Math.sin(az), new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  const down = Cesium.Cartesian3.multiplyByScalar(s.up, -g, new Cesium.Cartesian3())
  return Cesium.Cartesian3.add(down, Cesium.Cartesian3.multiplyByScalar(dir, wind.value, new Cesium.Cartesian3()), new Cesium.Cartesian3())
}

/**
 * Cesium 的 ParticleSystem 没有 gravity 选项，重力得自己在 updateCallback 里加：
 * 每帧把「重力加速度 × dt」叠到粒子速度上。position / velocity 都是世界坐标。
 */
const forces = new Map<string, Cesium.Cartesian3>()
const scratch = new Cesium.Cartesian3()

function updater(key: string) {
  return (particle: Cesium.Particle, dt: number) => {
    const g = forces.get(key)
    if (!g || !dt) return
    Cesium.Cartesian3.multiplyByScalar(g, dt, scratch)
    particle.velocity = Cesium.Cartesian3.add(particle.velocity, scratch, particle.velocity)
  }
}

function emitterOf(kind: Shape): Cesium.ParticleEmitter {
  switch (kind) {
    case 'sphere':
      return new Cesium.SphereEmitter(2.4)
    case 'cone':
      return new Cesium.ConeEmitter(Cesium.Math.toRadians(18))
    case 'box':
      return new Cesium.BoxEmitter(new Cesium.Cartesian3(6, 6, 0.4))
    default:
      return new Cesium.CircleEmitter(2.2)
  }
}

/* ---------------- 三个粒子系统 ---------------- */

const systems = new Map<string, Cesium.ParticleSystem>()

function destroySystems() {
  if (!viewer) return
  for (const s of systems.values()) {
    viewer.scene.primitives.remove(s)
    s.destroy()
  }
  systems.clear()
}

function buildSystems() {
  if (!viewer) return
  destroySystems()
  const v = viewer

  const flare = sites.flare
  const fountain = sites.fountain
  const plume = sites.plume
  if (!flare || !fountain || !plume) return

  const at = (s: Site, h: number) =>
    Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.ground + h))

  // 1) 火核：亮黄白，速度快、寿命短、尺寸小
  const core = v.scene.primitives.add(
    new Cesium.ParticleSystem({
      image: softSprite,
      imageSize: new Cesium.Cartesian2(16, 16),
      startColor: Cesium.Color.fromCssColorString('#fffbe6').withAlpha(0.95),
      endColor: Cesium.Color.fromCssColorString('#ff9a2e').withAlpha(0),
      startScale: 0.9 * scale.value,
      endScale: 0.25 * scale.value,
      minimumParticleLife: 0.35,
      maximumParticleLife: 0.7,
      minimumSpeed: 5,
      maximumSpeed: 11,
      emissionRate: rate.value,
      emitter: emitterOf(shape.value),
      lifetime: Number.POSITIVE_INFINITY,
      modelMatrix: at(flare, 46),
      updateCallback: updater('core'),
    }),
  )

  // 2) 火焰：橙红，向上窜
  const flame = v.scene.primitives.add(
    new Cesium.ParticleSystem({
      image: softSprite,
      imageSize: new Cesium.Cartesian2(34, 34),
      startColor: Cesium.Color.fromCssColorString('#ffb43c').withAlpha(0.8),
      endColor: Cesium.Color.fromCssColorString('#e2451a').withAlpha(0),
      startScale: 1.2 * scale.value,
      endScale: 2.6 * scale.value,
      minimumParticleLife: life.value * 0.7,
      maximumParticleLife: life.value * 1.3,
      minimumSpeed: 7,
      maximumSpeed: 15,
      emissionRate: rate.value * 0.55,
      emitter: emitterOf(shape.value),
      lifetime: Number.POSITIVE_INFINITY,
      modelMatrix: at(flare, 47),
      updateCallback: updater('flame'),
    }),
  )

  // 3) 黑烟：慢、大、寿命长
  const smoke = v.scene.primitives.add(
    new Cesium.ParticleSystem({
      image: softSprite,
      imageSize: new Cesium.Cartesian2(26, 26),
      startColor: Cesium.Color.fromCssColorString('#9aa3ab').withAlpha(0.22),
      endColor: Cesium.Color.fromCssColorString('#3c434a').withAlpha(0),
      startScale: 0.9 * scale.value,
      endScale: 3.4 * scale.value,
      minimumParticleLife: 3.2,
      maximumParticleLife: 5.6,
      minimumSpeed: 6,
      maximumSpeed: 10,
      emissionRate: rate.value * 0.22,
      emitter: emitterOf(shape.value),
      lifetime: Number.POSITIVE_INFINITY,
      modelMatrix: at(flare, 50),
      updateCallback: updater('smoke'),
    }),
  )

  // 4) 喷泉：球形发射 + 重力下落 + 落地即消（寿命短）
  const fountainSys = v.scene.primitives.add(
    new Cesium.ParticleSystem({
      image: softSprite,
      imageSize: new Cesium.Cartesian2(14, 14),
      startColor: Cesium.Color.fromCssColorString('#cfefff').withAlpha(0.9),
      endColor: Cesium.Color.fromCssColorString('#4aa8ff').withAlpha(0),
      startScale: 0.8 * scale.value,
      endScale: 0.5 * scale.value,
      minimumParticleLife: 1.1,
      maximumParticleLife: 1.9,
      minimumSpeed: 16,
      maximumSpeed: 26,
      emissionRate: rate.value * 0.7,
      emitter: new Cesium.SphereEmitter(1.4),
      lifetime: Number.POSITIVE_INFINITY,
      modelMatrix: at(fountain, 6),
      updateCallback: updater('fountain'),
    }),
  )

  // 5) 烟羽：锥形发射器朝上，一股持续的工业烟柱
  const plumeSys = v.scene.primitives.add(
    new Cesium.ParticleSystem({
      image: softSprite,
      imageSize: new Cesium.Cartesian2(30, 30),
      startColor: Cesium.Color.fromCssColorString('#e2eaf2').withAlpha(0.2),
      endColor: Cesium.Color.fromCssColorString('#7b8794').withAlpha(0),
      startScale: 0.7 * scale.value,
      endScale: 3.0 * scale.value,
      minimumParticleLife: 4,
      maximumParticleLife: 7,
      minimumSpeed: 12,
      maximumSpeed: 20,
      emissionRate: rate.value * 0.45,
      emitter: emitterOf(shape.value === 'circle' ? 'cone' : shape.value),
      lifetime: Number.POSITIVE_INFINITY,
      modelMatrix: at(plume, 22),
      updateCallback: updater('plume'),
    }),
  )

  // 热浮力用负重力表现（火焰往上窜），喷泉用真实重力往下落
  forces.set('core', gravityAt(flare, 3.2))
  forces.set('flame', gravityAt(flare, -1.2))
  forces.set('smoke', gravityAt(flare, -0.6))
  forces.set('fountain', gravityAt(fountain, 9.8))
  forces.set('plume', gravityAt(plume, 0.4))

  systems.set('core', core)
  systems.set('flame', flame)
  systems.set('smoke', smoke)
  systems.set('fountain', fountainSys)
  systems.set('plume', plumeSys)
  applyVisibility()
}

/** 当前场景只留该系统，其余 show=false（销毁重建代价大） */
function applyVisibility() {
  const s = scene.value
  const on = (k: string) => s === 'flare' ? k === 'core' || k === 'flame' || k === 'smoke' : s === 'fountain' ? k === 'fountain' : k === 'plume'
  for (const [k, sys] of systems) {
    sys.show = on(k) && !paused.value
  }
}

/** 滑块直接改实例属性，不必重建（ParticleSystem 每帧读取这些值） */
function applyTuning() {
  for (const [k, sys] of systems) {
    sys.emissionRate = k === 'smoke' ? rate.value * 0.22 : k === 'fountain' ? rate.value * 0.7 : k === 'plume' ? rate.value * 0.45 : k === 'flame' ? rate.value * 0.55 : rate.value
    sys.startScale = (k === 'smoke' ? 1.4 : k === 'plume' ? 1.1 : k === 'flame' ? 1.2 : k === 'core' ? 0.9 : 0.8) * scale.value
    if (k === 'flame' || k === 'core') sys.minimumParticleLife = life.value * (k === 'core' ? 0.25 : 0.7)
  }
  // 风力改的是「世界重力向量」的水平分量，所以只要换掉受力表里的向量
  if (sites.flare) {
    forces.set('core', gravityAt(sites.flare, 3.2))
    forces.set('flame', gravityAt(sites.flare, -1.2))
    forces.set('smoke', gravityAt(sites.flare, -0.6))
  }
  if (sites.fountain) forces.set('fountain', gravityAt(sites.fountain, 9.8))
  if (sites.plume) forces.set('plume', gravityAt(sites.plume, 0.4))
}

/* ---------------- 场地布景 ---------------- */

function buildSite() {
  if (!viewer) return
  const v = viewer
  const flare = sites.flare
  const fountain = sites.fountain
  const plume = sites.plume
  if (!flare || !fountain || !plume) return

  // 火炬塔：塔身 + 顶部平台
  v.entities.add({
    cylinder: {
      length: 46,
      topRadius: 1.1,
      bottomRadius: 2.4,
      material: Cesium.Color.fromCssColorString('#2c3238'),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString('#59636d'),
    },
    position: Cesium.Cartesian3.fromDegrees(flare.lon, flare.lat, flare.ground + 23),
  })
  v.entities.add({
    box: {
      dimensions: new Cesium.Cartesian3(9, 9, 1.4),
      material: Cesium.Color.fromCssColorString('#3b434b'),
    },
    position: Cesium.Cartesian3.fromDegrees(flare.lon, flare.lat, flare.ground + 46),
  })

  // 厂区：几个厂房盒子给个尺度参照
  const blocks: Array<[number, number, number, number]> = [
    [0.0016, -0.0006, 46, 18],
    [-0.0018, -0.0012, 38, 22],
    [0.0002, 0.0018, 30, 16],
  ]
  for (const [dLon, dLat, w, h] of blocks) {
    v.entities.add({
      box: {
        dimensions: new Cesium.Cartesian3(w, w * 0.7, h),
        material: Cesium.Color.fromCssColorString('#252c33'),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#454f59'),
      },
      position: Cesium.Cartesian3.fromDegrees(
        flare.lon + dLon,
        flare.lat + dLat,
        flare.ground + h / 2,
      ),
    })
  }

  // 喷泉基座、烟囱
  v.entities.add({
    cylinder: {
      length: 2,
      topRadius: 9,
      bottomRadius: 10,
      material: Cesium.Color.fromCssColorString('#2a3138'),
    },
    position: Cesium.Cartesian3.fromDegrees(fountain.lon, fountain.lat, fountain.ground + 1),
  })
  v.entities.add({
    cylinder: {
      length: 22,
      topRadius: 2.2,
      bottomRadius: 3.2,
      material: Cesium.Color.fromCssColorString('#333b42'),
    },
    position: Cesium.Cartesian3.fromDegrees(plume.lon, plume.lat, plume.ground + 11),
  })
}

/* ---------------- 监听 ---------------- */

watch(scene, () => {
  if (!viewer) return
  const target = scene.value === 'flare' ? sites.flare : scene.value === 'fountain' ? sites.fountain : sites.plume
  if (target) {
    // 火炬在 46 m 高，喷泉/烟囱贴着地面，机位要分开给
    const cfg =
      scene.value === 'flare'
        ? { d: 0.00181, up: 110, pitch: -14 }
        : { d: 0.0011, up: 62, pitch: -19 }
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(target.lon, target.lat - cfg.d, target.ground + cfg.up),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(cfg.pitch), roll: 0 },
      duration: 1.1,
    })
  }
  applyVisibility()
})
watch([rate, scale, life, wind], applyTuning)
watch(paused, applyVisibility)
watch(shape, () => {
  for (const [k, sys] of systems) {
    if (k === 'fountain') continue
    if (k === 'plume') sys.emitter = emitterOf(shape.value === 'circle' ? 'cone' : shape.value)
    else sys.emitter = emitterOf(shape.value)
  }
})

/* ---------------- 生命周期 ---------------- */

let stopTerrain: (() => void) | null = null
let timer = 0

onMounted(async () => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)
  viewer.camera.setView(home)
  // 关键：粒子是按 frameState.time 的增量推进的，时钟不走就一颗粒子都不发射
  viewer.clock.shouldAnimate = true
  viewer.scene.globe.enableLighting = false

  stopTerrain = enableTerrainScene(viewer)
  // enableTerrainScene 会打开大气与雾，夜景要在它之后再关掉
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false
  viewer.scene.globe.showGroundAtmosphere = false
  viewer.scene.fog.enabled = false
  await waitRealTerrain(viewer, 12000)

  sites.flare = await makeSite(LON, LAT)
  sites.fountain = await makeSite(LON + 0.0022, LAT - 0.0014)
  sites.plume = await makeSite(LON - 0.0026, LAT + 0.0012)

  if (viewer.isDestroyed()) return
  buildSite()
  buildSystems()

  let frames = 0
  const pre = viewer.scene.preRender.addEventListener(() => {
    frames++
  })
  timer = window.setInterval(() => {
    fps.value = frames * 2
    frames = 0
  }, 500)
  onBeforeUnmount(() => viewer?.scene.preRender.removeEventListener(pre))
})

onBeforeUnmount(() => {
  window.clearInterval(timer)
  if (stopTerrain) stopTerrain()
  destroySystems()
  forces.clear()
  for (const k of Object.keys(sites)) delete sites[k]
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
        <span class="dot" :class="{ live: !paused }"></span>
        粒子系统 · {{ SCENES.find((s) => s.id === scene)?.label }}
      </div>
      <div class="sub">发射率 {{ rate }} /s · {{ fps }} fps</div>

      <div class="row">
        <button
          v-for="s in SCENES"
          :key="s.id"
          class="chip"
          :class="{ on: scene === s.id }"
          @click="scene = s.id"
        >
          {{ s.label }}
        </button>
        <button class="chip" :class="{ on: !paused }" @click="paused = !paused">
          {{ paused ? '冻结' : '运行' }}
        </button>
      </div>

      <div class="row shapes">
        <span class="lab">发射器</span>
        <button
          v-for="s in SHAPES"
          :key="s.id"
          class="chip sm"
          :class="{ on: shape === s.id }"
          @click="shape = s.id"
        >
          {{ s.label }}
        </button>
      </div>

      <div class="ctrl">
        <span class="lab">发射率</span>
        <input v-model.number="rate" type="range" min="40" max="900" step="10" />
        <b>{{ rate }}<i>/s</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">粒子尺寸</span>
        <input v-model.number="scale" type="range" min="0.4" max="2.2" step="0.1" />
        <b>{{ scale.toFixed(1) }}<i>×</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">生命期</span>
        <input v-model.number="life" type="range" min="0.6" max="3.2" step="0.1" />
        <b>{{ life.toFixed(1) }}<i>s</i></b>
      </div>
      <div class="ctrl">
        <span class="lab">风速</span>
        <input v-model.number="wind" type="range" min="0" max="22" step="1" />
        <b>{{ wind }}<i>m/s</i></b>
      </div>

      <div class="tip">{{ sceneTip }}</div>
      <div class="tip dim">
        贴图是 canvas 画的径向渐变（数据 URL），没有外部图片依赖；重力是世界向量，
        竖直向下要先求当地法线 <code>Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal</code>。
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
  background: rgba(10, 15, 22, 0.9);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.42);
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
  background: #ffb454;
  box-shadow: 0 0 9px #ffb454;
}
.sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: #7d8fa2;
  font-family: ui-monospace, monospace;
}
.row {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}
.shapes {
  align-items: center;
  margin-top: 7px;
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
.chip.sm {
  padding: 2px 7px;
  font-size: 10.5px;
}
.chip:hover {
  border-color: rgba(255, 180, 84, 0.55);
  color: #ffe9cc;
}
.chip.on {
  color: #1a1108;
  background: #ffb454;
  border-color: #ffb454;
  font-weight: 600;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.lab {
  flex: 0 0 56px;
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
  background: #ffb454;
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
.tip {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.24);
  font-size: 10.5px;
  line-height: 1.6;
  color: #8b9aaa;
}
.tip.dim {
  margin-top: 5px;
  padding-top: 0;
  border-top: 0;
  color: #74838f;
}
.tip code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 180, 84, 0.1);
  color: #e8bf86;
  font-size: 10px;
}
</style>
