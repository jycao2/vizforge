<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const tip = ref<{ x: number; y: number; text: string } | null>(null)

const autoRotate = ref(true)
const arcLevel = ref(2) // 1 少 / 2 中 / 3 多
const speed = ref(1)
const stats = ref({ cities: 0, arcs: 0, fps: 0 })

const DEG = Math.PI / 180
const R = 1

interface City {
  name: string
  lon: number
  lat: number
  hub?: boolean
}

const CITIES: City[] = [
  { name: '北京', lon: 116.4, lat: 39.9, hub: true },
  { name: '上海', lon: 121.5, lat: 31.2, hub: true },
  { name: '东京', lon: 139.7, lat: 35.7 },
  { name: '首尔', lon: 127, lat: 37.6 },
  { name: '新加坡', lon: 103.8, lat: 1.35 },
  { name: '曼谷', lon: 100.5, lat: 13.75 },
  { name: '雅加达', lon: 106.8, lat: -6.2 },
  { name: '悉尼', lon: 151.2, lat: -33.9 },
  { name: '奥克兰', lon: 174.8, lat: -36.9 },
  { name: '孟买', lon: 72.9, lat: 19.1 },
  { name: '迪拜', lon: 55.3, lat: 25.2, hub: true },
  { name: '伊斯坦布尔', lon: 29, lat: 41 },
  { name: '莫斯科', lon: 37.6, lat: 55.8 },
  { name: '伦敦', lon: -0.13, lat: 51.5, hub: true },
  { name: '巴黎', lon: 2.35, lat: 48.9 },
  { name: '柏林', lon: 13.4, lat: 52.5 },
  { name: '开罗', lon: 31.2, lat: 30 },
  { name: '拉各斯', lon: 3.4, lat: 6.5 },
  { name: '约翰内斯堡', lon: 28, lat: -26.2 },
  { name: '纽约', lon: -74, lat: 40.7, hub: true },
  { name: '多伦多', lon: -79.4, lat: 43.7 },
  { name: '洛杉矶', lon: -118.2, lat: 34.05 },
  { name: '墨西哥城', lon: -99.1, lat: 19.4 },
  { name: '圣保罗', lon: -46.6, lat: -23.5 },
  { name: '利马', lon: -77, lat: -12 },
]

/** 经纬度 → 球面坐标（y 轴朝北） */
function toVec(lon: number, lat: number, r = R): THREE.Vector3 {
  const phi = (90 - lat) * DEG
  const theta = (lon + 180) * DEG
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  )
}

/** 大圆插值 + 中段抬升，看起来像一条拱起来的航线 */
function arcPoints(a: THREE.Vector3, b: THREE.Vector3, lift = 0.12) {
  const angle = a.angleTo(b)
  const pts: THREE.Vector3[] = []
  const n = 64
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const p = new THREE.Vector3().lerpVectors(a, b, t).normalize()
    p.multiplyScalar(R * (1 + Math.sin(Math.PI * t) * lift * (0.6 + angle / Math.PI)))
    pts.push(p)
  }
  return pts
}

const HUB_COLORS: Record<string, number> = {
  北京: 0xffcf80,
  上海: 0x7fd4ff,
  伦敦: 0xb08cff,
  纽约: 0x5affc8,
  迪拜: 0xff9e6b,
}

let group: THREE.Group | null = null
let arcGroup: THREE.Group | null = null
let flowPoints: THREE.Points | null = null
const flowData: Array<{ pts: THREE.Vector3[]; phase: number; speed: number }> = []
let cityPoints: THREE.Points | null = null
let cityIndex: City[] = []
let detachPointer: (() => void) | null = null

function buildArcs(level: number) {
  const ag = arcGroup
  if (!ag) return
  ag.clear()
  flowData.length = 0

  const hubs = CITIES.filter((c) => c.hub)
  const targets = CITIES.filter((c) => !c.hub)
  const take = level === 1 ? 2 : level === 3 ? 5 : 3
  let count = 0

  hubs.forEach((hub, hi) => {
    const color = HUB_COLORS[hub.name] ?? 0x7fd4ff
    const a = toVec(hub.lon, hub.lat)
    for (let k = 0; k < take; k++) {
      const to = targets[(hi * 5 + k * 2) % targets.length]
      const b = toVec(to.lon, to.lat)
      const pts = arcPoints(a, b)
      const geom = new THREE.BufferGeometry().setFromPoints(pts)
      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      ag.add(new THREE.Line(geom, mat))
      flowData.push({ pts, phase: Math.random(), speed: 0.11 + Math.random() * 0.1 })
      count++
    }
  })

  if (flowPoints) {
    const pos = new Float32Array(count * 3)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    flowPoints.geometry.dispose()
    flowPoints.geometry = geo
  }
  stats.value = { ...stats.value, arcs: count }
}

useThree(
  container,
  {
    fov: 42,
    near: 0.1,
    far: 100,
    background: 0x04070d,
    cameraPos: [0, 0.45, 3.85],
    lookAt: [0, 0, 0],
    controls: true,
  },
  (ctx) => {
    const { scene, camera, renderer, controls } = ctx
    scene.fog = null

    group = new THREE.Group()
    // 让亚欧大陆正对镜头：lon 90 落在 +z 方向，再稍微倾斜一点
    group.rotation.y = Math.PI * 0.95
    group.rotation.z = 0.16
    scene.add(group)

    /* 球体：深色海面 */
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.995, 64, 48),
      new THREE.MeshBasicMaterial({ color: 0x071019 }),
    )
    group.add(globe)

    /* 大气光晕：背面 + 加色，边缘才有那层蓝光 */
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.14, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0x3d8bff) } },
        vertexShader: `
          varying vec3 vN;
          varying vec3 vView;
          void main() {
            vN = normalize(normalMatrix * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          uniform vec3 uColor;
          varying vec3 vN;
          varying vec3 vView;
          void main() {
            // 视线越贴近切线，菲涅尔越强 → 边缘亮、正对处透明
            float f = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.6);
            gl_FragColor = vec4(uColor, f * 0.75);
          }
        `,
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    group.add(halo)

    /* 经纬网：每 15° 一条 */
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x1d3a58,
      transparent: true,
      opacity: 0.85,
    })
    const netPts: THREE.Vector3[] = []
    for (let lon = -180; lon < 180; lon += 15) {
      for (let lat = -90; lat < 90; lat += 3) {
        netPts.push(toVec(lon, lat, R * 1.001), toVec(lon, lat + 3, R * 1.001))
      }
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      for (let lon = -180; lon < 180; lon += 3) {
        netPts.push(toVec(lon, lat, R * 1.001), toVec(lon + 3, lat, R * 1.001))
      }
    }
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(netPts), lineMat))

    // 赤道与南北回归线加亮：网格里唯一能说明「这是地球」的线索
    const keyLat = [
      { lat: 0, color: 0x4fa3ff, opacity: 0.85 },
      { lat: 23.5, color: 0x2f6d9e, opacity: 0.7 },
      { lat: -23.5, color: 0x2f6d9e, opacity: 0.7 },
      { lat: 66.5, color: 0x274a68, opacity: 0.6 },
      { lat: -66.5, color: 0x274a68, opacity: 0.6 },
    ]
    keyLat.forEach((k) => {
      const ring: THREE.Vector3[] = []
      for (let lon = -180; lon <= 180; lon += 2) ring.push(toVec(lon, k.lat, R * 1.002))
      group!.add(
        new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(ring),
          new THREE.LineBasicMaterial({
            color: k.color,
            transparent: true,
            opacity: k.opacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        ),
      )
    })

    const dotCanvas = document.createElement('canvas')
    dotCanvas.width = dotCanvas.height = 64
    const dctx = dotCanvas.getContext('2d')!
    const grad = dctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.35, 'rgba(190,225,255,0.85)')
    grad.addColorStop(1, 'rgba(120,180,255,0)')
    dctx.fillStyle = grad
    dctx.fillRect(0, 0, 64, 64)
    const dotTex = new THREE.CanvasTexture(dotCanvas)

    /* 星空：纯装饰，给球一个空间参照 */
    const starGeo = new THREE.BufferGeometry()
    const starPos = new Float32Array(700 * 3)
    for (let i = 0; i < 700; i++) {
      const u = Math.random() * 2 - 1
      const phi = Math.random() * Math.PI * 2
      const rr = 14 + Math.random() * 10
      const sq = Math.sqrt(1 - u * u)
      starPos[i * 3] = sq * Math.cos(phi) * rr
      starPos[i * 3 + 1] = u * rr
      starPos[i * 3 + 2] = sq * Math.sin(phi) * rr
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
    scene.add(
      new THREE.Points(
        starGeo,
        new THREE.PointsMaterial({ color: 0x9fc4ea, size: 0.17, map: dotTex, transparent: true, opacity: 0.85, sizeAttenuation: true, depthWrite: false }),
      ),
    )

    /* 城市点：圆形贴图 + 加色混合，远看像一颗颗灯 */
    const pos = new Float32Array(CITIES.length * 3)
    const colors = new Float32Array(CITIES.length * 3)
    cityIndex = CITIES.slice()
    CITIES.forEach((c, i) => {
      const v = toVec(c.lon, c.lat, R * 1.008)
      pos[i * 3] = v.x
      pos[i * 3 + 1] = v.y
      pos[i * 3 + 2] = v.z
      const col = new THREE.Color(c.hub ? 0xffcf80 : 0x9fd8ff)
      colors[i * 3] = col.r
      colors[i * 3 + 1] = col.g
      colors[i * 3 + 2] = col.b
    })
    const cityGeo = new THREE.BufferGeometry()
    cityGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    cityGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    cityPoints = new THREE.Points(
      cityGeo,
      new THREE.PointsMaterial({
        size: 0.075,
        map: dotTex,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    )
    group.add(cityPoints)

    /* 飞线图层 + 流动光点 */
    arcGroup = new THREE.Group()
    group.add(arcGroup)

    const flowGeo = new THREE.BufferGeometry()
    flowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3))
    flowPoints = new THREE.Points(
      flowGeo,
      new THREE.PointsMaterial({
        size: 0.032,
        map: dotTex,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    )
    group.add(flowPoints)

    buildArcs(arcLevel.value)
    stats.value = { ...stats.value, cities: CITIES.length }

    /* 拾取：Points 的 raycaster 阈值要放大，否则 1px 的点根本点不中 */
    const ray = new THREE.Raycaster()
    ray.params.Points.threshold = 0.055
    const mouse = new THREE.Vector2()
    let hovered = -1

    function onMove(e: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect()
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      ray.setFromCamera(mouse, camera)
      const hit = cityPoints ? ray.intersectObject(cityPoints) : []
      // instanceId 在 Points 上是 index
      const idx = hit.length ? (hit[0].index ?? -1) : -1
      if (idx !== hovered) {
        hovered = idx
        if (idx >= 0) {
          const c = cityIndex[idx]
          tip.value = {
            x: e.clientX - rect.left + 12,
            y: e.clientY - rect.top - 8,
            text: `${c.name} · ${c.lon.toFixed(1)}°, ${c.lat.toFixed(1)}°`,
          }
          renderer.domElement.style.cursor = 'pointer'
        } else {
          tip.value = null
          renderer.domElement.style.cursor = 'grab'
        }
      } else if (idx >= 0 && tip.value) {
        tip.value = { x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8, text: tip.value.text }
      }
    }
    renderer.domElement.addEventListener('pointermove', onMove)
    detachPointer = () => renderer.domElement.removeEventListener('pointermove', onMove)

    /* 帧循环 */
    let fpsT = 0
    let frames = 0
    const tmp = new THREE.Vector3()

    return (dt: number) => {
      if (controls) {
        controls.autoRotate = autoRotate.value
        controls.autoRotateSpeed = 0.55 * speed.value
      }

      // 流动光点：沿预采样的弧线取点，端点做淡入淡出（用缩放近似）
      if (flowPoints) {
        const attr = flowPoints.geometry.getAttribute('position') as THREE.BufferAttribute
        flowData.forEach((f, i) => {
          f.phase = (f.phase + dt * f.speed * speed.value) % 1
          const idx = Math.min(f.pts.length - 1, Math.floor(f.phase * f.pts.length))
          tmp.copy(f.pts[idx])
          attr.setXYZ(i, tmp.x, tmp.y, tmp.z)
        })
        attr.needsUpdate = true
      }

      frames++
      fpsT += dt
      if (fpsT > 0.5) {
        stats.value = { ...stats.value, fps: Math.round(frames / fpsT) }
        frames = 0
        fpsT = 0
      }
    }
  },
)

function applyLevel() {
  buildArcs(arcLevel.value)
}

onBeforeUnmount(() => {
  detachPointer?.()
  detachPointer = null
})
</script>

<template>
  <div class="globe-wrap">
    <div ref="container" class="globe-canvas"></div>

    <div v-if="tip" class="tip" :style="{ left: tip.x + 'px', top: tip.y + 'px' }">{{ tip.text }}</div>

    <div class="panel">
      <div class="head">
        <span class="dot"></span>
        <div class="head-text">
          <div class="name">球面地球 · 城市航线</div>
          <div class="url">{{ stats.cities }} 城市 · {{ stats.arcs }} 条飞线 · {{ stats.fps }} fps</div>
        </div>
      </div>

      <div class="ctrl">
        <span class="lab">弧线</span>
        <div class="segs">
          <button v-for="n in [1, 2, 3]" :key="n" class="seg" :class="{ on: arcLevel === n }" @click="arcLevel = n; applyLevel()">
            {{ ['少', '中', '多'][n - 1] }}
          </button>
        </div>
      </div>

      <div class="ctrl">
        <span class="lab">速度</span>
        <input v-model.number="speed" type="range" min="0.2" max="2.4" step="0.1" />
        <b>{{ speed.toFixed(1) }}×</b>
      </div>

      <button class="switch" :class="{ on: autoRotate }" @click="autoRotate = !autoRotate">
        <span class="track"><span class="knob"></span></span>
        <span class="sw-label">自动旋转</span>
      </button>

      <div class="hint">
        经纬网每 15°，城市点用加色混合的圆形贴图；飞线是大圆插值后按 sin 抬升中段，
        光点沿同一条折线取点。<b>悬停城市点看经纬度</b>，拖拽可自由旋转。
      </div>
    </div>
  </div>
</template>

<style scoped>
.globe-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  background: #04070d;
}
.globe-canvas {
  width: 100%;
  height: 100%;
}
.tip {
  position: absolute;
  z-index: 15;
  padding: 3px 8px;
  border-radius: 5px;
  background: rgba(10, 18, 30, 0.9);
  border: 1px solid rgba(120, 170, 220, 0.45);
  color: #cfe4f7;
  font-size: 11px;
  pointer-events: none;
  white-space: nowrap;
}
.panel {
  position: absolute;
  left: 14px;
  top: 14px;
  z-index: 20;
  width: 244px;
  padding: 11px 12px 12px;
  border-radius: 11px;
  background: rgba(10, 16, 26, 0.9);
  border: 1px solid rgba(80, 110, 145, 0.42);
  color: #d7e2ee;
  font-size: 12px;
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.35);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 9px;
  border-bottom: 1px solid rgba(80, 110, 145, 0.25);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5ab0ff;
  box-shadow: 0 0 8px #5ab0ff;
  flex: none;
}
.head-text {
  min-width: 0;
}
.name {
  font-size: 12.5px;
  font-weight: 600;
  color: #eaf2fb;
  white-space: nowrap;
}
.url {
  font-size: 10px;
  color: #7d8fa3;
  margin-top: 2px;
}
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
}
.lab {
  font-size: 10.5px;
  color: #7d8fa3;
  width: 26px;
  flex: none;
}
.segs {
  display: flex;
  gap: 4px;
}
.seg {
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid rgba(80, 110, 145, 0.5);
  background: transparent;
  color: #a9bccf;
  font-size: 10.5px;
  cursor: pointer;
}
.seg.on {
  background: #2f6fd0;
  border-color: #2f6fd0;
  color: #fff;
}
.ctrl input[type='range'] {
  flex: 1;
  min-width: 0;
  accent-color: #4f9dff;
  height: 3px;
}
.ctrl b {
  font-size: 10px;
  color: #a9bccf;
  width: 32px;
  text-align: right;
  font-weight: 500;
}
.switch {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  width: 100%;
  padding: 6px 7px;
  border-radius: 7px;
  border: 1px solid rgba(80, 110, 145, 0.4);
  background: rgba(255, 255, 255, 0.03);
  color: #c6d5e5;
  font-size: 11.5px;
  cursor: pointer;
}
.track {
  width: 26px;
  height: 14px;
  border-radius: 8px;
  background: rgba(120, 145, 170, 0.4);
  position: relative;
  flex: none;
  transition: background 0.18s ease;
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #e8f1fb;
  transition: transform 0.18s ease;
}
.switch.on .track {
  background: #3d8bff;
}
.switch.on .knob {
  transform: translateX(12px);
}
.hint {
  margin-top: 9px;
  font-size: 10.5px;
  line-height: 1.6;
  color: #7d8fa3;
}
.hint b {
  color: #a9bccf;
}
</style>
