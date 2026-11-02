<script setup lang="ts">
/**
 * 发光光墙（Cesium 版）
 * ===========================================================================
 * Cesium 有现成的 Wall 图元：给一串地面点 + 每个点的最大/最小高度，就能立起一堵
 * 沿边界走的墙。比 MapLibre 那套「把边加厚再拉伸」干净得多，而且：
 *
 *   · 墙的高度可以是 CallbackProperty，每帧返回一个新数组 —— 呼吸脉动不用重传几何；
 *   · 墙面材质支持半透明 + 逐帧改 alpha，但要拿住 ColorMaterialProperty 的引用
 *     （entity.wall.material 换成新对象会触发整条属性重建，肉眼可见地卡一下）；
 *   · 墙脚再压一条 PolylineGlow 当「落地线」，否则悬空的墙在暗底图上没有体积感。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import '@/examples/shared/screen.css'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'
import { applyScreenLook, glowLine, ringToPositions, screenHome } from './screenScene'
import { ZONES, nGon } from '@/examples/shared/screen'

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const HOME = screenHome([120.215, 30.2335], 4600, -42, -22, 2400)
const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => HOME,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

const wallH = ref(150)
const breathe = ref(true)
const alpha = ref(0.35)
const active = ref<string | null>(null)

/** 每堵墙自己的基础高度与材质，呼吸与调参都靠这两个引用 */
interface WallRef {
  id: string
  base: number
  entity: Cesium.Entity
  material: Cesium.ColorMaterialProperty
}
const walls: WallRef[] = []
const feet: Array<{ id: string; entity: Cesium.Entity }> = []
let phase = 0
let removeTick: (() => void) | null = null

function buildWalls() {
  if (!viewer) return
  const v = viewer
  for (const z of ZONES) {
    const ring = nGon(z.center, z.radiusKm, 40, z.value)
    const positions = ringToPositions(ring)
    const base = wallH.value * (0.55 + (z.value / 100) * 0.55)
    const material = new Cesium.ColorMaterialProperty(
      Cesium.Color.fromCssColorString('#2ea8ff').withAlpha(alpha.value),
    )
    const entity = v.entities.add({
      wall: {
        positions,
        // 呼吸：每帧返回一个新高度数组，长度必须与 positions 一致
        maximumHeights: new Cesium.CallbackProperty(() => {
          const k = breathe.value ? 1 + Math.sin(phase) * 0.16 : 1
          return new Array(positions.length).fill(base * k)
        }, false),
        minimumHeights: new Array(positions.length).fill(0),
        material,
      },
    })
    walls.push({ id: z.id, base, entity, material })
    feet.push({
      id: z.id,
      entity: glowLine(v, ringToPositions(ring, 1), { color: '#9fe8ff', width: 3, glow: 0.3 }),
    })
    v.entities.add({
      position: Cesium.Cartesian3.fromDegrees(z.center[0], z.center[1], 0),
      label: {
        text: `${z.name} · ${z.value}`,
        font: '600 12px "PingFang SC", "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#eaf8ff'),
        outlineColor: Cesium.Color.fromCssColorString('#03101f'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelOffset: new Cesium.Cartesian2(0, -8),
      },
    })
  }
}

function pick(id: string | null) {
  active.value = id
  for (const w of walls) w.entity.show = !id || w.id === id
  for (const f of feet) f.entity.show = !id || f.id === id
}

function applyAlpha() {
  for (const w of walls) {
    // 赋 ConstantProperty 而不是裸 Color：类型上要求 Property，
    // 运行期虽然会自动包一层，但显式写出来意图更清楚
    w.material.color = new Cesium.ConstantProperty(
      Cesium.Color.fromCssColorString('#2ea8ff').withAlpha(alpha.value),
    )
  }
}

/** 基准高度变了要重建（高度在实体创建时算进闭包了） */
function rebuild() {
  walls.length = 0
  feet.length = 0
  active.value = null
  viewer?.entities.removeAll()
  buildWalls()
}

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  const v = viewer
  applyBasemap(currentBasemap.value)
  applyScreenLook(v)
  v.camera.setView(HOME)
  buildWalls()
  // 呼吸相位推进放在 clock.onTick：Cesium 的帧循环在这里最稳
  removeTick = v.clock.onTick.addEventListener(() => {
    phase += 0.045
  })
})

onBeforeUnmount(() => {
  removeTick?.()
  removeTick = null
  walls.length = 0
  feet.length = 0
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
        <div class="scr-title">重点片区管控</div>
        <div class="scr-sub">GLOW WALL · CESIUM WALL PRIMITIVE</div>
      </div>

      <div class="scr-card left">
        <div class="scr-h">光墙参数</div>
        <label class="scr-slider">
          <span>基准高度</span>
          <input v-model.number="wallH" type="range" min="40" max="320" step="10" />
          <b>{{ wallH }}m</b>
        </label>
        <label class="scr-slider">
          <span>墙体浓度</span>
          <input v-model.number="alpha" type="range" min="0.1" max="0.8" step="0.05" @input="applyAlpha" />
          <b>{{ alpha.toFixed(2) }}</b>
        </label>
        <div class="scr-btn-row">
          <button class="scr-btn" :class="{ on: breathe }" @click="breathe = !breathe">呼吸脉动</button>
          <button class="scr-btn" :class="{ on: !active }" @click="pick(null)">全部片区</button>
        </div>
        <div class="scr-note">改高度后点「重建」让新基准生效</div>
        <div class="scr-btn-row">
          <button class="scr-btn" @click="rebuild">重建光墙</button>
        </div>
      </div>

      <div class="scr-card right">
        <div class="scr-h">片区指标 <em>点击列表切换</em></div>
        <div class="scr-list">
          <div
            v-for="z in ZONES"
            :key="z.id"
            class="scr-item item"
            :class="{ active: active === z.id }"
            @click="pick(active === z.id ? null : z.id)"
          >
            <span>{{ z.name }}</span>
            <b>{{ z.value }}</b>
            <div class="scr-bar" :class="{ warn: z.value > 85 }">
              <i :style="{ width: `${z.value}%` }"></i>
            </div>
          </div>
        </div>
      </div>

      <div class="scr-tip">Wall 图元 + CallbackProperty 高度（每帧新数组）· 墙脚 PolylineGlow 落地 · 材质引用常驻，只改颜色不重建</div>
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
  width: 218px;
}
.right {
  top: 76px;
  right: 16px;
  width: 196px;
}
.item {
  cursor: pointer;
  padding: 2px 4px;
  margin: 0 -4px;
  border-radius: 3px;
}
.item:hover {
  background: rgba(90, 190, 255, 0.12);
}
.item.active span {
  color: #9fe8ff;
  text-shadow: 0 0 10px rgba(90, 210, 255, 0.6);
}
.scr-note {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(140, 180, 210, 0.85);
  font-size: 10.5px;
}
</style>
