<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { useThree } from './useThree'

/* ============================================================
 * 六轴工业机器人 · 传送带上下料 · 托盘码垛
 *  - 结构：底座 → 腰(j1) → 大臂(j2) → 小臂(j3) → 腕俯仰(j5) → 腕自转(j6) → 两指夹爪
 *  - 逆解：腰角取目标方位角，肩肘用平面 2R 解析解，腕部补偿使夹爪始终竖直向下
 *  - 动作：取料上方 → 下降 → 夹紧 → 抬升 → 平移 → 下降 → 松开 → 抬升（关键点插值）
 *  - 传送带：料箱按节拍送入，到位排队；码满一托盘后整托出库
 * ============================================================ */

/* ---------------- 机械臂主参数（单位：米） ---------------- */
const SHOULDER_Y = 1.02 // 肩关节（腰转轴顶点）高度
const L1 = 1.5 // 大臂长度
const L2 = 1.45 // 小臂长度
const TOOL_LEN = 0.58 // 腕心（j5 原点）→ 夹爪指尖
const J6_OFFSET = 0.14 // 腕心到 j6 自转中心
const BOX_W = 0.46
const BOX_H = 0.42
const CONV_Y = 0.8 // 传送带面高
const CONV_X0 = 1.15 // 传送带靠机械臂一端
const CONV_X1 = 6.7 // 传送带尾部
const PICK_X = 2.36 // 取料工位中心 x
const BELT_SPEED = 0.62 // 传送带线速度 m/s
const PALLET_X = -2.02 // 托盘中心
const PALLET_Z = 0.0
const SLOT_GAP = 0.505 // 码垛间距
const PALLET_TOP = 0.155 // 托盘台面高度
const LAYER_CAP = 9 // 每层 3×3
const LAYERS = 2
const TOTAL = LAYER_CAP * LAYERS

/* ---------------- UI 状态 ---------------- */
const container = ref<HTMLDivElement>()
const running = ref(true)
const speed = ref(1)
const count = ref(0)
const totalOut = ref(0)
const pallets = ref(0)
const status = ref('待机')

/* ---------------- 运行时对象 ---------------- */
const j1 = new THREE.Group() // 腰（绕 Y）
const j2 = new THREE.Group() // 肩（绕 X）
const j3 = new THREE.Group() // 肘（绕 X）
const j5 = new THREE.Group() // 腕俯仰（绕 X）
const j6 = new THREE.Group() // 腕自转（绕 Y）
const fingerL = new THREE.Group()
const fingerR = new THREE.Group()

let gripTarget = 0 // 0 张开 1 夹紧
let gripNow = 0

interface Step {
  to: THREE.Vector3
  dur: number
  onEnd?: () => void
  label?: string
}
let steps: Step[] = []
let stepIdx = 0
let stepT = 0
const stepFrom = new THREE.Vector3()

const tipPos = new THREE.Vector3(0, 2.2, 1.6) // 当前指尖目标点（世界坐标，机械臂底座局部系）

interface Cargo {
  mesh: THREE.Mesh
  state: 'belt' | 'held' | 'placed'
}
const beltBoxes: Cargo[] = []
let held: Cargo | null = null
const placed: Cargo[] = []
let slotIndex = 0
let spawnTimer = 0
let palletOut = 0 // 托盘出库动画进度
let palletGroup = new THREE.Group()
let resetting = false

const cleanups: Array<() => void> = []
const tmpV = new THREE.Vector3()
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const clamp = THREE.MathUtils.clamp

onBeforeUnmount(() => {
  cleanups.forEach((fn) => fn())
  cleanups.length = 0
})

/* ============================================================
 * 材质 / 纹理小工具
 * ============================================================ */
const std = (color: number, metalness = 0.35, roughness = 0.55) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness, envMapIntensity: 0.9 })

const M = {
  arm: std(0xe8951c, 0.28, 0.42), // 机器人本体橙
  armDark: std(0xc9760f, 0.3, 0.45),
  joint: std(0x2c323b, 0.62, 0.38), // 关节深灰
  steel: std(0x9aa3ad, 0.85, 0.28),
  dark: std(0x1b1f25, 0.5, 0.55),
  finger: std(0x424c58, 0.75, 0.32),
  rail: std(0x4a525c, 0.55, 0.45),
  pallet: std(0x8a6a44, 0.1, 0.85),
  palletDark: std(0x6d5233, 0.06, 0.9),
  fence: std(0xf2c31c, 0.15, 0.6),
}

const cyl = (rt: number, rb: number, h: number, mat: THREE.Material, seg = 28) =>
  new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat)
const box = (w: number, h: number, d: number, mat: THREE.Material) =>
  new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)

function shade(o: THREE.Object3D, cast = true, receive = true) {
  o.traverse((c) => {
    const m = c as THREE.Mesh
    if (m.isMesh) {
      m.castShadow = cast
      m.receiveShadow = receive
    }
  })
  return o
}

/** 圆角矩形轮廓（臂体截面） */
function roundedRect(w: number, d: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const hw = w / 2
  const hd = d / 2
  s.moveTo(-hw + r, -hd)
  s.lineTo(hw - r, -hd)
  s.quadraticCurveTo(hw, -hd, hw, -hd + r)
  s.lineTo(hw, hd - r)
  s.quadraticCurveTo(hw, hd, hw - r, hd)
  s.lineTo(-hw + r, hd)
  s.quadraticCurveTo(-hw, hd, -hw, hd - r)
  s.lineTo(-hw, -hd + r)
  s.quadraticCurveTo(-hw, -hd, -hw + r, -hd)
  return s
}

/**
 * 变截面圆角棱柱：底部 wBot×dBot，顶端 wTop×dTop，高度 h，沿 +Y 生长。
 * 做法是挤出圆角矩形后，按高度线性缩放 XZ —— 工业机器人的臂体就是这种带拔模斜度的箱型铸件。
 */
function taperedPrism(
  wBot: number,
  wTop: number,
  dBot: number,
  dTop: number,
  h: number,
  radius: number,
): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(roundedRect(wBot, dBot, radius), {
    depth: h,
    bevelEnabled: false,
    curveSegments: 3,
    steps: 1,
  })
  geo.rotateX(-Math.PI / 2)
  geo.translate(0, 0, 0)
  const pos = geo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const t = THREE.MathUtils.clamp(y / h, 0, 1)
    pos.setX(i, pos.getX(i) * ((wBot + (wTop - wBot) * t) / wBot))
    pos.setZ(i, pos.getZ(i) * ((dBot + (dTop - dBot) * t) / dBot))
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
  return geo
}

/** 纸箱纹理 */
function cartonTexture() {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 256
  const g = cv.getContext('2d')!
  g.fillStyle = '#bb8c58'
  g.fillRect(0, 0, 256, 256)
  for (let i = 0; i < 2400; i++) {
    const v = Math.random()
    g.fillStyle = `rgba(${110 + v * 70 | 0},${80 + v * 55 | 0},${48 + v * 40 | 0},0.22)`
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2)
  }
  // 封箱胶带
  g.fillStyle = '#dcc9a5'
  g.fillRect(0, 112, 256, 34)
  g.fillStyle = 'rgba(255,255,255,0.35)'
  g.fillRect(0, 112, 256, 4)
  // 边框压痕
  g.strokeStyle = 'rgba(88,58,28,0.4)'
  g.lineWidth = 4
  g.strokeRect(5, 5, 246, 246)
  // 面单
  g.fillStyle = 'rgba(250,250,248,0.92)'
  g.fillRect(28, 26, 92, 62)
  g.fillStyle = '#2b3138'
  for (let i = 0; i < 5; i++) {
    g.fillRect(36, 36 + i * 9, 40 + Math.random() * 34, 3)
  }
  g.fillStyle = '#1e2530'
  g.fillRect(28, 26, 92, 12)
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** 混凝土地面（含分缝） */
function floorTexture() {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 512
  const g = cv.getContext('2d')!
  g.fillStyle = '#5f656d'
  g.fillRect(0, 0, 512, 512)
  for (let i = 0; i < 9000; i++) {
    const v = Math.random()
    g.fillStyle = `rgba(${90 + v * 90 | 0},${96 + v * 90 | 0},${104 + v * 90 | 0},0.3)`
    g.fillRect(Math.random() * 512, Math.random() * 512, 3, 3)
  }
  g.strokeStyle = 'rgba(62,66,72,0.45)'
  g.lineWidth = 3
  g.strokeRect(0, 0, 512, 512)
  g.strokeStyle = 'rgba(120,126,134,0.35)'
  g.lineWidth = 2
  g.beginPath()
  g.moveTo(256, 0)
  g.lineTo(256, 512)
  g.moveTo(0, 256)
  g.lineTo(512, 256)
  g.stroke()
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(6, 6)
  t.anisotropy = 4
  return t
}

/** 传送带皮带纹理 */
function beltTexture() {
  const cv = document.createElement('canvas')
  cv.width = 256
  cv.height = 64
  const g = cv.getContext('2d')!
  g.fillStyle = '#22262c'
  g.fillRect(0, 0, 256, 64)
  for (let x = 0; x < 256; x += 16) {
    g.fillStyle = 'rgba(255,255,255,0.07)'
    g.fillRect(x, 0, 7, 64)
    g.fillStyle = 'rgba(0,0,0,0.35)'
    g.fillRect(x + 7, 0, 3, 64)
  }
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 4
  return t
}

/* ============================================================
 * 逆运动学：目标指尖点 → j1 / j2 / j3 / j5
 * ============================================================ */
interface JointAngles {
  yaw: number
  a2: number
  a3: number
  a5: number
  ok: boolean
}
function solveIK(target: THREE.Vector3): JointAngles {
  const yaw = Math.atan2(target.x, target.z)
  const horiz = Math.hypot(target.x, target.z)
  // 夹爪竖直向下 → 腕心在指尖正上方 TOOL_LEN
  const wy = target.y + TOOL_LEN - SHOULDER_Y
  const wz = horiz
  const D = Math.hypot(wy, wz)
  const inner = clamp((D * D - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1)
  const a3 = Math.acos(inner)
  const a2 = Math.atan2(wz, wy) - Math.atan2(L2 * Math.sin(a3), L1 + L2 * Math.cos(a3))
  const a5 = Math.PI - (a2 + a3)
  return { yaw, a2, a3, a5, ok: D <= L1 + L2 - 0.02 && D >= Math.abs(L1 - L2) + 0.02 }
}

/* ============================================================
 * 场景搭建
 * ============================================================ */
useThree(
  container,
  {
    fov: 34,
    near: 0.1,
    far: 240,
    background: 0x0d1117,
    cameraPos: [1.75, 3.9, 8.35],
    lookAt: [0.05, 0.95, 0.0],
    controls: true,
    shadows: true,
  },
  ({ scene, camera, renderer, controls }) => {
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.12
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.06).texture
    scene.environment = envTex
    scene.fog = new THREE.Fog(0x0d1117, 24, 46)

    if (controls) {
      controls.minDistance = 3.2
      controls.maxDistance = 24
      controls.maxPolarAngle = Math.PI * 0.495
      controls.target.set(0.05, 0.95, 0.0)
    }

    /* ---------------- 灯光 ---------------- */
    scene.add(new THREE.HemisphereLight(0xb6cde4, 0x2a2f36, 0.95))

    const sun = new THREE.DirectionalLight(0xfff2dc, 1.95)
    sun.position.set(6.5, 10.5, 5.2)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 32
    const S = 8.2
    sun.shadow.camera.left = -S
    sun.shadow.camera.right = S
    sun.shadow.camera.top = S
    sun.shadow.camera.bottom = -S
    sun.shadow.bias = -0.0007
    sun.shadow.normalBias = 0.022
    scene.add(sun)

    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.55)
    fill.position.set(-7, 5.5, -5.5)
    scene.add(fill)

    const rim = new THREE.SpotLight(0xdfe9ff, 26, 22, Math.PI / 5, 0.5, 1.4)
    rim.position.set(-2.4, 8.4, 5.6)
    rim.target.position.set(-0.6, 0.6, -0.4)
    scene.add(rim, rim.target)

    /* ---------------- 地面 ---------------- */
    const floorTex = floorTexture()
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(46, 46),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92, metalness: 0.04 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    scene.add(floor)

    // 黄色安全区标线
    function safetyLine(x0: number, z0: number, x1: number, z1: number) {
      const len = Math.hypot(x1 - x0, z1 - z0)
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(len, 0.09),
        new THREE.MeshStandardMaterial({
          color: 0xf5c518,
          roughness: 0.7,
          metalness: 0,
          emissive: 0x3a2c00,
        }),
      )
      m.rotation.x = -Math.PI / 2
      m.rotation.z = -Math.atan2(z1 - z0, x1 - x0)
      m.position.set((x0 + x1) / 2, 0.006, (z0 + z1) / 2)
      scene.add(m)
    }
    // 围栏已经把作业区框住了，地上再画一圈黄线会显乱，只保留门口一段
    safetyLine(-3.55, 3.05, -0.6, 3.05)
    safetyLine(0.6, 3.05, 3.35, 3.05)

    /* ---------------- 机械臂本体 ---------------- */
    const robot = new THREE.Group()
    scene.add(robot)

    // 底座：地脚 + 立筒 + 腰座
    const base = new THREE.Group()
    robot.add(base)
    const foot = cyl(0.72, 0.78, 0.1, M.joint, 40)
    foot.position.y = 0.05
    base.add(foot)
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const bolt = cyl(0.045, 0.045, 0.05, M.steel, 12)
      bolt.position.set(Math.cos(a) * 0.62, 0.12, Math.sin(a) * 0.62)
      base.add(bolt)
    }
    const column = cyl(0.42, 0.55, 0.78, M.arm, 36)
    column.position.y = 0.49
    base.add(column)
    // 铭牌
    const plate = box(0.34, 0.12, 0.02, M.dark)
    plate.position.set(0, 0.5, 0.5)
    base.add(plate)

    // 底部黄黑警示带
    {
      const cv = document.createElement('canvas')
      cv.width = 256
      cv.height = 64
      const g2 = cv.getContext('2d')!
      g2.fillStyle = '#e8b81c'
      g2.fillRect(0, 0, 256, 64)
      g2.fillStyle = '#1b1f25'
      for (let i = -64; i < 320; i += 64) {
        g2.beginPath()
        g2.moveTo(i, 0)
        g2.lineTo(i + 30, 0)
        g2.lineTo(i + 62, 64)
        g2.lineTo(i + 32, 64)
        g2.closePath()
        g2.fill()
      }
      const tex = new THREE.CanvasTexture(cv)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.repeat.set(3, 1)
      const band = cyl(0.455, 0.455, 0.15, new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.7,
        metalness: 0.1,
      }), 36)
      band.position.y = 0.17
      base.add(band)
    }

    // j1 腰
    j1.position.y = SHOULDER_Y
    robot.add(j1)
    const waist = cyl(0.44, 0.44, 0.34, M.joint, 36)
    waist.position.y = -0.12
    j1.add(waist)
    const shoulderHousing = new THREE.Mesh(
      new THREE.SphereGeometry(0.37, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.62),
      M.arm,
    )
    shoulderHousing.rotation.x = Math.PI
    j1.add(shoulderHousing)
    // 肩部两侧关节盖
    for (const s of [-1, 1]) {
      const cap = cyl(0.24, 0.24, 0.1, M.joint, 28)
      cap.rotation.z = Math.PI / 2
      cap.position.set(s * 0.335, 0.02, 0)
      j1.add(cap)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.026, 8, 28), M.steel)
      ring.rotation.y = Math.PI / 2
      ring.position.set(s * 0.39, 0.02, 0)
      j1.add(ring)
      // 关节端面的螺栓圈
      for (let b = 0; b < 6; b++) {
        const ang = (b / 6) * Math.PI * 2
        const bolt = cyl(0.022, 0.022, 0.035, M.steel, 8)
        bolt.rotation.z = Math.PI / 2
        bolt.position.set(s * 0.4, 0.02 + Math.cos(ang) * 0.145, Math.sin(ang) * 0.145)
        j1.add(bolt)
      }
    }

    // j2 大臂：根部粗、顶端细的箱型截面
    j1.add(j2)
    const upperArm = new THREE.Mesh(taperedPrism(0.34, 0.245, 0.31, 0.235, L1, 0.07), M.arm)
    j2.add(upperArm)
    // 侧面盖板
    for (const s of [-1, 1]) {
      const plate = box(0.014, L1 * 0.8, 0.24, M.armDark)
      plate.position.set(s * 0.163, L1 * 0.45, 0)
      j2.add(plate)
      const rib = box(0.026, L1 * 0.66, 0.11, M.joint)
      rib.position.set(s * 0.176, L1 * 0.42, 0)
      j2.add(rib)
    }
    // 臂体侧面散热凹槽
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const slot = box(0.012, L1 * 0.09, 0.05, M.joint)
        slot.position.set(s * 0.166, L1 * (0.24 + i * 0.14), 0)
        j2.add(slot)
      }
    }

    // 根部轴承座
    const rootBearing = cyl(0.175, 0.175, 0.46, M.joint, 24)
    rootBearing.rotation.z = Math.PI / 2
    rootBearing.position.y = 0.06
    j2.add(rootBearing)

    // j3 肘
    j3.position.y = L1
    j2.add(j3)
    const elbow = cyl(0.26, 0.26, 0.46, M.joint, 30)
    elbow.rotation.z = Math.PI / 2
    j3.add(elbow)
    for (const s of [-1, 1]) {
      const cap = cyl(0.17, 0.17, 0.06, M.steel, 24)
      cap.rotation.z = Math.PI / 2
      cap.position.x = s * 0.235
      j3.add(cap)
    }

    // 小臂：变截面箱体
    const foreLen = L2
    const foreGeo = new THREE.BoxGeometry(0.23, foreLen, 0.25)
    foreGeo.translate(0, foreLen / 2, 0)
    const forearm = new THREE.Mesh(foreGeo, M.arm)
    j3.add(forearm)
    const foreShell = box(0.27, foreLen * 0.55, 0.29, M.armDark)
    foreShell.position.set(0, foreLen * 0.34, 0)
    j3.add(foreShell)
    // 线缆包
    const cable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, foreLen * 0.9, 10),
      std(0x14181d, 0.1, 0.9),
    )
    cable.position.set(0.115, foreLen * 0.5, 0.055)
    j3.add(cable)

    // j5 腕俯仰
    j5.position.y = L2
    j3.add(j5)
    const wristYoke = cyl(0.17, 0.17, 0.34, M.joint, 26)
    wristYoke.rotation.z = Math.PI / 2
    j5.add(wristYoke)

    // j6 腕自转 + 夹爪
    j6.position.y = J6_OFFSET
    j5.add(j6)
    const flange = cyl(0.12, 0.145, 0.1, M.steel, 28)
    flange.position.y = 0.02
    j6.add(flange)
    const palm = box(0.34, 0.13, 0.19, M.joint)
    palm.position.y = 0.11
    j6.add(palm)
    // 气缸
    const airCyl = cyl(0.05, 0.05, 0.16, M.steel, 16)
    airCyl.position.set(0, 0.2, 0)
    j6.add(airCyl)

    // 两指：沿 ±X 开合，指尖在本地 y = TOOL_LEN
    for (const [grp, s] of [
      [fingerL, -1],
      [fingerR, 1],
    ] as Array<[THREE.Group, number]>) {
      grp.position.set(0, 0, 0)
      j6.add(grp)
      const pad = box(0.05, 0.22, 0.17, M.finger)
      pad.position.set(0, 0.35, 0)
      grp.add(pad)
      const web = box(0.04, 0.16, 0.09, M.joint)
      web.position.set(0, 0.19, 0)
      grp.add(web)
      const grip = box(0.024, 0.17, 0.14, std(0x14181d, 0.25, 0.92))
      grip.position.set(-s * 0.032, 0.35, 0)
      grp.add(grip)
      // 初始位置由 updateGrip 设置
    }

    shade(robot)
    // 夹爪手指薄件不必投影到自身
    fingerL.traverse((o) => ((o as THREE.Mesh).castShadow = true))
    fingerR.traverse((o) => ((o as THREE.Mesh).castShadow = true))

    /* ---------------- 塔灯 ---------------- */
    const towerLamp = new THREE.Group()
    towerLamp.position.set(0.0, 1.42, -0.36)
    robot.add(towerLamp)
    const lampPole = cyl(0.022, 0.022, 0.3, M.dark, 10)
    lampPole.position.y = -0.15
    towerLamp.add(lampPole)
    const lampMats = [
      new THREE.MeshStandardMaterial({ color: 0x5a1a1a, emissive: 0xff2a1e, emissiveIntensity: 0.6 }),
      new THREE.MeshStandardMaterial({ color: 0x5a4a12, emissive: 0xffc21e, emissiveIntensity: 0.15 }),
      new THREE.MeshStandardMaterial({ color: 0x14521f, emissive: 0x2bff6a, emissiveIntensity: 0.15 }),
    ]
    lampMats.forEach((m, i) => {
      const bulb = cyl(0.062, 0.062, 0.1, m, 18)
      bulb.position.y = 0.06 + i * 0.105
      towerLamp.add(bulb)
    })

    /* ---------------- 传送带 ---------------- */
    const conv = new THREE.Group()
    scene.add(conv)
    const cLen = CONV_X1 - CONV_X0
    const cMid = (CONV_X0 + CONV_X1) / 2

    const beltTex = beltTexture()
    beltTex.repeat.set(cLen * 1.6, 1)
    const belt = box(cLen, 0.06, 0.62, new THREE.MeshStandardMaterial({
      map: beltTex,
      roughness: 0.82,
      metalness: 0.12,
      color: 0xffffff,
    }))
    belt.position.set(cMid, CONV_Y - 0.03, 0)
    conv.add(belt)

    // 滚轮（InstancedMesh）
    const rollerGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.58, 16)
    rollerGeo.rotateX(Math.PI / 2)
    const rollerN = 22
    const rollers = new THREE.InstancedMesh(rollerGeo, M.steel, rollerN)
    const mtx = new THREE.Matrix4()
    for (let i = 0; i < rollerN; i++) {
      mtx.makeTranslation(CONV_X0 + 0.18 + (i * (cLen - 0.36)) / (rollerN - 1), CONV_Y - 0.1, 0)
      rollers.setMatrixAt(i, mtx)
    }
    rollers.instanceMatrix.needsUpdate = true
    rollers.castShadow = true
    rollers.frustumCulled = false
    conv.add(rollers)

    // 侧板 + 支腿
    for (const s of [-1, 1]) {
      const side = box(cLen, 0.2, 0.05, M.rail)
      side.position.set(cMid, CONV_Y - 0.08, s * 0.335)
      conv.add(side)
      const guard = box(cLen, 0.05, 0.03, M.fence)
      guard.position.set(cMid, CONV_Y + 0.1, s * 0.335)
      conv.add(guard)
    }
    for (let i = 0; i < 5; i++) {
      const x = CONV_X0 + 0.5 + (i * (cLen - 1)) / 4
      for (const s of [-1, 1]) {
        const leg = box(0.07, CONV_Y - 0.1, 0.07, M.rail)
        leg.position.set(x, (CONV_Y - 0.1) / 2, s * 0.3)
        conv.add(leg)
      }
      const cross = box(0.05, 0.05, 0.66, M.rail)
      cross.position.set(x, 0.24, 0)
      conv.add(cross)
    }
    // 传送带尾部挡板
    const stopPlate = box(0.04, 0.42, 0.7, M.fence)
    stopPlate.position.set(CONV_X1 + 0.02, CONV_Y + 0.16, 0)
    conv.add(stopPlate)

    // 取料工位传感器（对射光）
    const sensorBeam = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, 0.02, 0.66),
      new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.5 }),
    )
    sensorBeam.position.set(PICK_X + 0.32, CONV_Y + 0.26, 0)
    conv.add(sensorBeam)
    for (const s of [-1, 1]) {
      const post = box(0.05, 0.5, 0.05, M.joint)
      post.position.set(PICK_X + 0.32, CONV_Y + 0.25, s * 0.33)
      conv.add(post)
    }

    /* ---------------- 托盘 ---------------- */
    scene.add(palletGroup)
    function buildPallet() {
      palletGroup.clear()
      const pw = SLOT_GAP * 3 + 0.26
      // 上铺板（整块，带木纹渐变）
      const deck = box(pw, 0.03, pw, M.pallet)
      deck.position.set(PALLET_X, PALLET_TOP - 0.015, PALLET_Z)
      palletGroup.add(deck)
      // 纵梁
      for (const x of [-1, 0, 1]) {
        const beam = box(0.1, 0.09, pw, M.palletDark)
        beam.position.set(PALLET_X + x * (pw / 2 - 0.07), PALLET_TOP - 0.075, PALLET_Z)
        palletGroup.add(beam)
      }
      // 垫块
      for (const x of [-1, 0, 1]) {
        for (const z of [-1, 1]) {
          const b = box(0.11, 0.07, 0.11, M.palletDark)
          b.position.set(
            PALLET_X + x * (pw / 2 - 0.07),
            PALLET_TOP - 0.145,
            PALLET_Z + z * (pw / 2 - 0.07),
          )
          palletGroup.add(b)
        }
      }
      shade(palletGroup)
    }
    buildPallet()

    /* ---------------- 安全围栏 ---------------- */
    const fence = new THREE.Group()
    scene.add(fence)
    const FX0 = -3.7
    const FX1 = 3.5
    const FZ0 = -3.1
    const FZ1 = 2.15
    const FH = 1.5
    const postGeo = new THREE.CylinderGeometry(0.045, 0.045, FH, 12)
    function fenceRun(x0: number, z0: number, x1: number, z1: number) {
      const len = Math.hypot(x1 - x0, z1 - z0)
      const n = Math.max(2, Math.round(len / 1.6))
      for (let i = 0; i <= n; i++) {
        const t = i / n
        const p = new THREE.Mesh(postGeo, M.fence)
        p.position.set(x0 + (x1 - x0) * t, FH / 2, z0 + (z1 - z0) * t)
        p.castShadow = true
        fence.add(p)
      }
      // 网状钢丝（线段）
      const pts: number[] = []
      const dirX = (x1 - x0) / len
      const dirZ = (z1 - z0) / len
      const nx = -dirZ
      const nz = dirX
      for (let h = 0.05; h < FH; h += 0.16) {
        pts.push(x0, h, z0, x1, h, z1)
      }
      for (let d = 0; d <= len; d += 0.22) {
        const bx = x0 + dirX * d
        const bz = z0 + dirZ * d
        pts.push(bx + nx * 0.0, 0.05, bz + nz * 0.0, bx + nx * 0.0, FH, bz + nz * 0.0)
      }
      const lg = new THREE.BufferGeometry()
      lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      const lines = new THREE.LineSegments(
        lg,
        new THREE.LineBasicMaterial({ color: 0x9aa6b2, transparent: true, opacity: 0.32 }),
      )
      fence.add(lines)
      // 上下横杆 + 踢脚板
      const dir = new THREE.Vector3(x1 - x0, 0, z1 - z0).normalize()
      const up = new THREE.Vector3(0, 1, 0)
      for (const h of [FH - 0.05, 0.5]) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, len, 8), M.rail)
        bar.position.set((x0 + x1) / 2, h, (z0 + z1) / 2)
        bar.quaternion.setFromUnitVectors(up, dir)
        bar.castShadow = true
        fence.add(bar)
      }
      const kick = new THREE.Mesh(new THREE.BoxGeometry(len, 0.07, 0.025), M.rail)
      kick.position.set((x0 + x1) / 2, 0.06, (z0 + z1) / 2)
      kick.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir)
      fence.add(kick)
    }
    // 三面围栏，靠传送带一侧留口
    fenceRun(FX0, FZ0, FX1, FZ0)
    fenceRun(FX0, FZ1, FX0, FZ0)
    fenceRun(FX1, FZ1, FX0, FZ1)

    /* ---------------- 阴影设置 ---------------- */
    belt.receiveShadow = true

    /* ============================================================
     * 料箱
     * ============================================================ */
    const cartonTex = cartonTexture()
    const cartonMat = new THREE.MeshStandardMaterial({
      map: cartonTex,
      roughness: 0.86,
      metalness: 0.02,
    })

    function spawnBox() {
      const geo = new THREE.BoxGeometry(BOX_W, BOX_H, BOX_W)
      const mesh = new THREE.Mesh(geo, cartonMat)
      mesh.position.set(CONV_X1 - 0.2, CONV_Y + BOX_H / 2, 0)
      mesh.rotation.y = (Math.random() - 0.5) * 0.12
      mesh.castShadow = true
      mesh.receiveShadow = true
      scene.add(mesh)
      beltBoxes.push({ mesh, state: 'belt' })
    }

    /* ============================================================
     * 取放料动作序列
     * ============================================================ */

    /** 码垛目标中心点 */
    function slotCenter(i: number) {
      const layer = Math.floor(i / LAYER_CAP)
      const k = i % LAYER_CAP
      return new THREE.Vector3(
        PALLET_X + ((k % 3) - 1) * SLOT_GAP,
        PALLET_TOP + BOX_H / 2 + layer * BOX_H,
        PALLET_Z + (Math.floor(k / 3) - 1) * SLOT_GAP,
      )
    }

    function startCycle(boxMesh: THREE.Mesh) {
      const src = boxMesh.position
      const pick = new THREE.Vector3(src.x, src.y, src.z)
      const slot = slotCenter(slotIndex)
      const place = new THREE.Vector3(slot.x, slot.y, slot.z)
      const lift = 0.62
      const cargo = beltBoxes.find((b) => b.mesh === boxMesh)!
      status.value = '取料'

      steps = [
        {
          to: pick.clone().setY(pick.y + lift),
          dur: 0.95,
          label: '直达取料点上方',
        },
        { to: pick.clone(), dur: 0.5, label: '下降取料' },
        {
          to: pick.clone(),
          dur: 0.34,
          label: '夹爪闭合',
          onEnd: () => {
            gripNow = 0
            gripTarget = 1
            held = cargo
            cargo.state = 'held'
            const k = beltBoxes.indexOf(cargo)
            if (k >= 0) beltBoxes.splice(k, 1)
            status.value = '搬运'
          },
        },
        { to: pick.clone().setY(pick.y + lift), dur: 0.52, label: '提升' },
        { to: place.clone().setY(place.y + lift), dur: 1.15, label: '平移至码垛位' },
        { to: place.clone(), dur: 0.5, label: '下降放料' },
        {
          to: place.clone(),
          dur: 0.32,
          label: '夹爪张开',
          onEnd: () => {
            gripTarget = 0
            if (held) {
              // slot 是箱子中心，place 是指尖（箱顶）位置，别搞混
              held.mesh.position.copy(slot)
              held.mesh.rotation.y = 0
              held.mesh.userData.home = slot.clone()
              held.state = 'placed'
              placed.push(held)
              held = null
              count.value++
              totalOut.value++
            }
            slotIndex++
            status.value = '回位'
          },
        },
        { to: place.clone().setY(place.y + lift), dur: 0.55, label: '抬升' },
        {
          to: new THREE.Vector3(1.95, 1.56, 0.2),
          dur: 0.8,
          label: '返回等待位',
          onEnd: () => {
            status.value = '待机'
            if (slotIndex >= TOTAL) resetting = true
          },
        },
      ]
      stepIdx = 0
      stepT = 0
      stepFrom.copy(tipPos)
    }

    /* ============================================================
     * 每帧更新
     * ============================================================ */
    let lampT = 0
    let curYaw = 0
    let curA2 = 0.7
    let curA3 = 1.2
    let curA5 = 1.2

    tipPos.set(1.95, 1.56, 0.2)
    {
      const g = solveIK(tipPos)
      curYaw = g.yaw
      curA2 = g.a2
      curA3 = g.a3
      curA5 = g.a5
    }

    function updateGrip() {
      // 指尖中心到指尖底部…手指沿 X 张开
      // 纸箱宽 0.46、手指厚 0.05 → 闭合时指心必须在 ±0.25，张开到 ±0.40
      const open = 0.25 + (1 - gripNow) * 0.15
      fingerL.position.x = -open
      fingerR.position.x = open
    }
    updateGrip()

    function tick(dtRaw: number) {
      const dt = Math.min(dtRaw, 0.05)
      const d = running.value ? dt * speed.value : 0

      lampT += dt
      // 塔灯：运行时绿灯呼吸，暂停时黄灯闪
      const breathe = 0.55 + 0.45 * Math.sin(lampT * 3.4)
      lampMats[2].emissiveIntensity = running.value ? 0.35 + breathe * 1.6 : 0.08
      lampMats[1].emissiveIntensity = running.value ? 0.05 : 0.4 + Math.abs(Math.sin(lampT * 6)) * 1.6
      lampMats[0].emissiveIntensity = 0.12

      /* --- 传送带送料 --- */
      if (d > 0) {
        spawnTimer += d
        const interval = 1.55
        if (spawnTimer >= interval && beltBoxes.length + (held ? 1 : 0) < 4) {
          spawnTimer = 0
          spawnBox()
        }
        // 皮带纹理滚动
        beltTex.offset.x -= d * 0.55
      }

      /* --- 料箱前进 / 排队 --- */
      for (let i = 0; i < beltBoxes.length; i++) {
        const b = beltBoxes[i]
        const stopX = PICK_X + i * (BOX_W + 0.13)
        const p = b.mesh.position
        if (p.x > stopX) p.x = Math.max(stopX, p.x - BELT_SPEED * d)
        b.mesh.rotation.y *= 1 - Math.min(1, d * 6)
      }

      /* --- 动作序列推进 --- */
      if (steps.length && d > 0) {
        const st = steps[stepIdx]
        stepT += d / st.dur
        tipPos.lerpVectors(stepFrom, st.to, easeInOut(clamp(stepT, 0, 1)))
        if (stepT >= 1) {
          tipPos.copy(st.to)
          st.onEnd?.()
          stepIdx++
          stepT = 0
          stepFrom.copy(st.to)
          if (stepIdx >= steps.length) steps = []
        }
      }

      /* --- 没有任务且取料位有箱子 → 开始新周期 --- */
      if (!steps.length && !held && !resetting && slotIndex < TOTAL && beltBoxes.length) {
        const front = beltBoxes[0]
        if (front.mesh.position.x <= PICK_X + 0.004) startCycle(front.mesh)
      }

      /* --- 逆解 + 关节插值 --- */
      const g = solveIK(tipPos)
      let dy = g.yaw - curYaw
      dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
      const kk = Math.min(1, dt * 16)
      curYaw += dy * kk
      curA2 += (g.a2 - curA2) * kk
      curA3 += (g.a3 - curA3) * kk
      curA5 += (g.a5 - curA5) * kk
      j1.rotation.y = curYaw
      j2.rotation.x = curA2
      j3.rotation.x = curA3
      j5.rotation.x = curA5
      j6.rotation.y = -curYaw

      /* --- 夹爪 --- */
      gripNow += (gripTarget - gripNow) * Math.min(1, dt * 12)
      updateGrip()

      /* --- 夹住的箱子跟随指尖 --- */
      if (held) {
        j6.updateWorldMatrix(true, false)
        tmpV.set(0, TOOL_LEN - J6_OFFSET, 0).applyMatrix4(j6.matrixWorld)
        held.mesh.position.set(tmpV.x, tmpV.y, tmpV.z)
        held.mesh.rotation.y = 0
      }

      /* --- 整托出库 --- */
      if (resetting) {
        palletOut += dt
        const t = Math.min(1, palletOut / 1.7)
        const e = easeInOut(t)
        palletGroup.position.set(0, -e * 0.3, -e * 5.4)
        placed.forEach((c) => {
          const home = c.mesh.userData.home as THREE.Vector3 | undefined
          if (home) c.mesh.position.set(home.x, home.y - e * 0.3, home.z - e * 5.4)
        })
        if (t >= 1) {
          placed.forEach((c) => scene.remove(c.mesh))
          placed.length = 0
          slotIndex = 0
          count.value = 0
          pallets.value++
          palletOut = 0
          palletGroup.position.set(0, 0, 0)
          resetting = false
          status.value = '待机'
        }
      }
    }

    /* ---------------- 对外暴露的操作 ---------------- */
    cleanups.push(() => {
      pmrem.dispose()
      envTex.dispose()
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.geometry?.dispose()
        }
      })
    })

    return tick
  },
)

/* ---------------- UI 操作 ---------------- */
function toggleRun() {
  running.value = !running.value
  status.value = running.value ? '运行' : '暂停'
}
function resetAll() {
  placed.forEach((c) => c.mesh.parent?.remove(c.mesh))
  placed.length = 0
  beltBoxes.forEach((c) => c.mesh.parent?.remove(c.mesh))
  beltBoxes.length = 0
  if (held) {
    held.mesh.parent?.remove(held.mesh)
    held = null
  }
  steps = []
  stepIdx = 0
  stepT = 0
  slotIndex = 0
  count.value = 0
  totalOut.value = 0
  pallets.value = 0
  spawnTimer = 0
  resetting = false
  palletOut = 0
  palletGroup.position.set(0, 0, 0)
  palletGroup.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.material) {
      const mat = m.material as THREE.MeshStandardMaterial
      mat.opacity = 1
      mat.transparent = false
    }
  })
  tipPos.set(1.95, 1.56, 0.2)
  status.value = '已复位'
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>

    <div class="panel">
      <div class="title">
        <span class="dot" :class="{ live: running }"></span>
        六轴工业机器人 · 码垛工作站
      </div>
      <div class="sub">解析逆解驱动 · 传送带上下料 · 双指夹爪</div>

      <div class="row">
        <button class="btn primary" @click="toggleRun">{{ running ? '暂停' : '启动' }}</button>
        <button class="btn" @click="resetAll">复位</button>
      </div>

      <div class="slider">
        <span class="lab">节拍</span>
        <input v-model.number="speed" type="range" min="0.3" max="2.2" step="0.1" />
        <b>{{ speed.toFixed(1) }}×</b>
      </div>

      <div class="stat">
        <div class="item">
          <span class="k">本托</span>
          <b>{{ count }}</b>
          <span class="u">/ {{ TOTAL }} 件</span>
        </div>
        <div class="item">
          <span class="k">已出库</span>
          <b class="alt">{{ pallets }}</b>
          <span class="u">托 · {{ totalOut }} 件</span>
        </div>
      </div>

      <div class="state">当前动作：<b>{{ status }}</b></div>

      <div class="legend">
        <span><i class="c1"></i>腰 j1</span>
        <span><i class="c2"></i>肩 j2</span>
        <span><i class="c3"></i>肘 j3</span>
        <span><i class="c4"></i>腕 j5/j6</span>
      </div>

      <div class="tip">
        腰角取目标方位角；肩肘在臂平面内用 2R 解析解；腕部俯仰补偿 π−(a2+a3) 使夹爪始终竖直向下，
        腕自转 −θ1 抵消腰转，保证手指恒对齐料箱边。
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
  width: 300px;
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
  box-shadow: 0 0 0 rgba(0, 0, 0, 0);
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
.btn:hover {
  border-color: rgba(120, 165, 220, 0.75);
  color: #e6f0fa;
}
.btn.primary {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.slider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 11px;
  color: #93a5b8;
}
.slider input {
  flex: 1;
  height: 3px;
  accent-color: #4f9dff;
}
.slider b {
  width: 34px;
  text-align: right;
  color: #cfe0f2;
  font-variant-numeric: tabular-nums;
}
.stat {
  display: flex;
  gap: 14px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid rgba(88, 108, 132, 0.28);
}
.item {
  display: flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11.5px;
}
.item b {
  font-size: 16px;
  font-weight: 600;
  color: #7ee787;
  font-variant-numeric: tabular-nums;
}
.item b.small {
  font-size: 12px;
  color: #ffd479;
}
.item b.alt {
  color: #6fb3ff;
}
.state {
  margin-top: 7px;
  font-size: 11px;
  color: #8496a8;
}
.state b {
  color: #ffd479;
  font-weight: 600;
}
.item .u,
.item .k {
  font-size: 10.5px;
  color: #7d8fa2;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 9px;
  font-size: 10.5px;
  color: #8496a8;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.legend i {
  width: 6px;
  height: 6px;
  border-radius: 2px;
}
.c1 {
  background: #4f9dff;
}
.c2 {
  background: #7ee787;
}
.c3 {
  background: #ffd479;
}
.c4 {
  background: #ff8fa3;
}
.tip {
  margin-top: 8px;
  font-size: 10.8px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
