<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()

/* ============================== UI 状态 ============================== */
const explode = ref(42) // 拆解程度 0~100
const speed = ref(26) // 曲轴转速 0~100
const running = ref(true)
const autoRotate = ref(true)
const ghost = ref(false)
const showLabels = ref(true)

interface PartInfo {
  name: string
  en: string
  desc: string
  spec: string
}
const selected = ref<PartInfo | null>(null)
const hover = ref<{ name: string; x: number; y: number } | null>(null)
const partTotal = ref(0)

/* ============================== 发动机主参数 ============================== */
// 缸心距 6.4，缸径 φ80（模型 1 单位 ≈ 20mm）
const CYL_Z = [-9.6, -3.2, 3.2, 9.6]
// 直列四缸点火顺序 1-3-4-2：1、4 缸同相，2、3 缸反相
const PHASE = [0, Math.PI, Math.PI, 0]
const CRANK_R = 2.2 // 曲柄半径（行程 4.4）
const ROD_L = 7.2 // 连杆中心距
const DECK_Y = 11.2 // 缸体上平面
const BLOCK_HW = 3.0 // 缸体半宽
const BLOCK_HL = 13.4 // 缸体半长
const BORE_R = 2.0 // 缸孔半径
const HEAD_TOP = 13.6
const CAM_Y = 12.62
const CAM_X = 1.16

/* ============================== 材质与几何小工具 ============================== */
const std = (color: number, metalness = 0.6, roughness = 0.4) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness, envMapIntensity: 0.78 })

const cyl = (rt: number, rb: number, h: number, mat: THREE.Material, seg = 40, open = false) =>
  new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), mat)

const box = (w: number, h: number, d: number, mat: THREE.Material) =>
  new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)

const torus = (r: number, t: number, mat: THREE.Material, seg = 48) =>
  new THREE.Mesh(new THREE.TorusGeometry(r, t, 10, seg), mat)

/** 躺倒的圆柱：轴线沿 Z（发动机纵向） */
function cylZ(r: number, len: number, mat: THREE.Material, seg = 36, open = false) {
  const m = cyl(r, r, len, mat, seg, open)
  m.rotation.x = Math.PI / 2
  return m
}

function shade(o: THREE.Object3D, cast = true, receive = true) {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = cast
      c.receiveShadow = receive
    }
  })
  return o
}

/** 圆角矩形轮廓（用于正时罩等钣件） */
function roundRect(w: number, h: number, r: number) {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false)
  s.lineTo(x + w, y + h - r)
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false)
  s.lineTo(x + r, y + h)
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
  s.lineTo(x, y + r)
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false)
  return s
}

/** 求若干圆的外公切线包络（链条 / 皮带走线） */
function beltPolyline(circles: { x: number; y: number; r: number }[]) {
  const pts: THREE.Vector2[] = []
  for (const c of circles) {
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2
      pts.push(new THREE.Vector2(c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r))
    }
  }
  pts.sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: THREE.Vector2[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: THREE.Vector2[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/* ============================== 部件登记 ============================== */
interface Part {
  id: string
  name: string
  en: string
  desc: string
  spec: string
  group: THREE.Group
  dir: THREE.Vector3
  dist: number
  mats: THREE.MeshStandardMaterial[]
}

const parts: Part[] = []

/** 活塞销高度：曲柄转角 a（自压缩上止点起算） */
const pinY = (a: number) =>
  CRANK_R * Math.cos(a) + Math.sqrt(ROD_L * ROD_L - (CRANK_R * Math.sin(a)) ** 2)

/* ============================== 场景 ============================== */
useThree(
  container,
  {
    fov: 24,
    near: 0.4,
    far: 4000,
    background: 0x0a1017,
    cameraPos: [72, 20, 30],
    lookAt: [0, 5.6, 0],
    controls: true,
    shadows: true,
  },
  ({ scene, camera, renderer, controls }) => {
    /* ---------- 环境贴图：让铝、钢有真实反射 ---------- */
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0

    const pmrem = new THREE.PMREMGenerator(renderer)
    const envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.06).texture
    scene.environment = envTex

    /* ---------- 渐变背景球 ---------- */
    const bg = new THREE.Mesh(
      new THREE.SphereGeometry(900, 32, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          uTop: { value: new THREE.Color(0x101a26) },
          uBot: { value: new THREE.Color(0x05080d) },
        },
        vertexShader: `varying vec3 vP;
          void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform vec3 uTop; uniform vec3 uBot; varying vec3 vP;
          void main(){
            vec3 d = normalize(vP);
            float h = d.y * 0.5 + 0.5;
            vec3 c = mix(uBot, uTop, pow(h, 1.5));
            c += vec3(0.05, 0.075, 0.11) * pow(max(0.0, 1.0 - abs(d.y)), 8.0);
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    )
    scene.add(bg)

    /* ---------- 灯光 ---------- */
    scene.add(new THREE.HemisphereLight(0xa8c6ee, 0x0c1118, 0.85))

    const key = new THREE.DirectionalLight(0xfff2e0, 2.9)
    key.position.set(22, 34, 20)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    const sc = key.shadow.camera as THREE.OrthographicCamera
    sc.left = -30
    sc.right = 30
    sc.top = 30
    sc.bottom = -30
    sc.near = 1
    sc.far = 140
    key.shadow.bias = -0.0007
    key.shadow.normalBias = 0.035
    scene.add(key)

    const rim = new THREE.DirectionalLight(0x7fb4ff, 1.75)
    rim.position.set(-24, 12, -26)
    scene.add(rim)

    const fill = new THREE.DirectionalLight(0xbfd6ff, 0.5)
    fill.position.set(6, -18, 14)
    scene.add(fill)

    /* ---------- 铸件表面颗粒（程序化噪声贴图） ---------- */
    const grain = (() => {
      const c = document.createElement('canvas')
      c.width = c.height = 256
      const ctx = c.getContext('2d')!
      const img = ctx.createImageData(256, 256)
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 132 + Math.random() * 78
        img.data[i] = v
        img.data[i + 1] = v
        img.data[i + 2] = v
        img.data[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      const t = new THREE.CanvasTexture(c)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(7, 7)
      return t
    })()
    const grainy = <T extends THREE.MeshStandardMaterial>(m: T, scale = 0.02) => {
      m.roughnessMap = grain
      m.bumpMap = grain
      m.bumpScale = scale
      return m
    }

    /* ---------- 装配根节点 ---------- */
    const root = new THREE.Group()
    scene.add(root)

    const pickables: THREE.Object3D[] = []

    /** 部件收尾：把网格加入拾取列表，并收集该部件的材质（高亮时统一改自发光） */
    function finish(p: Part) {
      p.group.traverse((o) => {
        const mesh = o as THREE.Mesh
        const m = mesh.material
        if (m && !Array.isArray(m) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          const sm = m as THREE.MeshStandardMaterial
          if (!p.mats.includes(sm)) p.mats.push(sm)
        }
        if (mesh.isMesh) pickables.push(o)
      })
    }

    function part(
      id: string,
      name: string,
      en: string,
      desc: string,
      spec: string,
      dir: [number, number, number],
      dist: number,
    ) {
      const group = new THREE.Group()
      group.userData.partId = id
      root.add(group)
      const p: Part = { id, name, en, desc, spec, group, dir: new THREE.Vector3(...dir), dist, mats: [] }
      parts.push(p)
      return p
    }

    /* ================================================================
     * 1. 气缸体：铸铝缸体 + 4 个缸孔 + 水套外壳 + 加强筋 + 水堵
     * ================================================================ */
    {
      const p = part(
        'block',
        '气缸体',
        'Cylinder Block',
        '发动机的骨架。四个缸孔呈直列布置，孔壁为离心浇铸的铸铁缸套，外侧铸有水套、油道与主轴承座。',
        '材料：铝合金铸造 / 缸套：合金铸铁 · 缸径 φ80 · 缸心距 88',
        [0, 0, 0],
        0,
      )
      const g = p.group
      const cast = grainy(std(0x6f7781, 0.58, 0.66), 0.03)
      const castDark = grainy(std(0x5a626c, 0.55, 0.72), 0.03)
      const boreMat = new THREE.MeshStandardMaterial({
        color: 0x4a5058,
        metalness: 0.85,
        roughness: 0.35,
        side: THREE.BackSide,
        envMapIntensity: 0.9,
      })

      const wallT = 0.52
      const skTop = DECK_Y - 0.34
      const skBot = -0.9
      const h = skTop - skBot

      // 四周侧壁（中间是空的，才能从上面看到缸孔）
      for (const sx of [-1, 1]) {
        const side = box(wallT, h, BLOCK_HL * 2, cast)
        side.position.set(sx * (BLOCK_HW - wallT / 2), skBot + h / 2, 0)
        g.add(side)
      }
      for (const sz of [-1, 1]) {
        const end = box(BLOCK_HW * 2, h, wallT, cast)
        end.position.set(0, skBot + h / 2, sz * (BLOCK_HL - wallT / 2))
        g.add(end)
      }

      // 上平面：带 4 个圆孔的板（ExtrudeGeometry 支持挖孔）
      const deckShape = new THREE.Shape()
      deckShape.moveTo(-BLOCK_HW, -BLOCK_HL)
      deckShape.lineTo(BLOCK_HW, -BLOCK_HL)
      deckShape.lineTo(BLOCK_HW, BLOCK_HL)
      deckShape.lineTo(-BLOCK_HW, BLOCK_HL)
      deckShape.closePath()
      for (const z of CYL_Z) {
        const hole = new THREE.Path()
        hole.absarc(0, z, BORE_R + 0.02, 0, Math.PI * 2, true)
        deckShape.holes.push(hole)
      }
      const deckGeo = new THREE.ExtrudeGeometry(deckShape, { depth: 0.34, bevelEnabled: false })
      deckGeo.rotateX(Math.PI / 2)
      const deck = new THREE.Mesh(deckGeo, cast)
      deck.position.y = DECK_Y
      g.add(deck)

      // 缸孔内壁 + 上缘倒角环
      for (const z of CYL_Z) {
        const liner = cyl(BORE_R - 0.02, BORE_R - 0.02, 10.1, boreMat, 44, true)
        liner.position.set(0, DECK_Y - 5.05, z)
        g.add(liner)
        const lip = torus(BORE_R - 0.02, 0.07, castDark)
        lip.rotation.x = Math.PI / 2
        lip.position.set(0, DECK_Y - 0.06, z)
        g.add(lip)
      }

      // 外侧竖向加强筋
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 9; i++) {
          const z = -11.2 + i * 2.8
          const rib = box(0.26, 7.6, 0.2, castDark)
          rib.position.set(sx * (BLOCK_HW + 0.05), 6.6, z)
          g.add(rib)
        }
        // 水套凸台 / 水堵
        for (const z of [-10.4, -6.6, 0, 6.6, 10.4]) {
          const plug = cyl(0.42, 0.42, 0.14, castDark, 20)
          plug.rotation.z = Math.PI / 2
          plug.position.set(sx * (BLOCK_HW + 0.02), 8.3, z)
          g.add(plug)
        }
        // 主油道
        const gallery = cyl(0.14, 0.14, BLOCK_HL * 2 - 2, castDark, 12)
        gallery.rotation.x = Math.PI / 2
        gallery.position.set(sx * (BLOCK_HW - 0.32), 4.4, 0)
        g.add(gallery)
      }

      // 主轴承座（5 道，隔板式）
      for (const z of [-12.8, -6.4, 0, 6.4, 12.8]) {
        // 宽度必须收在两侧内壁之间、底面不能低于裙部底(-0.9)，否则会从缸体侧面露出一排舌片
        const bulk = box((BLOCK_HW - wallT) * 2 - 0.06, 2.44, 0.62, castDark)
        bulk.position.set(0, 0.42, z)
        g.add(bulk)
        const boss = cylZ(0.98, 1.5, castDark, 20)
        boss.position.set(0, 0, z)
        g.add(boss)
      }

      // 机油滤清器座 + 滤芯
      const ofh = box(0.9, 1.5, 1.6, castDark)
      ofh.position.set(-BLOCK_HW - 0.45, 3.4, 7.4)
      g.add(ofh)
      const filter = cyl(0.85, 0.85, 2.0, std(0x2b5f96, 0.4, 0.5), 28)
      filter.rotation.z = Math.PI / 2
      filter.position.set(-BLOCK_HW - 1.1, 3.4, 7.4)
      g.add(filter)

      // 机油尺导管
      const dip = cyl(0.11, 0.11, 3.4, std(0xb9c3ce, 0.9, 0.3), 12)
      dip.position.set(-BLOCK_HW - 0.2, 5.2, -10.6)
      dip.rotation.z = 0.16
      g.add(dip)

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 2. 气缸盖：燃烧室 / 进排气道 / 凸轮轴承座 / 缸盖螺栓
     * ================================================================ */
    {
      const p = part(
        'head',
        '气缸盖',
        'Cylinder Head',
        '封闭燃烧室并形成进排气道。顶面有 10 道凸轮轴轴承座，中央是 4 个火花塞孔，两侧各有 4 个进/排气道口。',
        '材料：铝合金铸造 · 双顶置凸轮轴（DOHC）· 每缸 2 气门',
        [0, 1, 0],
        8.2,
      )
      const g = p.group
      const alu = std(0xb6bfca, 0.72, 0.42)
      const aluDark = std(0x8b95a2, 0.68, 0.5)

      // 缸垫
      const gasket = box(BLOCK_HW * 2 + 0.1, 0.09, BLOCK_HL * 2 + 0.1, std(0x3a4048, 0.15, 0.85))
      gasket.position.y = DECK_Y + 0.06
      g.add(gasket)

      // 缸盖本体
      const body = box(BLOCK_HW * 2 + 0.1, 2.2, BLOCK_HL * 2 - 0.2, alu)
      body.position.y = DECK_Y + 1.2
      g.add(body)

      // 燃烧室凹坑（从下方看得见）
      for (const z of CYL_Z) {
        const ch = cyl(1.78, 1.5, 0.5, aluDark, 36)
        ch.position.set(0, DECK_Y + 0.14, z)
        g.add(ch)
      }

      // 凸轮轴座（两条纵向平台）
      for (const sx of [-1, 1]) {
        const rail = box(1.9, 0.42, BLOCK_HL * 2 - 0.6, alu)
        rail.position.set(sx * CAM_X, HEAD_TOP - 0.1, 0)
        g.add(rail)
        // 轴承座（带半圆缺口，用环体表现）
        for (const z of [-12.6, -8, -4.8, 0, 4.8, 8, 12.6]) {
          const cap = box(1.86, 0.5, 0.52, aluDark)
          cap.position.set(sx * CAM_X, CAM_Y + 0.46, z)
          g.add(cap)
          const bear = cylZ(0.52, 0.5, aluDark, 24)
          bear.position.set(sx * CAM_X, CAM_Y, z)
          g.add(bear)
        }
      }

      // 气门导管
      for (const z of CYL_Z) {
        for (const sx of [-1, 1]) {
          const guide = cyl(0.19, 0.19, 1.5, aluDark, 16)
          guide.position.set(sx * CAM_X, HEAD_TOP - 0.5, z + sx * 0.5)
          g.add(guide)
          // 气道口（朝外的喇叭口）
          const port = cylZ(0.62, 0.9, aluDark, 20)
          port.rotation.set(0, Math.PI / 2, 0)
          port.position.set(sx * (BLOCK_HW + 0.35), 12.15, z)
          g.add(port)
        }
      }

      // 火花塞井
      for (const z of CYL_Z) {
        const well = cyl(0.34, 0.34, 2.2, aluDark, 20, true)
        well.position.set(0, DECK_Y + 1.3, z)
        g.add(well)
      }

      // 缸盖螺栓
      for (const sx of [-1, 1]) {
        for (const z of [-12.4, -6.4, 0, 6.4, 12.4]) {
          const bolt = cyl(0.2, 0.2, 0.5, std(0xa9b4c1, 0.95, 0.24), 10)
          bolt.position.set(sx * 2.55, HEAD_TOP + 0.1, z)
          g.add(bolt)
          const hex = cyl(0.3, 0.3, 0.22, std(0x8d99a6, 0.95, 0.3), 6)
          hex.position.set(sx * 2.55, HEAD_TOP + 0.42, z)
          g.add(hex)
        }
      }

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 3. 气门室盖
     * ================================================================ */
    {
      const p = part(
        'cover',
        '气门室盖',
        'Valve Cover',
        '密封缸盖顶部的罩壳，内部有油气分离迷宫，把曲轴箱窜气中的机油分离后送回油底壳。',
        '材料：镁铝合金压铸 + 橡胶密封垫 · 8 颗螺栓固定',
        [0, 1, 0],
        13.5,
      )
      const g = p.group
      const alu = std(0xa8b2be, 0.7, 0.4)
      const accent = std(0x2b6fb8, 0.55, 0.4)
      const dark = std(0x2a3038, 0.3, 0.7)

      // 罩壳主体：梯形断面（下宽上窄）挤出，比方块像铸件
      const prof = new THREE.Shape()
      prof.moveTo(-BLOCK_HW + 0.05, 0)
      prof.lineTo(BLOCK_HW - 0.05, 0)
      prof.lineTo(2.42, 1.02)
      prof.lineTo(-2.42, 1.02)
      prof.closePath()
      const shellGeo = new THREE.ExtrudeGeometry(prof, {
        depth: BLOCK_HL * 2 - 0.9,
        bevelEnabled: true,
        bevelSize: 0.07,
        bevelThickness: 0.07,
        bevelSegments: 2,
      })
      shellGeo.translate(0, HEAD_TOP + 0.06, -(BLOCK_HL * 2 - 0.9) / 2)
      g.add(new THREE.Mesh(shellGeo, alu))

      // 顶盖板（略内缩，形成一圈台阶）
      const topPlate = box(4.7, 0.16, BLOCK_HL * 2 - 1.5, alu)
      topPlate.position.y = HEAD_TOP + 1.12
      g.add(topPlate)

      // 装饰铭牌
      const badge = box(2.2, 0.08, 5.6, accent)
      badge.position.set(0, HEAD_TOP + 1.23, -2.4)
      g.add(badge)

      // 横向加强筋（横跨顶面）
      for (let i = 0; i < 6; i++) {
        const rib = box(4.9, 0.22, 0.15, alu)
        rib.position.set(0, HEAD_TOP + 1.17, -10.6 + i * 4.2)
        g.add(rib)
      }

      // 加油口盖
      const cap = cyl(0.6, 0.6, 0.32, dark, 28)
      cap.position.set(1.5, HEAD_TOP + 1.34, -8.8)
      g.add(cap)
      const capRing = torus(0.6, 0.07, alu)
      capRing.rotation.x = Math.PI / 2
      capRing.position.set(1.5, HEAD_TOP + 1.2, -8.8)
      g.add(capRing)

      // 固定螺栓
      for (const sx of [-1, 1]) {
        for (const z of [-12.2, -6.1, 0, 6.1, 12.2]) {
          const b = cyl(0.16, 0.16, 0.28, std(0xa9b4c1, 0.95, 0.25), 6)
          b.position.set(sx * 2.66, HEAD_TOP + 0.86, z)
          g.add(b)
        }
      }

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 4/5. 双凸轮轴（带真实凸轮型线）
     * ================================================================ */
    const cams: { spin: THREE.Group; side: number }[] = []
    for (const side of [-1, 1]) {
      const isIn = side < 0
      const p = part(
        isIn ? 'cam-in' : 'cam-ex',
        isIn ? '进气凸轮轴' : '排气凸轮轴',
        isIn ? 'Intake Camshaft' : 'Exhaust Camshaft',
        isIn
          ? '由正时链以 1:2 减速驱动，凸轮升程决定进气门开启时刻与持续角，直接影响充气效率。'
          : '驱动排气门。与进气凸轮轴的相位差（LSA）决定了气门重叠角与扫气效果。',
        '材料：冷激铸铁 / 表面感应淬火 · 基圆 φ32 · 升程 10.5mm',
        [side * 0.22, 1, 0],
        11.2,
      )
      const g = p.group
      const steel = std(0x99a4b1, 0.95, 0.26)
      const hard = std(0x8c96a2, 0.9, 0.2)

      // 关键：凸轮轴必须绕「自身轴心」旋转。建一个以轴心为原点的子组再转，
      // 直接转整个部件组会变成绕曲轴公转（凸轮轴会飞到机体外）。
      const spin = new THREE.Group()
      spin.position.set(side * CAM_X, CAM_Y, 0)
      g.add(spin)

      const shaft = cylZ(0.36, 27.4, steel, 28)
      shaft.position.z = -0.4
      spin.add(shaft)

      // 轴颈
      for (const z of [-12.6, -8, -4.8, 0, 4.8, 8, 12.6]) {
        const j = cylZ(0.48, 0.62, hard, 24)
        j.position.z = z
        spin.add(j)
      }

      // 凸轮型线：极坐标 r(θ) = 基圆 + 升程 × 桃形凸起，挤出成实体
      CYL_Z.forEach((z, i) => {
        const off = i * (Math.PI / 2) + (isIn ? 0 : 0.55)
        const beta = Math.PI - off // 桃尖朝向 -Y（正对气门）
        const shape = new THREE.Shape()
        const N = 96
        for (let k = 0; k <= N; k++) {
          const t = (k / N) * Math.PI * 2
          const bump = Math.max(0, Math.cos(t - beta)) ** 2.6
          const r = 0.56 + 0.42 * bump
          const x = Math.sin(t) * r
          const y = Math.cos(t) * r
          if (k === 0) shape.moveTo(x, y)
          else shape.lineTo(x, y)
        }
        const geo = new THREE.ExtrudeGeometry(shape, {
          depth: 0.62,
          bevelEnabled: true,
          bevelThickness: 0.03,
          bevelSize: 0.03,
          bevelSegments: 1,
        })
        const lobe = new THREE.Mesh(geo, hard)
        lobe.position.z = z - 0.31
        spin.add(lobe)
      })

      // 前端法兰
      const flange = cylZ(0.85, 0.36, steel, 24)
      flange.position.z = -13.9
      spin.add(flange)

      shade(g)
      finish(p)
      cams.push({ spin, side })
    }

    /* ================================================================
     * 6. 气门组：气门 + 螺旋弹簧 + 弹簧座 + 锁片
     * ================================================================ */
    const valveItems: { g: THREE.Group; y0: number; off: number }[] = []
    {
      const p = part(
        'valves',
        '气门组',
        'Valve Train',
        '8 个气门（每缸 1 进 1 排）。凸轮压下气门顶部，气门下行打开气道；弹簧负责回位，锁片把弹簧座固定在气门杆上。',
        '材料：进气门 4Cr9Si2 / 排气门 21-4N 奥氏体钢 · 气门杆 φ6',
        [0, 1, 0],
        15.2,
      )
      const g = p.group
      const stemMat = std(0xb6c1cd, 0.96, 0.2)
      const headMat = std(0x8e99a6, 0.92, 0.28)
      const exMat = std(0x9a8a7c, 0.85, 0.45)
      const springMat = std(0xa8b3c0, 0.95, 0.28)
      const retMat = std(0x7d8894, 0.9, 0.35)

      for (const z of CYL_Z) {
        for (const side of [-1, 1]) {
          const isEx = side > 0
          const vg = new THREE.Group()
          vg.position.set(side * CAM_X, 0, z)
          g.add(vg)

          const stemTop = 13.5
          const stem = cyl(0.1, 0.1, 3.75, stemMat, 14)
          stem.position.y = stemTop - 3.75 / 2
          vg.add(stem)

          // 气门头部（锥面 + 密封带）
          const vh = cyl(0.62, 0.5, 0.26, isEx ? exMat : headMat, 32)
          vh.position.y = stemTop - 3.72
          vg.add(vh)
          const face = cyl(0.5, 0.46, 0.1, isEx ? exMat : headMat, 32)
          face.position.y = stemTop - 3.95
          vg.add(face)

          // 弹簧（螺旋线扫掠）
          const pts: THREE.Vector3[] = []
          const turns = 6
          for (let i = 0; i <= 150; i++) {
            const t = i / 150
            const a = t * Math.PI * 2 * turns
            pts.push(new THREE.Vector3(Math.cos(a) * 0.4, t * 1.35, Math.sin(a) * 0.4))
          }
          const spring = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.055, 6, false),
            springMat,
          )
          spring.position.y = 11.35
          vg.add(spring)

          const retainer = cyl(0.42, 0.42, 0.12, retMat, 20)
          retainer.position.y = 12.78
          vg.add(retainer)

          shade(vg)
          // 与凸轮同相：camA = off 时桃尖压下气门（在下方循环里按缸序补相位）
          valveItems.push({ g: vg, y0: 0, off: isEx ? 0.55 : 0 })
        }
      }

      // 点火间隔 180° 曲轴角 = 90° 凸轮角
      valveItems.forEach((v, i) => {
        v.off += Math.floor(i / 2) * (Math.PI / 2)
      })

      finish(p)
    }

    /* ================================================================
     * 7. 火花塞
     * ================================================================ */
    {
      const p = part(
        'plugs',
        '火花塞',
        'Spark Plug',
        '把点火线圈的高压电引入燃烧室，在电极间跳火点燃混合气。陶瓷绝缘体保证高压不漏电。',
        '材料：氧化铝陶瓷绝缘体 + 镍合金电极 · 间隙 0.9mm · 拧紧力矩 25N·m',
        [0, 1, 0],
        18.6,
      )
      const g = p.group
      const ceramic = std(0xe6e2d8, 0.05, 0.55)
      const shell = std(0x9aa5b2, 0.95, 0.3)
      const tip = std(0x8a7f72, 0.9, 0.4)

      for (const z of CYL_Z) {
        const plug = new THREE.Group()
        plug.position.set(0, 0, z)
        g.add(plug)

        const thread = cyl(0.22, 0.22, 0.55, shell, 16)
        thread.position.y = 11.75
        plug.add(thread)

        const hexNut = cyl(0.34, 0.34, 0.32, shell, 6)
        hexNut.position.y = 12.18
        plug.add(hexNut)

        const ins = cyl(0.24, 0.19, 1.5, ceramic, 24)
        ins.position.y = 13.06
        plug.add(ins)

        // 陶瓷伞裙
        for (let i = 0; i < 4; i++) {
          const skirt = cyl(0.29, 0.26, 0.1, ceramic, 24)
          skirt.position.y = 12.55 + i * 0.28
          plug.add(skirt)
        }

        const term = cyl(0.1, 0.1, 0.5, tip, 12)
        term.position.y = 14.0
        plug.add(term)

        // 电极
        const elec = cyl(0.06, 0.06, 0.2, tip, 8)
        elec.position.y = 11.36
        plug.add(elec)

        shade(plug)
      }

      finish(p)
    }

    /* ================================================================
     * 8. 活塞组
     * ================================================================ */
    const pistonItems: { g: THREE.Group; phase: number; z: number }[] = []
    {
      const p = part(
        'pistons',
        '活塞组',
        'Pistons',
        '承受燃烧压力并把力传给连杆。顶部三道环槽分别安装两道气环和一道油环，裙部有石墨涂层减摩。',
        '材料：共晶铝硅合金锻造 · 直径 φ79.5 · 压缩高度 32mm · 质量 268g',
        [0, 1, 0],
        5.6,
      )
      const g = p.group
      const skirtMat = std(0xb9c2cc, 0.82, 0.34)
      const crownMat = std(0x8d97a3, 0.8, 0.4)
      const carbon = std(0x2a2d33, 0.4, 0.8)
      const ringMat = std(0x585f68, 0.9, 0.35)
      const pinMat = std(0xa7b2bf, 0.96, 0.2)

      CYL_Z.forEach((z, i) => {
        const pg = new THREE.Group()
        pg.position.set(0, 0, z)
        g.add(pg)

        // 裙部 + 顶部
        const skirt = cyl(1.94, 1.9, 1.5, skirtMat, 44)
        skirt.position.y = 0.35
        pg.add(skirt)

        const body = cyl(1.95, 1.95, 1.15, skirtMat, 44)
        body.position.y = 1.32
        pg.add(body)

        // 顶部燃烧室凹坑
        const bowl = cyl(1.55, 1.25, 0.22, crownMat, 40)
        bowl.position.y = 1.92
        pg.add(bowl)
        const rim = torus(1.72, 0.05, crownMat)
        rim.rotation.x = Math.PI / 2
        rim.position.y = 1.9
        pg.add(rim)

        // 活塞环
        for (const yy of [1.72, 1.5, 1.28]) {
          const ring = torus(1.95, 0.045, ringMat)
          ring.rotation.x = Math.PI / 2
          ring.position.y = yy
          pg.add(ring)
        }
        // 油环回油孔
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2
          const hole = cyl(0.06, 0.06, 0.1, carbon, 8)
          hole.rotation.x = Math.PI / 2
          hole.position.set(Math.cos(a) * 1.9, 1.28, Math.sin(a) * 1.9)
          pg.add(hole)
        }

        // 销座 + 活塞销
        for (const sx of [-1, 1]) {
          const boss = box(0.42, 0.9, 1.2, crownMat)
          boss.position.set(sx * 0.85, 0.05, 0)
          pg.add(boss)
        }
        const pin = cyl(0.3, 0.3, 3.5, pinMat, 24)
        pin.rotation.z = Math.PI / 2
        pin.position.y = 0
        pg.add(pin)

        shade(pg)
        pistonItems.push({ g: pg, phase: PHASE[i], z })
      })

      finish(p)
    }

    /* ================================================================
     * 9. 连杆组
     * ================================================================ */
    const rodItems: { g: THREE.Group; phase: number; z: number }[] = []
    {
      const p = part(
        'rods',
        '连杆组',
        'Connecting Rods',
        '把活塞的往复运动转成曲轴的旋转。杆身是 I 型断面，大头抱合曲柄销并装有连杆瓦，小头压装衬套。',
        '材料：40Cr 锻钢 · 中心距 144mm · 大头 φ48 · 质量 412g',
        [1, -0.35, -0.6],
        9.6,
      )
      const g = p.group
      const forged = std(0x9aa5b1, 0.93, 0.3)
      const darkCap = std(0x7f8a96, 0.92, 0.36)
      const boltMat = std(0xb8c3cf, 0.98, 0.18)

      CYL_Z.forEach((z, i) => {
        const rg = new THREE.Group()
        rg.position.set(0, 0, z)
        g.add(rg)

        // 大头
        const big = cylZ(0.95, 0.86, forged, 32)
        rg.add(big)
        const bigBore = cylZ(0.74, 0.9, darkCap, 28)
        rg.add(bigBore)
        // 连杆盖分型面
        const cap = box(1.9, 0.16, 0.9, darkCap)
        cap.position.y = -0.02
        rg.add(cap)
        // 连杆螺栓
        for (const sx of [-1, 1]) {
          const b = cyl(0.11, 0.11, 1.15, boltMat, 10)
          b.position.set(sx * 0.74, -0.55, 0)
          rg.add(b)
        }

        // 杆身：I 型断面（腹板 + 两侧翼缘）
        const len = ROD_L - 1.5
        const web = box(0.3, len, 0.62, forged)
        web.position.y = len / 2 + 0.5
        rg.add(web)
        for (const sz of [-1, 1]) {
          const flange = box(0.66, len, 0.14, forged)
          flange.position.set(0, len / 2 + 0.5, sz * 0.36)
          rg.add(flange)
        }

        // 小头
        const small = cylZ(0.56, 0.8, forged, 28)
        small.position.y = ROD_L
        rg.add(small)
        const bush = cylZ(0.31, 0.86, std(0x8f6f45, 0.9, 0.35), 24)
        bush.position.y = ROD_L
        rg.add(bush)

        shade(rg)
        rodItems.push({ g: rg, phase: PHASE[i], z })
      })

      finish(p)
    }

    /* ================================================================
     * 10. 曲轴
     * ================================================================ */
    const crankSpin = new THREE.Group()
    {
      const p = part(
        'crank',
        '曲轴',
        'Crankshaft',
        '把活塞的往复惯性力与燃气压力转成扭矩输出。5 道主轴颈由主轴承支撑，4 个曲柄销按 180° 相位布置，平衡重抵消旋转惯性力。',
        '材料：42CrMo 锻钢 / 轴颈氮化 · 主轴颈 φ52 · 曲柄销 φ45 · 行程 88mm',
        [0, -1, 0.05],
        8.4,
      )
      const forged = std(0x98a3b0, 0.95, 0.24)
      const polished = std(0xb2bdc9, 0.98, 0.12)
      const webMat = std(0x8b96a3, 0.92, 0.32)

      p.group.add(crankSpin)

      // 主轴颈
      for (const z of [-12.8, -6.4, 0, 6.4, 12.8]) {
        const j = cylZ(0.95, 1.0, polished, 32)
        j.position.set(0, 0, z)
        crankSpin.add(j)
      }

      // 曲柄销 + 曲柄臂 + 平衡重
      CYL_Z.forEach((z, i) => {
        const b = PHASE[i]
        const px = Math.sin(b) * CRANK_R
        const py = Math.cos(b) * CRANK_R

        const pin = cylZ(0.86, 2.5, polished, 32)
        pin.position.set(px, py, z)
        crankSpin.add(pin)

        // 两侧曲柄臂
        for (const sz of [-1, 1]) {
          const arm = new THREE.Group()
          arm.position.set(0, 0, z + sz * 1.55)
          arm.rotation.z = -b
          crankSpin.add(arm)

          const plate = box(1.65, 3.05, 0.62, webMat)
          plate.position.y = CRANK_R / 2
          arm.add(plate)

          const boss = cylZ(0.82, 0.66, webMat, 24)
          boss.position.y = CRANK_R
          arm.add(boss)

          // 平衡重（扇形配重，向曲柄销反方向）
          const cw = box(2.5, 1.7, 0.62, webMat)
          cw.position.y = -1.75
          arm.add(cw)
          const cwRound = cylZ(1.25, 0.62, webMat, 28)
          cwRound.position.y = -2.5
          arm.add(cwRound)
        }
      })

      // 前端轴颈 + 后端法兰
      const nose = cylZ(0.72, 2.4, forged, 28)
      nose.position.z = -14.0
      crankSpin.add(nose)
      const flange = cylZ(2.9, 0.55, forged, 40)
      flange.position.z = 13.55
      crankSpin.add(flange)
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2
        const bolt = cyl(0.14, 0.14, 0.3, std(0xbcc7d3, 0.98, 0.2), 10)
        bolt.rotation.x = Math.PI / 2
        bolt.position.set(Math.cos(a) * 2.4, Math.sin(a) * 2.4, 13.9)
        crankSpin.add(bolt)
      }

      shade(p.group)
      finish(p)
    }

    /* ================================================================
     * 11. 飞轮 + 起动齿圈
     * ================================================================ */
    const flySpin = new THREE.Group()
    {
      const p = part(
        'flywheel',
        '飞轮',
        'Flywheel',
        '储存做功行程的动能，维持曲轴匀速运转；外缘的起动齿圈与起动机小齿轮啮合，负责起动发动机。',
        '材料：灰铸铁 HT250 · 质量 7.2kg · 齿圈 118 齿 · 离合器摩擦面 φ225',
        [0, 0.1, 1],
        9.4,
      )
      const iron = grainy(std(0x5e6771, 0.55, 0.64), 0.02)
      const face = std(0xa6b1bd, 0.95, 0.22)
      const gear = std(0x9099a4, 0.9, 0.35)

      p.group.add(flySpin)
      flySpin.position.z = 13.9

      const disc = cylZ(5.0, 0.72, iron, 64)
      flySpin.add(disc)

      const friction = cylZ(3.45, 0.1, face, 56)
      friction.position.z = -0.4
      flySpin.add(friction)

      // 起动齿圈：环形基体 + 齿
      const ring = cylZ(5.02, 0.62, gear, 64)
      ring.position.z = 0.36
      flySpin.add(ring)
      const teeth = new THREE.Group()
      flySpin.add(teeth)
      for (let i = 0; i < 56; i++) {
        const a = (i / 56) * Math.PI * 2
        const t = box(0.16, 0.34, 0.6, gear)
        t.position.set(Math.cos(a) * 5.16, Math.sin(a) * 5.16, 0.36)
        t.rotation.z = a
        teeth.add(t)
      }

      // 减重孔 + 螺栓
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        const hole = cylZ(0.34, 0.8, std(0x30363e, 0.5, 0.7), 20)
        hole.position.set(Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0)
        flySpin.add(hole)
      }

      shade(p.group)
      finish(p)
    }

    /* ================================================================
     * 12. 油底壳
     * ================================================================ */
    {
      const p = part(
        'pan',
        '油底壳',
        'Oil Pan',
        '储存并冷却机油，底部最深处的放油螺塞用于换油。内部有挡油板，防止车辆加减速时机油晃动露出集滤器。',
        '材料：冲压钢板 / 铝合金 · 容积 4.2L · 湿式油底壳',
        [0.1, -1, 0.12],
        13.2,
      )
      const g = p.group
      const sheet = grainy(std(0x5c655f, 0.5, 0.7), 0.025)

      const shape = new THREE.Shape()
      shape.moveTo(-BLOCK_HW, -0.9)
      shape.lineTo(BLOCK_HW, -0.9)
      shape.lineTo(2.55, -1.9)
      shape.lineTo(2.2, -4.05)
      shape.lineTo(-2.2, -4.05)
      shape.lineTo(-2.55, -1.9)
      shape.closePath()
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 25.6, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1 })
      geo.translate(0, 0, -12.8)
      g.add(new THREE.Mesh(geo, sheet))

      // 与缸体结合的法兰边
      const lip = box(BLOCK_HW * 2 + 0.2, 0.14, 25.8, sheet)
      lip.position.y = -0.95
      g.add(lip)

      // 侧面加强筋
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 6; i++) {
          const rib = box(0.12, 1.4, 0.22, std(0x6f7883, 0.65, 0.6))
          rib.position.set(sx * 2.6, -1.9, -10 + i * 4)
          g.add(rib)
        }
      }

      // 放油螺塞
      const plug = cyl(0.28, 0.28, 0.28, std(0xa9b4c1, 0.95, 0.25), 6)
      plug.position.set(0, -3.62, 8.2)
      g.add(plug)

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 13. 进气歧管：稳压腔 + 4 根等长歧管 + 节气门 + 喷油轨
     * ================================================================ */
    {
      const p = part(
        'intake',
        '进气歧管',
        'Intake Manifold',
        '稳压腔把节气门后的脉动气流稳定下来，再经 4 根等长歧管均匀分配到各缸。喷油器安装在歧管根部，向气道内喷射燃油。',
        '材料：玻纤增强 PA66 注塑 · 歧管长度 210mm · 节气门 φ56',
        [-1, 0.16, 0],
        10.4,
      )
      const g = p.group
      const nylon = std(0x272c33, 0.16, 0.68)
      const nylon2 = std(0x333a43, 0.18, 0.6)
      const metal = std(0xa9b4c1, 0.95, 0.28)

      const plenum = cylZ(1.5, 19.4, nylon, 40)
      plenum.position.set(-4.7, 12.72, 0.4)
      g.add(plenum)

      // 端盖
      for (const sz of [-1, 1]) {
        const capEnd = cylZ(0.1, 0.25, nylon2, 40)
        capEnd.position.set(-4.7, 12.72, 0.4 + sz * 9.7)
        g.add(capEnd)
      }

      // 4 根歧管
      CYL_Z.forEach((z) => {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(-4.5, 12.5, z),
          new THREE.Vector3(-4.1, 12.35, z),
          new THREE.Vector3(-3.6, 12.2, z),
          new THREE.Vector3(-3.15, 12.1, z),
        ])
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.52, 20, false), nylon)
        g.add(tube)
        // 缸盖侧法兰
        const flange = box(0.16, 1.5, 1.4, nylon2)
        flange.position.set(-3.02, 12.1, z)
        g.add(flange)
        // 喷油器
        const inj = cyl(0.15, 0.15, 0.85, metal, 14)
        inj.position.set(-3.55, 12.9, z)
        inj.rotation.z = -0.5
        g.add(inj)
      })

      // 节气门体
      const tb = cylZ(0.95, 1.3, std(0x8c96a2, 0.9, 0.3), 32)
      tb.position.set(-4.7, 12.72, -9.8)
      g.add(tb)
      const tbMotor = box(0.9, 0.8, 1.0, nylon2)
      tbMotor.position.set(-4.7, 13.7, -9.8)
      g.add(tbMotor)
      // 节气门翻板
      const blade = cyl(0.82, 0.82, 0.08, metal, 32)
      blade.rotation.x = Math.PI / 2
      blade.position.set(-4.7, 12.72, -9.8)
      g.add(blade)

      // 燃油分配轨
      const rail = cylZ(0.28, 16, metal, 20)
      rail.position.set(-3.35, 13.15, 0)
      g.add(rail)

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 14. 排气歧管：4-2-1 脉冲转换
     * ================================================================ */
    {
      const p = part(
        'exhaust',
        '排气歧管',
        'Exhaust Manifold',
        '把各缸废气汇集成一股引入排气管。采用 4-2-1 结构，利用排气脉冲的相位差提高扫气效果，管壁较厚以抑制热变形。',
        '材料：高硅钼球墨铸铁 · 管壁 4.5mm · 出口 φ51',
        [1, 0.08, -0.12],
        11.4,
      )
      const g = p.group
      const castIron = grainy(std(0x3b3732, 0.4, 0.86), 0.03)
      const hot = grainy(std(0x423c34, 0.35, 0.9), 0.03)

      CYL_Z.forEach((z) => {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(3.05, 11.85, z),
          new THREE.Vector3(3.9, 11.5, z * 0.86),
          new THREE.Vector3(4.5, 9.9, z * 0.62),
          new THREE.Vector3(4.5, 8.4, z * 0.32 + 4.2),
          new THREE.Vector3(4.35, 7.9, 10.4),
        ])
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.5, 18, false), hot)
        g.add(tube)
        const flange = box(0.16, 1.4, 1.3, castIron)
        flange.position.set(3.1, 11.85, z)
        g.add(flange)
      })

      // 集合管 + 出口
      const collector = cylZ(0.92, 3.2, castIron, 32)
      collector.position.set(4.35, 7.9, 11.4)
      g.add(collector)
      const outlet = cyl(0.92, 0.46, 0.85, castIron, 28)
      outlet.position.set(4.35, 6.95, 12.4)
      g.add(outlet)

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 15. 正时链系：曲轴链轮 → 双凸轮轴链轮 + 链条 + 张紧器
     * ================================================================ */
    let chainLinks: THREE.InstancedMesh | null = null
    let chainSegs: { a: THREE.Vector2; b: THREE.Vector2; len: number; start: number }[] = []
    let chainLen = 0
    let chainSpacing = 0.52
    {
      const p = part(
        'timing',
        '正时链系',
        'Timing Chain Drive',
        '曲轴链轮通过链条以 2:1 减速驱动两根凸轮轴，保证活塞与气门的严格相位关系。液压张紧器与导轨抑制链条抖动。',
        '材料：链板 40Cr / 链轮 20CrMnTi 渗碳 · 链节 9.525mm · 传动比 2:1',
        [0, 0, -1],
        7.6,
      )
      const g = p.group
      const steel = std(0xa2adba, 0.95, 0.28)
      const gear = std(0x8e99a5, 0.92, 0.34)

      function sprocket(r: number, teeth: number, x: number, y: number, z: number, mat: THREE.Material) {
        const grp = new THREE.Group()
        grp.position.set(x, y, z)
        const body = cylZ(r - 0.16, 0.34, mat, 48)
        grp.add(body)
        const rim = cylZ(r, 0.2, mat, 48)
        grp.add(rim)
        for (let i = 0; i < teeth; i++) {
          const a = (i / teeth) * Math.PI * 2
          const t = box(0.12, 0.2, 0.22, mat)
          t.position.set(Math.cos(a) * (r + 0.04), Math.sin(a) * (r + 0.04), 0)
          t.rotation.z = a
          grp.add(t)
        }
        // 减重孔
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.4
          const hole = cylZ(r * 0.32, 0.4, std(0x39414b, 0.6, 0.6), 16)
          hole.position.set(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, 0)
          grp.add(hole)
        }
        return grp
      }

      const crankSp = sprocket(1.62, 20, 0, 0, -14.1, gear)
      const camSpA = sprocket(2.42, 30, -CAM_X, CAM_Y, -14.1, gear)
      const camSpB = sprocket(2.42, 30, CAM_X, CAM_Y, -14.1, gear)
      g.add(crankSp, camSpA, camSpB)

      // 链条中心线
      const hull = beltPolyline([
        { x: 0, y: 0, r: 1.74 },
        { x: -CAM_X, y: CAM_Y, r: 2.54 },
        { x: CAM_X, y: CAM_Y, r: 2.54 },
      ])

      chainSegs = []
      chainLen = 0
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i]
        const b = hull[(i + 1) % hull.length]
        const len = a.distanceTo(b)
        if (len < 1e-4) continue
        chainSegs.push({ a, b, len, start: chainLen })
        chainLen += len
      }

      const count = Math.max(1, Math.round(chainLen / 0.5))
      chainSpacing = chainLen / count
      chainLinks = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.56, 0.26, 0.32),
        std(0x9aa5b2, 0.95, 0.32),
        count,
      )
      chainLinks.castShadow = true
      chainLinks.frustumCulled = false
      g.add(chainLinks)

      // 液压张紧器 + 导轨
      const tensioner = cyl(0.34, 0.34, 1.5, steel, 20)
      tensioner.position.set(2.05, 4.6, -14.1)
      tensioner.rotation.z = -0.35
      g.add(tensioner)
      const shoe = box(0.24, 5.4, 0.42, std(0x4b535d, 0.35, 0.6))
      shoe.position.set(1.98, 6.4, -14.1)
      shoe.rotation.z = 0.14
      g.add(shoe)
      const guide = box(0.24, 6.0, 0.42, std(0x4b535d, 0.35, 0.6))
      guide.position.set(-1.98, 5.4, -14.1)
      guide.rotation.z = -0.12
      g.add(guide)

      shade(g)
      finish(p)

      // 供动画使用的链轮
      ;(crankSp as THREE.Group).userData.role = 'crankSprocket'
      p.group.userData.crankSp = crankSp
      p.group.userData.camSpA = camSpA
      p.group.userData.camSpB = camSpB
    }

    /* ================================================================
     * 16. 正时罩
     * ================================================================ */
    {
      const p = part(
        'frontcover',
        '正时罩',
        'Timing Cover',
        '密封正时链室并挡住飞溅的机油。前端同时作为水泵与曲轴前油封的安装座。',
        '材料：铝合金压铸 · 壁厚 4mm · 曲轴前油封 φ42×62',
        [0.42, 0.12, -1],
        13.2,
      )
      const g = p.group
      const alu = std(0xa3adb9, 0.7, 0.42)
      const plateGeo = new THREE.ExtrudeGeometry(roundRect(6.7, 17.4, 1.1), {
        depth: 0.6,
        bevelEnabled: true,
        bevelSize: 0.07,
        bevelThickness: 0.07,
        bevelSegments: 1,
      })
      const plate = new THREE.Mesh(plateGeo, alu)
      plate.position.set(0, 6.85, -15.9)
      g.add(plate)

      // 曲轴前油封座
      const sealBoss = cylZ(0.98, 0.34, alu, 32)
      sealBoss.position.set(0, 0, -16.1)
      g.add(sealBoss)
      // 曲轴皮带轮
      const pulley = cylZ(1.72, 0.52, std(0x3c444e, 0.5, 0.5), 44)
      pulley.position.set(0, 0, -16.5)
      g.add(pulley)
      for (let i = 0; i < 5; i++) {
        const groove = torus(1.72, 0.06, std(0x2a3038, 0.4, 0.6))
        groove.position.set(0, 0, -16.34 - i * 0.09)
        g.add(groove)
      }

      // 周圈螺栓
      for (let i = 0; i < 13; i++) {
        const a = (i / 13) * Math.PI * 2
        const b = cyl(0.15, 0.15, 0.24, std(0xa9b4c1, 0.95, 0.25), 6)
        b.rotation.x = Math.PI / 2
        b.position.set(Math.cos(a) * 2.85, 6.85 + Math.sin(a) * 7.9, -16.05)
        g.add(b)
      }

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 17. 水泵
     * ================================================================ */
    {
      const p = part(
        'pump',
        '水泵',
        'Water Pump',
        '离心式水泵由皮带驱动，把冷却液从缸体水套抽出压入缸盖，形成强制循环。机械密封防止冷却液从泵轴渗漏。',
        '材料：铝合金泵壳 + 工程塑料叶轮 · 流量 120L/min · 皮带轮 φ120',
        [0.3, 0.45, -1],
        9.8,
      )
      const g = p.group
      const alu = std(0xa8b2be, 0.84, 0.38)
      const body = cylZ(1.25, 1.2, alu, 40)
      body.position.set(2.35, 6.4, -16.5)
      g.add(body)
      const neck = cyl(0.62, 0.62, 1.6, alu, 28)
      neck.position.set(2.35, 5.5, -16.5)
      g.add(neck)
      const inlet = cylZ(0.66, 2.2, alu, 28)
      inlet.position.set(1.6, 4.6, -16.5)
      g.add(inlet)
      const pulley = cylZ(1.15, 0.5, std(0x3c444e, 0.5, 0.5), 40)
      pulley.position.set(2.35, 6.4, -17.4)
      g.add(pulley)

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 18. 发电机
     * ================================================================ */
    {
      const p = part(
        'alt',
        '发电机',
        'Alternator',
        '由曲轴皮带驱动，把机械能转成电能给蓄电池充电并供给全车用电。内置整流桥把三相交流整流为直流。',
        '材料：铝合金端盖 + 硅钢片定子 · 输出 14V / 110A',
        [-0.9, 0.3, -0.6],
        9.2,
      )
      const g = p.group
      const alu = std(0xa4aeba, 0.85, 0.4)
      const caseMat = std(0x8b96a2, 0.8, 0.45)
      const body = cylZ(1.3, 2.6, caseMat, 36)
      body.position.set(-3.9, 4.6, -12.4)
      g.add(body)
      for (let i = 0; i < 7; i++) {
        const ring = torus(1.3, 0.05, alu, 36)
        ring.position.set(-3.9, 4.6, -13.6 + i * 0.38)
        g.add(ring)
      }
      const face = cylZ(1.15, 0.3, alu, 36)
      face.position.set(-3.9, 4.6, -14.1)
      g.add(face)
      const pulley = cylZ(0.72, 0.44, std(0x3c444e, 0.5, 0.5), 32)
      pulley.position.set(-3.9, 4.6, -14.5)
      g.add(pulley)
      // 支架
      const bracket = box(0.5, 1.9, 0.7, caseMat)
      bracket.position.set(-3.55, 5.6, -12.0)
      g.add(bracket)

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 19. 机脚（悬置）
     * ================================================================ */
    {
      const p = part(
        'mount',
        '发动机悬置',
        'Engine Mounts',
        '把动力总成弹性地固定在车架上。橡胶主簧隔振，液压阻尼腔抑制低频抖动。',
        '材料：铸铝支架 + 天然橡胶 · 静刚度 220N/mm',
        [0, -1, 0.2],
        7.2,
      )
      const g = p.group
      const alu = std(0x99a3af, 0.8, 0.45)
      const rubber = std(0x1d2126, 0.1, 0.85)

      for (const sz of [-1, 1]) {
        const bracket = box(0.7, 1.5, 2.4, alu)
        bracket.position.set(-3.2, 1.9, sz * 8.4)
        g.add(bracket)
        const arm = box(2.4, 0.6, 1.0, alu)
        arm.position.set(-4.2, 1.2, sz * 8.4)
        g.add(arm)
        const bush = cyl(0.62, 0.62, 1.2, rubber, 24)
        bush.rotation.x = Math.PI / 2
        bush.position.set(-5.1, 0.8, sz * 8.4)
        g.add(bush)
        const bolt = cyl(0.2, 0.2, 1.6, std(0xb0bbc7, 0.95, 0.25), 10)
        bolt.rotation.x = Math.PI / 2
        bolt.position.set(-5.1, 0.8, sz * 8.4)
        g.add(bolt)
      }

      shade(g)
      finish(p)
    }

    /* ================================================================
     * 标注（CSS2D）
     * ================================================================ */
    const labelRenderer = new CSS2DRenderer()
    labelRenderer.domElement.style.position = 'absolute'
    labelRenderer.domElement.style.top = '0'
    labelRenderer.domElement.style.left = '0'
    labelRenderer.domElement.style.pointerEvents = 'none'
    container.value?.appendChild(labelRenderer.domElement)

    const LABEL_AT: Record<string, [number, number, number]> = {
      cover: [0, 15.9, 0],
      head: [3.3, 13.9, -6.4],
      block: [3.5, 8.6, -12.4],
      crank: [0, -1.6, -12.4],
      pistons: [0, 10.6, 9.6],
      rods: [2.6, 3.2, 0],
      flywheel: [0, 6.1, 14],
      pan: [-3.5, -3.0, 0],
      intake: [-7.3, 13.0, 0],
      exhaust: [6.2, 9.0, 8],
      timing: [0, 15.2, -14.2],
      'cam-in': [-3.6, 13.2, -8],
      'cam-ex': [3.6, 13.2, 8],
    }
    const labels: { obj: CSS2DObject; group: THREE.Group; el: HTMLDivElement }[] = []
    for (const pt of parts) {
      const at = LABEL_AT[pt.id]
      if (!at) continue
      const el = document.createElement('div')
      el.className = 'eng-label'
      el.textContent = pt.name
      const obj = new CSS2DObject(el)
      obj.position.set(...at)
      pt.group.add(obj)
      labels.push({ obj, group: pt.group, el })
    }

    const onResize = () => {
      const el = container.value
      if (!el) return
      labelRenderer.setSize(el.clientWidth || 1, el.clientHeight || 1)
    }
    window.addEventListener('resize', onResize)
    onResize()

    /* ================================================================
     * 交互：拾取 + 高亮
     * ================================================================ */
    const raycaster = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    let selectedId: string | null = null

    function pickAt(clientX: number, clientY: number) {
      const rect = renderer.domElement.getBoundingClientRect()
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObjects(pickables, false)
      for (const h of hits) {
        let o: THREE.Object3D | null = h.object
        while (o && !o.userData.partId) o = o.parent
        if (o) return o.userData.partId as string
      }
      return null
    }

    function highlight(id: string | null) {
      for (const pt of parts) {
        const on = pt.id === id
        for (const m of pt.mats) {
          if (!m.userData.baseEmissive) {
            m.userData.baseEmissive = m.emissive.clone()
            m.userData.baseIntensity = m.emissiveIntensity
          }
          if (on) {
            m.emissive.setHex(0x1d63ff)
            m.emissiveIntensity = 0.55
          } else {
            m.emissive.copy(m.userData.baseEmissive as THREE.Color)
            m.emissiveIntensity = m.userData.baseIntensity as number
          }
        }
      }
      selectedId = id
      const pt = parts.find((x) => x.id === id)
      selected.value = pt ? { name: pt.name, en: pt.en, desc: pt.desc, spec: pt.spec } : null
    }

    let downX = 0
    let downY = 0
    let downT = 0

    const onDown = (e: PointerEvent) => {
      downX = e.clientX
      downY = e.clientY
      downT = performance.now()
    }

    const onUp = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY)
      if (moved > 6 || performance.now() - downT > 700) return
      const id = pickAt(e.clientX, e.clientY)
      highlight(id)
    }

    const onMove = (e: PointerEvent) => {
      const id = pickAt(e.clientX, e.clientY)
      renderer.domElement.style.cursor = id ? 'pointer' : 'grab'
      if (id) {
        const pt = parts.find((x) => x.id === id)
        const rect = container.value?.getBoundingClientRect()
        hover.value = pt
          ? { name: pt.name, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
          : null
      } else {
        hover.value = null
      }
    }

    const onLeave = () => {
      hover.value = null
    }

    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerleave', onLeave)
    renderer.domElement.style.cursor = 'grab'

    onBeforeUnmount(() => {
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('resize', onResize)
      labelRenderer.domElement.remove()
    })

    partTotal.value = parts.length

    /* ================================================================
     * 动画
     * ================================================================ */
    let phi = 0
    let sOff = 0
    let explodeSmooth = 0
    let ghostOn = false
    const dummy = new THREE.Object3D()

    const castMap = new Map<THREE.Material, boolean>()

    function applyGhost(on: boolean) {
      const targets = parts.filter((x) => x.id === 'block' || x.id === 'head' || x.id === 'cover')
      for (const pt of targets) {
        pt.group.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const m of mats as THREE.MeshStandardMaterial[]) {
            if (m.transparent === on && (on ? m.opacity !== 0.24 : m.opacity !== 1)) continue
            if (!castMap.has(m)) castMap.set(m, m.transparent)
            m.transparent = on
            m.opacity = on ? 0.24 : 1
            m.depthWrite = !on
            m.needsUpdate = true
          }
        })
      }
    }

    return (dt) => {
      /* 拆解时按比例拉远，保证爆炸图整体不出画 */
      const zoomWanted = 1 - 0.46 * explodeSmooth
      if (Math.abs(camera.zoom - zoomWanted) > 0.0008) {
        camera.zoom = zoomWanted
        camera.updateProjectionMatrix()
      }

      /* 拆解缓动 */
      const target = explode.value / 100
      explodeSmooth += (target - explodeSmooth) * Math.min(1, dt * 7)
      if (Math.abs(target - explodeSmooth) < 0.0005) explodeSmooth = target
      for (const pt of parts) {
        pt.group.position.copy(pt.dir).multiplyScalar(pt.dist * explodeSmooth)
      }

      /* 半透明开关 */
      if (ghostOn !== ghost.value) {
        ghostOn = ghost.value
        applyGhost(ghostOn)
      }

      /* 曲轴转动 */
      const omega = running.value ? (speed.value / 100) * 3.6 : 0
      phi += omega * dt

      crankSpin.rotation.z = -phi
      flySpin.rotation.z = -phi

      // 活塞 / 连杆运动学
      pistonItems.forEach((it, i) => {
        const a = phi + PHASE[i]
        const y = CRANK_R * Math.cos(a) + Math.sqrt(ROD_L * ROD_L - (CRANK_R * Math.sin(a)) ** 2)
        // 必须带上该缸的 z，否则四只活塞会全部叠在 z=0
        it.g.position.set(0, y, it.z)
      })
      rodItems.forEach((it, i) => {
        const a = phi + PHASE[i]
        const px = CRANK_R * Math.sin(a)
        const py = CRANK_R * Math.cos(a)
        const y = py + Math.sqrt(ROD_L * ROD_L - (CRANK_R * Math.sin(a)) ** 2)
        it.g.position.set(px, py, it.z)
        // 杆身指向活塞销：默认沿 +Y，绕 Z 旋转 -atan2(dx, dy)
        it.g.rotation.z = -Math.atan2(-px, y - py)
      })

      // 凸轮轴 / 气门升程
      const camA = phi / 2
      cams.forEach((c) => {
        c.spin.rotation.z = -camA
      })
      valveItems.forEach((v) => {
        const open = Math.max(0, Math.cos(camA - v.off))
        v.g.position.y = -open * open * 0.62
      })

      // 链条沿包络滚动
      if (chainLinks && chainSegs.length) {
        sOff = (sOff + omega * dt * 0.9) % chainLen
        const count = chainLinks.count
        for (let i = 0; i < count; i++) {
          let s = (i * chainSpacing + sOff) % chainLen
          let seg = chainSegs[chainSegs.length - 1]
          for (const c of chainSegs) {
            if (s >= c.start && s < c.start + c.len) {
              seg = c
              break
            }
          }
          const t = Math.min(1, (s - seg.start) / seg.len)
          dummy.position.set(
            THREE.MathUtils.lerp(seg.a.x, seg.b.x, t),
            THREE.MathUtils.lerp(seg.a.y, seg.b.y, t),
            -14.1,
          )
          dummy.rotation.z = -Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x)
          dummy.updateMatrix()
          chainLinks.setMatrixAt(i, dummy.matrix)
        }
        chainLinks.instanceMatrix.needsUpdate = true
      }

      /* 标注显隐：拆解到一定程度才显示，避免初始画面太乱 */
      const showLbl = showLabels.value && (explodeSmooth > 0.08 || selectedId !== null)
      for (const l of labels) {
        l.obj.visible = showLbl
        l.el.style.opacity = String(Math.min(1, (explodeSmooth - 0.08) * 6 + (selectedId ? 1 : 0)))
      }

      /* 自动旋转 */
      if (controls) {
        controls.autoRotate = autoRotate.value
        controls.autoRotateSpeed = 0.55
      }

      labelRenderer.render(scene, camera)
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>

    <!-- 控制面板 -->
    <div class="panel">
      <div class="ttl">
        直列四缸汽油机
        <em>拆解演示</em>
      </div>

      <div class="row">
        <span>拆解程度</span>
        <b>{{ explode }}%</b>
      </div>
      <input v-model.number="explode" class="rng" type="range" min="0" max="100" step="1" />

      <div class="row">
        <span>曲轴转速</span>
        <b>{{ Math.round(speed * 24) }} rpm</b>
      </div>
      <input v-model.number="speed" class="rng" type="range" min="0" max="100" step="1" />

      <div class="chips">
        <button class="chip" :class="{ on: running }" @click="running = !running">
          {{ running ? '运转中' : '已暂停' }}
        </button>
        <button class="chip" :class="{ on: autoRotate }" @click="autoRotate = !autoRotate">自动旋转</button>
        <button class="chip" :class="{ on: ghost }" @click="ghost = !ghost">半透明壳体</button>
        <button class="chip" :class="{ on: showLabels }" @click="showLabels = !showLabels">部件标注</button>
      </div>

      <div class="chips">
        <button class="chip act" @click="explode = 100">全部拆解</button>
        <button class="chip act" @click="explode = 0">复原装配</button>
      </div>

      <div class="hint">点击任意部件查看说明 · 共 {{ partTotal }} 个可拆部件</div>
    </div>

    <!-- 部件信息卡 -->
    <transition name="fade">
      <div v-if="selected" class="info">
        <div class="info-h">
          <div>
            <b>{{ selected.name }}</b>
            <i>{{ selected.en }}</i>
          </div>
          <button class="x" @click="selected = null">×</button>
        </div>
        <p>{{ selected.desc }}</p>
        <div class="spec">{{ selected.spec }}</div>
      </div>
    </transition>

    <!-- 悬停提示 -->
    <div v-if="hover" class="hover" :style="{ left: hover.x + 14 + 'px', top: hover.y + 14 + 'px' }">
      {{ hover.name }}
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
  position: relative;
  width: 100%;
  height: 100%;
}

.panel {
  position: absolute;
  left: 14px;
  top: 14px;
  width: 244px;
  padding: 12px 13px 10px;
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(17, 24, 34, 0.93), rgba(12, 17, 24, 0.9));
  border: 1px solid rgba(88, 112, 140, 0.42);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(10px);
  z-index: 4;
}
.ttl {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: #e8f0fa;
  letter-spacing: 0.3px;
  margin-bottom: 11px;
}
.ttl em {
  font-style: normal;
  font-size: 10.5px;
  font-weight: 500;
  color: #57b6ff;
  padding: 1px 6px;
  border-radius: 20px;
  background: rgba(47, 127, 208, 0.16);
  border: 1px solid rgba(79, 157, 255, 0.35);
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 11px;
  color: #8fa2b7;
  margin-bottom: 4px;
}
.row b {
  color: #cfdcec;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.rng {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  margin: 0 0 11px;
  border-radius: 4px;
  background: linear-gradient(90deg, #2f7fd0 0%, #2f7fd0 45%, rgba(120, 140, 165, 0.28) 45%);
  outline: none;
  cursor: pointer;
}
.rng::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #eaf4ff;
  border: 2px solid #2f7fd0;
  box-shadow: 0 0 8px rgba(79, 157, 255, 0.7);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.chip {
  padding: 4px 9px;
  font-size: 10.5px;
  color: #9fb1c5;
  background: rgba(36, 46, 58, 0.85);
  border: 1px solid rgba(83, 105, 130, 0.5);
  border-radius: 6px;
  cursor: pointer;
  transition: 0.16s;
}
.chip:hover {
  color: #dce9f7;
  border-color: rgba(110, 160, 210, 0.7);
}
.chip.on {
  color: #eaf4ff;
  background: rgba(47, 127, 208, 0.28);
  border-color: rgba(79, 157, 255, 0.75);
  box-shadow: 0 0 10px rgba(47, 127, 208, 0.3) inset;
}
.chip.act {
  color: #c9e4ff;
  border-color: rgba(79, 157, 255, 0.45);
}
.hint {
  font-size: 10px;
  line-height: 1.5;
  color: #6f8298;
  padding-top: 3px;
  border-top: 1px dashed rgba(90, 110, 135, 0.3);
}

.info {
  position: absolute;
  right: 14px;
  bottom: 14px;
  width: 296px;
  padding: 12px 14px;
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(17, 24, 34, 0.95), rgba(11, 16, 22, 0.93));
  border: 1px solid rgba(79, 157, 255, 0.4);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
  z-index: 4;
}
.info-h {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 7px;
}
.info-h b {
  font-size: 13.5px;
  color: #eaf3fd;
  font-weight: 600;
}
.info-h i {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: 10px;
  letter-spacing: 0.6px;
  color: #5f9fd6;
  text-transform: uppercase;
}
.x {
  width: 20px;
  height: 20px;
  line-height: 1;
  font-size: 15px;
  color: #8ba0b6;
  background: transparent;
  border: 1px solid rgba(90, 110, 135, 0.4);
  border-radius: 6px;
  cursor: pointer;
}
.x:hover {
  color: #e8f2fc;
  border-color: rgba(120, 170, 220, 0.7);
}
.info p {
  margin: 0 0 8px;
  font-size: 11.5px;
  line-height: 1.7;
  color: #b3c3d5;
}
.spec {
  font-size: 10.5px;
  line-height: 1.6;
  color: #7fd0a2;
  padding-top: 7px;
  border-top: 1px dashed rgba(90, 110, 135, 0.35);
}

.hover {
  position: absolute;
  padding: 3px 8px;
  font-size: 11px;
  color: #dceaf8;
  background: rgba(12, 19, 27, 0.9);
  border: 1px solid rgba(79, 157, 255, 0.5);
  border-radius: 6px;
  pointer-events: none;
  white-space: nowrap;
  z-index: 6;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s, transform 0.18s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

:deep(.eng-label) {
  padding: 2px 7px;
  font-size: 10px;
  letter-spacing: 0.3px;
  color: #d6e7f8;
  background: rgba(10, 16, 23, 0.78);
  border: 1px solid rgba(79, 157, 255, 0.42);
  border-radius: 5px;
  white-space: nowrap;
  transition: opacity 0.2s;
  pointer-events: none;
}
</style>
