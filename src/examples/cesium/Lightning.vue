<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import * as Cesium from 'cesium'
import type { Viewer } from 'cesium'
import { useCesiumView, VIEWER_OPTIONS } from './useCesium'
import { applyCesiumBasemap } from './basemaps'

/* ============================================================
 * 雷暴闪电（Cesium）
 *  - 云团：canvas 生成软云 → billboard 群，随机分布 + 缓慢漂移
 *  - 闪电：中点位移算法（递归细分，每层加垂直扰动）生成分形折线，
 *    主放电 + 若干分支；用 CallbackProperty 驱动「生成→闪 3 次→淡出」
 *  - 画面闪光：闪电峰值时抬升全屏白色遮罩的透明度，模拟照亮云层
 * ============================================================ */

const container = ref<HTMLDivElement>()
const viewerRef = shallowRef<Viewer | null>(null)
const DEFAULTS = { autoRate: 1.4, cloudOpacity: 0.5 } // 自动放电间隔（秒）/ 云层浓度
const autoRate = ref(DEFAULTS.autoRate)
const cloudOpacity = ref(DEFAULTS.cloudOpacity)
const flashRef = ref(0) // 0~1 由 JS 驱动
const strikeCount = ref(0)

const CENTER: [number, number] = [120.16, 30.27]

function getViewer() {
  return viewerRef.value
}

const { reset } = useCesiumView(getViewer, () => ({
  // 相机必须压在云层之下平视：从云顶俯视时整幅画面只会被云盖糊满，闪电全被挡住
  destination: Cesium.Cartesian3.fromDegrees(CENTER[0], CENTER[1] - 0.05, 460),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-6), roll: 0 },
  focus: {
    center: Cesium.Cartesian3.fromDegrees(CENTER[0], CENTER[1], 0),
    radius: 3500,
    range: 4200,
  },
}))

/* ---------------- 云贴图 ---------------- */
function cloudTexture(): string {
  const size = 256
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const ctx = cv.getContext('2d')!
  // 十几个随机软圆叠成一朵云
  for (let i = 0; i < 16; i++) {
    const x = size / 2 + (Math.random() - 0.5) * size * 0.55
    const y = size / 2 + (Math.random() - 0.5) * size * 0.42
    const r = size * (0.12 + Math.random() * 0.2)
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, 'rgba(196,206,224,0.55)')
    g.addColorStop(0.55, 'rgba(148,160,184,0.28)')
    g.addColorStop(1, 'rgba(110,124,150,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  return cv.toDataURL('image/png')
}

/* ---------------- 分形闪电 ---------------- */
function midDisplace(
  a: Cesium.Cartesian3,
  b: Cesium.Cartesian3,
  depth: number,
  roughness: number,
  out: Cesium.Cartesian3[],
) {
  if (depth <= 0) {
    out.push(b)
    return
  }
  const mid = Cesium.Cartesian3.midpoint(a, b, new Cesium.Cartesian3())
  const len = Cesium.Cartesian3.distance(a, b)
  // 垂直方向扰动：用与线段垂直的随机向量，越往深处扰动越小
  const dir = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )
  const up = new Cesium.Cartesian3(0, 0, 1)
  let perp = Cesium.Cartesian3.cross(dir, up, new Cesium.Cartesian3())
  if (Cesium.Cartesian3.magnitude(perp) < 1e-6) {
    perp = Cesium.Cartesian3.cross(dir, new Cesium.Cartesian3(1, 0, 0), new Cesium.Cartesian3())
  }
  Cesium.Cartesian3.normalize(perp, perp)
  const side = Cesium.Cartesian3.cross(dir, perp, new Cesium.Cartesian3())
  Cesium.Cartesian3.normalize(side, side)

  const amp = len * roughness
  const off = new Cesium.Cartesian3(
    (Math.random() - 0.5) * amp,
    (Math.random() - 0.5) * amp,
    (Math.random() - 0.5) * amp * 0.25,
  )
  const m = Cesium.Cartesian3.add(mid, off, new Cesium.Cartesian3())

  midDisplace(a, m, depth - 1, roughness * 0.62, out)
  midDisplace(m, b, depth - 1, roughness * 0.62, out)
}

interface Strike {
  lines: Cesium.Entity[]
  born: number
  life: number
  peak: number
}

const strikes: Strike[] = []
let cloudEntities: Cesium.Entity[] = []
let strikeTimer = 0

function fireLightning(viewer: Viewer, textureUrl: string) {
  // 落点：云团下方 ±3km 的随机点
  const groundLon = CENTER[0] + (Math.random() - 0.5) * 0.02
  const groundLat = CENTER[1] + (Math.random() - 0.5) * 0.016
  const cloudH = 1000 + Math.random() * 500
  const start = Cesium.Cartesian3.fromDegrees(
    groundLon + (Math.random() - 0.5) * 0.01,
    groundLat + (Math.random() - 0.5) * 0.008,
    cloudH,
  )
  const end = Cesium.Cartesian3.fromDegrees(groundLon, groundLat, 20)

  const main: Cesium.Cartesian3[] = [start]
  midDisplace(start, end, 6, 0.42, main)

  const born = performance.now()
  const life = 620
  const lines: Cesium.Entity[] = []

  // 主放电
  lines.push(
    viewer.entities.add({
      polyline: {
        positions: main,
        width: 3.2,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: Cesium.Color.fromCssColorString('#d9f0ff').withAlpha(0.95),
          glowPower: 0.32,
          taperPower: 0.9,
        }),
      },
    }),
  )

  // 分支：从主放电中段挑 3 个点，向侧下方分裂
  for (let b = 0; b < 3; b++) {
    const i = Math.floor(main.length * (0.25 + Math.random() * 0.5))
    const from = main[Math.min(i, main.length - 1)]
    const fromC = Cesium.Cartographic.fromCartesian(from)
    const to = Cesium.Cartesian3.fromRadians(
      fromC.longitude + (Math.random() - 0.5) * 0.012,
      fromC.latitude + (Math.random() - 0.5) * 0.01,
      Math.max(20, fromC.height * (0.15 + Math.random() * 0.35)),
    )
    const branch: Cesium.Cartesian3[] = [from]
    midDisplace(from, to, 5, 0.4, branch)
    lines.push(
      viewer.entities.add({
        polyline: {
          positions: branch,
          width: 1.6,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: Cesium.Color.fromCssColorString('#a8d8ff').withAlpha(0.7),
            glowPower: 0.22,
          }),
        },
      }),
    )
  }

  // 落点光晕
  lines.push(
    viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(groundLon, groundLat, 30),
      billboard: {
        image: textureUrl,
        sizeInMeters: true,
        width: 900,
        height: 900,
        color: Cesium.Color.fromCssColorString('#bfe8ff'),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }),
  )

  strikes.push({ lines, born, life, peak: 1 })
  strikeCount.value++
}

onMounted(() => {
  const el = container.value
  if (!el) return
  const viewer = new Cesium.Viewer(el, { ...VIEWER_OPTIONS, shouldAnimate: true })
  viewerRef.value = viewer
  applyCesiumBasemap(viewer, 'imagery', null)
  viewer.scene.globe.depthTestAgainstTerrain = false
  // 夜色：压暗底图，闪电才「亮」
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#05080d')
  // 低掠射角下 skyAtmosphere 会把整个地面罩成灰蓝霾，夜色场景直接关掉
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false
  // 真凶是它：globe 自带的「地表大气辉光」在掠射角下把整片地面刷成灰蓝
  viewer.scene.globe.showGroundAtmosphere = false
  viewer.scene.fog.enabled = true
  viewer.scene.fog.density = 0.00003 // 雾太浓会把整个画面洗成灰蓝

  // —— 云团 ——
  const cloudUrl = cloudTexture()
  // 数量与透明度要克制：几十片大 alpha 云叠在一起会糊成一堵云墙
  // 云团要收拢成一团紧凑的风暴云：摊开到几公里宽时，几十片半透明云
  // 会在画面里叠成一堵不透光的云墙，什么都看不见
  const groups = [
    { lon: CENTER[0] - 0.006, lat: CENTER[1] + 0.004, n: 7 },
    { lon: CENTER[0] + 0.007, lat: CENTER[1] - 0.002, n: 6 },
    { lon: CENTER[0] - 0.001, lat: CENTER[1] - 0.008, n: 6 },
  ]
  for (const g of groups) {
    for (let i = 0; i < g.n; i++) {
      const lon = g.lon + (Math.random() - 0.5) * 0.014
      const lat = g.lat + (Math.random() - 0.5) * 0.011
      const h = 900 + Math.random() * 600
      // sizeInMeters 模式下必须用 width/height 显式给米数：
      // scale 是「贴图像素 × scale」，256px 贴图 × 700 会被放大成一百多公里宽的巨片
      const cs = 700 + Math.random() * 600
      cloudEntities.push(
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, h),
          billboard: {
            image: cloudUrl,
            sizeInMeters: true,
            width: cs,
            height: cs,
            color: Cesium.Color.WHITE.withAlpha(0.4 + Math.random() * 0.25),
            // 云不参与深度遮挡（否则会被地球吃掉一半）
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            rotation: Math.random() * Math.PI * 2,
          },
        }),
      )
    }
  }

  // —— 主循环：闪电生命周期 + 闪光 ——
  let lastAuto = performance.now()
  let raf = 0
  let t = 0
  let lastCloudOpacity = -1
  const loop = () => {
    raf = requestAnimationFrame(loop)
    const now = performance.now()
    t += 0.016

    // 自动放电
    if (autoRate.value > 0 && now - lastAuto > autoRate.value * 1000) {
      lastAuto = now
      fireLightning(viewer, cloudUrl)
    }

    // 逐条闪电：闪 3 次后淡出
    let flash = 0
    for (let i = strikes.length - 1; i >= 0; i--) {
      const s = strikes[i]
      const age = now - s.born
      const k = age / s.life
      if (k >= 1) {
        for (const e of s.lines) viewer.entities.remove(e)
        strikes.splice(i, 1)
        continue
      }
      // 双闪：前 60% 时间按 14Hz 闪三次，后面单调衰减
      const flicker =
        k < 0.6 ? (Math.sin(k * 3 * Math.PI * 2.4) > 0 ? 1 : 0.15) : 1
      const decay = 1 - Math.max(0, (k - 0.35) / 0.65)
      const a = flicker * decay
      for (const e of s.lines) {
        const pl = e.polyline
        if (pl?.material instanceof Cesium.PolylineGlowMaterialProperty) {
          pl.material.color = new Cesium.ConstantProperty(
            Cesium.Color.fromCssColorString('#dff3ff').withAlpha(Math.min(1, a)),
          )
        } else if (e.billboard) {
          e.billboard.color = new Cesium.ConstantProperty(
            Cesium.Color.fromCssColorString('#bfe8ff').withAlpha(a * 0.8),
          )
        }
      }
      flash = Math.max(flash, a)
    }
    flashRef.value = flash * 0.55

    // 云层浓度（只在变化时重设，避免每帧 new 属性对象）
    if (cloudOpacity.value !== lastCloudOpacity) {
      lastCloudOpacity = cloudOpacity.value
      const c = Cesium.Color.WHITE.withAlpha(0.18 + cloudOpacity.value * 0.35)
      for (const e of cloudEntities) {
        if (e.billboard) e.billboard.color = new Cesium.ConstantProperty(c)
      }
    }
    void t
  }
  loop()

  cleanups.push(() => cancelAnimationFrame(raf))

  // 手动触发
  triggerRef.value = () => fireLightning(viewer, cloudUrl)
})

const triggerRef = shallowRef<(() => void) | null>(null)
const cleanups: Array<() => void> = []

onBeforeUnmount(() => {
  cleanups.forEach((f) => f())
  const v = viewerRef.value
  if (v && !v.isDestroyed()) v.destroy()
  viewerRef.value = null
})

/** 复位要连参数一起还原：只飞相机的话，调过滑杆的用户点下去画面纹丝不动，像按钮坏了 */
function resetAll() {
  autoRate.value = DEFAULTS.autoRate
  cloudOpacity.value = DEFAULTS.cloudOpacity
  reset()
}

function strike() {
  triggerRef.value?.()
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="cesium-container"></div>
    <div class="flash" :style="{ opacity: flashRef }"></div>
    <div class="panel">
      <div class="row">
        <span class="label">自动放电</span>
        <input
          class="range"
          type="range"
          min="0"
          max="6"
          step="0.2"
          :value="autoRate"
          @input="autoRate = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ autoRate === 0 ? '关' : autoRate.toFixed(1) + 's' }}</span>
      </div>
      <div class="row">
        <span class="label">云层浓度</span>
        <input
          class="range"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="cloudOpacity"
          @input="cloudOpacity = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ cloudOpacity.toFixed(2) }}</span>
      </div>
      <div class="row">
        <button class="btn" @click="strike">立即放电</button>
        <button class="btn" @click="resetAll()">复位</button>
      </div>
      <div class="meta">已放电 {{ strikeCount }} 次</div>
      <div class="tip">
        闪电用中点位移递归细分生成（6 层，每层扰动 ×0.62），随机挑主放电上的点分裂出 3 条支线；
        用 CallbackProperty 的 14Hz 双闪 + 淡出模拟真实放电，全屏遮罩同步闪一下。
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
/* 全屏闪光遮罩（不接管点击） */
.flash {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    circle at 50% 42%,
    rgba(220, 240, 255, 0.9) 0%,
    rgba(150, 200, 255, 0.35) 45%,
    rgba(120, 180, 255, 0) 75%
  );
  mix-blend-mode: screen;
  z-index: 4;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 310px;
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
  width: 42px;
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
  padding: 3px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.5);
  background: rgba(30, 42, 60, 0.7);
  color: #9fd0ff;
  cursor: pointer;
}
</style>
