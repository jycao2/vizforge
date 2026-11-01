<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import MapControls from '@/components/MapControls.vue'
import { CESIUM_BASEMAPS } from './basemaps'
import { VIEWER_OPTIONS, useCesiumBasemap, useCesiumView } from './useCesium'

/**
 * Cesium 后期处理链（PostProcessStage）
 *
 * 场景：陆家嘴夜城。楼群是拉伸多边形，窗户/路灯是 PointPrimitiveCollection
 * （3000+ 个只 1 个 draw call），画面本身就有明暗层次，效果才看得出来。
 *
 * 演示三件事：
 *  1. 内置效果库 PostProcessStageLibrary：夜视 / 边缘检测 / 黑白 / 景深
 *  2. 自定义 PostProcessStage：写 GLSL 的片段着色器，把整帧当纹理处理
 *  3. 多段串联：曝光（Brightness）常驻，效果段叠在其后面按顺序执行
 */

const wrapRef = ref<HTMLDivElement>()
const container = ref<HTMLDivElement>()
let viewer: Cesium.Viewer | null = null

const LON = 121.4997
const LAT = 31.2397
const GRID = 12 // 12 × 12 个街区
const STEP = 118 // 街区中心间距 m
const FOOT = 76 // 楼体边长 m

const home = {
  destination: Cesium.Cartesian3.fromDegrees(LON, LAT - 0.0036, 720),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-38), roll: 0 },
}

const { zoomIn, zoomOut, reset, toggleFullscreen } = useCesiumView(
  () => viewer,
  () => home,
)
const { current: currentBasemap, apply: applyBasemap } = useCesiumBasemap(() => viewer, 'dark')

/* ---------------- 参数 ---------------- */

type EffectKind = 'none' | 'night' | 'edge' | 'bw' | 'dof' | 'mosaic' | 'scan'

const EFFECTS: Array<{ id: EffectKind; label: string; stage: string }> = [
  { id: 'none', label: '原图', stage: '—' },
  { id: 'night', label: '夜视', stage: 'NightVision' },
  { id: 'edge', label: '描边', stage: '自定义 · Sobel' },
  { id: 'bw', label: '黑白', stage: 'BlackAndWhite' },
  { id: 'dof', label: '景深', stage: 'DepthOfField' },
  { id: 'mosaic', label: '像素化', stage: '自定义 · Mosaic' },
  { id: 'scan', label: '扫描线', stage: '自定义 · Scanline' },
]

const effect = ref<EffectKind>('night')
const exposure = ref(1.1)
const focus = ref(1600)
const blockSize = ref(160)
const edgeGain = ref(2.2)
const fxaa = ref(true)
const dofSupported = ref(true)
const stats = ref({ buildings: 0, lights: 0, fps: 0 })
const pipelineText = computed(() => {
  const e = EFFECTS.find((x) => x.id === effect.value)
  return e && e.id !== 'none' ? `Brightness → ${e.stage}` : 'Brightness'
})

/* ---------------- 场景内容 ---------------- */

/** 固定种子的伪随机，保证每次进入城市形态一致 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 以场地中心为原点的局部平面偏移 → 经纬度（米制近似，几十公里内误差可忽略） */
function offset(lon: number, lat: number, dx: number, dy: number): [number, number] {
  return [lon + dx / (111320 * Math.cos(Cesium.Math.toRadians(lat))), lat + dy / 110540]
}

let lightTick = 0
const warnLights: Cesium.PointPrimitive[] = []

function buildCity(v: Cesium.Viewer) {
  const rand = rng(20261101)
  const buildings = v.entities
  const lightColl = new Cesium.PointPrimitiveCollection()
  v.scene.primitives.add(lightColl)

  const half = ((GRID - 1) / 2) * STEP
  let bcount = 0

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const cx = gx * STEP - half
      const cy = gy * STEP - half
      const r = Math.hypot(cx, cy)
      // 中心高、外围低的城市天际线；约 1/5 的街区留作绿地
      if (rand() < 0.16) continue
      const h = 45 + 235 * Math.exp(-((r / 520) ** 2)) * (0.45 + 0.55 * rand())
      const jx = (rand() - 0.5) * 14
      const jy = (rand() - 0.5) * 14
      bcount++
      const [lon, lat] = offset(LON, LAT, cx + jx, cy + jy)
      const hw = FOOT / 2 / (111320 * Math.cos(Cesium.Math.toRadians(LAT)))
      const hh = FOOT / 2 / 110540

      // 楼体：高度分档取色，越高的楼越亮
      const t = Math.min(1, h / 280)
      const color = Cesium.Color.lerp(
        Cesium.Color.fromCssColorString('#243447'),
        Cesium.Color.fromCssColorString('#7c93ae'),
        t,
        new Cesium.Color(),
      )
      buildings.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray([
              lon - hw, lat - hh,
              lon + hw, lat - hh,
              lon + hw, lat + hh,
              lon - hw, lat + hh,
            ]),
          ),
          height: 0,
          extrudedHeight: h,
          material: color,
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#0b1119').withAlpha(0.85),
        },
      })

      // 屋盖：1m 厚的浅色薄片，给立方体一个"顶面"，侧面和顶面才有层次
      buildings.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray([
              lon - hw, lat - hh,
              lon + hw, lat - hh,
              lon + hw, lat + hh,
              lon - hw, lat + hh,
            ]),
          ),
          height: h,
          extrudedHeight: h + 1.2,
          material: Cesium.Color.lerp(color, Cesium.Color.WHITE, 0.18, new Cesium.Color()),
        },
      })

      // 窗户灯：沿四个立面撒点，略微外挑 0.8m，避免被楼体挡在内部
      const floors = Math.max(4, Math.floor(h / 22))
      const warm = rand() < 0.62
      for (let f = 1; f < floors; f++) {
        const y = (h * f) / floors
        for (let s = 0; s < 4; s++) {
          if (rand() < 0.32) continue
          const u = (rand() - 0.5) * FOOT * 0.92
          const side = s < 2 ? 1 : -1
          const along = s % 2 === 0
          const [plon, plat] = offset(
            LON,
            LAT,
            cx + jx + (along ? u : side * (FOOT / 2 + 0.8)),
            cy + jy + (along ? side * (FOOT / 2 + 0.8) : u),
          )
          lightColl.add({
            position: Cesium.Cartesian3.fromDegrees(plon, plat, y),
            pixelSize: 2.4 + rand() * 2,
            color: warm
              ? Cesium.Color.fromCssColorString('#ffcf80')
              : Cesium.Color.fromCssColorString('#9fd4ff'),
          })
        }
      }

      // 超高层顶灯：红色航空障碍灯，闪烁
      if (h > 190) {
        const [tl, tt] = offset(LON, LAT, cx + jx, cy + jy)
        const p = lightColl.add({
          position: Cesium.Cartesian3.fromDegrees(tl, tt, h + 3),
          pixelSize: 6,
          color: Cesium.Color.fromCssColorString('#ff4433'),
        })
        warnLights.push(p)
      }
    }
  }

  // 路灯：街区路口的暖色小球
  const roadColl = new Cesium.PointPrimitiveCollection()
  v.scene.primitives.add(roadColl)
  for (let gy = 0; gy <= GRID; gy++) {
    for (let gx = 0; gx <= GRID; gx++) {
      const [lon, lat] = offset(LON, LAT, gx * STEP - half - STEP / 2, gy * STEP - half - STEP / 2)
      roadColl.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 8),
        pixelSize: 4,
        color: Cesium.Color.fromCssColorString('#ffb45e').withAlpha(0.8),
      })
    }
  }

  stats.value.buildings = bcount
  stats.value.lights = lightColl.length + roadColl.length
}

/* ---------------- 后期处理链 ---------------- */

let brightness: Cesium.PostProcessStage | null = null
let current: Cesium.PostProcessStage | Cesium.PostProcessStageComposite | null = null

const SOBEL_FS = `
uniform sampler2D colorTexture;
uniform float uGain;
uniform vec3 uEdge;
in vec2 v_textureCoordinates;

float lum(vec2 uv) {
  return dot(texture(colorTexture, uv).rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  // 3×3 邻域做 Sobel，亮度梯度大的地方就是轮廓
  vec2 t = 1.0 / vec2(textureSize(colorTexture, 0));
  vec2 uv = v_textureCoordinates;
  float tl = lum(uv + vec2(-t.x,  t.y)), tc = lum(uv + vec2(0.0,  t.y)), tr = lum(uv + vec2(t.x,  t.y));
  float ml = lum(uv + vec2(-t.x,  0.0)),                                mr = lum(uv + vec2(t.x,  0.0));
  float bl = lum(uv + vec2(-t.x, -t.y)), bc = lum(uv + vec2(0.0, -t.y)), br = lum(uv + vec2(t.x, -t.y));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -bl - 2.0 * bc - br + tl + 2.0 * tc + tr;
  float g = clamp(sqrt(gx * gx + gy * gy) * uGain, 0.0, 1.0);
  vec3 base = texture(colorTexture, uv).rgb;
  out_FragColor = vec4(mix(base * 0.55, uEdge, g), 1.0);
}
`

const MOSAIC_FS = `
uniform sampler2D colorTexture;
uniform float uBlock;
in vec2 v_textureCoordinates;

void main() {
  // 把 uv 吸附到 block 网格中心，整帧就成了马赛克
  vec2 uv = (floor(v_textureCoordinates * uBlock) + 0.5) / uBlock;
  out_FragColor = texture(colorTexture, uv);
}
`

const SCAN_FS = `
uniform sampler2D colorTexture;
uniform float uStrength;
uniform float uShift;
in vec2 v_textureCoordinates;

void main() {
  vec2 uv = v_textureCoordinates;
  // 三通道错位：模拟镜头色散
  float r = texture(colorTexture, uv + vec2(uShift, 0.0)).r;
  float g = texture(colorTexture, uv).g;
  float b = texture(colorTexture, uv - vec2(uShift, 0.0)).b;
  vec3 col = vec3(r, g, b);
  // 扫描线：每 3 像素压暗一条
  float line = 0.5 + 0.5 * sin(uv.y * 1400.0);
  col *= 1.0 - uStrength * line * 0.55;
  out_FragColor = vec4(col, 1.0);
}
`

function makeStage(kind: EffectKind): Cesium.PostProcessStage | Cesium.PostProcessStageComposite | null {
  const lib = Cesium.PostProcessStageLibrary
  switch (kind) {
    case 'night':
      return lib.createNightVisionStage()
    case 'edge':
      return new Cesium.PostProcessStage({
        name: 'vz_sobel',
        fragmentShader: SOBEL_FS,
        uniforms: { uGain: () => edgeGain.value, uEdge: () => Cesium.Color.fromCssColorString('#8ef0ff') },
      })
    case 'bw':
      return lib.createBlackAndWhiteStage()
    case 'dof': {
      const stage = lib.createDepthOfFieldStage()
      // 复合阶段里第 0 段才是景深本身，焦距走它的 uniforms
      stage.get(0).uniforms.focalDistance = focus.value
      return stage
    }
    case 'mosaic':
      return new Cesium.PostProcessStage({
        name: 'vz_mosaic',
        fragmentShader: MOSAIC_FS,
        uniforms: { uBlock: () => blockSize.value },
      })
    case 'scan':
      return new Cesium.PostProcessStage({
        name: 'vz_scanline',
        fragmentShader: SCAN_FS,
        uniforms: { uStrength: () => 0.85, uShift: () => 1.6 / 1440 },
      })
    default:
      return null
  }
}

function applyEffect(kind: EffectKind) {
  if (!viewer) return
  const stages = viewer.scene.postProcessStages
  if (current) {
    stages.remove(current)
    current = null
  }
  current = makeStage(kind)
  if (current) stages.add(current)
}

watch(effect, (k) => applyEffect(k))
watch(exposure, (x) => {
  if (brightness) brightness.uniforms.brightness = x
})
watch(focus, (f) => {
  // 拖焦距时不必重建，直接改当前景深段的 uniform
  if (current && effect.value === 'dof' && 'get' in current) {
    current.get(0).uniforms.focalDistance = f
  }
})
watch(fxaa, (on) => {
  if (viewer) viewer.scene.postProcessStages.fxaa.enabled = on
})

/* ---------------- 生命周期 ---------------- */

onMounted(() => {
  if (!container.value) return
  viewer = new Cesium.Viewer(container.value, { ...VIEWER_OPTIONS })
  applyBasemap(currentBasemap.value)

  const scene = viewer.scene
  scene.globe.enableLighting = false
  // 关掉大气散射，天空留成星空，城市才像夜里
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
  scene.globe.showGroundAtmosphere = false
  scene.fog.enabled = false
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#050a12')

  viewer.camera.setView(home)
  buildCity(viewer)

  dofSupported.value = Cesium.PostProcessStageLibrary.isDepthOfFieldSupported(scene)

  brightness = Cesium.PostProcessStageLibrary.createBrightnessStage()
  brightness.uniforms.brightness = exposure.value
  scene.postProcessStages.add(brightness)
  scene.postProcessStages.fxaa.enabled = fxaa.value
  applyEffect(effect.value)

  // 航空障碍灯闪烁 + FPS 统计
  scene.preRender.addEventListener(() => {
    lightTick++
    if (lightTick % 30 === 0) {
      const on = lightTick % 60 === 0
      for (const p of warnLights) {
        p.show = on
      }
    }
  })
  // 自建帧率统计（scene.frameState 不在公开类型里，别依赖它）
  let frames = 0
  scene.preRender.addEventListener(() => {
    frames++
  })
  const timer = window.setInterval(() => {
    stats.value.fps = frames * 2
    frames = 0
  }, 500)
  onBeforeUnmount(() => window.clearInterval(timer))
})

onBeforeUnmount(() => {
  warnLights.length = 0
  brightness = null
  current = null
  if (viewer && !viewer.isDestroyed()) viewer.destroy()
  viewer = null
})
</script>

<template>
  <div ref="wrapRef" class="map-wrap">
    <div ref="container" class="cesium-container"></div>

    <MapControls
      :basemaps="CESIUM_BASEMAPS"
      :model-value="currentBasemap"
      @update:model-value="applyBasemap"
      @zoom-in="zoomIn"
      @zoom-out="zoomOut"
      @reset="reset"
      @fullscreen="toggleFullscreen(wrapRef)"
    />

    <div class="panel">
      <div class="title">
        <span class="dot"></span>
        后期处理 · 全屏特效链
      </div>
      <div class="sub">当前管线：{{ pipelineText }}</div>

      <div class="chips">
        <button
          v-for="e in EFFECTS"
          :key="e.id"
          class="chip"
          :class="{ on: effect === e.id }"
          :disabled="e.id === 'dof' && !dofSupported"
          @click="effect = e.id"
        >
          {{ e.label }}
        </button>
      </div>

      <div class="ctrl">
        <span class="lab">曝光</span>
        <input v-model.number="exposure" type="range" min="0.4" max="2.4" step="0.05" />
        <b>{{ exposure.toFixed(2) }}<i>×</i></b>
      </div>
      <div v-if="effect === 'dof'" class="ctrl">
        <span class="lab">焦距</span>
        <input v-model.number="focus" type="range" min="200" max="6000" step="50" />
        <b>{{ focus }}<i>m</i></b>
      </div>
      <div v-if="effect === 'edge'" class="ctrl">
        <span class="lab">强度</span>
        <input v-model.number="edgeGain" type="range" min="0.6" max="6" step="0.1" />
        <b>{{ edgeGain.toFixed(1) }}</b>
      </div>
      <div v-if="effect === 'mosaic'" class="ctrl">
        <span class="lab">像素块</span>
        <input v-model.number="blockSize" type="range" min="40" max="420" step="10" />
        <b>{{ blockSize }}<i>px</i></b>
      </div>

      <div class="row">
        <button class="chip" :class="{ on: fxaa }" @click="fxaa = !fxaa">
          FXAA {{ fxaa ? '开' : '关' }}
        </button>
        <span class="stat">{{ stats.buildings }} 栋 · {{ stats.lights }} 灯光点 · {{ stats.fps }} fps</span>
      </div>

      <div class="tip">
        效果段按加入顺序串成一条链：常驻 <b>Brightness</b> 打底，选中效果叠在后面。
        夜视 / 黑白 / 景深来自内置库；描边（Sobel）、像素化、扫描线是<b>自己写的 GLSL</b>——
        <code>colorTexture</code> 就是整帧，<code>v_textureCoordinates</code> 是屏幕 uv。
        景深依赖 <code>WEBGL_depth_texture</code>，不支持时按钮自动禁用。
      </div>
    </div>
  </div>
</template>

<style scoped>
.map-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
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
  width: 322px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(10, 15, 22, 0.9);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.42);
}
.title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #7fe3ff;
  box-shadow: 0 0 9px #7fe3ff;
}
.sub {
  margin-top: 3px;
  font-size: 10.5px;
  color: #7d8fa2;
  font-family: ui-monospace, monospace;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 9px;
}
.chip {
  padding: 3px 8px;
  font-size: 11px;
  color: #b7c6d6;
  background: rgba(38, 50, 64, 0.9);
  border: 1px solid rgba(96, 116, 140, 0.4);
  border-radius: 6px;
  cursor: pointer;
  transition: 0.15s;
}
.chip:hover {
  border-color: rgba(127, 227, 255, 0.5);
  color: #e6f4ff;
}
.chip.on {
  color: #06121a;
  background: #7fe3ff;
  border-color: #7fe3ff;
  font-weight: 600;
}
.chip:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.lab {
  flex: 0 0 42px;
  font-size: 11px;
  color: #8fa0b3;
}
.ctrl input[type='range'] {
  flex: 1;
  height: 3px;
  appearance: none;
  background: rgba(96, 116, 140, 0.5);
  border-radius: 2px;
  outline: none;
}
.ctrl input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #7fe3ff;
  border: 2px solid #0b1119;
  cursor: pointer;
}
.ctrl b {
  flex: 0 0 52px;
  text-align: right;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #cfe4f5;
  font-weight: 500;
}
.ctrl b i {
  font-style: normal;
  font-size: 9.5px;
  color: #6f8296;
  margin-left: 1px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid rgba(88, 108, 132, 0.28);
}
.stat {
  font-size: 10px;
  color: #8fa0b3;
  font-family: ui-monospace, monospace;
}
.tip {
  margin-top: 8px;
  font-size: 10.5px;
  line-height: 1.6;
  color: #7b8b9d;
}
.tip b {
  color: #cfe4f5;
  font-weight: 600;
}
.tip code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(127, 227, 255, 0.1);
  color: #9fd8f0;
  font-size: 10px;
}
</style>
