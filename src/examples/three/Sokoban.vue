<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { useThree } from './useThree'

/* ============================================================
 * 三维推箱子 · Sokoban 3D
 *
 * 玩法：方向键 / WASD 移动，把每个木箱推到发光目标点即为过关。
 * 场景细节：
 *  - 地砖逐块建模（倒角 + 缝隙 + 深浅交替），墙体带压顶石
 *  - 木箱用圆角盒 + 木板纹理 + 四角金属包边，压上目标点会透出绿光
 *  - 目标环呼吸脉动；角色是带行走起伏、转身插值的小机器人
 *  - 单向投影（PCFSoft 阴影贴图）+ 半球光 + ACES 色调映射
 * 交互：拖拽旋转视角、滚轮缩放、Z 撤销、R 重来
 * ============================================================ */

/* ---------------- 关卡（# 墙 / . 目标 / $ 箱 / @ 玩家） ---------------- */
const LEVELS: string[][] = [
  [
    '#######',
    '#     #',
    '#     #',
    '#  .  #',
    '#  $  #',
    '#  @  #',
    '#######',
  ],
  [
    '########',
    '#      #',
    '# $  . #',
    '#  @   #',
    '# $  . #',
    '#      #',
    '########',
  ],
  [
    '##########',
    '#        #',
    '#  $  .  #',
    '#  #  #  #',
    '#  @  .  #',
    '#  $  #  #',
    '#        #',
    '##########',
  ],
  [
    '##########',
    '#        #',
    '#  .  .  #',
    '#  $  $  #',
    '#   @    #',
    '#  $  $  #',
    '#  .  .  #',
    '#        #',
    '##########',
  ],
]
const LEVEL_NAMES = ['初次推箱', '双箱对推', '走廊拐角', '四箱仓库']
/** 各关最少步数（BFS 求出，用于展示"最优"参考） */
const LEVEL_BEST = [1, 14, 18, 11]

/* ---------------- UI 状态 ---------------- */
const container = ref<HTMLDivElement>()
const levelIdx = ref(0)
const moves = ref(0)
const pushes = ref(0)
const won = ref(false)
const follow = ref(true)
const hint = ref('方向键 / WASD 移动，把木箱推到发光点')
const levelName = computed(() => `${levelIdx.value + 1}. ${LEVEL_NAMES[levelIdx.value]}`)

/* ---------------- 棋盘数据 ---------------- */
const TILE = 1
const WALL_H = 0.62
interface Cell {
  wall: boolean
  goal: boolean
}
let W = 0
let H = 0
let grid: Cell[][] = []
let px = 0
let pz = 0
/** "x,z" → 箱子 */
let boxes = new Set<string>()
/** 撤销栈：每一步存快照 */
let history: Array<{ px: number; pz: number; boxes: string[] }> = []

const key = (x: number, z: number) => `${x},${z}`

function parseLevel(rows: string[]) {
  H = rows.length
  W = Math.max(...rows.map((r) => r.length))
  grid = []
  boxes = new Set()
  history = []
  for (let z = 0; z < H; z++) {
    const line = rows[z].padEnd(W, '#')
    const row: Cell[] = []
    for (let x = 0; x < W; x++) {
      const ch = line[x]
      row.push({ wall: ch === '#', goal: ch === '.' || ch === '*' || ch === '+' })
      if (ch === '$' || ch === '*') boxes.add(key(x, z))
      if (ch === '@' || ch === '+') {
        px = x
        pz = z
      }
    }
    grid.push(row)
  }
}

const isWall = (x: number, z: number) => x < 0 || z < 0 || x >= W || z >= H || grid[z][x].wall
const isGoal = (x: number, z: number) => !isWall(x, z) && grid[z][x].goal
/** 世界坐标：棋盘居中，x 向东、z 向南 */
const worldX = (x: number) => (x - (W - 1) / 2) * TILE
const worldZ = (z: number) => (z - (H - 1) / 2) * TILE

/* ---------------- 材质 / 纹理 ---------------- */
/** 木箱纹理：竖向木板 + 节疤，画在 canvas 上 */
function woodTexture(): THREE.CanvasTexture {
  const S = 256
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.fillStyle = '#8b5a2b'
  g.fillRect(0, 0, S, S)
  const plank = S / 4
  for (let i = 0; i < 4; i++) {
    const base = 62 + Math.random() * 26
    g.fillStyle = `rgb(${base + 78},${base + 32},${base - 6})`
    g.fillRect(i * plank + 1, 0, plank - 2, S)
    // 木纹
    g.strokeStyle = `rgba(${base + 30},${base - 6},${base - 24},0.55)`
    g.lineWidth = 1.4
    for (let k = 0; k < 9; k++) {
      const y0 = Math.random() * S
      g.beginPath()
      g.moveTo(i * plank + 4, y0)
      g.bezierCurveTo(
        i * plank + plank * 0.3,
        y0 + 12,
        i * plank + plank * 0.7,
        y0 - 14,
        i * plank + plank - 4,
        y0 + 6,
      )
      g.stroke()
    }
    // 板缝
    g.fillStyle = 'rgba(40,22,10,0.55)'
    g.fillRect(i * plank, 0, 1.5, S)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

/** 石砖纹理：轻微斑驳，铺在地砖上增加细节 */
function stoneTexture(): THREE.CanvasTexture {
  const S = 128
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.fillStyle = '#5b6470'
  g.fillRect(0, 0, S, S)
  for (let i = 0; i < 900; i++) {
    const a = 0.03 + Math.random() * 0.07
    g.fillStyle = `rgba(${200 + Math.random() * 40},${205 + Math.random() * 40},${215},${a})`
    const r = 1 + Math.random() * 2.4
    g.beginPath()
    g.arc(Math.random() * S, Math.random() * S, r, 0, Math.PI * 2)
    g.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

const woodTex = woodTexture()
const stoneTex = stoneTexture()

const matFloorA = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0xb3c0cf, roughness: 0.88, metalness: 0.05 })
const matFloorB = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0x9aa8b8, roughness: 0.9, metalness: 0.05 })
const matWall = new THREE.MeshStandardMaterial({ color: 0x4a5665, roughness: 0.76, metalness: 0.18 })
const matWallCap = new THREE.MeshStandardMaterial({ color: 0x6f7d91, roughness: 0.6, metalness: 0.25 })
const matCrate = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.72, metalness: 0.06 })
const matCrateBand = new THREE.MeshStandardMaterial({ color: 0x6d7683, roughness: 0.42, metalness: 0.85 })
const matGoal = new THREE.MeshStandardMaterial({
  color: 0x2ee6c8,
  emissive: new THREE.Color(0x1ec8ad),
  emissiveIntensity: 0.9,
  roughness: 0.35,
  metalness: 0.2,
})
const matGoalOn = new THREE.MeshStandardMaterial({
  color: 0x8dff9e,
  emissive: new THREE.Color(0x45e06a),
  emissiveIntensity: 1.4,
  roughness: 0.3,
})

/* ---------------- 场景图元（重建关卡时整体替换） ---------------- */
const board = new THREE.Group()
const staticGroup = new THREE.Group() // 地砖 + 墙
const goalGroup = new THREE.Group()
const crateGroup = new THREE.Group()
let playerRig: THREE.Group | null = null
const goalRings: THREE.Mesh[] = []
const crateMeshes = new Map<string, THREE.Group>()

/* 复用的几何体 */
const tileGeo = new RoundedBoxGeometry(TILE * 0.965, 0.14, TILE * 0.965, 2, 0.03)
const wallGeo = new RoundedBoxGeometry(TILE * 0.99, WALL_H, TILE * 0.99, 2, 0.06)
const capGeo = new RoundedBoxGeometry(TILE * 0.99, 0.1, TILE * 0.99, 2, 0.03)
const crateGeo = new RoundedBoxGeometry(0.8, 0.8, 0.8, 3, 0.055)
const bandGeo = new THREE.BoxGeometry(0.83, 0.075, 0.83)
const ringGeo = new THREE.RingGeometry(0.27, 0.36, 40)
const goalPlateGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.02, 32)

/* ---------------- 动画状态 ---------------- */
interface Tween {
  obj: THREE.Object3D
  fx: number
  fz: number
  tx: number
  tz: number
  t: number
  dur: number
  hop?: number
}
let tweens: Tween[] = []
let animating = false
let pendingDir: [number, number] | null = null
let playerYaw = 0
let bobT = 0
let elapsed = 0

/** 相机轨道参数（拖拽旋转 / 滚轮缩放） */
let camYaw = -Math.PI / 4
let camElev = 0.62
let camDist = 12
const camTarget = new THREE.Vector3()

let three: ReturnType<typeof useThree> | null = null

/* ---------------- 建场景 ---------------- */
function buildBoard() {
  // 清空
  for (const g of [staticGroup, goalGroup, crateGroup]) {
    g.clear()
  }
  goalRings.length = 0
  crateMeshes.clear()
  if (playerRig) {
    board.remove(playerRig)
    playerRig = null
  }

  // 地砖：只在非墙格上铺，深浅交替 + 缝隙
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (isWall(x, z)) continue
      const tile = new THREE.Mesh(tileGeo, (x + z) % 2 === 0 ? matFloorA : matFloorB)
      tile.position.set(worldX(x), -0.07, worldZ(z))
      tile.receiveShadow = true
      staticGroup.add(tile)
    }
  }

  // 墙：主体 + 压顶石
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (!isWall(x, z)) continue
      const wall = new THREE.Mesh(wallGeo, matWall)
      wall.position.set(worldX(x), WALL_H / 2 - 0.02, worldZ(z))
      wall.castShadow = true
      wall.receiveShadow = true
      staticGroup.add(wall)
      const cap = new THREE.Mesh(capGeo, matWallCap)
      cap.position.set(worldX(x), WALL_H - 0.01, worldZ(z))
      cap.castShadow = true
      staticGroup.add(cap)
    }
  }

  // 目标点：发光底盘 + 呼吸环
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (!isGoal(x, z)) continue
      const plate = new THREE.Mesh(goalPlateGeo, matGoal)
      plate.position.set(worldX(x), 0.012, worldZ(z))
      plate.receiveShadow = true
      goalGroup.add(plate)
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0x3ff0d4,
          transparent: true,
          opacity: 0.8,
          side: THREE.DoubleSide,
        }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(worldX(x), 0.03, worldZ(z))
      goalGroup.add(ring)
      goalRings.push(ring)
    }
  }

  // 箱子
  for (const k of boxes) {
    const [bx, bz] = k.split(',').map(Number)
    spawnCrate(bx, bz, key(bx, bz))
  }

  // 角色
  playerRig = buildPlayer()
  playerRig.position.set(worldX(px), 0, worldZ(pz))
  board.add(playerRig)
}

/** 木箱：圆角盒 + 四条金属包边（上下各一圈） */
function spawnCrate(x: number, z: number, k: string) {
  const g = new THREE.Group()
  // 每个箱子独立材质：压上目标点要单独透绿光
  const bodyMat = matCrate.clone()
  const body = new THREE.Mesh(crateGeo, bodyMat)
  g.userData.mat = bodyMat
  body.castShadow = true
  body.receiveShadow = true
  g.add(body)
  for (const y of [-0.3, 0.3]) {
    const band = new THREE.Mesh(bandGeo, matCrateBand)
    band.position.y = y
    band.castShadow = true
    g.add(band)
  }
  // 顶面十字压条
  const cross = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.03, 0.1), matCrateBand)
  cross.position.y = 0.405
  g.add(cross)
  g.position.set(worldX(x), 0.42, worldZ(z))
  crateGroup.add(g)
  crateMeshes.set(k, g)
  setCrateGlow(g, isGoal(x, z))
}

/** 箱子压在目标上时透出绿光（直接改这套独立材质的 emissive） */
function setCrateGlow(g: THREE.Object3D, on: boolean) {
  const m = g.userData.mat as THREE.MeshStandardMaterial | undefined
  if (!m) return
  m.emissive.setHex(on ? 0x2fbf62 : 0x000000)
  m.emissiveIntensity = on ? 0.7 : 0
  m.roughness = on ? 0.55 : 0.72
}

/** 机器人：胶囊身体 + 球头面罩 + 双臂 + 天线 */
function buildPlayer(): THREE.Group {
  const g = new THREE.Group()
  g.scale.setScalar(1.12)
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffab4a, roughness: 0.45, metalness: 0.25 })
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b3340, roughness: 0.5, metalness: 0.6 })
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x0d1822,
    roughness: 0.15,
    metalness: 0.9,
    emissive: new THREE.Color(0x1f6f9c),
    emissiveIntensity: 0.35,
  })

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.26, 8, 16), bodyMat)
  body.position.y = 0.36
  body.castShadow = true
  g.add(body)

  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.1, 20), darkMat)
  skirt.position.y = 0.12
  skirt.castShadow = true
  g.add(skirt)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.185, 26, 20), bodyMat)
  head.position.y = 0.78
  head.castShadow = true
  g.add(head)

  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 18, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.32, Math.PI * 0.42), visorMat)
  visor.position.copy(head.position)
  visor.rotation.y = Math.PI / 2
  g.add(visor)

  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8), darkMat)
  antenna.position.set(0, 0.98, 0)
  g.add(antenna)
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xffe066, emissive: new THREE.Color(0xffc93c), emissiveIntensity: 1.2 }),
  )
  bulb.position.set(0, 1.07, 0)
  g.add(bulb)

  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.2, 6, 12), darkMat)
    arm.position.set(s * 0.26, 0.42, 0)
    arm.rotation.z = s * 0.28
    arm.castShadow = true
    g.add(arm)
  }

  // 脚下柔和投影（贴地圆片，弥补阴影贴图的硬边）
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.34, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.005
  g.add(shadow)

  return g
}

/* ---------------- 游戏逻辑 ---------------- */
function snapshot(): { px: number; pz: number; boxes: string[] } {
  return { px, pz, boxes: [...boxes] }
}

function move(dx: number, dz: number) {
  if (won.value) return
  if (animating) {
    pendingDir = [dx, dz]
    return
  }
  const nx = px + dx
  const nz = pz + dz
  if (isWall(nx, nz)) return
  const targetKey = key(nx, nz)
  let pushed = false
  let movingCrateKey: string | null = null
  let crateTo: { x: number; z: number } | null = null

  if (boxes.has(targetKey)) {
    const bx = nx + dx
    const bz = nz + dz
    // 箱子后面是墙或箱子 → 推不动
    if (isWall(bx, bz) || boxes.has(key(bx, bz))) return
    movingCrateKey = targetKey
    crateTo = { x: bx, z: bz }
    pushed = true
  }

  history.push(snapshot())
  if (history.length > 200) history.shift()

  // 更新数据模型
  px = nx
  pz = nz
  if (pushed && movingCrateKey && crateTo) {
    boxes.delete(movingCrateKey)
    boxes.add(key(crateTo.x, crateTo.z))
  }
  moves.value += 1
  if (pushed) pushes.value += 1

  // 视觉动画
  animating = true
  const dur = 0.13
  if (playerRig) {
    tweens.push({ obj: playerRig, fx: worldX(px - dx), fz: worldZ(pz - dz), tx: worldX(px), tz: worldZ(pz), t: 0, dur, hop: 0.07 })
  }
  if (pushed && movingCrateKey && crateTo) {
    const mesh = crateMeshes.get(movingCrateKey)
    const toKey = key(crateTo.x, crateTo.z)
    if (mesh) {
      crateMeshes.delete(movingCrateKey)
      crateMeshes.set(toKey, mesh)
      tweens.push({
        obj: mesh,
        fx: worldX(crateTo.x - dx),
        fz: worldZ(crateTo.z - dz),
        tx: worldX(crateTo.x),
        tz: worldZ(crateTo.z),
        t: 0,
        dur: dur * 1.15,
      })
    }
    // 目标点状态（落定后再刷新发光，避免闪烁）
  }

  // 转身
  playerYaw = Math.atan2(dx, dz)

  setTimeout(() => {
    finishMove()
  }, dur * 1000 + 20)
}

function finishMove() {
  animating = false
  // 刷新所有箱子的发光状态
  for (const [k, mesh] of crateMeshes) {
    const [x, z] = k.split(',').map(Number)
    setCrateGlow(mesh, isGoal(x, z))
  }
  checkWin()
  if (!won.value && pendingDir) {
    const [dx, dz] = pendingDir
    pendingDir = null
    move(dx, dz)
  }
}

function checkWin() {
  for (const k of boxes) {
    const [x, z] = k.split(',').map(Number)
    if (!isGoal(x, z)) return
  }
  won.value = true
  hint.value = `过关！用了 ${moves.value} 步（最优 ${LEVEL_BEST[levelIdx.value]} 步）`
  goalRings.forEach((r) => {
    ;(r.material as THREE.MeshBasicMaterial).color.set(0x9dffb0)
  })
}

function undo() {
  if (animating || !history.length) return
  const s = history.pop()!
  px = s.px
  pz = s.pz
  boxes = new Set(s.boxes)
  moves.value = Math.max(0, moves.value - 1)
  // 位置直接重建（撤销不需要动画）
  rebuildDynamic()
  won.value = false
  if (LEVEL_BEST[levelIdx.value] === undefined) hint.value = ''
}

function rebuildDynamic() {
  crateGroup.clear()
  crateMeshes.clear()
  for (const k of boxes) {
    const [x, z] = k.split(',').map(Number)
    spawnCrate(x, z, k)
  }
  if (playerRig) {
    playerRig.position.set(worldX(px), 0, worldZ(pz))
  }
}

function loadLevel(i: number) {
  levelIdx.value = i
  parseLevel(LEVELS[i])
  moves.value = 0
  pushes.value = 0
  won.value = false
  tweens = []
  animating = false
  pendingDir = null
  hint.value = '方向键 / WASD 移动，把木箱推到发光点'
  buildBoard()
  fitCamera()
}

function restart() {
  loadLevel(levelIdx.value)
}

function nextLevel() {
  if (levelIdx.value + 1 < LEVELS.length) loadLevel(levelIdx.value + 1)
  else {
    hint.value = '已经是最后一关，按「重来」再玩一次'
  }
}

/* ---------------- 相机 ---------------- */
function fitCamera() {
  const span = Math.max(W, H)
  camDist = span * 1.15 + 2.6
  camTarget.set(0, 0.4, 0)
}

function updateCamera(dt: number) {
  if (!three) return
  const cam = three.camera
  const goal = follow.value && playerRig ? new THREE.Vector3(worldX(px), 0.5, worldZ(pz)) : new THREE.Vector3(0, 0.3, 0)
  const k = 1 - Math.exp(-6 * dt)
  camTarget.lerp(goal, k)
  const ce = Math.cos(camElev)
  cam.position.set(
    camTarget.x + camDist * ce * Math.sin(camYaw),
    camTarget.y + camDist * Math.sin(camElev),
    camTarget.z + camDist * ce * Math.cos(camYaw),
  )
  cam.lookAt(camTarget)
}

/* ---------------- 键盘 / 指针 ---------------- */
const KEYMAP: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  w: [0, -1],
  s: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  W: [0, -1],
  S: [0, 1],
  A: [-1, 0],
  D: [1, 0],
}

function onKey(e: KeyboardEvent) {
  const dir = KEYMAP[e.key]
  if (dir) {
    e.preventDefault()
    move(dir[0], dir[1])
    return
  }
  if (e.key === 'z' || e.key === 'Z') undo()
  if (e.key === 'r' || e.key === 'R') restart()
  if (e.key === 'n' || e.key === 'N') nextLevel()
}

let dragging = false
let lastX = 0
let lastY = 0

function onPointerDown(e: PointerEvent) {
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
}
function onPointerMove(e: PointerEvent) {
  if (!dragging) return
  camYaw -= (e.clientX - lastX) * 0.006
  camElev = THREE.MathUtils.clamp(camElev + (e.clientY - lastY) * 0.004, 0.16, 1.25)
  lastX = e.clientX
  lastY = e.clientY
}
function onPointerUp() {
  dragging = false
}
function onWheel(e: WheelEvent) {
  e.preventDefault()
  camDist = THREE.MathUtils.clamp(camDist * (1 + Math.sign(e.deltaY) * 0.08), 4, 40)
}

/* ---------------- 启动 ---------------- */
parseLevel(LEVELS[0])

three = useThree(
  container,
  {
    fov: 40,
    near: 0.1,
    far: 200,
    background: 0x0d131b,
    shadows: true,
    controls: false,
    cameraPos: [8, 9, 8],
  },
  (ctx) => {
    ctx.renderer.toneMapping = THREE.ACESFilmicToneMapping
    ctx.renderer.toneMappingExposure = 1.18
    ctx.renderer.outputColorSpace = THREE.SRGBColorSpace

    // 环境光：半球光压暗地面 + 主平行光投影
    const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x2a3342, 1.25)
    ctx.scene.add(hemi)
    // 环境补光：墙体会挡主光，没有环境光棋盘内部就是一团黑
    ctx.scene.add(new THREE.AmbientLight(0x5b6b80, 0.55))
    // 主光偏垂直，避免高墙把光挡在场地外
    const key = new THREE.DirectionalLight(0xfff2e0, 2.5)
    key.position.set(4.5, 15, 5.5)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.near = 1
    key.shadow.camera.far = 40
    const S = Math.max(W, H) * 0.75 + 2
    key.shadow.camera.left = -S
    key.shadow.camera.right = S
    key.shadow.camera.top = S
    key.shadow.camera.bottom = -S
    key.shadow.bias = -0.0006
    key.shadow.normalBias = 0.02
    ctx.scene.add(key)
    const rim = new THREE.DirectionalLight(0x6ea8ff, 0.55)
    rim.position.set(-7, 5, -6)
    ctx.scene.add(rim)

    // 底座：棋盘下方一块厚板，给整个场景"落地"感
    const base = new THREE.Mesh(
      new RoundedBoxGeometry(W * TILE + 0.9, 0.36, H * TILE + 0.9, 2, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x1a2029, roughness: 0.9, metalness: 0.15 }),
    )
    base.position.y = -0.3
    base.receiveShadow = true
    ctx.scene.add(base)

    // 地面：大圆盘接阴影，外圈渐隐
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(Math.max(W, H) * 6, 64),
      new THREE.MeshStandardMaterial({ color: 0x0f151d, roughness: 1 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.48
    ground.receiveShadow = true
    ctx.scene.add(ground)

    ctx.scene.add(board)
    board.add(staticGroup, goalGroup, crateGroup)
    ctx.scene.fog = new THREE.Fog(0x0d131b, 22, 46)

    fitCamera()
    buildBoard()

    window.addEventListener('keydown', onKey)
    const dom = ctx.renderer.domElement
    dom.addEventListener('pointerdown', onPointerDown)
    dom.addEventListener('pointermove', onPointerMove)
    dom.addEventListener('pointerup', onPointerUp)
    dom.addEventListener('pointerleave', onPointerUp)
    dom.addEventListener('wheel', onWheel, { passive: false })
    dom.style.cursor = 'grab'

    return (dt: number) => {
      elapsed += dt
      // 目标环呼吸
      goalRings.forEach((r, i) => {
        const s = 1 + Math.sin(elapsed * 2.2 + i) * 0.06
        r.scale.setScalar(s)
        ;(r.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 2.2 + i))
      })
      // 补间
      tweens = tweens.filter((tw) => {
        tw.t += dt
        const f = Math.min(tw.t / tw.dur, 1)
        const e = 1 - Math.pow(1 - f, 3) // easeOutCubic
        tw.obj.position.x = tw.fx + (tw.tx - tw.fx) * e
        tw.obj.position.z = tw.fz + (tw.tz - tw.fz) * e
        if (tw.hop) tw.obj.position.y = Math.sin(f * Math.PI) * tw.hop
        return f < 1
      })
      // 角色朝向插值 + 行走起伏
      if (playerRig) {
        let diff = playerYaw - playerRig.rotation.y
        while (diff > Math.PI) diff -= Math.PI * 2
        while (diff < -Math.PI) diff += Math.PI * 2
        playerRig.rotation.y += diff * Math.min(1, dt * 14)
        if (animating) {
          bobT += dt * 14
          playerRig.position.y = Math.abs(Math.sin(bobT)) * 0.05
        } else {
          bobT = 0
          playerRig.position.y *= 0.8
        }
      }
      updateCamera(dt)
    }
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  woodTex.dispose()
  stoneTex.dispose()
  tileGeo.dispose()
  wallGeo.dispose()
  capGeo.dispose()
  crateGeo.dispose()
  bandGeo.dispose()
  ringGeo.dispose()
  goalPlateGeo.dispose()
})
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>

    <div class="panel">
      <div class="title">
        <span class="dot" :class="{ live: !won }"></span>
        三维推箱子 · Sokoban 3D
      </div>
      <div class="sub">{{ levelName }} · 把箱子推到发光点</div>

      <div class="levels">
        <button
          v-for="(n, i) in LEVEL_NAMES"
          :key="n"
          class="chip"
          :class="{ on: i === levelIdx }"
          @click="loadLevel(i)"
        >
          {{ i + 1 }}
        </button>
        <span class="best">最优 {{ LEVEL_BEST[levelIdx] }} 步</span>
      </div>

      <div class="stat">
        <div class="item"><span class="k">步数</span><b>{{ moves }}</b></div>
        <div class="item"><span class="k">推动</span><b class="alt">{{ pushes }}</b></div>
        <div class="item"><span class="k">箱子</span><b class="alt">{{ boxes.size }}</b></div>
      </div>

      <div class="pad">
        <button class="key up" @click="move(0, -1)">↑</button>
        <button class="key left" @click="move(-1, 0)">←</button>
        <button class="key down" @click="move(0, 1)">↓</button>
        <button class="key right" @click="move(1, 0)">→</button>
      </div>

      <div class="row">
        <button class="btn" @click="undo">撤销 Z</button>
        <button class="btn" @click="restart">重来 R</button>
        <button class="btn primary" :disabled="!won" @click="nextLevel">
          {{ levelIdx + 1 < LEVEL_NAMES.length ? '下一关 N' : '再玩一次' }}
        </button>
      </div>

      <div class="row">
        <button class="btn" :class="{ on: follow }" @click="follow = !follow">
          {{ follow ? '跟随角色' : '环视全盘' }}
        </button>
      </div>

      <div class="state" :class="{ win: won }">{{ hint }}</div>

      <div class="tip">
        拖拽旋转视角、滚轮缩放。箱子只能推不能拉，别把它顶到墙角——
        推入死角就按 <b>Z</b> 撤销。
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
  width: 286px;
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
.levels {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
}
.chip {
  width: 24px;
  height: 22px;
  border-radius: 6px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #a9bccf;
  font-size: 11.5px;
  cursor: pointer;
}
.chip.on {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.8);
  color: #eaf4ff;
}
.best {
  margin-left: auto;
  font-size: 10.5px;
  color: #6d8098;
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
  color: #8b9cb0;
}
.item b {
  font-size: 16px;
  font-weight: 600;
  color: #e9f2fb;
  font-variant-numeric: tabular-nums;
}
.item b.alt {
  color: #7fd0ff;
}
.pad {
  display: grid;
  grid-template-columns: repeat(3, 30px);
  grid-template-rows: repeat(2, 26px);
  gap: 5px;
  margin-top: 10px;
  justify-content: center;
}
.key {
  border-radius: 6px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #b9c8d8;
  font-size: 13px;
  cursor: pointer;
}
.key:hover {
  border-color: rgba(120, 165, 220, 0.75);
  color: #e6f0fa;
}
.key.up {
  grid-column: 2;
}
.key.left {
  grid-column: 1;
  grid-row: 2;
}
.key.down {
  grid-column: 2;
  grid-row: 2;
}
.key.right {
  grid-column: 3;
  grid-row: 2;
}
.row {
  display: flex;
  gap: 7px;
  margin-top: 9px;
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
  opacity: 0.42;
  cursor: not-allowed;
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
  font-size: 11px;
  color: #8fa3b8;
  min-height: 15px;
}
.state.win {
  color: #7df0a0;
  font-weight: 600;
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
