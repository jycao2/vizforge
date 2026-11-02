<script setup lang="ts">
/**
 * 涟漪脉冲（Cesium 版）
 * ===========================================================================
 * 「一圈圈扩散、边扩散边变淡」在 Cesium 里就是 Ellipse：半长轴与材质透明度
 * 都是 CallbackProperty，每帧按同一个相位算一次即可，不需要重建实体。
 *
 * 与 MapLibre 那版的思路差异值得对照：
 *   · MapLibre 用 sprite 缩放（像素尺度，放大不会失真但半径不是真实米数）；
 *   · Cesium 用 Ellipse（真实米数，缩放到什么级别都准确，代价是每帧算材质颜色）。
 *
 * 相位错开 1/N 周期，就有连续不断的「波」；相位全同步只会看到一个个孤立的圈。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'
import { applyScreenLook, glowSprite, screenHome } from './screenScene'
import { HOTSPOTS } from '@/examples/shared/screen'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const HOME = screenHome([120.224, 30.238], 5200, -52, -12, 2600)
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => HOME,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

const RINGS = 4
const R_MAX = 2200 // 扩散到 2.2 km
const period = ref(2.6)
const paused = ref(false)

const LEVEL_COLOR: Record<string, string> = {
  high: '#ff7a6b',
  mid: '#ffd166',
  low: '#5fd8ff',
}

/** 相位 0→1 循环；放在 clock.onTick 里推进，与其它示例保持一致的驱动方式 */
let phase = 0
let removeTick: (() => void) | null = null

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  const v = viewer
  applyBasemap(currentBasemap.value)
  applyScreenLook(v)
  v.camera.setView(HOME)

  const sprite = glowSprite(64, 'rgba(200,240,255,0.95)')

  HOTSPOTS.forEach((h, hi) => {
    const base = Cesium.Color.fromCssColorString(LEVEL_COLOR[h.level])

    // 地面光晕
    v.entities.add({
      position: Cesium.Cartesian3.fromDegrees(h.center[0], h.center[1], 4),
      billboard: { image: sprite, width: 92, height: 92, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    })

    for (let k = 0; k < RINGS; k++) {
      const offset = k / RINGS
      // 波纹半径：真实米数，随相位线性放大
      const radius = new Cesium.CallbackProperty(() => {
        const p = (phase + offset) % 1
        return Math.max(1, p * R_MAX)
      }, false)
      // 透明度：1.8 次幂衰减，衰减快一点才像「波」而不是「充气的圈」
      const material = new Cesium.ColorMaterialProperty(
        new Cesium.CallbackProperty(() => {
          const p = (phase + offset) % 1
          return base.withAlpha(Math.pow(1 - p, 1.8) * 0.9)
        }, false) as unknown as Cesium.Color,
      )
      v.entities.add({
        position: Cesium.Cartesian3.fromDegrees(h.center[0], h.center[1], 2),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          height: 2,
          material,
          outline: true,
          outlineColor: base.withAlpha(0.35),
        },
      })
    }

    v.entities.add({
      position: Cesium.Cartesian3.fromDegrees(h.center[0], h.center[1], 40),
      label: {
        text: `${h.name} · ${h.value}`,
        font: '600 13px "PingFang SC", "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#eef9ff'),
        outlineColor: Cesium.Color.fromCssColorString('#03101f'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -26),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  })

  removeTick = v.clock.onTick.addEventListener(() => {
    if (paused.value) return
    // 0.018/tick ≈ 1.1 圈/秒（60fps），配合 period 滑杆微调观感
    phase = (phase + 0.018 * (2.6 / period.value)) % 1
  })
})

onBeforeUnmount(() => {
  removeTick?.()
  removeTick = null
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>

    <div class="scr-overlay">
      <div class="scr-frame"><i></i><i></i><i></i><i></i></div>
      <div class="scr-top">
        <div class="scr-title">实时告警热点</div>
        <div class="scr-sub">RIPPLE · ELLIPSE CALLBACK</div>
      </div>

      <div class="scr-card left">
        <div class="scr-h">脉冲参数</div>
        <label class="scr-slider">
          <span>扩散周期</span>
          <input v-model.number="period" type="range" min="1" max="6" step="0.2" />
          <b>{{ period.toFixed(1) }}s</b>
        </label>
        <div class="scr-btn-row">
          <button class="scr-btn" :class="{ on: !paused }" @click="paused = !paused">
            {{ paused ? '继续' : '暂停' }}
          </button>
        </div>
        <div class="scr-note">
          3 个热点 × {{ RINGS }} 圈，Ellipse 的真实半径最大 {{ R_MAX / 1000 }} km
        </div>
      </div>

      <div class="scr-card right">
        <div class="scr-h">热点等级 <em>红 / 黄 / 青</em></div>
        <div class="scr-list">
          <div v-for="h in HOTSPOTS" :key="h.name" class="scr-item">
            <span>{{ h.name }}</span>
            <b :style="{ color: LEVEL_COLOR[h.level] }">{{ h.value }}</b>
            <div class="scr-bar" :class="{ warn: h.level === 'high' }">
              <i :style="{ width: `${h.value}%` }"></i>
            </div>
          </div>
        </div>
      </div>

      <div class="scr-tip">Ellipse 的 semiMajorAxis / 材质 alpha 都是 CallbackProperty，每帧算一次，几何不重建</div>
    </div>

    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />
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
.left {
  top: 76px;
  left: 16px;
  width: 210px;
}
.right {
  top: 76px;
  right: 16px;
  width: 200px;
}
.scr-note {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(140, 180, 210, 0.85);
  font-size: 10.5px;
  line-height: 1.5;
}
</style>
