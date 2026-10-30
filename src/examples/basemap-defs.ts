/**
 * 底图统一定义（Cesium / OpenLayers 共用）。
 *
 * 全部使用 Esri ArcGIS Online 的公开瓦片服务：
 * - 无需 Token、无 API Key 水印；
 * - 响应头带 `Access-Control-Allow-Origin: *`，可被 WebGL 当作纹理使用（Cesium 必需）；
 * - 瓦片编号遵循 XYZ 规则（TMS 之外的 {z}/{y}/{x} 形式）。
 *
 * 注意：CARTO 的 basemaps 现已强制要求 API Key（直接返回「API KEY REQUIRED」水印瓦片），
 * OpenStreetMap 官方瓦片服务会对非规范客户端返回 403，故此处不再使用。
 */
export interface BasemapDef {
  id: string
  label: string
  /** ArcGIS REST 服务路径（拼在 host 之后） */
  service: string
  /** 该服务支持的最大层级，超出后会返回空白瓦片 */
  maxZoom: number
  credit: string
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services'

export const BASEMAP_DEFS: BasemapDef[] = [
  {
    id: 'street',
    label: '矢量',
    service: 'World_Street_Map',
    maxZoom: 19,
    credit: '© Esri, HERE, Garmin, © OpenStreetMap contributors',
  },
  {
    id: 'imagery',
    label: '影像',
    service: 'World_Imagery',
    maxZoom: 19,
    credit: '© Esri, Maxar, Earthstar Geographics',
  },
  {
    id: 'terrain',
    label: '地形',
    service: 'World_Topo_Map',
    maxZoom: 19,
    credit: '© Esri, HERE, Garmin, USGS',
  },
  {
    id: 'light',
    label: '浅色',
    service: 'Canvas/World_Light_Gray_Base',
    maxZoom: 16,
    credit: '© Esri',
  },
  {
    id: 'dark',
    label: '深色',
    service: 'Canvas/World_Dark_Gray_Base',
    maxZoom: 16,
    credit: '© Esri',
  },
]

/** 瓦片模板，z/y/x 为占位符 */
export function tileTemplate(service: string): string {
  return `${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`
}

/** 缩略图：取 z4/x13/y6 这张（东亚区域，带地形与路网细节），用于底图选择面板 */
export function tileThumb(service: string): string {
  return `${ESRI}/${service}/MapServer/tile/4/6/13`
}

export function findBasemap(id: string): BasemapDef {
  return BASEMAP_DEFS.find((d) => d.id === id) ?? BASEMAP_DEFS[0]
}
