import type { StyleSpecification } from 'maplibre-gl'
import { BASEMAP_DEFS, findBasemap, tileThumb, tileTemplate } from '../basemap-defs'

/**
 * 字形服务：文字图层的 text-field 需要 SDF 字形 PBF。
 * mapbox://fonts 要走 Token，这里用 OpenMapTiles 的公开字形服务，免 Token。
 */
export const MB_GLYPHS = 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf'

/** 本项目里统一用的一套字段名，方便示例之间对照 */
export const MB_FONT = 'Open Sans Regular'

export const MB_BASEMAPS = BASEMAP_DEFS.map((d) => ({
  id: d.id,
  label: d.label,
  thumb: tileThumb(d.service),
}))

/** 默认深色：数据可视化叠上去最清楚 */
export const MB_DEFAULT = 'dark'

/**
 * 用 Esri 公开栅格瓦片拼一个合法 style。
 *
 * Mapbox GL 的 style 规范本来就不要求瓦片来自 Mapbox —— 只要 raster source 指向
 * 普通 XYZ 瓦片即可，全程不会出现 mapbox:// 请求，所以不需要 accessToken。
 */
export function rasterStyle(id: string = MB_DEFAULT): StyleSpecification {
  const def = findBasemap(id)
  return {
    version: 8,
    glyphs: MB_GLYPHS,
    sources: {
      base: {
        type: 'raster',
        // Esri 的模板是 {z}/{y}/{x}，token 按名字替换，顺序无所谓
        tiles: [tileTemplate(def.service)],
        tileSize: 256,
        maxzoom: def.maxZoom,
        attribution: def.credit,
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#070c14' } },
      { id: 'base', type: 'raster', source: 'base' },
    ],
  }
}

/** 只有底色 + 字形的空样式：叠加类示例不想要底图干扰时用 */
export function blankStyle(bg = '#070c14'): StyleSpecification {
  return {
    version: 8,
    glyphs: MB_GLYPHS,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': bg } }],
  }
}

/** 在栅格底图上再叠一层，做「影像 + 深色遮罩」这类效果 */
export function rasterStyleWithOverlay(id: string, overlay = 'rgba(6,12,22,0.55)'): StyleSpecification {
  const style = rasterStyle(id)
  style.layers.push({
    id: 'shade',
    type: 'background',
    paint: { 'background-color': overlay },
  })
  return style
}
