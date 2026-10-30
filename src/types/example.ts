import type { Component } from 'vue'

/** 单个示例的元信息（小类） */
export interface ExampleMeta {
  /** 示例唯一 id，用于路由与查找 */
  id: string
  /** 展示标题 */
  title: string
  /** 简短描述 */
  description: string
  /**
   * 相对 `src/examples` 的文件路径，例如 `cesium/BasicGlobe.vue`。
   * 组件与源码都由 store 依据该路径自动解析，无需重复声明。
   */
  file: string
}

/** 技术栈大类 */
export interface TechCategory {
  /** 技术栈 id：cesium / three / openlayers / webgl */
  id: string
  /** 展示名称 */
  name: string
  /** 图标（emoji） */
  icon: string
  /** 大类描述 */
  description: string
  /** 该技术栈下的示例（小类） */
  examples: ExampleMeta[]
}

/** 示例源码加载器 */
export type SourceLoader = () => Promise<string>

/** 示例组件加载器 */
export type ComponentLoader = () => Promise<{ default: Component }>
