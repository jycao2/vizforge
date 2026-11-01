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
  /**
   * 依赖预构建缓存换个位置。
   *
   * 默认的 node_modules/.vite 在「config 变更后重新优化」时会被整目录清空，
   * 而带删除保护的运行环境（一次性删 200+ 文件会被拦）会让 dev server 直接退出。
   * 换到 .cache 下只影响本地开发，构建产物不变。
   */
  cacheDir: 'node_modules/.cache/vite',
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
  optimizeDeps: {
    /**
     * 显式列出全部 OpenLayers 入口。
     *
     * 不写的话，dev server 运行中一旦从新加的文件里发现没预构建过的 ol 子模块，
     * 就会触发「重新优化 + 重启」——中间要整目录删除 deps_temp（200+ 文件），
     * 在带删除保护的运行环境里直接让进程退出。列全之后，新增示例不会再触发。
     */
    include: [
      'ol',
      'ol/Feature',
      'ol/ImageTile',
      'ol/Map',
      'ol/View',
      'ol/control',
      'ol/control/OverviewMap',
      'ol/coordinate',
      'ol/events/condition',
      'ol/format/GeoJSON',
      'ol/format/MVT',
      'ol/geom',
      'ol/geom/Circle',
      'ol/geom/LineString',
      'ol/geom/MultiLineString',
      'ol/geom/Point',
      'ol/geom/Polygon',
      'ol/interaction/DragBox',
      'ol/interaction/Draw',
      'ol/interaction/Modify',
      'ol/interaction/Select',
      'ol/interaction/Snap',
      'ol/layer/Heatmap',
      'ol/layer/Image',
      'ol/layer/Tile',
      'ol/layer/Vector',
      'ol/layer/VectorTile',
      'ol/proj',
      'ol/render/Event',
      'ol/render/Feature',
      'ol/source/Cluster',
      'ol/source/ImageCanvas',
      'ol/source/ImageStatic',
      'ol/source/Tile',
      'ol/source/TileImage',
      'ol/source/TileWMS',
      'ol/source/Vector',
      'ol/source/VectorTile',
      'ol/source/XYZ',
      'ol/sphere',
      'ol/style',
      'ol/style/Circle',
      'ol/style/Fill',
      'ol/style/Stroke',
      'ol/style/Style',
      'ol/tilegrid',
    ],
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
})
