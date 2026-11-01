import { ref } from 'vue'
import type Map from 'ol/Map'
import type { Coordinate } from 'ol/coordinate'
import TileLayer from 'ol/layer/Tile'
import type TileSource from 'ol/source/Tile'
import { DEFAULT_BASEMAP, applyOlBasemap, createOlSource } from './basemaps'
import { provideMapHost } from '@/components/mapHost'

/** 视图操作：放大 / 缩小 / 复位 / 全屏 */
export function useOlView(getMap: () => Map | null, home: Coordinate, homeZoom: number) {
  // 把 map 暴露给工具栏（测距/测面），页面无需额外传参
  provideMapHost(() => {
    const m = getMap()
    return m ? { kind: 'ol', instance: m } : null
  })

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

/**
 * 只把地图实例交给工具栏（量测用），不接管缩放与复位。
 * 给那些自己实现了工具栏逻辑、没有调用 useOlView 的示例用，一行接入。
 */
export function useOlHost(getMap: () => Map | null): void {
  provideMapHost(() => {
    const m = getMap()
    return m ? { kind: 'ol', instance: m } : null
  })
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
