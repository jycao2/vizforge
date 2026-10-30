<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { useExamplesStore } from '@/stores/examples'
import { highlightVue } from '@/utils/highlight'

const props = defineProps<{ techId: string; exampleId: string }>()
const store = useExamplesStore()

const category = computed(() => store.categoryById(props.techId))
const example = computed(() => store.exampleById(props.techId, props.exampleId))

/** 根据文件路径懒加载示例组件 */
const ExampleComp = computed(() => {
  if (!example.value) return null
  const loader = store.componentOf(example.value.file)
  return loader ? defineAsyncComponent(loader) : null
})

// ---- 源码面板 ----
const showSource = ref(false)
const code = ref('')
const loading = ref(false)
const copied = ref(false)
let copyTimer: number | undefined

const lineCount = computed(() => code.value.split('\n').length)
const highlighted = computed(() => highlightVue(code.value))

async function loadSource() {
  if (!example.value) return
  const loader = store.sourceOf(example.value.file)
  if (!loader) {
    code.value = '// 未找到该示例的源码文件'
    return
  }
  loading.value = true
  try {
    code.value = await loader()
  } catch (e) {
    code.value = '// 源码加载失败：' + String(e)
  } finally {
    loading.value = false
  }
}

async function toggleSource() {
  showSource.value = !showSource.value
  // 面板开合会改变画布尺寸，触发一次 resize 让 Three/WebGL 示例自适应
  await nextTick()
  window.dispatchEvent(new Event('resize'))
  if (showSource.value && !code.value) {
    await loadSource()
  }
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(code.value)
    copied.value = true
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copied.value = false), 1600)
  } catch {
    copied.value = false
  }
}

// 切换示例时重置源码
watch(
  () => props.exampleId,
  () => {
    code.value = ''
    copied.value = false
    if (showSource.value) loadSource()
  },
)
</script>

<template>
  <div class="example-page">
    <header class="example-header">
      <div class="head-left">
        <div class="crumb">
          <span class="crumb-tech">{{ category?.icon }} {{ category?.name }}</span>
          <span class="crumb-sep">/</span>
          <span class="crumb-title">{{ example?.title }}</span>
        </div>
        <p v-if="example" class="example-desc">{{ example.description }}</p>
        <p v-else class="example-desc warn">未找到该示例，请从左侧导航选择。</p>
      </div>

      <button
        class="source-btn"
        :class="{ active: showSource }"
        :disabled="!example"
        @click="toggleSource"
      >
        <span class="code-icon">&lt;/&gt;</span>
        {{ showSource ? '隐藏源码' : '查看源码' }}
      </button>
    </header>

    <div class="example-body">
      <div class="example-stage">
        <component :is="ExampleComp" v-if="ExampleComp" />
        <div v-else class="stage-empty">请选择左侧的示例</div>
      </div>

      <transition name="slide">
        <aside v-if="showSource" class="source-panel">
          <div class="source-head">
            <div class="source-meta">
              <span class="source-badge">源码</span>
              <span class="source-file" :title="example?.file">{{ example?.file }}</span>
            </div>
            <button class="copy-btn" @click="copyCode">
              {{ copied ? '✓ 已复制' : '复制' }}
            </button>
          </div>

          <div v-if="loading" class="source-state">源码加载中…</div>
          <div v-else class="source-code">
            <div class="code-grid">
              <div class="gutter">
                <div v-for="n in lineCount" :key="n" class="gutter-line">{{ n }}</div>
              </div>
              <pre class="code-pre"><code class="hljs" v-html="highlighted"></code></pre>
            </div>
          </div>
        </aside>
      </transition>
    </div>
  </div>
</template>

<style scoped>
.example-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.example-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.head-left {
  min-width: 0;
}
.crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
}
.crumb-tech {
  color: var(--accent);
  font-weight: 600;
}
.crumb-title {
  color: var(--text);
  font-weight: 600;
  font-size: 15px;
}
.example-desc {
  margin: 8px 0 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.6;
}
.example-desc.warn {
  color: var(--accent-2);
}

.source-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-panel-2);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.source-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.source-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.source-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.code-icon {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  opacity: 0.9;
}

.example-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

.example-stage {
  flex: 1;
  min-width: 0;
  position: relative;
  background: #0a0e16;
}
.stage-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 14px;
}

/* ---- 源码面板 ---- */
.source-panel {
  flex: 0 0 auto;
  width: 46%;
  max-width: 680px;
  min-width: 340px;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: #0c1219;
  min-height: 0;
}
.source-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.source-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.source-badge {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(79, 157, 255, 0.16);
  color: var(--accent);
  font-weight: 600;
}
.source-file {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.copy-btn {
  flex: 0 0 auto;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-panel-2);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}
.copy-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.source-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 13px;
}

.source-code {
  --code-lh: 20px;
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: ui-monospace, 'Cascadia Code', Consolas, 'Courier New', monospace;
  font-size: 12.5px;
  line-height: var(--code-lh);
  tab-size: 2;
}
.code-grid {
  display: flex;
  align-items: flex-start;
  min-width: max-content;
}
.gutter {
  position: sticky;
  left: 0;
  z-index: 1;
  flex: 0 0 52px;
  padding: 12px 10px 12px 0;
  text-align: right;
  background: #0c1219;
  user-select: none;
  border-right: 1px solid rgba(42, 51, 64, 0.6);
}
.gutter-line {
  height: var(--code-lh);
  line-height: var(--code-lh);
  color: #4b5866;
}
.code-pre {
  margin: 0;
  padding: 12px 20px 12px 14px;
  white-space: pre;
  font-family: inherit;
  font-size: inherit;
  line-height: var(--code-lh);
  color: #d6e2ef;
}
.code-pre code {
  font-family: inherit;
  background: none;
  padding: 0;
}

/* ---- highlight.js 暗色 token 配色 ---- */
:deep(.hljs-comment),
:deep(.hljs-quote) {
  color: #7d8998;
  font-style: italic;
}
:deep(.hljs-keyword),
:deep(.hljs-selector-tag),
:deep(.hljs-literal),
:deep(.hljs-section),
:deep(.hljs-link) {
  color: #ff7b72;
}
:deep(.hljs-string),
:deep(.hljs-regexp),
:deep(.hljs-addition) {
  color: #a5d6ff;
}
:deep(.hljs-number),
:deep(.hljs-symbol),
:deep(.hljs-bullet),
:deep(.hljs-meta) {
  color: #79c0ff;
}
:deep(.hljs-title),
:deep(.hljs-name),
:deep(.hljs-selector-id),
:deep(.hljs-selector-class) {
  color: #7ee787;
}
:deep(.hljs-attr),
:deep(.hljs-attribute),
:deep(.hljs-variable),
:deep(.hljs-template-variable),
:deep(.hljs-type),
:deep(.hljs-built_in) {
  color: #ffa657;
}
:deep(.hljs-tag) {
  color: #8b949e;
}
:deep(.hljs-params),
:deep(.hljs-operator),
:deep(.hljs-punctuation) {
  color: #c9d1d9;
}
:deep(.hljs-property) {
  color: #79c0ff;
}
:deep(.hljs-deletion) {
  color: #ff7b72;
}

.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateX(22px);
}

@media (max-width: 900px) {
  .source-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 88%;
    max-width: none;
    min-width: 0;
    z-index: 5;
    box-shadow: -12px 0 30px rgba(0, 0, 0, 0.4);
  }
}
</style>
