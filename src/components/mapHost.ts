/**
 * 地图宿主注入契约
 * ===========================================================================
 * 工具栏（MapControls）在几乎所有示例里都会出现，但它是纯 UI 组件，拿不到地图实例。
 * 让 40 多个页面各自把 map/viewer 传进来既啰嗦又容易漏，所以反过来做：
 *
 *   useOlView / useCesiumView 在 setup 阶段 provide 一个「取实例」的函数，
 *   MapControls 用 inject 拿到它 —— 页面代码一行都不用改。
 *
 * 取实例是函数而不是值：地图在 onMounted 里才创建，provide 时还是 null。
 */
import { inject, provide, type InjectionKey } from 'vue'

export type MapHostKind = 'ol' | 'cesium'

export interface MapHost {
  kind: MapHostKind
  instance: unknown
}

export type MapHostGetter = () => MapHost | null

export const MAP_HOST_KEY: InjectionKey<MapHostGetter> = Symbol('vizforge:map-host')

/** 在页面脚手架里调用（必须处于 setup 同步阶段） */
export function provideMapHost(getter: MapHostGetter): void {
  provide(MAP_HOST_KEY, getter)
}

/** 在工具栏里调用 */
export function useMapHost(): MapHostGetter | null {
  return inject(MAP_HOST_KEY, null)
}
