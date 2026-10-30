<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useExamplesStore } from '@/stores/examples'

const store = useExamplesStore()
const route = useRoute()
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-logo">◆</span>
      <div class="brand-text">
        <div class="brand-title">VizForge</div>
        <div class="brand-sub">可视化实验室 · Vue3/TS</div>
      </div>
    </div>

    <nav class="nav">
      <router-link to="/" class="nav-home" active-class="active">
        <span class="dot">🏠</span> 总览
      </router-link>

      <div v-for="cat in store.categories" :key="cat.id" class="group">
        <div class="group-head">
          <span class="group-icon">{{ cat.icon }}</span>
          <span class="group-name">{{ cat.name }}</span>
          <span class="group-count">{{ cat.examples.length }}</span>
        </div>
        <ul class="group-list">
          <li v-for="ex in cat.examples" :key="ex.id">
            <router-link
              :to="{ name: 'example', params: { techId: cat.id, exampleId: ex.id } }"
              class="example-link"
              :class="{ active: route.params.techId === cat.id && route.params.exampleId === ex.id }"
            >
              {{ ex.title }}
            </router-link>
          </li>
        </ul>
      </div>
    </nav>

    <div class="footer">共 {{ store.categories.length }} 个技术栈 · {{ store.categories.reduce((n, c) => n + c.examples.length, 0) }} 个示例</div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  flex: 0 0 var(--sidebar-w);
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  height: 100%;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
.brand-logo {
  font-size: 22px;
  color: var(--accent);
}
.brand-title {
  font-weight: 600;
  font-size: 15px;
}
.brand-sub {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
}

.nav {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.nav-home {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius);
  color: var(--text-dim);
  font-size: 14px;
  margin-bottom: 6px;
}
.nav-home:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.nav-home.active {
  background: var(--bg-hover);
  color: var(--accent);
}

.group {
  margin-bottom: 10px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}
.group-icon {
  font-size: 15px;
}
.group-name {
  flex: 1;
  font-weight: 600;
  color: var(--text);
  text-transform: none;
  letter-spacing: 0;
  font-size: 14px;
}
.group-count {
  background: var(--bg-panel-2);
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
}

.group-list {
  list-style: none;
  margin: 0;
  padding: 0 0 0 6px;
}
.example-link {
  display: block;
  padding: 7px 12px;
  margin: 2px 0;
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 13px;
  border-left: 2px solid transparent;
}
.example-link:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.example-link.active {
  background: var(--bg-hover);
  color: var(--accent);
  border-left-color: var(--accent);
}

.footer {
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
}
</style>
