<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

/* ============================================================
 * 混凝土重力坝 · 5 孔弧形闸门 · 开闸放水
 *  - 坝体：按剖面 ExtrudeGeometry 沿坝轴挤出（重力坝三角形断面）
 *  - 闸门：圆心在铰链的圆弧面板，绕 X 轴旋转抬起（真实 tainter gate 运动）
 *  - 水流：沿 ogee 溢流面采样成条带 + 解析式粒子水花 + 坝趾雾化
 *  - 交互：Raycaster 点选单孔闸门，开度缓动到目标值
 * ============================================================ */

const CREST_Y = 10 // 坝顶高程
const WEIR_Y = 7.2 // 堰顶（溢流孔底）
const POOL_Y = 8.4 // 上游正常蓄水位
const TAIL_Y = 0.95 // 下游水位
const BED_Y = -4 // 河床
const SPILL_HALF = 10 // 溢流段半宽
const PIER_W = 0.667 // 闸墩厚
const BAY_W = 3.2 // 闸孔净宽
const GATE_N = 5
const GATE_R = 4.7 // 闸门面板半径
const PIVOT_Y = WEIR_Y + GATE_R // 铰链高程 11.9
const PIVOT_Z = -1.5 // 铰链在顺河向的位置
const A0 = -Math.PI / 2 // 面板下缘（正下方）
const A1 = -THREE.MathUtils.degToRad(20) // 面板上缘
const OPEN_ANGLE = 1.0 // 全开时的抬升角（≈57°）

/** 各闸孔中心 x（墩-孔交替排布，整体关于原点对称） */
const BAY_X = Array.from(
  { length: GATE_N },
  (_, k) => -SPILL_HALF + PIER_W + BAY_W / 2 + k * (BAY_W + PIER_W),
)

/* ---------------- 组件状态 ---------------- */
const container = ref<HTMLDivElement>()
const gateUI = ref(
  // 默认开中间三孔，视觉上才是「正在泄洪」而不是孤零零一股水
  Array.from({ length: GATE_N }, (_, i) => ({
    on: i >= 1 && i <= 3,
    ratio: i >= 1 && i <= 3 ? 1 : 0,
  })),
)
const flow = ref(0)
const hoverGate = ref(-1)

interface GateRig {
  group: THREE.Group
  panelMat: THREE.MeshStandardMaterial
  jet: THREE.Mesh
  wet: THREE.Mesh
  jetMat: THREE.ShaderMaterial
  spray: THREE.Points
  sprayMat: THREE.ShaderMaterial
  open: number
  target: number
}

let rigs: GateRig[] = []
let downPool: THREE.ShaderMaterial | null = null
let mistMat: THREE.ShaderMaterial | null = null
const cleanups: Array<() => void> = []

onBeforeUnmount(() => {
  cleanups.forEach((fn) => fn())
  cleanups.length = 0
  rigs = []
})

/* ============================================================
 * 几何工具
 * ============================================================ */

/** 把 (顺河向 z, 高程 y) 剖面沿坝轴挤出，并居中到 x ∈ [-width/2, width/2] */
function extrudeProfile(pts: Array<[number, number]>, width: number): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  shape.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1])
  shape.closePath()
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: false,
    curveSegments: 4,
  })
  geo.rotateY(-Math.PI / 2) // shape.x → world.z，挤出方向 → -x
  geo.translate(width / 2, 0, 0)
  geo.computeVertexNormals()
  return geo
}

/** 二次/三次贝塞尔采样成剖面点 */
function samplePts(curve: THREE.Curve<THREE.Vector2>, n: number): Array<[number, number]> {
  return curve.getPoints(n).map((p) => [p.x, p.y] as [number, number])
}

/** 弧形闸门面板：圆弧扫掠出的单层带面（圆心即铰链） */
function arcPanel(R: number, a0: number, a1: number, width: number, seg = 30) {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let i = 0; i <= seg; i++) {
    const t = i / seg
    const a = a0 + (a1 - a0) * t
    const z = Math.cos(a) * R
    const y = Math.sin(a) * R
    pos.push(-width / 2, y, z, width / 2, y, z)
    uv.push(0, t, 1, t)
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/** 两点之间的圆柱杆件（闸门支臂、栏杆立柱） */
function strut(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  mat: THREE.Material,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(to, from)
  const len = dir.length()
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 8), mat)
  mesh.position.copy(from).addScaledVector(dir, 0.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  return mesh
}

/* ============================================================
 * 水体着色器
 * ============================================================ */

const WATER_VERT = /* glsl */ `
uniform float uTime;
uniform float uAmp;
varying vec3 vWorld;
varying vec3 vNrm;

float waveH(vec2 p, float t) {
  // 三个长波定基调，再叠两个高频交叉波打散规则条纹，否则水面会像布纹
  return sin(p.x * 0.26 + t * 0.85) * 0.55
       + sin(p.y * 0.34 - t * 1.15) * 0.40
       + sin((p.x + p.y) * 0.17 + t * 0.55) * 0.32
       + sin(p.x * 0.83 - p.y * 0.61 + t * 1.7) * 0.15
       + sin(p.y * 2.1 + p.x * 0.47 - t * 2.4) * 0.07;
}

void main() {
  vec3 p = position;
  float h = waveH(p.xy, uTime) * uAmp;
  p.z += h;

  // 数值导数求扰动的法线（本地空间 +Z 为高度）
  float e = 0.35;
  float hx = waveH(p.xy + vec2(e, 0.0), uTime) * uAmp;
  float hy = waveH(p.xy + vec2(0.0, e), uTime) * uAmp;
  vec3 n = normalize(vec3(-(hx - h) / e, -(hy - h) / e, 1.0));
  // 平面绕 X 轴 -90°，local(x, y, z) → world(x, z, -y)
  vNrm = normalize(vec3(n.x, n.z, -n.y));

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform float uFoam;
uniform float uFoamZ;
uniform float uFoamRange;
uniform vec3 uSun;
uniform vec3 uDeep;
uniform vec3 uShallow;
varying vec3 vWorld;
varying vec3 vNrm;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec3 N = normalize(vNrm);
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSun);

  // 菲涅尔：掠射角反射天光，垂直俯视看到水色
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  vec3 col = mix(uDeep, uShallow, 0.45 + 0.25 * N.y);
  col = mix(col, vec3(0.46, 0.63, 0.82), fres * 0.72);

  // 太阳镜面高光
  vec3 H = normalize(L + V);
  col += vec3(1.0, 0.96, 0.86) * pow(max(dot(N, H), 0.0), 240.0) * 1.7;

  // 波纹明暗，让水面不至于死平
  col += (noise(vWorld.xz * 0.9 + uTime * 0.15) - 0.5) * 0.05;

  // 坝趾泡沫
  if (uFoam > 0.001) {
    float d = abs(vWorld.z - uFoamZ);
    float band = 1.0 - smoothstep(0.0, uFoamRange, d);
    float n1 = noise(vWorld.xz * 1.7 + vec2(uTime * 0.8, uTime * 0.5));
    float n2 = noise(vWorld.xz * 4.4 - vec2(uTime * 1.4, 0.0));
    float foam = band * (n1 * 0.62 + n2 * 0.46) * uFoam;
    col = mix(col, vec3(0.95, 0.98, 1.0), clamp(foam, 0.0, 1.0) * 0.9);
  }

  gl_FragColor = vec4(col, 1.0);
}
`

function makeWater(o: {
  deep: number
  shallow: number
  amp: number
  foamZ: number
  foamRange: number
}) {
  return new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uAmp: { value: o.amp },
      uFoam: { value: 0 },
      uFoamZ: { value: o.foamZ },
      uFoamRange: { value: o.foamRange },
      uSun: { value: new THREE.Vector3(0.5, 0.72, 0.48).normalize() },
      uDeep: { value: new THREE.Color(o.deep) },
      uShallow: { value: new THREE.Color(o.shallow) },
    },
    // 双面：从闸孔往里看也要能看到库水
    side: THREE.DoubleSide,
  })
}

/* ============================================================
 * 主场景
 * ============================================================ */

useThree(
  container,
  {
    fov: 40,
    near: 0.5,
    far: 20000,
    background: 0x0a1018,
    cameraPos: [30, 27, 67],
    lookAt: [1, 7, 6],
    controls: true,
    shadows: true,
  },
  ({ scene, camera, renderer, controls }) => {
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.6
    // 锁住平移与俯仰，避免把镜头拖进坝体或水面以下
    if (controls) {
      controls.enablePan = false
      controls.minDistance = 34
      controls.maxDistance = 190
      controls.maxPolarAngle = Math.PI * 0.487
      controls.minPolarAngle = Math.PI * 0.12
      controls.target.set(1, 7, 6)
    }
    scene.fog = new THREE.Fog(0xa9bccd, 110, 380)

    /* ---------- 光照 ---------- */
    const sunDir = new THREE.Vector3(42, 96, 54).normalize()
    scene.add(new THREE.HemisphereLight(0xc2d8f2, 0x3a4149, 1.15))

    const sun = new THREE.DirectionalLight(0xfff1da, 2.7)
    sun.position.copy(sunDir).multiplyScalar(150)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const sc = sun.shadow.camera as THREE.OrthographicCamera
    sc.left = -62
    sc.right = 62
    sc.top = 62
    sc.bottom = -62
    sc.near = 20
    sc.far = 320
    sc.updateProjectionMatrix()
    sun.shadow.bias = -0.0006
    sun.shadow.normalBias = 0.09
    scene.add(sun)

    /* ---------- 天穹 ---------- */
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uSun: { value: sunDir.clone() } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSun;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -1.0, 1.0);
          vec3 horizon = vec3(0.66, 0.74, 0.83);
          vec3 mid = vec3(0.31, 0.51, 0.78);
          vec3 top = vec3(0.06, 0.15, 0.33);
          vec3 col = mix(horizon, mid, smoothstep(0.0, 0.34, h));
          col = mix(col, top, smoothstep(0.3, 0.92, h));
          float s = max(dot(d, normalize(uSun)), 0.0);
          col += vec3(1.0, 0.94, 0.82) * pow(s, 320.0) * 2.0;
          col += vec3(1.0, 0.9, 0.74) * pow(s, 9.0) * 0.14;
          col = mix(vec3(0.70, 0.76, 0.83), col, smoothstep(-0.09, 0.12, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    })
    const sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 36, 24), skyMat)
    sky.frustumCulled = false
    scene.add(sky)

    /* ---------- 河谷地形 ---------- */
    function terrainHeight(x: number, z: number) {
      const bedHalf = z < 0 ? 19 : 31
      const wall = THREE.MathUtils.smoothstep(Math.abs(x), bedHalf, bedHalf + 40)
      const ridge =
        Math.sin(x * 0.11 + 1.3) * Math.cos(z * 0.075) * 5.6 +
        Math.sin(x * 0.27 - z * 0.16) * 2.1 +
        Math.sin(x * 0.63 + z * 0.41) * 0.85 +
        Math.sin(x * 1.17 - z * 0.93) * 0.34
      return BED_Y + wall * 34 + ridge * (0.12 + wall * 0.9)
    }

    const terrGeo = new THREE.PlaneGeometry(360, 320, 170, 152)
    terrGeo.rotateX(-Math.PI / 2)
    const tp = terrGeo.attributes.position as THREE.BufferAttribute
    const tCol = new Float32Array(tp.count * 3)
    const cBed = new THREE.Color(0x6a6350)
    const cRock = new THREE.Color(0x8b9096)
    const cVeg = new THREE.Color(0x3f5a36)
    const cTop = new THREE.Color(0xc6d1d8)
    const tmpC = new THREE.Color()
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i)
      const z = tp.getZ(i)
      const y = terrainHeight(x, z)
      tp.setY(i, y)
      const t = THREE.MathUtils.clamp((y - BED_Y) / 42, 0, 1)
      tmpC.copy(cBed)
      tmpC.lerp(cRock, THREE.MathUtils.smoothstep(t, 0.08, 0.42))
      tmpC.lerp(cVeg, THREE.MathUtils.smoothstep(t, 0.5, 0.88))
      tmpC.lerp(cTop, THREE.MathUtils.smoothstep(t, 0.94, 1.0))
      // 坡面斑驳：高频噪声扰动明度与色相，避免一大片纯色渐变的塑料感
      const mott =
        Math.sin(x * 0.83 + z * 0.41) * Math.cos(x * 0.37 - z * 0.62) * 0.55 +
        Math.sin(x * 2.1 + z * 1.7) * 0.28 +
        Math.sin(x * 0.13 - z * 0.09) * 0.45
      tmpC.offsetHSL(mott * 0.012, mott * 0.05, mott * 0.055)
      tCol[i * 3] = tmpC.r
      tCol[i * 3 + 1] = tmpC.g
      tCol[i * 3 + 2] = tmpC.b
    }
    terrGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3))
    terrGeo.computeVertexNormals()
    const terrain = new THREE.Mesh(
      terrGeo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.96,
        metalness: 0.02,
      }),
    )
    terrain.receiveShadow = true
    scene.add(terrain)

    /* ---------- 水面 ---------- */
    const upWaterMat = makeWater({
      deep: 0x0a2740,
      shallow: 0x1c6a83,
      amp: 0.5,
      foamZ: -1.0,
      foamRange: 5,
    })
    // 后沿铺到地形边缘，前沿只压进坝体 0.8m；再往前就会从坝面穿出来
    // 必须细分，否则顶点波动只作用在 4 个角上，水面就是个斜面
    const upWater = new THREE.Mesh(new THREE.PlaneGeometry(112, 150, 132, 176), upWaterMat)
    upWater.rotation.x = -Math.PI / 2
    upWater.position.set(0, POOL_Y, -75.4)
    scene.add(upWater)

    downPool = makeWater({
      deep: 0x0b2c3a,
      shallow: 0x2f7d7c,
      amp: 0.34,
      foamZ: 11.0,
      foamRange: 10.5,
    })
    const downWater = new THREE.Mesh(new THREE.PlaneGeometry(124, 116, 150, 140), downPool)
    downWater.rotation.x = -Math.PI / 2
    downWater.position.set(0, TAIL_Y, 62)
    scene.add(downWater)

    /* ---------- 坝体 ---------- */
    /** 混凝土纹理：细骨料噪点 + 纵向分缝 + 水平施工缝 + 底部水渍 */
    function concreteTexture(): THREE.CanvasTexture {
      const S = 512
      const cv = document.createElement('canvas')
      cv.width = cv.height = S
      const g = cv.getContext('2d')!
      g.fillStyle = '#a2a8ae'
      g.fillRect(0, 0, S, S)
      for (let i = 0; i < 12000; i++) {
        const v = Math.random()
        g.fillStyle = `rgba(${120 + v * 80 | 0},${126 + v * 80 | 0},${132 + v * 80 | 0},0.22)`
        g.fillRect(Math.random() * S, Math.random() * S, 2, 2)
      }
      // 纵向分缝（每 1/4 条）
      g.strokeStyle = 'rgba(78,84,90,0.55)'
      g.lineWidth = 2
      for (let i = 0; i <= 4; i++) {
        const x = (i * S) / 4
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, S)
        g.stroke()
      }
      // 水平施工缝
      g.strokeStyle = 'rgba(88,94,100,0.4)'
      g.lineWidth = 1.5
      for (let i = 0; i <= 3; i++) {
        const y = (i * S) / 3
        g.beginPath()
        g.moveTo(0, y)
        g.lineTo(S, y)
        g.stroke()
      }
      // 模板板缝（竖向细线）
      g.strokeStyle = 'rgba(96,102,108,0.22)'
      g.lineWidth = 1
      for (let i = 0; i < 16; i++) {
        const x = 8 + (i * S) / 16
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, S)
        g.stroke()
      }
      // 底部水渍
      const damp = g.createLinearGradient(0, S * 0.55, 0, S)
      damp.addColorStop(0, 'rgba(70,84,88,0)')
      damp.addColorStop(1, 'rgba(64,78,82,0.32)')
      g.fillStyle = damp
      g.fillRect(0, S * 0.55, S, S * 0.45)
      const t = new THREE.CanvasTexture(cv)
      t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      // ExtrudeGeometry 的 UV 以「米」为单位，1/14 表示 14m 一个循环
      t.repeat.set(1 / 14, 1 / 14)
      t.anisotropy = 4
      return t
    }
    const concreteTex = concreteTexture()

    const concrete = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: concreteTex,
      roughness: 0.94,
      metalness: 0.03,
    })
    const concreteWet = new THREE.MeshStandardMaterial({
      map: concreteTex,
      color: 0xb7bcc2,
      roughness: 0.7,
      metalness: 0.06,
    })
    // 无环境贴图时 metalness 过高会整片发黑，这里用「半金属」近似
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0xb3c0cd,
      roughness: 0.42,
      metalness: 0.35,
    })

    // 非溢流坝段（重力坝三角断面）
    const solidPts: Array<[number, number]> = [
      [-1.2, BED_Y],
      [-1.2, CREST_Y],
      [2.4, CREST_Y],
      [8.4, BED_Y],
    ]
    // 两端伸到 ±38，插进岸坡（该处地形高程约 11m > 库水位 8.4m），把库水封在坝内
    for (const cx of [-24, 24]) {
      const seg = new THREE.Mesh(extrudeProfile(solidPts, 28), concrete)
      seg.position.x = cx
      seg.castShadow = true
      seg.receiveShadow = true
      scene.add(seg)
    }

    // 溢流坝段：堰顶 + ogee 曲线下泄面
    const ogee = new THREE.CubicBezierCurve(
      new THREE.Vector2(-0.2, WEIR_Y),
      new THREE.Vector2(2.6, WEIR_Y - 0.08),
      new THREE.Vector2(3.8, 4.0),
      new THREE.Vector2(8.4, -0.5),
    )
    const spillPts: Array<[number, number]> = [
      [-1.2, BED_Y],
      [-1.2, WEIR_Y],
      [-0.2, WEIR_Y],
      ...samplePts(ogee, 20).slice(1),
      [8.4, BED_Y],
    ]
    const spill = new THREE.Mesh(extrudeProfile(spillPts, 20), concreteWet)
    spill.castShadow = true
    spill.receiveShadow = true
    scene.add(spill)

    // 闸墩：6 道，把 5 个闸孔夹在中间
    for (let k = 0; k <= GATE_N; k++) {
      const px = -SPILL_HALF + PIER_W / 2 + k * (BAY_W + PIER_W)
      const pier = new THREE.Mesh(new THREE.BoxGeometry(PIER_W, 5.2, 5.8), concrete)
      pier.position.set(px, WEIR_Y + 2.6, 0.4)
      pier.castShadow = true
      pier.receiveShadow = true
      scene.add(pier)

      // 墩顶机架
      const cap = new THREE.Mesh(new THREE.BoxGeometry(PIER_W + 0.2, 0.3, 6.0), concrete)
      cap.position.set(px, WEIR_Y + 5.32, 0.4)
      cap.castShadow = true
      scene.add(cap)
    }

    // 坝顶公路（非溢流段）
    for (const cx of [-24, 24]) {
      const road = new THREE.Mesh(new THREE.BoxGeometry(28, 0.5, 4.2), concrete)
      road.position.set(cx, CREST_Y + 0.25, 0.6)
      road.castShadow = true
      road.receiveShadow = true
      scene.add(road)

      // 栏杆：上下横杆 + 立柱
      for (const zz of [-1.4, 2.6]) {
        for (const yy of [0.95, 1.45]) {
          const rail = new THREE.Mesh(new THREE.BoxGeometry(28, 0.07, 0.07), steelMat)
          rail.position.set(cx, CREST_Y + yy, zz)
          scene.add(rail)
        }
        for (let i = 0; i <= 22; i++) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.2, 0.06), steelMat)
          post.position.set(cx - 13.6 + i * 1.24, CREST_Y + 0.6, zz)
          scene.add(post)
        }
      }
    }

    // 闸室上方机架桥（跨越 6 道闸墩）
    const deck = new THREE.Mesh(new THREE.BoxGeometry(20.4, 0.4, 1.5), concrete)
    deck.position.set(0, WEIR_Y + 5.5, -1.5)
    deck.castShadow = true
    scene.add(deck)
    for (const zz of [-2.15, -0.85]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(20.4, 0.06, 0.06), steelMat)
      rail.position.set(0, WEIR_Y + 6.4, zz)
      scene.add(rail)
    }

    // 下游护坦（消力池底板）
    const apron = new THREE.Mesh(new THREE.BoxGeometry(20, 0.5, 12), concreteWet)
    apron.position.set(0, 0.05, 14)
    apron.receiveShadow = true
    scene.add(apron)

    /* ---------- 弧形闸门 ---------- */
    const jetVert = /* glsl */ `
      uniform float uOpen;
      uniform float uCenterX;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position;
        // 开度小时水舌收窄
        p.x = uCenterX + (p.x - uCenterX) * mix(0.42, 1.0, uOpen);
        // 整体抬离溢流面 0.14（否则曲线中段会沉进坝体被整段吞掉），再叠一个中部鼓起
        p.y += (0.14 + sin(vUv.x * 3.14159) * (0.2 + 0.18 * vUv.y)) * uOpen;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`

    const jetFrag = /* glsl */ `
      uniform float uTime;
      uniform float uOpen;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        // 三层湍流：粗涡 → 细丝 → 白沫，纵向随时间向下滚动
        // 横向高频 + 纵向低频 = 沿流向拉长的水丝（反过来就会变成百叶窗式的横纹）
        float s1 = noise(vec2(vUv.x * 56.0, vUv.y * 1.6 - uTime * 1.15));
        float s2 = noise(vec2(vUv.x * 132.0, vUv.y * 3.4 - uTime * 2.1));
        float s3 = noise(vec2(vUv.x * 9.0, vUv.y * 5.0 - uTime * 1.7));
        float streak = s3 * 0.34 + s1 * 0.46 + s2 * 0.2;

        // 沿水流方向拉长的白沫斑块
        float foamN = noise(vec2(vUv.x * 34.0, vUv.y * 2.2 - uTime * 0.9));
        float foam = smoothstep(0.5, 0.86, foamN * 0.6 + s2 * 0.4);

        // 两侧羽化 + 出口柔化 + 末端渐隐
        float edge = smoothstep(0.0, 0.17, vUv.x) * smoothstep(1.0, 0.83, vUv.x);
        float head = smoothstep(0.0, 0.035, vUv.y);
        float tail = smoothstep(1.0, 0.9, vUv.y);

        // 坝趾附近水跃炸开 → 更白更亮
        float jump = smoothstep(0.52, 0.9, vUv.y);
        float a = edge * head * tail *
          (0.2 + 0.52 * streak + jump * 0.44 + foam * (0.32 + jump * 0.42)) * mix(0.06, 1.0, uOpen);

        vec3 col = mix(vec3(0.58, 0.80, 0.93), vec3(1.0), clamp(streak * 0.55 + foam * 0.8 + jump * 0.4, 0.0, 1.0));
        // 中间凸面受光、两侧折向侧面变暗，再给边缘一道薄水膜高光
        float shade = 0.9 + 0.1 * sin(vUv.x * 3.14159);
        float rim = smoothstep(0.14, 0.0, vUv.x) + smoothstep(0.86, 1.0, vUv.x);
        col = col * shade + vec3(0.22, 0.3, 0.34) * rim * 0.5;
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * 0.88);
      }`

    const sprayVert = /* glsl */ `
      attribute vec3 aSeed;
      attribute vec3 aOrigin;
      uniform float uTime;
      uniform float uOpen;
      uniform float uProj;
      uniform float uFloor;
      varying float vAlpha;
      void main() {
        float life = 1.05 + aSeed.x * 0.85;
        float t = fract(uTime / life + aSeed.y);
        float tt = t * life;
        // 初速：向上为主 + 向两侧散开 + 向下游抛
        vec3 v0 = vec3((aSeed.z - 0.5) * 4.6, 3.0 + aSeed.x * 4.4, 0.7 + aSeed.y * 2.6);
        vec3 p = aOrigin + v0 * tt + vec3(0.0, -4.9, 0.0) * tt * tt;
        p.y = max(p.y, uFloor);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = (0.13 + aSeed.z * 0.24) * (1.0 - t * 0.42);
        gl_PointSize = size * uProj / max(1.0, -mv.z);
        vAlpha = (1.0 - t) * uOpen;
      }`

    const sprayFrag = /* glsl */ `
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float a = (1.0 - r * 2.0) * vAlpha * 0.8;
        gl_FragColor = vec4(vec3(0.93, 0.97, 1.0), a);
      }`

    /** 沿溢流面到落水点的水舌轨迹 */
    function jetCurve(xk: number) {
      // 采样点贴着 ogee 曲线（(z,y)：0.82→7.01 / 2.02→6.35 / 3.43→5.01 / 5.04→3.13 / 7.12→0.81）
      // 每个点上抬 0.18 左右，保证水带浮在溢流面外侧而不是被坝体吞掉
      // 沿 ogee 面外侧 0.3~0.4m 走，压得太低会被坝体整段吞掉（只在下游露出一小块白斑）
      return new THREE.CatmullRomCurve3([
        new THREE.Vector3(xk, WEIR_Y + 0.55, -1.15),
        new THREE.Vector3(xk, 7.13, 0.74),
        new THREE.Vector3(xk, 6.47, 1.95),
        new THREE.Vector3(xk, 5.17, 3.36),
        new THREE.Vector3(xk, 3.31, 4.96),
        new THREE.Vector3(xk, 1.94, 6.6),
        new THREE.Vector3(xk, 1.06, 8.9),
        new THREE.Vector3(xk, TAIL_Y - 0.18, 12.8),
      ])
    }

    /**
     * 把轨迹采样成一条水带。
     * 横向必须细分（cols≥8）：只有左右两列顶点时，shader 里的边缘羽化和截面鼓起
     * 都挤在一个像素里，会出现锯齿状硬边，水面也是平的。
     */
    const JET_COLS = 10
    function jetGeometry(curve: THREE.CatmullRomCurve3, seg: number, width: number) {
      const pos: number[] = []
      const uv: number[] = []
      const idx: number[] = []
      for (let i = 0; i <= seg; i++) {
        const t = i / seg
        const p = curve.getPointAt(t)
        const w = width * (0.98 + 0.3 * t) // 越往下游略摊开（水跃扩散）
        for (let k = 0; k <= JET_COLS; k++) {
          const u = k / JET_COLS
          pos.push(p.x - w / 2 + w * u, p.y, p.z)
          uv.push(u, t)
        }
      }
      const stride = JET_COLS + 1
      for (let i = 0; i < seg; i++) {
        for (let k = 0; k < JET_COLS; k++) {
          const a = i * stride + k
          const b = a + stride
          idx.push(a, b, a + 1, a + 1, b, b + 1)
        }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
      g.setIndex(idx)
      g.computeVertexNormals()
      return g
    }

    const SPRAY_N = 420

    BAY_X.forEach((xk, k) => {
      const group = new THREE.Group()
      group.position.set(xk, PIVOT_Y, PIVOT_Z)
      group.userData.gateIndex = k

      // 面板（双面，内外都能看到）
      const panelMat = new THREE.MeshStandardMaterial({
        color: 0xc2cedb,
        roughness: 0.46,
        metalness: 0.22,
        emissive: 0x1a222c,
        side: THREE.DoubleSide,
      })
      const panel = new THREE.Mesh(arcPanel(GATE_R, A0, A1, BAY_W), panelMat)
      panel.castShadow = true
      // 单层曲面壳开 receiveShadow 会被自己的阴影贴图判定为全遮挡（发黑），只投影不接收
      panel.receiveShadow = false
      group.add(panel)

      // 沿弧面的加劲肋
      for (let i = 0; i <= 4; i++) {
        const a = A0 + (A1 - A0) * (i / 4)
        const rib = new THREE.Mesh(new THREE.BoxGeometry(BAY_W - 0.1, 0.09, 0.14), steelMat)
        rib.position.set(0, Math.sin(a) * (GATE_R - 0.12), Math.cos(a) * (GATE_R - 0.12))
        rib.rotation.x = a + Math.PI / 2
        group.add(rib)
      }
      // 顶部横梁
      const beam = new THREE.Mesh(new THREE.BoxGeometry(BAY_W + 0.06, 0.22, 0.22), steelMat)
      beam.position.set(0, Math.sin(A1) * (GATE_R - 0.2), Math.cos(A1) * (GATE_R - 0.2))
      group.add(beam)

      // 支臂：从铰链指向面板
      for (const sx of [-1, 0, 1]) {
        const a = A0 + (A1 - A0) * 0.62
        const tip = new THREE.Vector3(
          (sx * (BAY_W / 2 - 0.25)) * 0.9,
          Math.sin(a) * (GATE_R - 0.2),
          Math.cos(a) * (GATE_R - 0.2),
        )
        const arm = strut(new THREE.Vector3(sx * 0.34, 0.12, 0), tip, 0.075, steelMat)
        arm.castShadow = true
        group.add(arm)
      }

      // 铰支座
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, BAY_W * 0.82, 12), steelMat)
      hub.rotation.z = Math.PI / 2
      group.add(hub)

      group.rotation.x = 0
      scene.add(group)

      // 水舌
      const curve = jetCurve(xk)
      const jetMat = new THREE.ShaderMaterial({
        vertexShader: jetVert,
        fragmentShader: jetFrag,
        uniforms: {
          uTime: { value: 0 },
          uOpen: { value: 0 },
          uCenterX: { value: xk },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const jet = new THREE.Mesh(jetGeometry(curve, 50, BAY_W * 0.96), jetMat)
      jet.renderOrder = 3
      jet.visible = false
      scene.add(jet)

      // 溢流面上的湿痕：比水舌更宽、贴着坝面，让水流看起来是「贴」上去的
      const wetMat = new THREE.MeshStandardMaterial({
        color: 0x5a646e,
        roughness: 0.28,
        metalness: 0.12,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
      const wetCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(xk, WEIR_Y + 0.55, -1.15),
        new THREE.Vector3(xk, 7.0, 0.74),
        new THREE.Vector3(xk, 6.34, 1.95),
        new THREE.Vector3(xk, 5.04, 3.36),
        new THREE.Vector3(xk, 3.18, 4.96),
        new THREE.Vector3(xk, 1.82, 6.6),
      ])
      const wetGeo = jetGeometry(wetCurve, 36, BAY_W * 1.07)
      const wet = new THREE.Mesh(wetGeo, wetMat)
      wet.renderOrder = 2
      wet.visible = false
      scene.add(wet)

      // 水花粒子
      const sPos = new Float32Array(SPRAY_N * 3)
      const sSeed = new Float32Array(SPRAY_N * 3)
      const sOrigin = new Float32Array(SPRAY_N * 3)
      for (let i = 0; i < SPRAY_N; i++) {
        sPos[i * 3] = xk
        sPos[i * 3 + 1] = TAIL_Y
        sPos[i * 3 + 2] = 9
        sSeed[i * 3] = Math.random()
        sSeed[i * 3 + 1] = Math.random()
        sSeed[i * 3 + 2] = Math.random()
        sOrigin[i * 3] = xk + (Math.random() - 0.5) * BAY_W * 1.2
        sOrigin[i * 3 + 1] = TAIL_Y + 0.05
        sOrigin[i * 3 + 2] = 10.2 + (Math.random() - 0.5) * 2.4
      }
      const sprayGeo = new THREE.BufferGeometry()
      sprayGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3))
      sprayGeo.setAttribute('aSeed', new THREE.BufferAttribute(sSeed, 3))
      sprayGeo.setAttribute('aOrigin', new THREE.BufferAttribute(sOrigin, 3))
      const sprayMat = new THREE.ShaderMaterial({
        vertexShader: sprayVert,
        fragmentShader: sprayFrag,
        uniforms: {
          uTime: { value: 0 },
          uOpen: { value: 0 },
          uProj: { value: 900 },
          uFloor: { value: TAIL_Y - 0.1 },
        },
        transparent: true,
        depthWrite: false,
      })
      const spray = new THREE.Points(sprayGeo, sprayMat)
      spray.frustumCulled = false
      spray.renderOrder = 3
      spray.visible = false
      scene.add(spray)

      const rig: GateRig = {
        group,
        panelMat,
        jet,
        wet,
        jetMat,
        spray,
        sprayMat,
        open: k >= 1 && k <= 3 ? 1 : 0,
        target: k >= 1 && k <= 3 ? 1 : 0,
      }
      if (rig.open > 0) {
        group.rotation.x = rig.open * OPEN_ANGLE
        jet.visible = true
        wet.visible = true
        spray.visible = true
        jetMat.uniforms.uOpen.value = rig.open
        sprayMat.uniforms.uOpen.value = rig.open
      }
      rigs.push(rig)
    })

    /* ---------- 坝趾雾化 ---------- */
    const MIST_N = 240
    const mPos = new Float32Array(MIST_N * 3)
    const mSeed = new Float32Array(MIST_N * 3)
    for (let i = 0; i < MIST_N; i++) {
      mSeed[i * 3] = Math.random()
      mSeed[i * 3 + 1] = Math.random()
      mSeed[i * 3 + 2] = Math.random()
      mPos[i * 3] = (Math.random() - 0.5) * 22
      mPos[i * 3 + 1] = TAIL_Y
      mPos[i * 3 + 2] = 8 + Math.random() * 10
    }
    const mistGeo = new THREE.BufferGeometry()
    mistGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3))
    mistGeo.setAttribute('aSeed', new THREE.BufferAttribute(mSeed, 3))
    mistMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        uniform float uTime;
        uniform float uOpen;
        uniform float uProj;
        uniform float uFloor;
        varying float vAlpha;
        void main() {
          float t = fract(uTime * (0.13 + aSeed.x * 0.08) + aSeed.y);
          vec3 p = vec3(
            aSeed.z * 24.0 - 12.0 + sin(uTime * 0.45 + aSeed.y * 6.28) * 1.6,
            uFloor + 0.3 + t * 8.5,
            7.0 + aSeed.x * 9.0 + t * 3.5
          );
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (0.6 + aSeed.z * 1.1) * uProj / max(1.0, -mv.z);
          vAlpha = sin(t * 3.14159) * 0.34 * uOpen;
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          if (r > 0.5) discard;
          float a = pow(1.0 - r * 2.0, 2.0) * vAlpha;
          gl_FragColor = vec4(vec3(0.88, 0.94, 1.0), a);
        }`,
      uniforms: {
        uTime: { value: 0 },
        uOpen: { value: 0.5 },
        uProj: { value: 900 },
        uFloor: { value: TAIL_Y },
      },
      transparent: true,
      depthWrite: false,
    })
    const mist = new THREE.Points(mistGeo, mistMat)
    mist.frustumCulled = false
    mist.renderOrder = 4
    scene.add(mist)

    /* ---------- 交互：点选闸门 ---------- */
    const canvas = renderer.domElement
    const ray = new THREE.Raycaster()
    const gateGroups = rigs.map((r) => r.group)
    let downX = 0
    let downY = 0
    let downT = 0

    const toNdc = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
    }

    const pickGate = (e: PointerEvent): number => {
      ray.setFromCamera(toNdc(e), camera)
      const hits = ray.intersectObjects(gateGroups, true)
      if (!hits.length) return -1
      let o: THREE.Object3D | null = hits[0].object
      while (o && typeof o.userData.gateIndex !== 'number') o = o.parent
      return o ? (o.userData.gateIndex as number) : -1
    }

    const onDown = (e: PointerEvent) => {
      downX = e.clientX
      downY = e.clientY
      downT = performance.now()
    }
    const onUp = (e: PointerEvent) => {
      // 拖拽旋转视角时不触发点击
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return
      if (performance.now() - downT > 900) return
      const idx = pickGate(e)
      if (idx >= 0) toggleGate(idx)
    }

    let lastHover = performance.now()
    const onMove = (e: PointerEvent) => {
      const now = performance.now()
      if (now - lastHover < 60) return
      lastHover = now
      const idx = pickGate(e)
      if (idx === hoverGate.value) return
      hoverGate.value = idx
      canvas.style.cursor = idx >= 0 ? 'pointer' : ''
      rigs.forEach((r, i) => {
        r.panelMat.emissive.setHex(i === idx ? 0x1d3f66 : 0x000000)
      })
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    cleanups.push(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      canvas.style.cursor = ''
    })

    /* ---------- 每帧更新 ---------- */
    let t = 0
    let uiAcc = 0

    return (dt) => {
      const d = Math.min(dt, 0.05)
      t += d

      const projScale =
        (canvas.height || 900) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))

      let sumOpen = 0
      for (const r of rigs) {
        sumOpen += r.open
        if (r.open !== r.target) {
          r.open += (r.target - r.open) * Math.min(1, d * 3.2)
          if (Math.abs(r.target - r.open) < 0.004) r.open = r.target

          r.group.rotation.x = r.open * OPEN_ANGLE
          r.jetMat.uniforms.uOpen.value = r.open
          r.sprayMat.uniforms.uOpen.value = r.open
          r.jet.visible = r.open > 0.03
        r.wet.visible = r.open > 0.03
          r.spray.visible = r.open > 0.03
        }
        r.jetMat.uniforms.uTime.value = t
        r.sprayMat.uniforms.uTime.value = t
        r.sprayMat.uniforms.uProj.value = projScale
      }

      const avgOpen = sumOpen / GATE_N
      upWaterMat.uniforms.uTime.value = t
      if (downPool) {
        downPool.uniforms.uTime.value = t
        downPool.uniforms.uAmp.value = 0.13 + avgOpen * 0.22
        downPool.uniforms.uFoam.value = Math.min(0.8, avgOpen * 1.05)
      }
      if (mistMat) {
        mistMat.uniforms.uTime.value = t
        mistMat.uniforms.uOpen.value = 0.1 + avgOpen * 0.5
        mistMat.uniforms.uProj.value = projScale
      }

      uiAcc += d
      if (uiAcc > 0.1) {
        uiAcc = 0
        for (let i = 0; i < GATE_N; i++) {
          const r = rigs[i]
          const item = gateUI.value[i]
          if (!r || !item) continue
          const on = r.target > 0.5
          if (item.on !== on) item.on = on
          const q = Math.round(r.open * 20) / 20
          if (Math.abs(item.ratio - q) > 0.04) item.ratio = q
        }
        const q = Math.round((sumOpen * 340) / 10) * 10
        if (flow.value !== q) flow.value = q
      }
    }
  },
)

/* ============================================================
 * UI 操作
 * ============================================================ */
function toggleGate(i: number) {
  const rig = rigs[i]
  if (!rig) return
  rig.target = rig.target > 0.5 ? 0 : 1
  const item = gateUI.value[i]
  if (item) item.on = rig.target > 0.5
}

function setAll(on: boolean) {
  rigs.forEach((r, i) => {
    r.target = on ? 1 : 0
    const item = gateUI.value[i]
    if (item) item.on = on
  })
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>

    <div class="panel">
      <div class="title">混凝土重力坝 · 5 孔弧形闸门</div>
      <div class="sub">点击坝上任意闸门即可开合</div>

      <div class="gates">
        <button
          v-for="(g, i) in gateUI"
          :key="i"
          class="gate"
          :class="{ on: g.on, hover: hoverGate === i }"
          @click="toggleGate(i)"
        >
          <span class="no">{{ i + 1 }}#</span>
          <span class="st">{{ g.on ? '开启' : '关闭' }}</span>
          <span class="bar"><i :style="{ width: g.ratio * 100 + '%' }"></i></span>
        </button>
      </div>

      <div class="row">
        <button class="btn primary" @click="setAll(true)">全部开闸</button>
        <button class="btn" @click="setAll(false)">全部关闭</button>
      </div>

      <div class="stat">
        <span class="k">下泄流量</span>
        <b>{{ flow }}</b>
        <span class="u">m³/s</span>
        <span class="k" style="margin-left: 12px">上游水位</span>
        <b>{{ (8.4).toFixed(1) }}</b>
        <span class="u">m</span>
      </div>

      <div class="tip">
        弧形闸门绕铰链绕 X 轴旋转抬起，水流沿 ogee 溢流面下泄；水舌用弧长采样条带，
        水花与雾化为解析式粒子，坝趾泡沫随开度增强。
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
  width: 316px;
  padding: 11px 13px 12px;
  border-radius: 11px;
  background: rgba(14, 20, 28, 0.84);
  border: 1px solid rgba(88, 108, 132, 0.42);
  color: #d7e2ee;
  backdrop-filter: blur(9px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e8f0f8;
  letter-spacing: 0.2px;
}
.sub {
  margin-top: 3px;
  font-size: 11px;
  color: #7d8fa2;
}
.gates {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 10px;
}
.gate {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 7px 8px 8px;
  border-radius: 8px;
  border: 1px solid rgba(96, 116, 140, 0.4);
  background: rgba(26, 35, 46, 0.86);
  color: #93a5b8;
  cursor: pointer;
  transition: border-color 0.16s, background 0.16s, transform 0.12s;
}
.gate:hover {
  border-color: rgba(120, 165, 220, 0.7);
  transform: translateY(-1px);
}
.gate.hover {
  border-color: #4f9dff;
}
.gate.on {
  background: rgba(19, 46, 38, 0.9);
  border-color: rgba(72, 190, 130, 0.65);
  color: #b8f0d4;
}
.no {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
}
.st {
  font-size: 10.5px;
  opacity: 0.85;
}
.gate.on .st {
  color: #7ee787;
}
.bar {
  display: block;
  width: 100%;
  height: 3px;
  margin-top: 2px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #4f9dff, #7ee787);
  transition: width 0.16s linear;
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
.btn:hover {
  border-color: rgba(120, 165, 220, 0.75);
  color: #e6f0fa;
}
.btn.primary {
  background: linear-gradient(180deg, rgba(38, 92, 160, 0.95), rgba(28, 66, 118, 0.95));
  border-color: rgba(96, 158, 226, 0.7);
  color: #eaf4ff;
}
.btn.primary:hover {
  background: linear-gradient(180deg, rgba(48, 108, 184, 0.95), rgba(34, 78, 136, 0.95));
}
.stat {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid rgba(88, 108, 132, 0.28);
  font-size: 11.5px;
}
.stat b {
  font-size: 15px;
  color: #7ee787;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.stat .u {
  font-size: 10.5px;
  color: #7d8fa2;
}
.stat .k {
  color: #93a5b8;
}
.tip {
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.55;
  color: #7d8fa2;
}
</style>
