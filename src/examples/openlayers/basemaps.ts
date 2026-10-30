import XYZ from 'ol/source/XYZ'
import type TileSource from 'ol/source/Tile'
import type TileLayer from 'ol/layer/Tile'
import type { BasemapOption } from '@/types/map'
import { BASEMAP_DEFS, findBasemap, tileTemplate, tileThumb } from '../basemap-defs'

/** 底图选择面板使用的选项（带缩略图） */
export const OL_BASEMAPS: BasemapOption[] = BASEMAP_DEFS.map((d) => ({
  id: d.id,
  label: d.label,
  thumb: tileThumb(d.service),
}))

/** 默认底图 id */
export const DEFAULT_BASEMAP = BASEMAP_DEFS[0].id

/** 构造 OpenLayers 瓦片数据源（免 Token 的 Esri 公共瓦片） */
export function createOlSource(id: string): TileSource {
  const def = findBasemap(id)
  return new XYZ({
    url: tileTemplate(def.service),
    maxZoom: def.maxZoom,
    attributions: def.credit,
    crossOrigin: 'anonymous',
  })
}

/** 切换底图：直接替换瓦片图层的 source */
export function applyOlBasemap(layer: TileLayer<TileSource> | null, id: string): void {
  layer?.setSource(createOlSource(id))
}
