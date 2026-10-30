<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useExamplesStore } from '@/stores/examples'

const store = useExamplesStore()
const router = useRouter()

function openFirst(catId: string, exampleId: string) {
  router.push({ name: 'example', params: { techId: catId, exampleId } })
}
</script>

<template>
  <div class="home">
    <header class="hero">
      <h1>VizForge · 可视化实验室</h1>
      <p>
        基于 <b>Vue 3 + TypeScript + Pinia</b> 构建，汇集 Cesium、Three.js、OpenLayers 与原生
        WebGL 的 <b>74 个可运行示例</b>。每个示例都是手写的完整场景，点开即可交互，右上角
        <b>「查看源码」</b> 能直接读到全部实现并一键复制。点击卡片进入对应技术栈。
      </p>
    </header>

    <section class="grid">
      <article
        v-for="cat in store.categories"
        :key="cat.id"
        class="card"
        @click="openFirst(cat.id, cat.examples[0].id)"
      >
        <div class="card-icon">{{ cat.icon }}</div>
        <div class="card-body">
          <h2>{{ cat.name }}</h2>
          <p class="card-desc">{{ cat.description }}</p>
          <ul class="card-examples">
            <li v-for="ex in cat.examples" :key="ex.id">{{ ex.title }}</li>
          </ul>
        </div>
        <div class="card-go">进入 →</div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.home {
  flex: 1;
  overflow-y: auto;
  padding: 32px;
}
.hero {
  max-width: 900px;
  margin-bottom: 28px;
}
.hero h1 {
  font-size: 28px;
  margin: 0 0 10px;
}
.hero p {
  color: var(--text-dim);
  line-height: 1.7;
  margin: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 18px;
  max-width: 1200px;
}
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease;
  display: flex;
  flex-direction: column;
}
.card:hover {
  transform: translateY(-3px);
  border-color: var(--accent);
}
.card-icon {
  font-size: 30px;
  margin-bottom: 10px;
}
.card-body h2 {
  margin: 0 0 6px;
  font-size: 18px;
}
.card-desc {
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.6;
  margin: 0 0 12px;
}
.card-examples {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.card-examples li {
  background: var(--bg-panel-2);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--text);
}
.card-go {
  margin-top: 14px;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
}
</style>
