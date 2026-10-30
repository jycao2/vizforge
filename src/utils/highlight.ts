import hljs from 'highlight.js/lib/core'
import xml from 'highlight.js/lib/languages/xml'
import javascript from 'highlight.js/lib/languages/javascript'
import css from 'highlight.js/lib/languages/css'

// 只注册需要的语言，控制打包体积。
// highlight.js 的 xml 语法会对 <script> 使用 javascript 子语言、
// 对 <style> 使用 css 子语言，正好适配 .vue 单文件组件。
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('css', css)

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 把 Vue 单文件组件源码高亮为带 <span class="hljs-*"> 的 HTML 字符串。
 * 以 xml 作为主语法，template 标签 / script 中的 JS / style 中的 CSS 都会被着色。
 */
export function highlightVue(code: string): string {
  if (!code) return ''
  try {
    return hljs.highlight(code, { language: 'xml', ignoreIllegals: true }).value
  } catch {
    return escapeHtml(code)
  }
}
