<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { useThree } from './useThree'

/* ============================================================
 * 智慧工厂 · 产线数字孪生
 *  - 两条产线：上料 → 三台加工中心（到位停线、加工火花）→ 桁架机械手码垛 → 托盘出库
 *  - AGV 沿闭合路径（CatmullRomCurve3，按弧长匀速）跑物料，到站点停 2.5s
 *  - 每台设备有状态灯 + 光柱 + CSS2D 标签；故障设备地面扩散红色波纹
 *  - 相机在「全景 / 产线 / AGV 跟随」之间做阻尼插值切换
 *  - 传送带用 CanvasTexture 的 offset 滚动，不做几何动画，成本为零
 * ============================================================ */

const container = ref<HTMLDivElement>()
const running = ref(true)
const speed = ref(1.0)
const showShell = ref(true)
const showLabels = ref(true)
const showPath = ref(true)
const view = ref<'overview' | 'line' | 'agv'>('overview')

const stats = reactive({
  oee: 94,
  output: 0,
  alarms: 0,
  agv: '行驶中',
  cycle: 18.5,
})

type DeviceStatus = 'run' | 'warn' | 'fault'
interface Device {
  name: string
  code: string
  status: DeviceStatus
  oee: number
  light: THREE.Mesh
  beam: THREE.Mesh
  ring: THREE.Mesh
  labelEl: HTMLElement
  valEl: HTMLElement
}

const STATUS_COLOR: Record<DeviceStatus, number> = {
  run: 0x38e07b,
  warn: 0xffb02e,
  fault: 0xff4d4f,
}
const STATUS_TEXT: Record<DeviceStatus, string> = { run: '运行中', warn: '预警', fault: '故障停机' }

/** 由场景内部赋值的控制函数（注入故障 / 复位），供模板按钮调用 */
let injectFn: (() => void) | null = null
let clearFn: (() => void) | null = null
function injectAlarm() {
  injectFn?.()
}
function clearAlarms() {
  clearFn?.()
}

useThree(
  container,
  {
    background: 0x080b12,
    cameraPos: [36, 26, 36],
    lookAt: [0, 2, 0],
    controls: true,
    shadows: true,
  },
  ({ scene, camera, renderer, controls }) => {
    /* ---------------- 环境 ---------------- */
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture

    scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x0b1018, 0.75))

    const sun = new THREE.DirectionalLight(0xdfeaff, 1.6)
    sun.position.set(22, 30, 16)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 5
    sun.shadow.camera.far = 90
    sun.shadow.camera.left = -34
    sun.shadow.camera.right = 34
    sun.shadow.camera.top = 30
    sun.shadow.camera.bottom = -30
    sun.shadow.bias = -0.0009
    scene.add(sun)

    /* ---------------- 地面：程序化网格贴图 ---------------- */
    function floorTexture() {
      const c = document.createElement('canvas')
      c.width = c.height = 256
      const g = c.getContext('2d')!
      g.fillStyle = '#141a23'
      g.fillRect(0, 0, 256, 256)
      g.strokeStyle = '#1d2634'
      g.lineWidth = 2
      for (let i = 0; i <= 256; i += 32) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke()
        g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke()
      }
      const t = new THREE.CanvasTexture(c)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(22, 15)
      t.colorSpace = THREE.SRGBColorSpace
      return t
    }
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(44, 30),
      new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.92, metalness: 0.05 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    scene.add(floor)

    /* ---------------- 厂房：半透明外壳 + 钢结构框线 ---------------- */
    const shell = new THREE.Group()
    scene.add(shell)
    const W = 44, D = 30, H = 10
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x8fb6dd,
      metalness: 0.1,
      roughness: 0.15,
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const walls = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), glassMat)
    walls.position.y = H / 2
    shell.add(walls)
    const frameEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, D)),
      new THREE.LineBasicMaterial({ color: 0x3a5570, transparent: true, opacity: 0.9 }),
    )
    frameEdges.position.y = H / 2
    shell.add(frameEdges)

    // 立柱 + 屋面桁架
    const steel = new THREE.MeshStandardMaterial({ color: 0x2b3a4d, metalness: 0.7, roughness: 0.5 })
    const colGeo = new THREE.BoxGeometry(0.4, H, 0.4)
    for (let i = -2; i <= 2; i++) {
      for (const zz of [-D / 2, D / 2]) {
        const col = new THREE.Mesh(colGeo, steel)
        col.position.set(i * 10, H / 2, zz)
        col.castShadow = true
        shell.add(col)
      }
    }
    const trussPts: number[] = []
    for (let i = -2; i <= 2; i++) {
      const x = i * 10
      trussPts.push(x, H, -D / 2, x, H, D / 2)
      trussPts.push(x, H, -D / 2, x, H + 1.4, 0)
      trussPts.push(x, H, D / 2, x, H + 1.4, 0)
    }
    const trussGeo = new THREE.BufferGeometry()
    trussGeo.setAttribute('position', new THREE.Float32BufferAttribute(trussPts, 3))
    shell.add(new THREE.LineSegments(trussGeo, new THREE.LineBasicMaterial({ color: 0x35506b })))

    /* ---------------- AGV 路径 ---------------- */
    const pathCurve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(-19, 0.05, -11),
        new THREE.Vector3(19, 0.05, -11),
        new THREE.Vector3(19, 0.05, 11),
        new THREE.Vector3(-19, 0.05, 11),
      ],
      true,
      'catmullrom',
      0.5,
    )
    const pathLen = pathCurve.getLength()
    const pathGeo = new THREE.BufferGeometry().setFromPoints(pathCurve.getSpacedPoints(240))
    const pathLine = new THREE.Line(
      pathGeo,
      new THREE.LineDashedMaterial({
        color: 0xffc043,
        dashSize: 0.9,
        gapSize: 0.6,
        transparent: true,
        opacity: 0.65,
      }),
    )
    pathLine.computeLineDistances()
    scene.add(pathLine)

    /* ---------------- 设备工厂函数 ---------------- */
    const devices: Device[] = []

    function makeLightAndTag(
      parent: THREE.Object3D,
      name: string,
      code: string,
      pos: [number, number, number],
      beamH: number,
    ) {
      const light = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 20, 14),
        new THREE.MeshStandardMaterial({
          color: 0x38e07b,
          emissive: new THREE.Color(0x38e07b),
          emissiveIntensity: 2.2,
          roughness: 0.35,
        }),
      )
      light.position.set(...pos)
      parent.add(light)

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.38, beamH, 18, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x38e07b,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      )
      beam.position.set(pos[0], pos[1] + beamH / 2, pos[2])
      parent.add(beam)

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.72, 40),
        new THREE.MeshBasicMaterial({
          color: 0xff4d4f,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.set(pos[0], 0.03, pos[2])
      scene.add(ring)

      const labelEl = document.createElement('div')
      labelEl.className = 'dev-label'
      labelEl.innerHTML = `<b>${name}</b><i>${code} · 运行中</i>`
      const label = new CSS2DObject(labelEl)
      label.position.set(pos[0], pos[1] + 0.55, pos[2])
      parent.add(label)

      const dev: Device = {
        name,
        code,
        status: 'run',
        oee: 92 + Math.random() * 7,
        light,
        beam,
        ring,
        labelEl,
        valEl: labelEl.querySelector('i') as HTMLElement,
      }
      devices.push(dev)
      return dev
    }

    /* ---------------- 加工中心 ---------------- */
    const metalDark = new THREE.MeshStandardMaterial({ color: 0x27323f, metalness: 0.65, roughness: 0.42 })
    const metalLight = new THREE.MeshStandardMaterial({ color: 0x3d4d5f, metalness: 0.72, roughness: 0.34 })
    const winMat = new THREE.MeshPhysicalMaterial({
      color: 0x6fd0ff,
      metalness: 0,
      roughness: 0.06,
      transparent: true,
      opacity: 0.32,
      emissive: new THREE.Color(0x0e4a6b),
      emissiveIntensity: 1.0,
    })

    interface Spark {
      pts: THREE.Points
      pos: Float32Array
      vel: Float32Array
      life: Float32Array
      active: boolean
    }
    const sparks: Spark[] = []

    function makeSparks(parent: THREE.Object3D, pos: [number, number, number]): Spark {
      const N = 40
      const posArr = new Float32Array(N * 3)
      const velArr = new Float32Array(N * 3)
      const lifeArr = new Float32Array(N)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3))
      const pts = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: 0xffc46b,
          size: 0.07,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      pts.position.set(...pos)
      parent.add(pts)
      const s: Spark = { pts, pos: posArr, vel: velArr, life: lifeArr, active: false }
      sparks.push(s)
      return s
    }

    function emitSpark(s: Spark) {
      for (let i = 0; i < s.life.length; i++) {
        s.pos[i * 3] = 0
        s.pos[i * 3 + 1] = 0
        s.pos[i * 3 + 2] = 0
        s.vel[i * 3] = (Math.random() - 0.5) * 1.6
        s.vel[i * 3 + 1] = Math.random() * 1.9 + 0.4
        s.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.6
        s.life[i] = 0.35 + Math.random() * 0.4
      }
      s.active = true
    }

    function updateSparks(dt: number) {
      for (const s of sparks) {
        const mat = s.pts.material as THREE.PointsMaterial
        if (!s.active) {
          mat.opacity = Math.max(0, mat.opacity - dt * 3)
          continue
        }
        mat.opacity = 0.95
        let alive = 0
        for (let i = 0; i < s.life.length; i++) {
          if (s.life[i] <= 0) continue
          alive++
          s.life[i] -= dt
          s.vel[i * 3 + 1] -= 6.5 * dt
          s.pos[i * 3] += s.vel[i * 3] * dt
          s.pos[i * 3 + 1] += s.vel[i * 3 + 1] * dt
          s.pos[i * 3 + 2] += s.vel[i * 3 + 2] * dt
        }
        ;(s.pts.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
        if (alive === 0) s.active = false
      }
    }

    function makeCNC(x: number, z: number, name: string, code: string) {
      const g = new THREE.Group()
      g.position.set(x, 0, z)
      scene.add(g)

      const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.5, 2.6), metalDark)
      body.position.y = 1.25
      body.castShadow = true
      body.receiveShadow = true
      g.add(body)

      const top = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.22, 2.8), metalLight)
      top.position.y = 2.6
      top.castShadow = true
      g.add(top)

      const win = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.05, 0.08), winMat)
      win.position.set(0, 1.55, 1.31)
      g.add(win)

      // 主轴：加工时旋转
      const spindle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.2, 0.7, 16),
        new THREE.MeshStandardMaterial({ color: 0xb9c7d6, metalness: 1, roughness: 0.22 }),
      )
      spindle.position.set(0, 1.35, 1.05)
      g.add(spindle)

      const dev = makeLightAndTag(g, name, code, [0, 2.85, 0], 2.2)
      const spark = makeSparks(g, [0, 1.15, 1.15])
      return { group: g, dev, spark, spindle }
    }

    /* ---------------- 传送带（贴图 offset 滚动） ---------------- */
    function beltTexture() {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 32
      const g = c.getContext('2d')!
      g.fillStyle = '#232c38'
      g.fillRect(0, 0, 64, 32)
      g.fillStyle = '#38455a'
      for (let i = 0; i < 64; i += 16) g.fillRect(i, 0, 7, 32)
      const t = new THREE.CanvasTexture(c)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(28, 1)
      t.colorSpace = THREE.SRGBColorSpace
      return t
    }
    const beltTex = beltTexture()

    function makeBelt(z: number) {
      const g = new THREE.Group()
      g.position.set(0, 0, z)
      scene.add(g)

      const frame = new THREE.Mesh(new THREE.BoxGeometry(32, 0.18, 1.7), metalLight)
      frame.position.y = 0.92
      frame.castShadow = true
      frame.receiveShadow = true
      g.add(frame)

      const surface = new THREE.Mesh(
        new THREE.PlaneGeometry(32, 1.5),
        new THREE.MeshStandardMaterial({ map: beltTex, roughness: 0.85, metalness: 0.1 }),
      )
      surface.rotation.x = -Math.PI / 2
      surface.position.y = 1.02
      g.add(surface)

      // 支腿
      for (let i = -3; i <= 3; i++) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.92, 0.16), metalDark)
        leg.position.set(i * 4.6, 0.46, 0)
        g.add(leg)
      }
      // 滚筒
      for (const x of [-16, 16]) {
        const roller = new THREE.Mesh(
          new THREE.CylinderGeometry(0.32, 0.32, 1.62, 20),
          new THREE.MeshStandardMaterial({ color: 0x8b98a8, metalness: 1, roughness: 0.3 }),
        )
        roller.rotation.z = Math.PI / 2
        roller.position.set(x, 1.02, 0)
        g.add(roller)
      }
      return g
    }

    /* ---------------- 工件 ---------------- */
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 0.35, roughness: 0.55 })
    const boxMatDone = new THREE.MeshStandardMaterial({
      color: 0x4fd6ff,
      metalness: 0.5,
      roughness: 0.3,
      emissive: new THREE.Color(0x0d4d66),
      emissiveIntensity: 0.8,
    })
    interface Work {
      mesh: THREE.Mesh
      x: number
      done: [boolean, boolean, boolean]
      procIdx: number
      wait: number
      state: 'move' | 'proc' | 'wait' | 'gone'
    }

    /* ---------------- 桁架机械手（XYZ 三轴，坐标精确） ---------------- */
    function makeGantry(z: number) {
      const g = new THREE.Group()
      g.position.set(0, 0, z)
      scene.add(g)

      const railMat = new THREE.MeshStandardMaterial({ color: 0x45566b, metalness: 0.8, roughness: 0.35 })
      for (const zz of [-1.4, 1.4]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.3, 0.3), railMat)
        rail.position.set(17.5, 4.4, zz)
        rail.castShadow = true
        g.add(rail)
      }
      for (const x of [13.2, 17.5, 21.8]) {
        for (const zz of [-1.4, 1.4]) {
          const col = new THREE.Mesh(new THREE.BoxGeometry(0.26, 4.4, 0.26), railMat)
          col.position.set(x, 2.2, zz)
          g.add(col)
        }
      }
      // 横梁（随 X 移动）
      const bridge = new THREE.Group()
      bridge.position.set(15, 4.4, 0)
      g.add(bridge)
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 3.1), railMat)
      bridge.add(beam)

      // 滑车（随 Z 移动）
      const carriage = new THREE.Group()
      bridge.add(carriage)
      const carriageBox = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.7), metalLight)
      carriage.add(carriageBox)

      // 伸缩柱（随 Y 移动）
      const mast = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 3.2, 0.22),
        new THREE.MeshStandardMaterial({ color: 0xa8b6c6, metalness: 1, roughness: 0.25 }),
      )
      mast.position.y = -1.6
      carriage.add(mast)

      const gripper = new THREE.Group()
      gripper.position.y = -3.2
      carriage.add(gripper)
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.5), metalLight)
      gripper.add(palm)
      const fingers: THREE.Mesh[] = []
      for (const s of [-1, 1]) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.42), metalDark)
        f.position.set(s * 0.3, -0.26, 0)
        gripper.add(f)
        fingers.push(f)
      }
      return { group: g, bridge, carriage, gripper, fingers }
    }

    /* ---------------- 托盘 ---------------- */
    function makePallet(x: number, z: number) {
      const g = new THREE.Group()
      g.position.set(x, 0, z)
      scene.add(g)
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 0.14, 1.8),
        new THREE.MeshStandardMaterial({ color: 0x6b5638, roughness: 0.9 }),
      )
      base.position.y = 0.07
      base.receiveShadow = true
      g.add(base)
      return g
    }

    /* ---------------- 立体货架（InstancedMesh） ---------------- */
    function makeRack(x: number, z: number) {
      const g = new THREE.Group()
      g.position.set(x, 0, z)
      scene.add(g)
      const cols = 6
      const rows = 4
      const cell = 1.5
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a4a5c, metalness: 0.7, roughness: 0.45 })
      for (const cx of [0, cols * cell]) {
        for (const cz of [0, 2.2]) {
          const col = new THREE.Mesh(new THREE.BoxGeometry(0.14, rows * 1.15 + 0.4, 0.14), frameMat)
          col.position.set(cx, (rows * 1.15 + 0.4) / 2, cz)
          g.add(col)
        }
      }
      for (let r = 0; r <= rows; r++) {
        const shelf = new THREE.Mesh(new THREE.BoxGeometry(cols * cell, 0.08, 2.2), frameMat)
        shelf.position.set((cols * cell) / 2, r * 1.15 + 0.2, 1.1)
        shelf.castShadow = true
        g.add(shelf)
      }
      const count = cols * rows * 2
      const inst = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1.0, 0.7, 1.0),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.1 }),
        count,
      )
      inst.castShadow = true
      inst.receiveShadow = true
      const m = new THREE.Matrix4()
      const col = new THREE.Color()
      let i = 0
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          for (let d = 0; d < 2; d++) {
            m.makeTranslation(c * cell + cell / 2, r * 1.15 + 0.6, 0.6 + d * 1.0)
            inst.setMatrixAt(i, m)
            col.setHSL(0.08 + Math.random() * 0.12, 0.45, 0.32 + Math.random() * 0.12)
            inst.setColorAt(i, col)
            i++
          }
        }
      }
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      g.add(inst)
      return g
    }
    makeRack(-16, 12.6)
    makeRack(-6, 12.6)

    /* ---------------- 组装两条产线 ---------------- */
    interface Line {
      belt: THREE.Group
      cncs: ReturnType<typeof makeCNC>[]
      gantry: ReturnType<typeof makeGantry>
      pallet: THREE.Group
      works: Work[]
      stack: { x: number; y: number; z: number; count: number }
    }
    const lines: Line[] = []

    for (let li = 0; li < 2; li++) {
      const zc = li === 0 ? -6 : 6
      const machineZ = li === 0 ? zc - 2.9 : zc + 2.9
      const belt = makeBelt(zc)
      const cncs = [
        makeCNC(-8, machineZ, `加工中心 A${li + 1}-01`, 'CNC'),
        makeCNC(0, machineZ, `加工中心 A${li + 1}-02`, 'CNC'),
        makeCNC(8, machineZ, `加工中心 A${li + 1}-03`, 'CNC'),
      ]
      // 面向传送带
      for (const c of cncs) c.group.rotation.y = li === 0 ? 0 : Math.PI

      const gantry = makeGantry(li === 0 ? -7.2 : 7.2)
      const pallet = makePallet(19.5, li === 0 ? -7.2 : 7.2)
      makeLightAndTag(scene, `桁架机械手 L${li + 1}`, 'ROBOT', [17.5, 4.9, li === 0 ? -7.2 : 7.2], 1.4)

      const works: Work[] = []
      for (let i = 0; i < 7; i++) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.6), boxMat)
        mesh.castShadow = true
        mesh.position.set(-15 + i * 4, 1.27, zc)
        scene.add(mesh)
        works.push({
          mesh,
          x: -15 + i * 4,
          done: [false, false, false],
          procIdx: -1,
          wait: 0,
          state: 'move',
        })
      }
      lines.push({ belt, cncs, gantry, pallet, works, stack: { x: 19.5, y: 0.14, z: li === 0 ? -7.2 : 7.2, count: 0 } })
    }

    /* ---------------- AGV ---------------- */
    const agv = new THREE.Group()
    scene.add(agv)
    const agvBody = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 0.42, 1.15),
      new THREE.MeshStandardMaterial({ color: 0x2f6ea8, metalness: 0.55, roughness: 0.4 }),
    )
    agvBody.position.y = 0.44
    agvBody.castShadow = true
    agv.add(agvBody)
    const agvDeck = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 0.95), metalLight)
    agvDeck.position.y = 0.7
    agv.add(agvDeck)
    const cargo = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.6, 0.8),
      new THREE.MeshStandardMaterial({ color: 0xc98b3a, roughness: 0.75 }),
    )
    cargo.position.y = 1.05
    cargo.castShadow = true
    agv.add(cargo)
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.9 })
    for (const sx of [-0.62, 0.62]) {
      for (const sz of [-0.5, 0.5]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.14, 14), wheelMat)
        w.rotation.z = Math.PI / 2
        w.position.set(sx, 0.19, sz)
        agv.add(w)
      }
    }
    const lidar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 0.14, 16),
      new THREE.MeshStandardMaterial({ color: 0x101418, metalness: 0.6, roughness: 0.35 }),
    )
    lidar.position.set(0.82, 0.78, 0)
    agv.add(lidar)
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 14, 10),
      new THREE.MeshStandardMaterial({
        color: 0x38e07b,
        emissive: new THREE.Color(0x38e07b),
        emissiveIntensity: 2.4,
      }),
    )
    beacon.position.set(-0.7, 0.78, 0)
    agv.add(beacon)

    const agvDev = makeLightAndTag(agv, 'AGV 搬运车', 'AGV', [0, 1.5, 0], 0.9)

    let agvU = 0
    let agvStop = 0
    const STATIONS = [0, 0.25, 0.5, 0.75]
    let nextStation = 0

    /* ---------------- 状态与告警 ---------------- */
    function setStatus(d: Device, s: DeviceStatus) {
      d.status = s
      const c = new THREE.Color(STATUS_COLOR[s])
      const lm = d.light.material as THREE.MeshStandardMaterial
      lm.color.copy(c)
      lm.emissive.copy(c)
      const bm = d.beam.material as THREE.MeshBasicMaterial
      bm.color.copy(c)
      d.labelEl.classList.toggle('fault', s === 'fault')
      d.labelEl.classList.toggle('warn', s === 'warn')
    }
    // 初始放一台预警设备，画面更有信息量
    setStatus(devices[1], 'warn')

    function injectAlarm() {
      const pool = devices.filter((d) => d.status !== 'fault')
      if (!pool.length) return
      setStatus(pool[Math.floor(Math.random() * pool.length)], 'fault')
    }
    function clearAlarms() {
      devices.forEach((d) => setStatus(d, d === devices[1] ? 'warn' : 'run'))
    }
    // 把内部函数交给模板按钮（useThree 的 setup 作用域在外面拿不到）
    injectFn = injectAlarm
    clearFn = clearAlarms

    /* ---------------- 机械手任务状态机 ---------------- */
    interface Task {
      phase: 'toPick' | 'down' | 'grab' | 'lift' | 'toPlace' | 'down2' | 'release' | 'home'
      t: number
      work?: Work
    }
    const tasks: Task[] = [{ phase: 'home', t: 0 }, { phase: 'home', t: 0 }]

    const tmpV = new THREE.Vector3()
    function moveTo(obj: THREE.Object3D, x: number, y: number, z: number, dt: number, rate: number) {
      const k = 1 - Math.exp(-rate * dt)
      obj.position.x += (x - obj.position.x) * k
      obj.position.y += (y - obj.position.y) * k
      obj.position.z += (z - obj.position.z) * k
      return Math.abs(obj.position.x - x) + Math.abs(obj.position.y - y) + Math.abs(obj.position.z - z)
    }

    /* ---------------- 相机切换 ---------------- */
    const camGoalPos = new THREE.Vector3(36, 26, 36)
    const camGoalTarget = new THREE.Vector3(0, 2, 0)
    let camLerp = 0
    watch(view, (v) => {
      camLerp = 1.4
      if (v === 'overview') {
        camGoalPos.set(36, 26, 36)
        camGoalTarget.set(0, 2, 0)
      } else if (v === 'line') {
        camGoalPos.set(7, 6, 13)
        camGoalTarget.set(-1, 1.5, 5)
      }
    })

    /* ---------------- CSS2D ---------------- */
    const labelRenderer = new CSS2DRenderer()
    labelRenderer.domElement.style.position = 'absolute'
    labelRenderer.domElement.style.top = '0'
    labelRenderer.domElement.style.left = '0'
    labelRenderer.domElement.style.pointerEvents = 'none'
    container.value?.appendChild(labelRenderer.domElement)
    const onResize = () => {
      const el = container.value
      if (!el) return
      labelRenderer.setSize(el.clientWidth || 1, el.clientHeight || 1)
    }
    window.addEventListener('resize', onResize)
    onResize()
    onBeforeUnmount(() => {
      window.removeEventListener('resize', onResize)
      labelRenderer.domElement.remove()
    })

    /* ---------------- 每帧更新 ---------------- */
    let t = 0
    let statTimer = 0

    return (dtRaw) => {
      const dt = Math.min(dtRaw, 0.05)
      const run = running.value
      const sp = speed.value
      if (run) t += dt * sp

      // 传送带贴图滚动
      beltTex.offset.x -= dt * sp * 0.55

      // ---- 工件流转 ----
      for (let li = 0; li < lines.length; li++) {
        const L = lines[li]
        const stationsX = [-8, 0, 8]
        for (const w of L.works) {
          if (w.state === 'gone') continue
          if (w.state === 'proc') {
            const cnc = L.cncs[w.procIdx]
            // 设备故障 → 该工位停线，工件卡在这里等维修
            if (cnc.dev.status !== 'fault') {
              w.wait -= dt * sp
              cnc.spindle.rotation.y += dt * 22 * sp
            }
            if (w.wait <= 0) {
              w.done[w.procIdx] = true
              w.state = 'move'
              w.mesh.material = w.done[2] ? boxMatDone : boxMat
              w.procIdx = -1
            }
            continue
          }
          if (w.state === 'wait') continue // 等待机械手取走

          const nx = w.x + dt * sp * 1.9
          for (let si = 0; si < 3; si++) {
            if (!w.done[si] && w.x < stationsX[si] && nx >= stationsX[si]) {
              w.x = stationsX[si]
              w.mesh.position.x = w.x
              w.state = 'proc'
              w.procIdx = si
              w.wait = 1.5
              w.mesh.material = boxMat
              emitSpark(L.cncs[si].spark)
              break
            }
          }
          if (w.state === 'proc') continue
          w.x = Math.min(nx, 14.6)
          w.mesh.position.x = w.x
          w.mesh.position.y = 1.27
          if (w.x >= 14.6) w.state = 'wait'
        }

        // ---- 桁架机械手 ----
        const G = L.gantry
        const task = tasks[li]
        const gp = new THREE.Vector3()
        G.gripper.getWorldPosition(gp)
        let fingerOpen = 0.34

        if (task.phase === 'home') {
          moveTo(G.bridge, 15, 4.4, 0, dt, 4)
          moveTo(G.carriage, 0, 0, 0, dt, 4)
          moveTo(G.gripper, 0, -1.2, 0, dt, 4)
          const pending = L.works.find((w) => w.state === 'wait')
          if (pending) {
            task.phase = 'toPick'
            task.t = 0
            task.work = pending
          }
        } else if (task.phase === 'toPick') {
          const zPick = L.belt.position.z - G.group.position.z
          const d = moveTo(G.bridge, 14.6, 4.4, 0, dt, 5) + moveTo(G.carriage, 0, 0, zPick, dt, 5)
          if (d < 0.12) { task.phase = 'down'; task.t = 0 }
        } else if (task.phase === 'down') {
          const d = moveTo(G.gripper, 0, -2.75, 0, dt, 5)
          fingerOpen = 0.34
          if (d < 0.08) { task.phase = 'grab'; task.t = 0 }
        } else if (task.phase === 'grab') {
          task.t += dt * sp
          fingerOpen = 0.34 - 0.2 * Math.min(1, task.t / 0.35)
          if (task.t > 0.4) {
            const w = task.work
            if (w) {
              G.gripper.attach(w.mesh)
              w.state = 'gone'
              w.mesh.position.set(0, -0.45, 0)
              w.mesh.rotation.set(0, 0, 0)
              w.mesh.scale.set(0.6 / 0.6, 0.5 / 0.5, 0.6 / 0.6)
            }
            task.phase = 'lift'
            task.t = 0
          }
        } else if (task.phase === 'lift') {
          const d = moveTo(G.gripper, 0, -1.4, 0, dt, 5)
          fingerOpen = 0.14
          if (d < 0.1) { task.phase = 'toPlace'; task.t = 0 }
        } else if (task.phase === 'toPlace') {
          const layer = Math.floor(L.stack.count / 4)
          const slot = L.stack.count % 4
          const sx = 19.5 - 0.55 + (slot % 2) * 1.1
          const sz = (L.stack.z - G.group.position.z) - 0.28 + Math.floor(slot / 2) * 0.56
          const sy = 0.14 + 0.25 + layer * 0.5
          moveTo(G.bridge, sx, 4.4, 0, dt, 4)
          moveTo(G.carriage, 0, 0, sz, dt, 4)
          const d = moveTo(G.gripper, 0, -(4.4 - sy - 0.35), 0, dt, 4)
          if (d < 0.12) { task.phase = 'release'; task.t = 0 }
          fingerOpen = 0.14
        } else if (task.phase === 'release') {
          task.t += dt * sp
          fingerOpen = 0.14 + 0.2 * Math.min(1, task.t / 0.3)
          if (task.t > 0.35) {
            const w = task.work
            if (w) {
              scene.attach(w.mesh)
              const layer = Math.floor(L.stack.count / 4)
              const slot = L.stack.count % 4
              w.mesh.position.set(
                19.5 - 0.55 + (slot % 2) * 1.1,
                0.14 + 0.25 + layer * 0.5,
                L.stack.z - 0.28 + Math.floor(slot / 2) * 0.56,
              )
              w.mesh.scale.set(0.92, 0.8, 0.92)
              L.stack.count++
              stats.output++
              if (L.stack.count >= 16) L.stack.count = 0
              // 回炉重造：回到产线起点
              w.x = -15
              w.done = [false, false, false]
              w.state = 'move'
              w.mesh.material = boxMat
              w.mesh.scale.set(1, 1, 1)
            }
            task.work = undefined
            task.phase = 'home'
            task.t = 0
          }
        }
        G.fingers[0].position.x = -fingerOpen
        G.fingers[1].position.x = fingerOpen
      }

      // ---- AGV ----
      if (run) {
        if (agvStop > 0) {
          agvStop -= dt * sp
          stats.agv = `站点装卸 ${Math.max(0, agvStop).toFixed(1)}s`
          lidar.rotation.y += dt * 1.2
        } else {
          agvU += (dt * sp * 3.2) / pathLen
          if (agvU >= 1) agvU -= 1
          const target = STATIONS[nextStation]
          if ((agvU >= target && agvU - target < 0.02) || (target === 0 && agvU > 0.97)) {
            agvStop = 2.5
            nextStation = (nextStation + 1) % STATIONS.length
            stats.agv = '到站'
          } else if (agvU > 0.02 && agvU < 0.97) {
            stats.agv = '行驶中'
          }
          lidar.rotation.y += dt * 9
        }
      }
      const p = pathCurve.getPointAt(agvU)
      const tan = pathCurve.getTangentAt(agvU)
      agv.position.set(p.x, 0, p.z)
      agv.rotation.y = Math.atan2(tan.x, tan.z)

      // ---- 设备灯 / 告警波纹 ----
      for (const d of devices) {
        const lm = d.light.material as THREE.MeshStandardMaterial
        if (d.status === 'fault') {
          const pulse = 1.4 + Math.sin(t * 7) * 1.4
          lm.emissiveIntensity = Math.max(0.4, pulse)
          const bm = d.beam.material as THREE.MeshBasicMaterial
          bm.opacity = 0.18 + Math.sin(t * 7) * 0.12
          // 地面扩散波纹
          const k = (t * 0.55) % 1
          d.ring.scale.setScalar(0.8 + k * 4.2)
          ;(d.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - k)
          d.ring.visible = true
        } else {
          lm.emissiveIntensity = 2.2
          d.ring.visible = false
          const bm = d.beam.material as THREE.MeshBasicMaterial
          bm.opacity = d.status === 'warn' ? 0.14 + Math.sin(t * 3) * 0.06 : 0.16
        }
      }

      updateSparks(dt)

      // ---- 相机 ----
      if (view.value === 'agv') {
        const back = tmpV.set(-tan.x, 0, -tan.z).normalize().multiplyScalar(7.5)
        camGoalPos.set(p.x + back.x, 4.6, p.z + back.z)
        camGoalTarget.set(p.x, 1.0, p.z)
      }
      if (camLerp > 0 || view.value === 'agv') {
        const k = 1 - Math.exp(-3.2 * dt)
        camera.position.lerp(camGoalPos, k)
        controls?.target.lerp(camGoalTarget, k)
        if (camLerp > 0) camLerp -= dt
      }

      // ---- 看板数据（2Hz 刷新，避免每帧触发 Vue 更新） ----
      statTimer += dt
      if (statTimer > 0.5) {
        statTimer = 0
        const fault = devices.filter((d) => d.status === 'fault').length
        
        stats.alarms = fault
        stats.oee = Math.max(
          0,
          Math.round(
            devices.reduce((s, d) => s + (d.status === 'fault' ? 0 : d.status === 'warn' ? d.oee * 0.7 : d.oee), 0) /
              devices.length,
          ),
        )
        stats.cycle = Math.round((18.5 / Math.max(0.2, sp)) * 10) / 10
        for (const d of devices) {
          d.valEl.textContent = `${d.code} · ${STATUS_TEXT[d.status]}`
        }
      }

      shell.visible = showShell.value
      pathLine.visible = showPath.value
      labelRenderer.domElement.style.display = showLabels.value ? 'block' : 'none'
      labelRenderer.render(scene, camera)
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>

    <div class="hud">
      <div class="hud-title">智慧工厂 · 实时看板</div>
      <div class="kpi">
        <div><span>OEE</span><b>{{ stats.oee }}%</b></div>
        <div><span>下线</span><b>{{ stats.output }}</b></div>
        <div><span>节拍</span><b>{{ stats.cycle }}s</b></div>
        <div :class="{ bad: stats.alarms > 0 }"><span>告警</span><b>{{ stats.alarms }}</b></div>
      </div>
      <div class="agv-line">AGV：{{ stats.agv }}</div>
    </div>

    <div class="panel">
      <div class="title">智慧工厂 · 产线数字孪生</div>
      <div class="row">
        <span class="label">产线速度</span>
        <input v-model.number="speed" class="range" type="range" min="0.2" max="3" step="0.1" />
        <span class="val">{{ speed.toFixed(1) }}×</span>
      </div>
      <div class="row btns">
        <button class="chip" :class="{ on: running }" @click="running = !running">
          {{ running ? '暂停' : '继续' }}
        </button>
        <button class="chip" @click="injectAlarm">注入故障</button>
        <button class="chip" @click="clearAlarms">全部复位</button>
      </div>
      <div class="row btns">
        <button class="chip" :class="{ on: view === 'overview' }" @click="view = 'overview'">全景</button>
        <button class="chip" :class="{ on: view === 'line' }" @click="view = 'line'">产线</button>
        <button class="chip" :class="{ on: view === 'agv' }" @click="view = 'agv'">AGV 跟随</button>
      </div>
      <div class="row btns">
        <button class="chip" :class="{ on: showShell }" @click="showShell = !showShell">厂房外壳</button>
        <button class="chip" :class="{ on: showPath }" @click="showPath = !showPath">AGV 路径</button>
        <button class="chip" :class="{ on: showLabels }" @click="showLabels = !showLabels">设备标签</button>
      </div>
      <div class="tip">
        传送带没有做几何动画，而是滚动 CanvasTexture 的 <code>offset.x</code>；工件到加工中心触发停线 + 火花粒子，
        再由 XYZ 桁架机械手用 <code>gripper.attach()</code> 直接接管（保持世界变换，无需算逆解），放到托盘码垛。
        AGV 用 <code>getPointAt</code> 按弧长匀速跑闭合 CatmullRom 曲线，切向即车头朝向。
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
.three-container {
  position: relative;
  width: 100%;
  height: 100%;
}
.hud {
  position: absolute;
  right: 14px;
  top: 14px;
  z-index: 5;
  width: 250px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(12, 18, 26, 0.88);
  border: 1px solid rgba(90, 110, 135, 0.45);
  backdrop-filter: blur(8px);
  color: #d7e2ee;
}
.hud-title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
  margin-bottom: 8px;
}
.kpi {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.kpi > div {
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(28, 38, 51, 0.9);
  border: 1px solid rgba(80, 100, 125, 0.35);
}
.kpi span {
  display: block;
  font-size: 10.5px;
  color: #8b9aab;
}
.kpi b {
  font-size: 15px;
  color: #7ee787;
}
.kpi .bad b {
  color: #ff6b6b;
}
.agv-line {
  margin-top: 8px;
  font-size: 11px;
  color: #9fb0c2;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 340px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.88);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
  margin-bottom: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
.label {
  font-size: 12px;
  color: #9fb0c2;
  white-space: nowrap;
  flex: 0 0 62px;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  font-size: 12px;
  color: #7ee787;
  width: 44px;
  text-align: right;
}
.btns {
  gap: 7px;
}
.chip {
  padding: 5px 9px;
  font-size: 11px;
  border-radius: 7px;
  border: 1px solid rgba(96, 116, 140, 0.45);
  background: rgba(26, 35, 46, 0.9);
  color: #b9c8d8;
  cursor: pointer;
}
.chip.on {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #8b9aab;
}
.tip code {
  color: #7ee787;
}

:deep(.dev-label) {
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(11, 17, 25, 0.85);
  border: 1px solid rgba(79, 157, 255, 0.4);
  white-space: nowrap;
  transform: translateY(-2px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
}
:deep(.dev-label b) {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #eaf2fb;
}
:deep(.dev-label i) {
  display: block;
  font-style: normal;
  font-size: 10px;
  color: #63c9ff;
}
:deep(.dev-label.warn) {
  border-color: rgba(255, 176, 46, 0.6);
}
:deep(.dev-label.warn i) {
  color: #ffb02e;
}
:deep(.dev-label.fault) {
  border-color: rgba(255, 77, 79, 0.75);
  background: rgba(38, 12, 14, 0.9);
}
:deep(.dev-label.fault i) {
  color: #ff6b6b;
}
:deep(.dev-label.fault b) {
  color: #ffd7d7;
}
</style>
