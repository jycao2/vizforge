<script setup lang="ts">
/**
 * 大屏总览 · 城市运营（Cesium 版）
 * ===========================================================================
 * 与 MapLibre 那版是同一个场景、同一份数据，对比着看能看出两个引擎的差别：
 *
 *   · 楼块：Cesium 用 Primitive + GeometryInstance 批量提交（500 个盒子一次
 *     draw call），MapLibre 只要一个 fill-extrusion 图层；
 *   · 光墙：Cesium 有真正的 Wall 图元，给一串 positions + 高度数组就行；
 *     MapLibre 得把边界加厚成条带再拉伸；
 *   · 飞线：Cesium 用 PolylineGlowMaterial 自带的辉光，跑点用 CallbackProperty
 *     在弧长上插值，不需要每帧重传几何；
 *   · 外观：Cesium 默认是「蓝色地球 + 大气 + 星空」，必须手动关掉再压暗，
 *     否则再多的光效也压不住那股白天的 GIS 味。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'
import {
  addBuildings,
  arcPositions,
  applyScreenLook,
  glowLine,
  glowSprite,
  movingAlong,
  ringToPositions,
  screenHome,
} from './screenScene'
import { ODS, ZONES, buildings, countUp, fmt, nGon } from '@/examples/shared/screen'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const HOME = screenHome([120.2205, 30.2375], 6200, -50, -15, 3000)
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => HOME,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

const rotate = ref(true)
const BUILDINGS = buildings()
const POINTS = 1_284_637
const kpis = [
  { label: '在线设备', value: 8642, unit: '台' },
  { label: '今日告警', value: 37, unit: '条' },
  { label: '平均响应', value: 42, unit: '秒' },
  { label: '在线率', value: 99, unit: '%' },
]
const bootT = ref(0)
let removeTick: (() => void) | null = null

const zoneOf = (id: string) => ZONES.find((z) => z.id === id)!

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  const v = viewer
  applyBasemap(currentBasemap.value)
  applyScreenLook(v)
  v.camera.setView(HOME)

  addBuildings(v, BUILDINGS)

  // 片区：地面描边 + 半透明光墙
  for (const z of ZONES) {
    const ring = nGon(z.center, z.radiusKm, 40, z.value)
    glowLine(v, ringToPositions(ring, 2), { color: '#7ce8ff', width: 3, glow: 0.28 })
    v.entities.add({
      wall: {
        positions: ringToPositions(ring),
        maximumHeights: new Array(ring.length).fill(70 + z.value * 1.6),
        minimumHeights: new Array(ring.length).fill(0),
        material: Cesium.Color.fromCssColorString('#2ea8ff').withAlpha(0.3),
      },
    })
    v.entities.add({
      position: Cesium.Cartesian3.fromDegrees(z.center[0], z.center[1], 120),
      label: {
        text: `${z.name}  ${z.value}%`,
        font: '600 13px "PingFang SC", "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#dff2ff'),
        outlineColor: Cesium.Color.fromCssColorString('#03101f'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  // 飞线：辉光线 + 沿弧长跑的光点
  const sprite = glowSprite(64)
  ODS.forEach((o, i) => {
    const arc = arcPositions(zoneOf(o.from).center, zoneOf(o.to).center, 380 + o.v * 3.2)
    v.entities.add({
      polyline: {
        positions: arc,
        width: 1.6 + o.v / 60,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.34,
          color: Cesium.Color.fromCssColorString('#9fe8ff').withAlpha(0.85),
        }),
      },
    })
    v.entities.add({
      position: movingAlong(arc, 0.16, i * 0.13) as unknown as Cesium.Cartesian3,
      billboard: {
        image: sprite,
        width: 26,
        height: 26,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  })

  // 巡航：原地转方位角（等价于 MapLibre 版的 bearing 递增）。
  // 千万别用 camera.rotate(UNIT_Z, ...) —— 那是绕地轴「公转」，
  // 城市尺度下相机会被甩出目标区几百公里，瓦片永远加载不出来；
  // 也别用固定 rad/帧：onTick 按帧触发，掉帧时转速会翻倍，这里按真实 dt 折算
  let last = 0
  removeTick = v.clock.onTick.addEventListener(() => {
    if (!rotate.value) return
    const now = performance.now()
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0
    last = now
    if (dt <= 0) return
    v.camera.setView({
      destination: v.camera.positionWC.clone(),
      orientation: { heading: v.camera.heading + dt * 0.055, pitch: v.camera.pitch, roll: 0 },
    })
  })

  // KPI 入场滚动（与 MapLibre 版同一段逻辑）
  const t0 = performance.now()
  const step = () => {
    bootT.value = Math.min(1, (performance.now() - t0) / 1100)
    if (bootT.value < 1 && viewer && !viewer.isDestroyed()) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
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
        <div class="scr-title">城市运行监测大屏</div>
        <div class="scr-sub">URBAN OPERATION · CESIUM TWIN</div>
      </div>

      <div class="scr-card left">
        <div class="scr-h">运行总览 <em class="scr-live">LIVE</em></div>
        <div class="scr-kpi-row">
          <div v-for="k in kpis" :key="k.label" class="scr-kpi">
            <div class="scr-num">{{ countUp(k.value, bootT) }}<small>{{ k.unit }}</small></div>
            <div class="scr-label">{{ k.label }}</div>
          </div>
        </div>
        <div class="scr-h" style="margin-top: 11px">片区负荷</div>
        <div class="scr-list">
          <div v-for="z in ZONES" :key="z.id" class="scr-item">
            <span>{{ z.name }}</span>
            <b>{{ z.value }}%</b>
            <div class="scr-bar" :class="{ warn: z.value > 90 }">
              <i :style="{ width: `${countUp(z.value, bootT)}%` }"></i>
            </div>
          </div>
        </div>
      </div>

      <div class="scr-card right">
        <div class="scr-h">实时告警 <em>37 条</em></div>
        <div class="scr-list">
          <div class="scr-item"><span>滨江·泵站液位超限</span><b style="color: #ffb0a0">19:42</b></div>
          <div class="scr-item"><span>CBD·能耗环比 +18%</span><b style="color: #ffd08a">19:38</b></div>
          <div class="scr-item"><span>九堡·摄像头离线 3 台</span><b style="color: #a9c4dc">19:31</b></div>
        </div>
        <div class="scr-h" style="margin-top: 11px">控制 <em>共 {{ fmt(POINTS) }} 点位</em></div>
        <div class="scr-btn-row">
          <button class="scr-btn" :class="{ on: rotate }" @click="rotate = !rotate">自动巡航</button>
        </div>
      </div>

      <div class="scr-tip">
        {{ BUILDINGS.length }} 个楼块合并为 1 次 draw call（Primitive + GeometryInstance）· Wall 图元做光墙 · CallbackProperty 驱动跑点
      </div>
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
  top: 74px;
  left: 16px;
  width: 208px;
}
.right {
  top: 74px;
  right: 16px;
  width: 208px;
}
</style>
