<script setup lang="ts">
import { computed, ref } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

/* ============================================================
 * 百万级城市 · 海量实例的性能解剖
 *
 * 场景：程序化生成 10 万 ~ 100 万栋楼，逐实例颜色按高度渐变，夜里亮灯。
 * 三种渲染方式对比，直接把"为什么慢"量出来：
 *  1) 分块实例化（推荐）：把城市切成 8×8=64 块，每块一个 InstancedMesh，
 *     视锥剔除能逐块生效 → draw call 只有可见块（通常 10~30 个）
 *  2) 单块实例化：1 个 InstancedMesh 画完所有楼，draw call 恒为 1，
 *     但整块无法被视锥剔除——只要看得见一角，全部百万个实例都要过顶点着色器
 *  3) 逐实例 Mesh：每栋楼一个 Mesh，draw call = 建筑数，CPU 提交直接把帧率打死
 *     （所以只开放到 2 万，否则页面会卡死）
 *
 * 另外注意：实例数据在 CPU 侧一次性写进 instanceMatrix，渲染时不再有 JS 循环，
 * 这才是"百万级还能 60fps"的关键；瓶颈从来不是三角形数量，而是 draw call 与状态切换。
 * ============================================================ */

const container = ref<HTMLDivElement>()

/* ---------------- UI ---------------- */
const COUNTS = [100_000, 200_000, 500_000, 1_000_000]
const countIdx = ref(1)
const mode = ref<'chunked' | 'single' | 'naive'>('chunked')
const cruise = ref(true)
const busy = ref(false)
const buildMs = ref(0)

const fps = ref(0)
const drawCalls = ref(0)
const triangles = ref(0)
const shown = ref(0)

const countText = computed(() => `${(COUNTS[countIdx.value] / 10000).toFixed(0)} 万`)
const MODE_LABEL: Record<string, string> = {
  chunked: '分块实例化',
  single: '单块实例化',
  naive: '逐实例 Mesh',
}

/* ---------------- 场景参数（单位：米） ---------------- */
const CELL = 30 // 街区块边长（含 14m 道路）
const ROAD = 14
const CHUNKS = 8 // 每边切 8 块
const NAIVE_CAP = 20_000 // 逐实例 Mesh 的安全上限

let citySize = 0
let side = 0

/* ---------------- 场景对象 ---------------- */
let cityRoot: THREE.Group | null = null
const chunkMeshes: THREE.InstancedMesh[] = []
let naiveGroup: THREE.Group | null = null
let boxGeo: THREE.BoxGeometry | null = null
let mat: THREE.MeshStandardMaterial | null = null
let renderer: THREE.WebGLRenderer | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: { target: THREE.Vector3; maxDistance: number; minDistance: number; update: () => void } | null = null

/* FPS 统计 */
const frameTimes: number[] = []

/* 巡航 */
let cruiseAngle = 0

/* 确定性随机：同一建筑数每次生成的形态一致，方便对比 */
function makeRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * 高度分布：七成多层（10~45m），三成塔楼（25~180m），中心区小幅抬升。
 * 之前中心区乘 1.65 倍，塔楼冲到 360m，从 900m 高看下去全是"针"，完全失真。
 */
function buildingHeight(r: number, u: number): number {
  const lowRise = 8 + r * 26
  const tower = 30 + Math.pow((r - 0.78) / 0.22, 2) * 150
  const h = r < 0.78 ? lowRise : tower
  const dc = Math.max(0, 1 - u * 1.6) // 越靠中心越高
  return Math.min(180, h * (0.85 + dc * 0.35))
}

/* ---------------- 生成 / 重建 ---------------- */
function disposeCity() {
  for (const m of chunkMeshes) {
    m.geometry.dispose()
    ;(m.material as THREE.Material).dispose()
    cityRoot?.remove(m)
  }
  chunkMeshes.length = 0
  if (naiveGroup) {
    naiveGroup.clear()
    cityRoot?.remove(naiveGroup)
    naiveGroup = null
  }
  if (cityRoot) {
    cityRoot.clear()
  }
}

/**
 * 生成城市。三种模式共用一个"建筑清单"，保证对比的是同一份数据。
 * 建筑清单只存 (x, z, w, d, h, color)，真正写进 GPU 的是 instanceMatrix。
 */
function buildCity() {
  // 闭包里 TS 不会保留外层收窄，先捕获到局部常量
  const root = cityRoot
  const geo = boxGeo
  const material = mat
  if (!root || !geo || !material) return
  busy.value = true
  const target = COUNTS[countIdx.value]
  const t0 = performance.now()

  // 让 UI 先渲染出"生成中"，再干重活
  setTimeout(() => {
    disposeCity()
    shown.value = target

    side = Math.ceil(Math.sqrt(target))
    citySize = side * CELL
    const half = citySize / 2

    const rand = makeRng(20260431)
    const modeNow = mode.value

    // 分块容器：chunked 模式每块一个 InstancedMesh
    const perChunk = Math.ceil(side / CHUNKS)
    const buckets: Array<Array<{ x: number; z: number; w: number; d: number; h: number; c: THREE.Color }>> = []
    const chunkCount = CHUNKS * CHUNKS
    for (let i = 0; i < chunkCount; i++) buckets.push([])

    // 逐实例 Mesh 模式：直接建 Mesh（上限 2 万）
    const naiveCount = Math.min(target, NAIVE_CAP)
    if (modeNow === 'naive') {
      naiveGroup = new THREE.Group()
      root.add(naiveGroup)
    }

    const single = modeNow === 'single' ? { list: [] as Array<{ x: number; z: number; w: number; d: number; h: number; c: THREE.Color }> } : null

    let made = 0
    for (let gz = 0; gz < side && made < target; gz++) {
      for (let gx = 0; gx < side && made < target; gx++) {
        const r = rand()
        if (r < 0.16) continue // 空地 / 广场
        const jitter = () => (rand() - 0.5) * 2.4
        const x = -half + (gx + 0.5) * CELL + jitter()
        const z = -half + (gz + 0.5) * CELL + jitter()
        const w = CELL - ROAD + rand() * 3.5
        const d = CELL - ROAD + rand() * 3.5
        const u = Math.hypot(x, z) / half // 0 中心 → 1 边缘
        const h = buildingHeight(rand(), u)
        // 配色：低层暖砖色 → 高层冷玻璃色，拉开层次才不像一块"地毯"
        const t = THREE.MathUtils.clamp(h / 220, 0, 1)
        // 加一点逐栋抖动：同高度也有色差，整片才不会糊成一块板
        const c = new THREE.Color().setHSL(
          0.07 + t * 0.46 + (rand() - 0.5) * 0.04,
          0.34 - t * 0.12 + (rand() - 0.5) * 0.1,
          0.17 + t * 0.2 + (rand() - 0.5) * 0.06,
        )
        made++

        if (naiveGroup) {
          const m = new THREE.Mesh(geo, material)
          m.position.set(x, h / 2, z)
          m.scale.set(w, h, d)
          naiveGroup.add(m)
          if (made >= naiveCount) {
            // 逐实例模式只画到上限
            gx = side
            gz = side
          }
          continue
        }

        const item = { x, z, w, d, h, c }
        if (single) {
          single.list.push(item)
        } else {
          const cx = Math.min(CHUNKS - 1, Math.floor((x + half) / (CELL * perChunk)))
          const cz = Math.min(CHUNKS - 1, Math.floor((z + half) / (CELL * perChunk)))
          buckets[cz * CHUNKS + cx].push(item)
        }
      }
    }

    // 写实例矩阵
    const dummy = new THREE.Object3D()
    const writeInstances = (list: Array<{ x: number; z: number; w: number; d: number; h: number; c: THREE.Color }>) => {
      const mesh = new THREE.InstancedMesh(geo, material, list.length)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      for (let i = 0; i < list.length; i++) {
        const it = list[i]
        dummy.position.set(it.x, it.h / 2, it.z)
        dummy.scale.set(it.w, it.h, it.d)
        dummy.rotation.set(0, 0, 0)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        mesh.setColorAt(i, it.c)
      }
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.frustumCulled = true
      mesh.castShadow = false
      mesh.receiveShadow = false
      return mesh
    }

    if (naiveGroup) {
      // 已经建完 Mesh
    } else if (single) {
      const mesh = writeInstances(single.list)
      root.add(mesh)
      chunkMeshes.push(mesh)
    } else {
      for (let i = 0; i < buckets.length; i++) {
        if (!buckets[i].length) continue
        const mesh = writeInstances(buckets[i])
        root.add(mesh)
        chunkMeshes.push(mesh)
      }
    }

    buildMs.value = Math.round(performance.now() - t0)
    fitCamera()
    busy.value = false
  }, 30)
}

function fitCamera() {
  if (!camera || !controls) return
  // 机位压到"街区高度"（约 0.06 城宽、抬头 35°）：
  // 百万级城市铺开 10km，远看必然是一片细针——只有贴近街区，楼才有体量，
  // 远景靠雾吞掉，才能同时表达"密度"和"高度"。
  // 固定"街区尺度"取景（约 1.2km 斜距、40° 俯角），**不随城宽线性放大**：
  // 否则百万级城市要退到十几公里外，画面就糊成一块马赛克，
  // 反而看不出"楼"是什么。城市规模改由雾里的延伸来表达。
  camera.position.set(620, 760, 620)
  controls.target.set(0, 50, 0)
  controls.maxDistance = citySize * 1.2
  controls.minDistance = 30
  controls.update()
}

/* ---------------- 启动 ---------------- */
const three = useThree(
  container,
  {
    fov: 55,
    near: 1,
    far: 60000,
    background: 0x0a0f16,
    controls: true,
    cameraPos: [600, 380, 600],
    lookAt: [0, 0, 0],
  },
  (ctx) => {
    renderer = ctx.renderer
    camera = ctx.camera
    controls = ctx.controls as unknown as typeof controls
    ctx.renderer.toneMapping = THREE.ACESFilmicToneMapping
    ctx.renderer.toneMappingExposure = 1.05
    ctx.renderer.outputColorSpace = THREE.SRGBColorSpace

    ctx.scene.fog = new THREE.Fog(0x1b2c3f, 700, 7000)

    // 灯光：半球光给环境，主平行光给立面明暗（不开阴影，百万实例投影会直接拖垮帧率）
    ctx.scene.add(new THREE.HemisphereLight(0x9fc0ff, 0x1a2028, 1.15))
    const key = new THREE.DirectionalLight(0xffe4c4, 1.5)
    key.position.set(-0.4, 1, 0.35).multiplyScalar(1000)
    ctx.scene.add(key)
    const fill = new THREE.DirectionalLight(0x6f9cff, 0.5)
    fill.position.set(0.5, 0.4, -0.6).multiplyScalar(1000)
    ctx.scene.add(fill)

    // 天空：从上到下的渐变穹顶，给城市一个"天"
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: {
          top: { value: new THREE.Color(0x0a1424) },
          bottom: { value: new THREE.Color(0x24405c) },
        },
        vertexShader: `
          varying float vH;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vH = normalize(wp.xyz).y;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: `
          uniform vec3 top; uniform vec3 bottom; varying float vH;
          void main() {
            gl_FragColor = vec4(mix(bottom, top, smoothstep(-0.05, 0.55, vH)), 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    )
    sky.scale.setScalar(40000)
    ctx.scene.add(sky)

    // 地面：大圆盘 + 雾里渐隐
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 1, metalness: 0 }),
    )
    ground.rotation.x = -Math.PI / 2
    ctx.scene.add(ground)
    ;(ctx.scene.userData as { ground?: THREE.Mesh }).ground = ground

    boxGeo = new THREE.BoxGeometry(1, 1, 1)
    // 楼体：轻微的窗格感靠实例色 + 环境光，材质保持廉价（百万级下每像素的开销都算数）
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.68,
      metalness: 0.28,
      emissive: new THREE.Color(0x0b1420),
      emissiveIntensity: 0.5,
    })
    // 顶面（法线朝上）单独提亮：一个 box 也能区分"墙"与"屋顶"，
    // 不改几何、不加 draw call —— 百万实例下这点差异全靠 shader 补
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vUpY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvUpY = normal.y;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vUpY;')
        .replace(
          '#include <dithering_fragment>',
          `float roof = smoothstep(0.55, 0.95, vUpY);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 1.3 + vec3(0.02, 0.02, 0.03), roof);
           #include <dithering_fragment>`,
        )
    }

    cityRoot = new THREE.Group()
    ctx.scene.add(cityRoot)
    buildCity()

    return (dt: number) => {
      // FPS：滑动窗口，避免数字乱跳
      frameTimes.push(dt)
      if (frameTimes.length > 40) frameTimes.shift()
      const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
      fps.value = avg > 0 ? Math.round(1 / avg) : 0
      drawCalls.value = ctx.renderer.info.render.calls
      triangles.value = ctx.renderer.info.render.triangles

      // 地面跟着城市尺寸放大
      const g = (ctx.scene.userData as { ground?: THREE.Mesh }).ground
      if (g) g.scale.setScalar(Math.max(2000, citySize * 2.2))

      if (cruise.value && controls && camera) {
        cruiseAngle += dt * 0.05
        const r = 900
        camera.position.x = Math.cos(cruiseAngle) * r
        camera.position.z = Math.sin(cruiseAngle) * r
        camera.position.y = 780
        camera.lookAt(controls.target)
      }
    }
  },
)

/* ---------------- 面板交互 ---------------- */
function setCount(i: number) {
  countIdx.value = i
  buildCity()
}
function setMode(m: 'chunked' | 'single' | 'naive') {
  if (mode.value === m) return
  mode.value = m
  buildCity()
}
function rebuild() {
  buildCity()
}

const naiveCount = Math.min(COUNTS[countIdx.value], 20000)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>

    <div class="panel">
      <div class="title">
        <span class="dot" :class="{ live: !busy }"></span>
        百万级城市 · 海量实例性能解剖
      </div>
      <div class="sub">{{ countText }} 栋楼 · {{ MODE_LABEL[mode] }} · 生成 {{ buildMs }}ms</div>

      <div class="ctrl">
        <span class="lab">建筑数</span>
        <div class="chips">
          <button
            v-for="(c, i) in COUNTS"
            :key="c"
            class="chip"
            :class="{ on: i === countIdx }"
            :disabled="busy"
            @click="setCount(i)"
          >
            {{ c / 10000 }}万
          </button>
        </div>
      </div>

      <div class="ctrl">
        <span class="lab">渲染方式</span>
        <div class="chips">
          <button class="chip" :class="{ on: mode === 'chunked' }" :disabled="busy" @click="setMode('chunked')">
            分块实例化
          </button>
          <button class="chip" :class="{ on: mode === 'single' }" :disabled="busy" @click="setMode('single')">
            单块实例化
          </button>
          <button class="chip" :class="{ on: mode === 'naive' }" :disabled="busy" @click="setMode('naive')">
            逐实例 Mesh
          </button>
        </div>
      </div>

      <div class="stat">
        <div class="item">
          <span class="k">FPS</span>
          <b :class="{ bad: fps < 30, good: fps >= 55 }">{{ fps }}</b>
        </div>
        <div class="item">
          <span class="k">draw call</span>
          <b class="alt">{{ drawCalls }}</b>
        </div>
        <div class="item">
          <span class="k">三角面</span>
          <b class="alt">{{ (triangles / 10000).toFixed(0) }}万</b>
        </div>
      </div>

      <div class="row">
        <button class="btn" :class="{ on: cruise }" @click="cruise = !cruise">
          {{ cruise ? '停止巡航' : '自动巡航' }}
        </button>
        <button class="btn primary" :disabled="busy" @click="rebuild">重新生成</button>
      </div>

      <div class="state" :class="{ warn: mode === 'naive' }">
        <template v-if="busy">正在生成 InstanceMatrix…</template>
        <template v-else-if="mode === 'naive'">
          逐实例模式只画 {{ naiveCount }} 栋（超过 2 万会卡死页面）
        </template>
        <template v-else-if="mode === 'single'">
          单块：draw call = 1，但整块无法视锥剔除，转到背面照样全画
        </template>
        <template v-else>分块：{{ CHUNKS }}×{{ CHUNKS }} 块，剔除生效，draw call 只算可见块</template>
      </div>

      <div class="tip">
        瓶颈不是三角形数，而是 <b>draw call</b> 与状态切换。把城市切成小块实例化，
        视锥剔除才能逐块生效；实例数据一次性写进 <b>instanceMatrix</b>，渲染期不再有 JS 循环。
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.three-container {
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 302px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(14, 20, 28, 0.86);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
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
  background: #6b7783;
}
.dot.live {
  background: #3ddc84;
  box-shadow: 0 0 9px #3ddc84;
}
.sub {
  margin-top: 3px;
  font-size: 11px;
  color: #7d8fa2;
}
.ctrl {
  margin-top: 9px;
}
.lab {
  display: block;
  margin-bottom: 5px;
  font-size: 10.5px;
  color: #7f92a6;
}
.chips {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.chip {
  padding: 4px 8px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #a9bccf;
  cursor: pointer;
  transition: all 0.15s;
}
.chip:hover:not(:disabled) {
  border-color: rgba(120, 165, 220, 0.7);
  color: #e6f0fa;
}
.chip.on {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.8);
  color: #eaf4ff;
}
.chip:disabled {
  opacity: 0.45;
  cursor: progress;
}
.stat {
  display: flex;
  gap: 12px;
  margin-top: 11px;
  padding-top: 9px;
  border-top: 1px solid rgba(88, 108, 132, 0.28);
}
.item {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11px;
  color: #8b9cb0;
}
.item b {
  font-size: 17px;
  font-weight: 600;
  color: #e9f2fb;
  font-variant-numeric: tabular-nums;
}
.item b.alt {
  color: #7fd0ff;
}
.item b.good {
  color: #56e08a;
}
.item b.bad {
  color: #ff8a6b;
}
.row {
  display: flex;
  gap: 7px;
  margin-top: 10px;
}
.btn {
  flex: 1;
  padding: 6px 0;
  font-size: 11.5px;
  border-radius: 7px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #b9c8d8;
  cursor: pointer;
  transition: all 0.15s;
}
.btn:hover:not(:disabled) {
  border-color: rgba(120, 165, 220, 0.75);
  color: #e6f0fa;
}
.btn:disabled {
  opacity: 0.45;
  cursor: progress;
}
.btn.primary {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.btn.on {
  border-color: rgba(96, 226, 170, 0.7);
  color: #9df0c8;
}
.state {
  margin-top: 9px;
  font-size: 10.5px;
  line-height: 1.5;
  color: #8fa3b8;
  min-height: 15px;
}
.state.warn {
  color: #ffb27a;
}
.tip {
  margin-top: 8px;
  font-size: 10.5px;
  line-height: 1.55;
  color: #6d8098;
}
.tip b {
  color: #9fb6cc;
}
</style>
