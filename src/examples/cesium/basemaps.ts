import * as Cesium from 'cesium'
import type { BasemapOption } from '@/types/map'
import { BASEMAP_DEFS, findBasemap, tileTemplate, tileThumb } from '../basemap-defs'

/** 底图选择面板使用的选项（带缩略图） */
export const CESIUM_BASEMAPS: BasemapOption[] = BASEMAP_DEFS.map((d) => ({
  id: d.id,
  label: d.label,
  thumb: tileThumb(d.service),
}))

/** 默认底图 id */
export const DEFAULT_BASEMAP = BASEMAP_DEFS[0].id

/** 构造 Cesium 影像提供者（免 Token 的 Esri 公共瓦片） */
export function createCesiumImagery(id: string): Cesium.ImageryProvider {
  const def = findBasemap(id)
  return new Cesium.UrlTemplateImageryProvider({
    url: tileTemplate(def.service),
    maximumLevel: def.maxZoom,
    credit: def.credit,
  })
}

/**
 * 切换底图：移除旧图层、加入新图层并压到最底层。
 * @returns 新的底图图层，调用方需保存以便下次替换
 */
export function applyCesiumBasemap(
  viewer: Cesium.Viewer,
  id: string,
  prev: Cesium.ImageryLayer | null,
): Cesium.ImageryLayer {
  if (prev) viewer.imageryLayers.remove(prev, true)
  const layer = viewer.imageryLayers.addImageryProvider(createCesiumImagery(id))
  viewer.imageryLayers.lowerToBottom(layer)
  return layer
}
