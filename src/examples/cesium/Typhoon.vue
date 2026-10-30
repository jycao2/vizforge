<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

/* ============================================================
 * 台风路径与风圈
 *  - 路径：Catmull-Rom 样条插值出 37 个 6 小时时次，强度先增强后减弱
 *  - 风圈：7 / 10 / 12 级三层椭圆，半径随强度用 CallbackProperty 逐帧变化
 *  - 螺旋云系：Canvas 程序化绘制的四臂螺旋 billboard，持续自转
 *  - 时间轴：播放 / 暂停 / 倍速，已走路径按进度动态生长
 * ============================================================ */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

/* ---------------- 台风数据 ---------------- */
interface WP {
  t: number // 起报后小时数
  lon: number
  lat: number
  p: number // 中心气压 hPa
  w: number // 最大风速 m/s
  r7: number // 七级风圈 km
  r10: number
  r12: number
}

/** 控制点：菲律宾以东生成 → 西北行 → 登陆闽浙 → 北上入东海 */
const CTRL: Array<[number, number]> = [
  [142.5, 12.5],
  [139.0, 14.2],
  [134.5, 16.4],
  [130.2, 18.6],
  [126.8, 21.0],
  [124.2, 23.6],
  [122.4, 26.2],
  [121.3, 28.9],
  [121.6, 31.6],
  [123.2, 34.2],
  [126.0, 36.6],
  [129.8, 38.8],
  [134.0, 40.6],
  [139.0, 42.0],
]

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

function buildPath(): WP[] {
  const N = 36 // 时次数量
  const out: WP[] = []
  const seg = CTRL.length - 1
  for (let i = 0; i <= N; i++) {
    const u = i / N
    const g = u * seg
    const k = Math.min(seg - 1, Math.floor(g))
    const t = g - k
    const p0 = CTRL[Math.max(0, k - 1)]
    const p1 = CTRL[k]
    const p2 = CTRL[k + 1]
    const p3 = CTRL[Math.min(seg, k + 2)]
    const lon = catmull(p0[0], p1[0], p2[0], p3[0], t)
    const lat = catmull(p0[1], p1[1], p2[1], p3[1], t)

    // 强度：前期增强、登陆后减弱
    const peak = Math.exp(-Math.pow((u - 0.52) / 0.3, 2))
    const w = 15 + 48 * peak
    const p = Math.round(1010 - (w - 15) * 1.6)
    const r7 = Math.round(110 + 9.5 * (w - 15))
    out.push({
      t: i * 6,
      lon,
      lat,
      p,
      w: Math.round(w),
      r7,
      r10: Math.round(r7 * 0.52),
      r12: Math.round(r7 * 0.27),
    })
  }
  return out
}
const PATH = buildPath()

/** 中国台风等级 */
function gradeOf(w: number) {
  if (w >= 51) return { name: '超强台风', color: '#ff3b5c' }
  if (w >= 42) return { name: '强台风', color: '#ff8c1a' }
  if (w >= 33) return { name: '台风', color: '#ffd23f' }
  if (w >= 25) return { name: '强热带风暴', color: '#4fc3f7' }
  if (w >= 17) return { name: '热带风暴', color: '#4ade80' }
  return { name: '热带低压', color: '#9aa7b4' }
}

/* ---------------- 状态 ---------------- */
const playing = ref(true)
const speedFactor = ref(1)
const showCircles = ref(true)
const cloudGrow = ref(true)
let prog = 0 // 0..1
let spin = 0 // 云系自转角（弧度）
let baseCloud: HTMLCanvasElement | null = null
let cloudMaterial: Cesium.Material | null = null
let cloudPrimitive: Cesium.Primitive | null = null
let lastCloudRebuild = 0

const home = {
  destination: Cesium.Cartesian3.fromDegrees(125.0, 18.5, 2500000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-62), roll: 0 },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

/** 当前时次（用于面板显示） */
const info = ref({
  time: '',
  lon: 0,
  lat: 0,
  p: 0,
  w: 0,
  r7: 0,
  r10: 0,
  r12: 0,
  grade: gradeOf(30),
})

function idxOf() {
  return Math.min(PATH.length - 1, Math.max(0, Math.round(prog * (PATH.length - 1))))
}

function timeLabel(h: number): string {
  const base = Date.UTC(2026, 8, 12, 6, 0, 0) // 9 月 12 日 14 时（东八区）
  const d = new Date(base + h * 3600 * 1000)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  return `${mm}/${dd} ${hh}时`
}

/** 当前位置（经纬度插值） */
function currentLonLat(): { lon: number; lat: number } {
  const f = Math.max(0, Math.min(1, prog)) * (PATH.length - 1)
  const i = Math.max(0, Math.min(PATH.length - 2, Math.floor(f)))
  const t = f - i
  const a = PATH[i]
  const b = PATH[i + 1]
  return { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t }
}

/** 位置插值（世界坐标） */
function currentPosition(): Cesium.Cartesian3 {
  const c = currentLonLat()
  return Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 4000)
}

/* ---------------- 螺旋云系贴图 ---------------- */
function typhoonSprite(): HTMLCanvasElement {
  const size = 800
  const R = size / 2
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const g = cv.getContext('2d')!
  const img = g.createImageData(size, size)
  const data = img.data

  /* ---------- 值噪声 + fBm ---------- */
  const hash2 = (x: number, y: number) => {
    let h = (x * 374761393 + y * 668265263) | 0
    h = (h ^ (h >>> 13)) | 0
    h = Math.imul(h, 1274126177) | 0
    h = (h ^ (h >>> 16)) | 0
    return (h >>> 0) / 4294967296
  }
  const vnoise = (x: number, y: number) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const fx = x - xi
    const fy = y - yi
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    const c00 = hash2(xi, yi)
    const c10 = hash2(xi + 1, yi)
    const c01 = hash2(xi, yi + 1)
    const c11 = hash2(xi + 1, yi + 1)
    const a0 = c00 + (c10 - c00) * ux
    const a1 = c01 + (c11 - c01) * ux
    return a0 + (a1 - a0) * uy
  }
  const fbm = (x: number, y: number) => {
    let v = 0
    let amp = 0.55
    let fx = x
    let fy = y
    for (let o = 0; o < 4; o++) {
      v += vnoise(fx, fy) * amp
      fx = fx * 2.03 + 17.1
      fy = fy * 2.03 + 9.7
      amp *= 0.5
    }
    return v
  }
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
  const smooth = (e0: number, e1: number, x: number) => {
    const t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)
  }

  /* ---------- 逐像素生成云场 ---------- */
  const eyeR = 0.075
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const dx = (px + 0.5 - R) / R
      const dy = (py + 0.5 - R) / R
      const r = Math.hypot(dx, dy)
      const idx = (py * size + px) * 4
      if (r > 1) continue

      const theta = Math.atan2(dy, dx)
      // 对数螺旋：同一角度上半径越大越"后" → 云带自然卷曲成旋臂
      const spiral = theta + Math.log(Math.max(r, 0.03)) * 2.4

      const bands = fbm(spiral * 1.35 + 11.3, r * 2.6)
      const detail = fbm(spiral * 4.6 + 3.2, r * 7.5 + 21.7)

      // 径向廓线：内圈密蔽云区，外圈逐渐散开
      const radial = 1 - smooth(0.15, 1.0, r)
      // 眼区：中心留一个干净的风眼
      const eye = smooth(eyeR * 0.7, eyeR * 2.2, r)

      let dens = (bands * 0.74 + detail * 0.26) * (0.35 + 0.9 * radial) * eye
      dens = smooth(0.3, 0.64, dens) * 0.98
      // 眼壁：紧贴风眼的一圈最厚
      const wall = smooth(eyeR * 0.8, eyeR * 1.7, r) * (1 - smooth(eyeR * 1.7, eyeR * 3.4, r))
      dens = clamp01(dens + wall * 0.55)

      const alpha = dens * 255
      data[idx] = 250
      data[idx + 1] = 253
      data[idx + 2] = 255
      data[idx + 3] = alpha
    }
  }
  g.putImageData(img, 0, 0)

  // 风眼：中心压暗成空洞
  const eyeGrad = g.createRadialGradient(R, R, 0, R, R, R * eyeR * 1.15)
  eyeGrad.addColorStop(0, 'rgba(6,12,20,0.92)')
  eyeGrad.addColorStop(0.62, 'rgba(8,14,22,0.72)')
  eyeGrad.addColorStop(1, 'rgba(10,18,28,0)')
  g.fillStyle = eyeGrad
  g.beginPath()
  g.arc(R, R, R * eyeR * 1.15, 0, Math.PI * 2)
  g.fill()

  // 圆形收边：内容只占 82% 半径，外层留足透明缓冲。
  // 贴图会被 mipmap 缩小，边缘一旦有一点不透明，整块方影就会浮在地图上。
  g.globalCompositeOperation = 'destination-in'
  const mask = g.createRadialGradient(R, R, 0, R, R, R)
  mask.addColorStop(0, 'rgba(0,0,0,1)')
  mask.addColorStop(0.56, 'rgba(0,0,0,1)')
  mask.addColorStop(0.7, 'rgba(0,0,0,0.55)')
  mask.addColorStop(0.8, 'rgba(0,0,0,0.12)')
  mask.addColorStop(0.84, 'rgba(0,0,0,0)')
  g.fillStyle = mask
  g.fillRect(0, 0, size, size)
  g.globalCompositeOperation = 'source-over'

  return cv
}

/* ---------------- 运行时引用 ---------------- */
const circles: Cesium.Entity[] = []
let raf = 0
let last = performance.now()

/* ---------------- 场景搭建 ---------------- */
onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)

  const pathPositions = PATH.map((w) => Cesium.Cartesian3.fromDegrees(w.lon, w.lat, 3000))

  // 1) 完整路径（预测轨迹，暗色虚线）
  viewer.entities.add({
    polyline: {
      positions: pathPositions,
      width: 2,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString('#8fa7c0').withAlpha(0.55),
        dashLength: 12,
      }),
      arcType: Cesium.ArcType.GEODESIC,
    },
  })

  // 2) 已走路径：随进度生长
  viewer.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => {
        const n = Math.max(2, idxOf() + 1)
        return pathPositions.slice(0, n)
      }, false),
      width: 4,
      material: new Cesium.PolylineGlowMaterialProperty({
        color: Cesium.Color.fromCssColorString('#41d1ff'),
        glowPower: 0.22,
      }),
      arcType: Cesium.ArcType.GEODESIC,
    },
  })

  // 3) 关键时次点位 + 时间标签
  PATH.forEach((w, i) => {
    if (i % 3 !== 0) return
    const isKey = i % 6 === 0
    viewer!.entities.add({
      position: Cesium.Cartesian3.fromDegrees(w.lon, w.lat, 3000),
      point: {
        pixelSize: isKey ? 6 : 4,
        color: Cesium.Color.fromCssColorString('#9fe8ff'),
        outlineColor: Cesium.Color.fromCssColorString('#0b1a26'),
        outlineWidth: 1.4,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: timeLabel(w.t),
        font: '500 11px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#c9e6f7'),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0b1a26').withAlpha(0.72),
        backgroundPadding: new Cesium.Cartesian2(6, 3),
        pixelOffset: new Cesium.Cartesian2(0, -16),
        scale: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6.0e6),
      },
    })
  })

  // 4) 三层风圈（7 / 10 / 12 级）
  const ringDefs = [
    { key: 'r7' as const, color: '#ffd23f', alpha: 0.07, line: 0.55 },
    { key: 'r10' as const, color: '#ff8c1a', alpha: 0.1, line: 0.7 },
    { key: 'r12' as const, color: '#ff3b5c', alpha: 0.14, line: 0.85 },
  ]
  ringDefs.forEach((def) => {
    const ent = viewer!.entities.add({
      position: new Cesium.CallbackPositionProperty(() => currentPosition(), false),
      ellipse: {
        semiMajorAxis: new Cesium.CallbackProperty(() => PATH[idxOf()][def.key] * 1000, false),
        semiMinorAxis: new Cesium.CallbackProperty(() => PATH[idxOf()][def.key] * 1000, false),
        height: 2000,
        material: Cesium.Color.fromCssColorString(def.color).withAlpha(def.alpha),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(def.color).withAlpha(def.line),
        outlineWidth: 1.5,
        show: showCircles.value,
      },
    })
    circles.push(ent)
  })

  // 5) 螺旋云系：EllipseGeometry + 自定义材质
  // RectangleGraphics.stRotation 会旋转整个 UV，矩形四边采样越界后被 REPEAT，整块方影会显出来。
  // 这里用 Primitive 直接挂 Material，在 shader 里转 UV 并套圆形遮罩，同时关掉 mipmap，
  // 边缘不会被平均成半透明薄膜。
  const sprite = typhoonSprite()
  baseCloud = sprite
  cloudMaterial = new Cesium.Material({
    fabric: {
      uniforms: {
        image: sprite.toDataURL(),
        uSpin: 0,
      },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          vec2 uv = materialInput.st - 0.5;
          float s = sin(uSpin);
          float c = cos(uSpin);
          vec2 ruv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
          vec4 col = texture(image, clamp(ruv, 0.004, 0.996));
          float rr = length(uv) * 2.0;
          material.diffuse = col.rgb;
          material.alpha = col.a * (1.0 - smoothstep(0.9, 0.99, rr));
          return material;
        }`,
    },
    translucent: true,
    minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
  })
  rebuildCloudPrimitive()

  // 6) 台风中心标记
  viewer.entities.add({
    position: new Cesium.CallbackPositionProperty(() => currentPosition(), false),
    point: {
      pixelSize: 9,
      color: Cesium.Color.fromCssColorString('#fff2f4'),
      outlineColor: Cesium.Color.fromCssColorString('#ff3b5c'),
      outlineWidth: 2.4,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  })

  viewer.camera.setView(home)
  viewer.scene.globe.enableLighting = false
  tick(performance.now())
})

/**
 * 云系挂在 Primitive 上（Entity 的 material 只收 MaterialProperty，自定义 fabric 挂不上去）。
 * 台风一直在移动，所以每 250ms 重建一次几何；材质本身只改 uSpin，不重建。
 */
function rebuildCloudPrimitive() {
  if (!viewer || !cloudMaterial) return
  if (cloudPrimitive) {
    viewer.scene.primitives.remove(cloudPrimitive)
    cloudPrimitive = null
  }
  const c = currentLonLat()
  const r7 = PATH[idxOf()].r7
  const radius = (cloudGrow.value ? 380000 + r7 * 620 : 640000) * 1
  const geo = new Cesium.EllipseGeometry({
    center: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 4200),
    semiMajorAxis: radius,
    semiMinorAxis: radius * 0.94,
    vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
  })
  cloudPrimitive = viewer.scene.primitives.add(
    new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry: geo }),
      appearance: new Cesium.MaterialAppearance({
        material: cloudMaterial,
        translucent: true,
        flat: true,
      }),
      asynchronous: false,
      allowPicking: false,
    }),
  )
}

function tick(now: number) {
  raf = requestAnimationFrame(tick)
  const dt = Math.min(now - last, 80)
  last = now

  spin += (Math.max(0, dt) / 1000) * 0.14
  if (cloudMaterial) cloudMaterial.uniforms.uSpin = spin
  if (now - lastCloudRebuild > 600) {
    lastCloudRebuild = now
    rebuildCloudPrimitive()
  }

  if (playing.value) {
    prog += (Math.max(0, dt) / 1000) * 0.038 * speedFactor.value
    if (!Number.isFinite(prog) || prog > 1) prog = 0
    if (prog < 0) prog = 0
  }

  const wp = PATH[idxOf()]
  info.value = {
    time: timeLabel(wp.t),
    lon: wp.lon,
    lat: wp.lat,
    p: wp.p,
    w: wp.w,
    r7: wp.r7,
    r10: wp.r10,
    r12: wp.r12,
    grade: gradeOf(wp.w),
  }
}

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  viewer?.destroy()
  viewer = null
})

/* ---------------- 交互 ---------------- */
function setBasemap(id: string) {
  applyBasemap(id)
}
function togglePlay() {
  playing.value = !playing.value
}
function toggleCircles() {
  showCircles.value = !showCircles.value
  circles.forEach((e) => {
    if (e.ellipse) e.ellipse.show = new Cesium.ConstantProperty(showCircles.value)
  })
}
function restart() {
  prog = 0
}
function flyToTyphoon() {
  if (!viewer) return
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      PATH[idxOf()].lon - 3.2,
      PATH[idxOf()].lat - 6.5,
      900000,
    ),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-58), roll: 0 },
    duration: 1.6,
  })
}

const gradePercent = computed(() => Math.min(100, Math.max(0, ((info.value.w - 10) / 52) * 100)))
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>
    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="setBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="panel">
      <div class="title">
        <span class="dot" :class="{ live: playing }"></span>
        台风路径与风圈 · 西北太平洋
      </div>
      <div class="sub">{{ info.time }} · {{ info.grade.name }}</div>

      <div class="bar">
        <i :style="{ width: gradePercent + '%', background: info.grade.color }"></i>
      </div>

      <div class="grid">
        <div class="cell">
          <span class="k">中心气压</span>
          <b>{{ info.p }}<i>hPa</i></b>
        </div>
        <div class="cell">
          <span class="k">最大风速</span>
          <b>{{ info.w }}<i>m/s</i></b>
        </div>
        <div class="cell">
          <span class="k">位置</span>
          <b class="sm">{{ info.lon.toFixed(1) }}°E {{ info.lat.toFixed(1) }}°N</b>
        </div>
        <div class="cell">
          <span class="k">七级风圈</span>
          <b>{{ info.r7 }}<i>km</i></b>
        </div>
      </div>

      <div class="rings">
        <span><i style="background: #ffd23f"></i>7 级 {{ info.r7 }}km</span>
        <span><i style="background: #ff8c1a"></i>10 级 {{ info.r10 }}km</span>
        <span><i style="background: #ff3b5c"></i>12 级 {{ info.r12 }}km</span>
      </div>

      <div class="row">
        <button class="btn primary" @click="togglePlay">{{ playing ? '暂停' : '播放' }}</button>
        <button class="btn" @click="restart">重播</button>
        <button class="btn" @click="flyToTyphoon">跟随</button>
      </div>

      <div class="ctrl">
        <span class="lab">倍速</span>
        <input v-model.number="speedFactor" type="range" min="0.4" max="4" step="0.1" />
        <b>{{ speedFactor.toFixed(1) }}×</b>
      </div>

      <label class="check">
        <input :checked="showCircles" type="checkbox" @change="toggleCircles" />
        <span>风圈</span>
        <input v-model="cloudGrow" type="checkbox" />
        <span>云系随强度</span>
      </label>

      <div class="tip">
        路径由 Catmull-Rom 样条插值，强度峰值对应中心气压最低；三层风圈半径与中心风速线性相关，
        用 CallbackProperty 逐帧读取当前时次，所以拖动倍速时半径同步变化。
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
  z-index: 22;
  width: 292px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(11, 17, 25, 0.85);
  border: 1px solid rgba(88, 108, 132, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(10px);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.46);
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
  margin-top: 4px;
  font-size: 11.5px;
  color: #9fb4c8;
  font-variant-numeric: tabular-nums;
}
.bar {
  position: relative;
  height: 4px;
  margin-top: 8px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.09);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 0.2s linear, background 0.3s;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px 10px;
  margin-top: 10px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cell .k {
  font-size: 10.5px;
  color: #7d8fa2;
}
.cell b {
  font-size: 16px;
  font-weight: 600;
  color: #eaf3fb;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
}
.cell b i {
  margin-left: 3px;
  font-size: 10px;
  font-style: normal;
  color: #7d8fa2;
  font-weight: 400;
}
.cell b.sm {
  font-size: 13px;
  color: #b9d4ea;
}
.rings {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.26);
  font-size: 10.5px;
  color: #93a5b8;
}
.rings span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.rings i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  opacity: 0.9;
}
.row {
  display: flex;
  gap: 6px;
  margin-top: 9px;
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
  width: 34px;
  text-align: right;
  color: #cfe0f2;
  font-variant-numeric: tabular-nums;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
  font-size: 11.5px;
  color: #a9bccf;
  cursor: pointer;
}
.check input {
  accent-color: #61b6ff;
}
.check span:first-of-type {
  margin-right: 8px;
}
.tip {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid rgba(88, 108, 132, 0.26);
  font-size: 10.5px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
