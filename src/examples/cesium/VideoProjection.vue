<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import * as Cesium from 'cesium'
import type { Viewer } from 'cesium'
import { useCesiumView, VIEWER_OPTIONS } from './useCesium'
import { applyCesiumBasemap } from './basemaps'

/* ============================================================
 * 视频投射融合（Cesium 大屏常用功能）
 *  - 把 HTMLVideoElement 当纹理贴到矩形几何上（MaterialAppearance + 自定义 fabric）
 *  - 片元里按 st 做四边羽化，边缘自然融入底图，不是生硬的「贴了一块视频」
 *  - 视频元素做 uniform 必须显式打 type: 'sampler2D'（Cesium 的类型白名单不含 video）
 *  - 叠加一个发光边框与地面基座，模拟「投影到广场」的效果
 * ============================================================ */

const container = ref<HTMLDivElement>()
const viewerRef = shallowRef<Viewer | null>(null)
const DEFAULTS = { opacity: 0.95, feather: 0.14, boost: 1.15, playing: true } // 融合不透明度 / 四边羽化 / 亮度提升 / 播放状态
const opacity = ref(DEFAULTS.opacity)
const feather = ref(DEFAULTS.feather)
const boost = ref(DEFAULTS.boost)
const playing = ref(DEFAULTS.playing)
const label = ref('')

const VIDEO = 'https://static-assets.mapbox.com/mapbox-gl-js/drone.mp4'

// 投影区域：杭州钱江新城核心区（约 1.2km × 0.8km）
const RECT = { west: 120.204, south: 30.2385, east: 120.2165, north: 30.2472 }
const CENTER = [(RECT.west + RECT.east) / 2, (RECT.south + RECT.north) / 2]

let video: HTMLVideoElement | null = null
let material: Cesium.Material | null = null
let panelPrim: Cesium.Primitive | null = null
let framePrim: Cesium.Primitive | null = null
let removePreRender: (() => void) | null = null

function getViewer() {
  return viewerRef.value
}

const { reset } = useCesiumView(getViewer, () => ({
  // 相机不能贴太低：影像服务在高倍率下会回「Map data not yet available」灰瓦片
  destination: Cesium.Cartesian3.fromDegrees(CENTER[0], CENTER[1] - 0.012, 2600),
  orientation: { heading: 0.05, pitch: Cesium.Math.toRadians(-48), roll: 0 },
  focus: {
    center: Cesium.Cartesian3.fromDegrees(CENTER[0], CENTER[1], 0),
    radius: 1100,
    range: 2700,
  },
}))

/** 自定义 fabric：视频纹理 + 四边羽化 + 亮度提升 */
function buildMaterial(v: HTMLVideoElement) {
  // Cesium 的 Material.getUniformType 白名单里只有 string / Resource / canvas /
  // image / ImageBitmap / OffscreenCanvas，HTMLVideoElement 会被判定为「非法类型」
  // 直接抛 DeveloperError。给元素补一个 type 标记让类型判定短路，
  // 后面的纹理更新逻辑仍然是按 instanceof HTMLVideoElement 走逐帧 copyFrom 的。
  ;(v as unknown as { type: string }).type = 'sampler2D'

  return new Cesium.Material({
    fabric: {
      type: 'ProjectionVideo',
      uniforms: {
        image: v,
        uOpacity: opacity.value,
        uFeather: feather.value,
        uBoost: boost.value,
      },
      source: /* glsl */ `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          vec2 st = materialInput.st;
          vec3 col = texture(image, vec2(st.x, 1.0 - st.y)).rgb;

          // 四边羽化：越靠边越透明，视频与底图无缝衔接
          float fx = smoothstep(0.0, uFeather, st.x) * smoothstep(1.0, 1.0 - uFeather, st.x);
          float fy = smoothstep(0.0, uFeather, st.y) * smoothstep(1.0, 1.0 - uFeather, st.y);
          float edge = fx * fy;

          // 轻微提亮 + 边缘冷色描边（投影幕布质感）
          col = pow(col, vec3(0.92)) * uBoost;
          float rim = (1.0 - edge) * 0.35;
          col += vec3(0.25, 0.65, 0.95) * rim;

          material.diffuse = col;
          material.alpha = edge * uOpacity;
          return material;
        }
      `,
    },
    translucent: true,
  })
}

onMounted(() => {
  const el = container.value
  if (!el) return

  // 1. 视频元素（必须先 canplay 再建纹理，否则首帧是黑的）
  video = document.createElement('video')
  video.src = VIDEO
  video.crossOrigin = 'anonymous'
  video.loop = true
  video.muted = true
  video.playsInline = true
  video.style.display = 'none'
  document.body.appendChild(video)

  const viewer = new Cesium.Viewer(el, {
    ...VIEWER_OPTIONS,
    shouldAnimate: true,
  })
  viewerRef.value = viewer
  // Esri 矢量底图在中国区高倍率下没有数据（回「not yet available」灰瓦片），这页用影像底图
  applyCesiumBasemap(viewer, 'imagery', null)
  viewer.scene.globe.depthTestAgainstTerrain = false

  video.play().catch(() => {
    label.value = '视频需手动播放（浏览器策略）'
  })

  const start = () => {
    if (!video || viewer.isDestroyed()) return
    label.value = `${video.videoWidth}×${video.videoHeight} · ${video.currentTime.toFixed(1)}s`

    const rectangle = Cesium.Rectangle.fromDegrees(RECT.west, RECT.south, RECT.east, RECT.north)

    // 2. 地面基座（深色石板 + 边框），让投影有「落点」
    const baseGeo = new Cesium.RectangleGeometry({
      rectangle,
      height: 6,
    })
    panelPrim = viewer.scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: baseGeo,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString('#0c1620').withAlpha(0.92),
            ),
          },
        }),
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: false,
        }),
        asynchronous: false,
      }),
    )

    // 3. 视频面（抬高到基座上方，避免 z-fighting）
    material = buildMaterial(video)
    const videoGeo = new Cesium.RectangleGeometry({
      rectangle,
      height: 8,
    })
    framePrim = viewer.scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry: videoGeo }),
        appearance: new Cesium.MaterialAppearance({
          material,
          translucent: true,
          closed: false,
        }),
        asynchronous: false,
      }),
    )

    // 4. 标量 uniform 每帧同步一次：Material 里的数字不会自己跟着 Vue ref 走；
    //    视频帧本身由 Cesium 在 update 里 texture.copyFrom 逐帧上传，重赋同一元素是空操作
    const postRender = viewer.scene.postRender.addEventListener(() => {
      if (!material || !video || viewer.isDestroyed()) return
      material.uniforms.image = video
      material.uniforms.uOpacity = opacity.value
      material.uniforms.uFeather = feather.value
      material.uniforms.uBoost = boost.value
    })
    removePreRender = () => postRender()
  }

  if (video.readyState >= 2) start()
  else video.addEventListener('loadeddata', start, { once: true })

  // 每 0.5 秒更新一次状态文字
  const timer = window.setInterval(() => {
    if (!video || viewer.isDestroyed()) return
    label.value = `${video.videoWidth}×${video.videoHeight} · ${video.currentTime.toFixed(1)}s / ${video.duration.toFixed(1)}s`
  }, 500)

  timerId = timer
})

let timerId = 0
onBeforeUnmount(() => {
  window.clearInterval(timerId)
  removePreRender?.()
  removePreRender = null
  const v = viewerRef.value
  if (v && !v.isDestroyed()) {
    if (panelPrim) v.scene.primitives.remove(panelPrim)
    if (framePrim) v.scene.primitives.remove(framePrim)
    v.destroy()
  }
  viewerRef.value = null
  if (video) {
    video.pause()
    video.remove()
    video = null
  }
})

/** 复位视角 + 参数 + 播放状态一起还原：只飞相机的话，调过滑杆的用户点下去画面纹丝不动 */
function resetAll() {
  opacity.value = DEFAULTS.opacity
  feather.value = DEFAULTS.feather
  boost.value = DEFAULTS.boost
  if (playing.value !== DEFAULTS.playing) togglePlay()
  reset()
}

function togglePlay() {
  if (!video) return
  if (video.paused) {
    video.play()
    playing.value = true
  } else {
    video.pause()
    playing.value = false
  }
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="cesium-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">不透明度</span>
        <input
          class="range"
          type="range"
          min="0.1"
          max="1"
          step="0.01"
          :value="opacity"
          @input="opacity = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ opacity.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">边缘羽化</span>
        <input
          class="range"
          type="range"
          min="0"
          max="0.4"
          step="0.01"
          :value="feather"
          @input="feather = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ feather.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">亮度增益</span>
        <input
          class="range"
          type="range"
          min="0.6"
          max="1.8"
          step="0.05"
          :value="boost"
          @input="boost = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ boost.toFixed(2) }}</span>
      </div>
      <div class="row">
        <button class="btn" @click="togglePlay">{{ playing ? '暂停视频' : '播放视频' }}</button>
        <button class="btn" @click="resetAll()">复位</button>
      </div>
      <div class="meta">{{ label }}</div>
      <div class="tip">
        HTMLVideoElement 直接当纹理：Material fabric 里按 st 采样，四边 smoothstep 羽化后与底图融合。
        坑：Cesium 的 uniform 类型白名单不含 video 元素，必须显式打 type: 'sampler2D' 才不报 DeveloperError。
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.cesium-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 310px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.label {
  font-size: 12px;
  color: #9fb0c2;
  white-space: nowrap;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  font-size: 12px;
  color: #7ee787;
  width: 42px;
  text-align: right;
}
.meta {
  font-size: 11.5px;
  color: #7ee787;
  margin: 2px 0 4px;
}
.tip {
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
.btn {
  padding: 3px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.5);
  background: rgba(30, 42, 60, 0.7);
  color: #9fd0ff;
  cursor: pointer;
}
</style>
