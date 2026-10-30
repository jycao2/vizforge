import { ref } from 'vue'
import type Map from 'ol/Map'
import type { Coordinate } from 'ol/coordinate'
import TileLayer from 'ol/layer/Tile'
import type TileSource from 'ol/source/Tile'
import { DEFAULT_BASEMAP, applyOlBasemap, createOlSource } from './basemaps'

/** 视图操作：放大 / 缩小 / 复位 / 全屏 */
export function useOlView(getMap: () => Map | null, home: Coordinate, homeZoom: number) {
  function zoomBy(delta: number) {
    const view = getMap()?.getView()
    if (!view) return
    view.animate({ zoom: (view.getZoom() ?? 0) + delta, duration: 200 })
  }
  function reset() {
    getMap()?.getView().animate({ center: home, zoom: homeZoom, duration: 320 })
  }
  async function toggleFullscreen(el?: HTMLElement) {
    if (!el) return
    if (document.fullscreenElement) await document.exitFullscreen()
    else await el.requestFullscreen()
  }
  return { zoomBy, reset, toggleFullscreen }
}

/** 底图：创建图层并支持切换 */
export function useOlBasemap(initial = DEFAULT_BASEMAP) {
  const current = ref(initial)
  let layer: TileLayer<TileSource> | null = null

  function create(): TileLayer<TileSource> {
    layer = new TileLayer({ source: createOlSource(current.value) })
    return layer
  }
  function apply(id: string) {
    applyOlBasemap(layer, id)
    current.value = id
  }
  function getLayer() {
    return layer
  }

  return { current, create, apply, getLayer }
}
