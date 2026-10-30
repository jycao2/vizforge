<script setup lang="ts">
import Sidebar from '@/components/Sidebar.vue'
</script>

<template>
  <div class="layout">
    <Sidebar />
    <main class="main">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  height: 100%;
  width: 100%;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-app);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
