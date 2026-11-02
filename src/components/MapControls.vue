<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { BasemapOption } from '@/types/map'
import { useMapHost, type MapHostKind } from './mapHost'
import type { MeasureHandle, MeasureKind } from './measureShared'

const props = withDefaults(
  defineProps<{
    /** 可选底图列表；不传或为空则不显示底图按钮 */
    basemaps?: BasemapOption[]
    /** 当前底图 id */
    modelValue?: string
  }>(),
  { basemaps: () => [], modelValue: '' },
)

const emit = defineEmits<{
  (e: 'zoom-in'): void
  (e: 'zoom-out'): void
  (e: 'reset'): void
  (e: 'fullscreen'): void
  (e: 'update:modelValue', value: string): void
}>()

const rootRef = ref<HTMLDivElement>()
const panelOpen = ref(false)

/**
 * 量测：地图实例由页面脚手架 provide 进来（见 mapHost.ts），
 * 所以 40 多个示例不用各写一遍接入代码。
 * 两个实现按需动态加载 —— 否则 OL 页面会把 Cesium 打进同一个 chunk，反之亦然。
 */
const host = useMapHost()
const kind = ref<MapHostKind | null>(null)
const measuring = ref<MeasureKind | null>(null)
const readout = ref('')
const readoutSub = ref('')
let handle: MeasureHandle | null = null

const MEASURES: Array<{ id: MeasureKind; tip: string; label: string }> = [
  { id: 'line', tip: '测距', label: '测距' },
  { id: 'area', tip: '测面', label: '测面' },
  { id: 'height', tip: '测高（三维）', label: '测高' },
]

// 地图在父组件 onMounted 里才创建，比本组件晚 —— 先轮询拿类型，拿到就定型
let kindTimer = 0
let kindTries = 0

function probeKind() {
  const k = host?.()?.kind ?? null
  if (k) {
    kind.value = k
    if (kindTimer) clearInterval(kindTimer)
  }
}

function onMeasureUpdate(u: { text: string; detail?: string; done: boolean }) {
  readout.value = u.text
  readoutSub.value = u.detail ?? ''
}

async function toggleMeasure(id: MeasureKind) {
  if (measuring.value === id) {
    stopMeasure()
    return
  }
  stopMeasure()
  const h = host?.()
  if (!h) return
  measuring.value = id
  readout.value = '准备测量…'
  readoutSub.value = ''

  if (h.kind === 'ol') {
    if (id === 'height') {
      // 二维没有地形高程，不给测高
      measuring.value = null
      return
    }
    const { startOlMeasure } = await import('@/examples/openlayers/measureOl')
    handle = startOlMeasure(h.instance as never, id, onMeasureUpdate)
  } else if (h.kind === 'mapbox') {
    if (id === 'height') {
      // 未开地形时不给测高
      measuring.value = null
      return
    }
    const { startMbMeasure } = await import('@/examples/mapbox/measureMapbox')
    handle = startMbMeasure(h.instance as never, id, onMeasureUpdate)
  } else {
    const { startCesiumMeasure } = await import('@/examples/cesium/measureCesium')
    handle = startCesiumMeasure(h.instance as never, id, onMeasureUpdate)
  }
}

function stopMeasure() {
  handle?.dispose()
  handle = null
  measuring.value = null
  readout.value = ''
  readoutSub.value = ''
}

function togglePanel() {
  panelOpen.value = !panelOpen.value
}
function pick(id: string) {
  emit('update:modelValue', id)
  panelOpen.value = false
}
function onDocPointerDown(ev: PointerEvent) {
  if (!panelOpen.value) return
  const el = rootRef.value
  if (el && !el.contains(ev.target as Node)) panelOpen.value = false
}
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    panelOpen.value = false
    if (measuring.value) stopMeasure()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onKeydown)
  probeKind()
  if (!kind.value) {
    kindTimer = window.setInterval(() => {
      probeKind()
      if (++kindTries > 24) clearInterval(kindTimer)
    }, 80)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKeydown)
  if (kindTimer) clearInterval(kindTimer)
  stopMeasure()
})
</script>

<template>
  <div ref="rootRef" class="map-tools">
    <div class="tool-dock">
      <button class="tool" data-tip="放大" aria-label="放大" @click="emit('zoom-in')">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5 20 20M10.5 7.8v5.4M7.8 10.5h5.4" />
        </svg>
      </button>
      <button class="tool" data-tip="缩小" aria-label="缩小" @click="emit('zoom-out')">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="M15.5 15.5 20 20M7.8 10.5h5.4" />
        </svg>
      </button>
      <button class="tool" data-tip="复位视图" aria-label="复位视图" @click="emit('reset')">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="8.2" />
          <path d="M15.6 8.4l-2.2 5-5 2.2 2.2-5z" />
        </svg>
      </button>
      <button class="tool" data-tip="全屏" aria-label="全屏" @click="emit('fullscreen')">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M4 9.2V4h5.2M20 9.2V4h-5.2M4 14.8V20h5.2M20 14.8V20h-5.2" />
        </svg>
      </button>

      <!-- 量测：二维给测距/测面，三维再加测高 -->
      <template v-if="kind">
        <span class="dock-sep"></span>
        <button
          v-for="m in MEASURES.filter((x) => kind === 'cesium' || x.id !== 'height')"
          :key="m.id"
          class="tool"
          :class="{ on: measuring === m.id }"
          :data-tip="m.tip"
          :aria-label="m.tip"
          @click="toggleMeasure(m.id)"
        >
          <svg v-if="m.id === 'line'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M4.6 17.6 9.4 9.4l5.1 4 4.9-8.3" />
            <circle cx="4.6" cy="17.6" r="1.5" />
            <circle cx="19.4" cy="5.1" r="1.5" />
          </svg>
          <svg
            v-else-if="m.id === 'area'"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            aria-hidden="true"
          >
            <path d="M5 15.6 8.6 5.4h7.9l3.4 9-6.9 4.4z" />
            <path d="M8.6 5.4 13 18.8M5 15.6 19.9 14.4" opacity="0.42" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M4 19.4h16M4 4.6h16" opacity="0.45" />
            <path d="M12 16.6V7.4M9.4 10 12 7.4l2.6 2.6M9.4 14 12 16.6l2.6-2.6" />
          </svg>
        </button>
      </template>

      <template v-if="basemaps.length">
        <span class="dock-sep"></span>
        <button
          class="tool"
          :class="{ on: panelOpen }"
          data-tip="底图切换"
          aria-label="底图切换"
          @click="togglePanel"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M12 3.4 20.2 8 12 12.6 3.8 8z" />
            <path d="M3.8 12 12 16.6 20.2 12" />
            <path d="M3.8 16 12 20.6 20.2 16" />
          </svg>
        </button>
      </template>
    </div>

    <Transition name="measure-pop">
      <div v-if="measuring" class="measure-readout">
        <span class="mr-tag">{{ measuring === 'line' ? '测距' : measuring === 'area' ? '测面' : '测高' }}</span>
        <div class="mr-body">
          <b>{{ readout }}</b>
          <span v-if="readoutSub">{{ readoutSub }}</span>
        </div>
        <button class="mr-close" aria-label="结束测量" @click="stopMeasure">×</button>
      </div>
    </Transition>

    <Transition name="bm-pop">
      <div v-if="panelOpen && basemaps.length" class="bm-panel" role="dialog" aria-label="底图选择">
        <div class="bm-head">
          <span>底图</span>
          <span class="bm-hint">选择后立即生效</span>
        </div>
        <div class="bm-list">
          <button
            v-for="b in basemaps"
            :key="b.id"
            class="bm-item"
            :class="{ active: b.id === props.modelValue }"
            :aria-pressed="b.id === props.modelValue"
            @click="pick(b.id)"
          >
            <span class="bm-thumb">
              <img v-if="b.thumb" :src="b.thumb" :alt="b.label" loading="lazy" draggable="false" />
              <span class="bm-check">
                <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
                  <path d="M5 12.8 9.6 17.4 19 7.6" />
                </svg>
              </span>
            </span>
            <span class="bm-label">{{ b.label }}</span>
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.map-tools {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  user-select: none;
}

/* ---- 竖向图标工具栏 ---- */
.tool-dock {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px;
  gap: 2px;
  border-radius: 11px;
  background: rgba(20, 27, 38, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(10px) saturate(1.15);
}

.tool {
  position: relative;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #c6d3e1;
  cursor: pointer;
  transition:
    background 0.16s ease,
    color 0.16s ease,
    transform 0.08s ease;
}
.tool svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.tool:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}
.tool:active {
  transform: scale(0.93);
}
.tool:focus-visible {
  outline: 2px solid #4f9dff;
  outline-offset: 1px;
}
.tool.on {
  background: rgba(79, 157, 255, 0.2);
  color: #7fb8ff;
  box-shadow: inset 0 0 0 1px rgba(79, 157, 255, 0.45);
}

/* 悬浮提示（显示在按钮左侧） */
.tool[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  right: calc(100% + 9px);
  top: 50%;
  transform: translateY(-50%) translateX(4px);
  padding: 4px 8px;
  border-radius: 5px;
  background: rgba(12, 17, 24, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #e4ecf5;
  font-size: 11.5px;
  line-height: 1.3;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}
.tool[data-tip]:hover::after {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}
/* 面板展开时不再显示悬浮提示，避免与面板重叠 */
.tool.on[data-tip]::after {
  display: none;
}

.dock-sep {
  width: 18px;
  height: 1px;
  margin: 3px 0;
  background: rgba(255, 255, 255, 0.12);
}

/* ---- 量测读数条（工具栏左侧） ---- */
.measure-readout {
  position: absolute;
  top: 0;
  right: calc(100% + 10px);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: 10px;
  background: rgba(20, 27, 38, 0.94);
  border: 1px solid rgba(79, 157, 255, 0.42);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(10px) saturate(1.15);
  white-space: nowrap;
}
.mr-tag {
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(79, 157, 255, 0.2);
  color: #8cc4ff;
  font-size: 10px;
  flex: none;
}
.mr-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.mr-body b {
  color: #eaf2fb;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}
.mr-body span {
  color: #8fa4b9;
  font-size: 9.5px;
  line-height: 1.35;
  margin-top: 1px;
}
.mr-close {
  width: 20px;
  height: 20px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  color: #a9bccf;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.mr-close:hover {
  background: rgba(224, 97, 75, 0.24);
  color: #ffb4a4;
}

.measure-pop-enter-active,
.measure-pop-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
  transform-origin: right top;
}
.measure-pop-enter-from,
.measure-pop-leave-to {
  opacity: 0;
  transform: translateX(8px);
}

/* ---- 底图面板 ---- */
.bm-panel {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  padding: 10px;
  border-radius: 12px;
  background: rgba(20, 27, 38, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(12px) saturate(1.15);
}
.bm-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 2px 8px;
  color: #dfe8f2;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.bm-hint {
  color: #7a8798;
  font-size: 10.5px;
  font-weight: 400;
  letter-spacing: 0;
}
.bm-list {
  display: flex;
  gap: 8px;
}

.bm-item {
  width: 76px;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  overflow: hidden;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    transform 0.1s ease;
}
.bm-item:hover {
  border-color: rgba(79, 157, 255, 0.6);
  transform: translateY(-1px);
}
.bm-item.active {
  border-color: #4f9dff;
  box-shadow:
    0 0 0 1px #4f9dff,
    0 6px 16px rgba(79, 157, 255, 0.28);
}

.bm-thumb {
  position: relative;
  display: block;
  width: 100%;
  height: 56px;
  background: #1b2532;
  overflow: hidden;
}
.bm-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.bm-check {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #4f9dff;
  color: #fff;
  display: none;
  align-items: center;
  justify-content: center;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
.bm-check svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.bm-item.active .bm-check {
  display: flex;
}

.bm-label {
  display: block;
  padding: 4px 0;
  background: rgba(255, 255, 255, 0.035);
  color: #aebbc9;
  font-size: 11.5px;
  line-height: 1.45;
  text-align: center;
}
.bm-item.active .bm-label {
  background: #4f9dff;
  color: #fff;
  font-weight: 600;
}

/* 面板弹出动画 */
.bm-pop-enter-active,
.bm-pop-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
  transform-origin: top right;
}
.bm-pop-enter-from,
.bm-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}

@media (max-width: 900px) {
  .bm-item {
    width: 64px;
  }
  .bm-thumb {
    height: 48px;
  }
}
</style>
