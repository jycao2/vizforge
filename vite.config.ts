import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cesium from 'vite-plugin-cesium'
import { fileURLToPath, URL } from 'node:url'

/**
 * 部署到 GitHub Pages 时站点位于 https://<user>.github.io/<repo>/ 子路径下。
 *
 * 这里用相对 base 而不是 `/<repo>/`，原因是 vite-plugin-cesium 会把 Cesium 静态资源拷到
 * `outDir + base + '/cesium'`（见其 dist/index.js 的 copy 逻辑）：
 *  - base 为 `/repo/` 时，资源落到 `dist/repo/cesium/`，但 Pages 把上传的 dist 根映射成
 *    `/repo/`，浏览器请求 `/repo/cesium/Cesium.js` 实际找的是 `dist/cesium/` —— 404。
 *  - base 为 `./` 时，资源落到 `dist/cesium/`，页面里引用 `./cesium/Cesium.js` 在
 *    `/repo/index.html` 下正好解析成 `/repo/cesium/Cesium.js` —— 命中。
 * 本项目是 hash 路由的 SPA，页面路径恒为 `/repo/index.html`，相对路径不会因路由变化而失效。
 * 本地开发仍用根路径，避免 dev server 多套一层前缀。
 */
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? './' : '/',
  plugins: [vue(), cesium()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
})
