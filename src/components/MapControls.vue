<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { BasemapOption } from '@/types/map'

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
  if (ev.key === 'Escape') panelOpen.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKeydown)
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
