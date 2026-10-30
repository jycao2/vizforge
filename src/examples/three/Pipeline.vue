<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { useThree } from './useThree'

/* ============================================================
 * 长输管道 · 管道数字孪生
 *  - 地形：PlaneGeometry 顶点位移（三角函数叠加），管线随地形起伏
 *  - 主管道：CatmullRomCurve3 + TubeGeometry；内层「流体」用 ShaderMaterial
 *    沿 uv.x 做条纹流动，泄漏点/清管器位置直接写进 uniform 做局部染色
 *  - 法兰/管墩用 InstancedMesh 沿弧长均匀布设，姿态由曲线切向决定
 *  - 清管器（pig）按弧长推进；泄漏时粒子喷射 + 地面波纹 + 压力/流量联动
 * ============================================================ */

const container = ref<HTMLDivElement>()
const running = ref(true)
const flowSpeed = ref(1.0)
const shellOpacity = ref(0.95)
const valveOpen = ref(80)
const pigRunning = ref(false)
const followPig = ref(false)
const showLabels = ref(true)

const stats = reactive({
  flow: 420,
  pressure: 1.62,
  temp: 23.4,
  pig: 0,
  leak: false,
})

/** 由场景内部赋值的控制函数 */
let leakFn: (() => void) | null = null
let pigFn: ((on: boolean) => void) | null = null
function injectLeak() {
  leakFn?.()
}
function togglePig() {
  pigRunning.value = !pigRunning.value
  pigFn?.(pigRunning.value)
}

useThree(
  container,
  ({
    background: 0x0a1018,
    cameraPos: [26, 44, 74],
    lookAt: [0, 0, 0],
    controls: true,
    shadows: true,
  }),
  ({ scene, camera, renderer, controls }) => {
    scene.fog = new THREE.Fog(0x0a1018, 110, 260)
    scene.add(new THREE.HemisphereLight(0xbcd4f0, 0x0c1210, 0.85))
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.7)
    sun.position.set(35, 45, 20)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 10
    sun.shadow.camera.far = 160
    sun.shadow.camera.left = -70
    sun.shadow.camera.right = 70
    sun.shadow.camera.top = 60
    sun.shadow.camera.bottom = -60
    sun.shadow.bias = -0.0008
    scene.add(sun)

    /* ---------------- 地形 ---------------- */
    const TERRAIN_W = 130
    const TERRAIN_D = 80
    function terrainH(x: number, z: number) {
      return (
        1.5 * Math.sin(x * 0.06) * Math.cos(z * 0.05) +
        0.7 * Math.sin(x * 0.13 + 1.7) * Math.sin(z * 0.09 + 0.6) +
        0.3 * Math.sin(x * 0.31 + z * 0.23)
      )
    }
    const tGeo = new THREE.PlaneGeometry(TERRAIN_W, TERRAIN_D, 110, 68)
    tGeo.rotateX(-Math.PI / 2)
    const tPos = tGeo.getAttribute('position') as THREE.BufferAttribute
    const colors = new Float32Array(tPos.count * 3)
    const cLow = new THREE.Color(0x33502f)
    const cHigh = new THREE.Color(0x51683f)
    for (let i = 0; i < tPos.count; i++) {
      const x = tPos.getX(i)
      const z = tPos.getZ(i)
      const h = terrainH(x, z)
      tPos.setY(i, h)
      const c = cLow.clone().lerp(cHigh, THREE.MathUtils.clamp((h + 2) / 5, 0, 1))
      colors[i * 3] = c.r
      colors[i * 3 + 1] = c.g
      colors[i * 3 + 2] = c.b
    }
    tGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    tGeo.computeVertexNormals()
    const terrain = new THREE.Mesh(
      tGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
    )
    terrain.receiveShadow = true
    scene.add(terrain)

    /* ---------------- 管线路由（贴地起伏） ---------------- */
    const waypoints: THREE.Vector3[] = [
      [-52, -14],
      [-30, -18],
      [-8, -6],
      [10, 4],
      [26, 14],
      [48, 10],
      [58, -2],
    ].map(([x, z]) => new THREE.Vector3(x, terrainH(x, z) + 1.6, z))
    const route = new THREE.CatmullRomCurve3(waypoints, false, 'catmullrom', 0.5)
    const routeLen = route.getLength()

    /* ---------------- 外管（保温层） + 内部流体 ---------------- */
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0xaeb9c6,
      metalness: 0.75,
      roughness: 0.38,
      transparent: true,
      opacity: 1,
    })
    const shell = new THREE.Mesh(new THREE.TubeGeometry(route, 600, 0.52, 22, false), shellMat)
    shell.castShadow = true
    scene.add(shell)

    const fluidMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFlow: { value: 1 },
        uLeak: { value: -1 },
        uPig: { value: -1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uFlow;
        uniform float uLeak;
        uniform float uPig;
        varying vec2 vUv;
        float band(float x) {
          float f = fract(x);
          return smoothstep(0.0, 0.12, f) * smoothstep(0.5, 0.38, f);
        }
        void main() {
          float x = vUv.x * 90.0 - uTime * uFlow * 2.6;
          float b = band(x) * 0.45 + band(x * 0.5 + 13.7) * 0.3;
          vec3 col = mix(vec3(0.04, 0.28, 0.46), vec3(0.09, 0.52, 0.7), vUv.y);
          col += b * vec3(0.16, 0.34, 0.38);
          if (uLeak >= 0.0) {
            float dl = abs(vUv.x - uLeak);
            dl = min(dl, 1.0 - dl);
            col = mix(col, vec3(0.72, 0.14, 0.1), (1.0 - smoothstep(0.0, 0.035, dl)) * 0.85);
          }
          if (uPig >= 0.0) {
            float dp = abs(vUv.x - uPig);
            dp = min(dp, 1.0 - dp);
            col += vec3(0.9, 0.8, 0.2) * (1.0 - smoothstep(0.0, 0.02, dp)) * 0.9;
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(route, 600, 0.42, 18, false), fluidMat))

    /* ---------------- 法兰（InstancedMesh，沿弧长均匀） ---------------- */
    const flangeCount = 36
    const flanges = new THREE.InstancedMesh(
      new THREE.TorusGeometry(0.56, 0.1, 12, 28),
      new THREE.MeshStandardMaterial({ color: 0x77828e, metalness: 0.9, roughness: 0.32 }),
      flangeCount,
    )
    flanges.castShadow = true
    const boltRings = new THREE.InstancedMesh(
      new THREE.TorusGeometry(0.68, 0.045, 8, 28),
      new THREE.MeshStandardMaterial({ color: 0x39424c, metalness: 0.85, roughness: 0.4 }),
      flangeCount,
    )
    const m4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const zAxis = new THREE.Vector3(0, 0, 1)
    const tan = new THREE.Vector3()
    for (let i = 0; i < flangeCount; i++) {
      const u = (i + 0.5) / flangeCount
      const p = route.getPointAt(u)
      route.getTangentAt(u, tan)
      q.setFromUnitVectors(zAxis, tan)
      m4.compose(p, q, new THREE.Vector3(1, 1, 1))
      flanges.setMatrixAt(i, m4)
      m4.compose(p, q, new THREE.Vector3(1.0, 1.0, 1.24))
      boltRings.setMatrixAt(i, m4)
    }
    scene.add(flanges, boltRings)

    /* ---------------- 管墩 ---------------- */
    const pierCount = 26
    const piers = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.55, 1, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x8d8d88, roughness: 0.95 }),
      pierCount,
    )
    piers.castShadow = true
    piers.receiveShadow = true
    for (let i = 0; i < pierCount; i++) {
      const u = (i + 0.5) / pierCount
      const p = route.getPointAt(u)
      const ground = terrainH(p.x, p.z)
      const h = Math.max(0.4, p.y - ground - 0.2)
      const scale = new THREE.Vector3(1, h, 1)
      m4.compose(new THREE.Vector3(p.x, ground + h / 2, p.z), q.identity(), scale)
      piers.setMatrixAt(i, m4)
    }
    scene.add(piers)

    /* ---------------- 泵站 ---------------- */
    const pumpGroup = new THREE.Group()
    const p0 = route.getPointAt(0)
    const p0g = terrainH(p0.x, p0.z)
    pumpGroup.position.set(p0.x, p0g, p0.z)
    scene.add(pumpGroup)

    const concrete = new THREE.MeshStandardMaterial({ color: 0x9a9a94, roughness: 0.95 })
    const platform = new THREE.Mesh(new THREE.BoxGeometry(9, 0.5, 6), concrete)
    platform.position.y = 0.25
    platform.receiveShadow = true
    pumpGroup.add(platform)

    const pumpBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.62, 2.2, 24),
      new THREE.MeshStandardMaterial({ color: 0x2f6ea8, metalness: 0.6, roughness: 0.35 }),
    )
    pumpBody.rotation.z = Math.PI / 2
    pumpBody.position.set(-0.6, 1.35, 0)
    pumpBody.castShadow = true
    pumpGroup.add(pumpBody)

    const motor = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.1, 1.1),
      new THREE.MeshStandardMaterial({ color: 0x37414f, metalness: 0.5, roughness: 0.45 }),
    )
    motor.position.set(1.6, 1.35, 0)
    motor.castShadow = true
    pumpGroup.add(motor)

    // 散热风扇（旋转）
    const fan = new THREE.Group()
    fan.position.set(2.45, 1.35, 0)
    pumpGroup.add(fan)
    const fanRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.05, 10, 24),
      new THREE.MeshStandardMaterial({ color: 0x22282f, metalness: 0.6, roughness: 0.4 }),
    )
    fanRing.rotation.y = Math.PI / 2
    fan.add(fanRing)
    for (let i = 0; i < 5; i++) {
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.68, 0.16),
        new THREE.MeshStandardMaterial({ color: 0x8b98a8, metalness: 0.8, roughness: 0.3 }),
      )
      blade.rotation.x = (i / 5) * Math.PI * 2
      fan.add(blade)
    }

    // 泵进出口短管
    const stub1 = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 1.1, 16),
      new THREE.MeshStandardMaterial({ color: 0xaeb9c6, metalness: 0.75, roughness: 0.35 }),
    )
    stub1.rotation.z = Math.PI / 2
    stub1.position.set(-2.3, 1.35, 0)
    pumpGroup.add(stub1)

    /* ---------------- 阀门 ---------------- */
    interface Valve {
      group: THREE.Group
      wheel: THREE.Group
      u: number
      labelVal: HTMLElement
    }
    const valves: Valve[] = []
    function makeValve(u: number, name: string) {
      const g = new THREE.Group()
      const p = route.getPointAt(u)
      route.getTangentAt(u, tan)
      g.position.copy(p)
      g.quaternion.setFromUnitVectors(zAxis, tan)
      scene.add(g)

      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.72, 24, 18),
        new THREE.MeshStandardMaterial({ color: 0x37617f, metalness: 0.7, roughness: 0.35 }),
      )
      body.scale.set(0.8, 0.8, 0.8)
      body.castShadow = true
      g.add(body)

      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.09, 0.9, 10),
        new THREE.MeshStandardMaterial({ color: 0x8b98a8, metalness: 0.9, roughness: 0.25 }),
      )
      stem.position.y = 0.85
      g.add(stem)

      const wheel = new THREE.Group()
      wheel.position.y = 1.35
      wheel.rotation.x = Math.PI / 2
      g.add(wheel)
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.055, 10, 28),
        new THREE.MeshStandardMaterial({ color: 0xc23b3b, metalness: 0.4, roughness: 0.5 }),
      )
      wheel.add(rim)
      for (let i = 0; i < 4; i++) {
        const spoke = new THREE.Mesh(
          new THREE.BoxGeometry(0.05, 0.95, 0.05),
          new THREE.MeshStandardMaterial({ color: 0xc23b3b, metalness: 0.4, roughness: 0.5 }),
        )
        spoke.rotation.z = (i / 4) * Math.PI
        wheel.add(spoke)
      }

      const el = document.createElement('div')
      el.className = 'pipe-label'
      el.innerHTML = `<b>${name}</b><i>开度 --</i>`
      const label = new CSS2DObject(el)
      label.position.set(0, 2.0, 0)
      g.add(label)

      valves.push({ group: g, wheel, u, labelVal: el.querySelector('i') as HTMLElement })
    }
    makeValve(0.28, '阀门 XV-201')
    makeValve(0.52, '阀门 XV-202')
    makeValve(0.78, '阀门 XV-203')

    /* ---------------- 里程桩标签 ---------------- */
    const mileEl = document.createElement('div')
    mileEl.className = 'pipe-label'
    mileEl.innerHTML = `<b>泵站 P-101</b><i>增压单元</i>`
    const pumpLabel = new CSS2DObject(mileEl)
    pumpLabel.position.set(0, 4.2, 0)
    pumpGroup.add(pumpLabel)
    const extraLabels: CSS2DObject[] = [pumpLabel]
    for (const [u, text] of [
      [0.25, '里程桩 K0+025'],
      [0.5, '里程桩 K0+050'],
      [0.75, '里程桩 K0+075'],
    ] as const) {
      const el = document.createElement('div')
      el.className = 'pipe-label dim'
      el.innerHTML = `<i>${text}</i>`
      const label = new CSS2DObject(el)
      label.position.copy(route.getPointAt(u)).add(new THREE.Vector3(0, 2.0, 0))
      scene.add(label)
      extraLabels.push(label)
    }

    /* ---------------- 清管器（pig） ---------------- */
    const pig = new THREE.Group()
    pig.visible = false
    scene.add(pig)
    const pigBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 0.55, 18),
      new THREE.MeshStandardMaterial({ color: 0xd8b13a, metalness: 0.7, roughness: 0.3 }),
    )
    pigBody.rotation.z = Math.PI / 2
    pig.add(pigBody)
    const cupMat = new THREE.MeshStandardMaterial({ color: 0xc23b3b, roughness: 0.6 })
    for (const dx of [-0.36, 0.36]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 0.12, 18), cupMat)
      cup.rotation.z = Math.PI / 2
      cup.position.x = dx
      pig.add(cup)
    }
    const pigLamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 12, 8),
      new THREE.MeshStandardMaterial({
        color: 0xffe066,
        emissive: new THREE.Color(0xffe066),
        emissiveIntensity: 2.4,
      }),
    )
    pigLamp.position.x = 0.46
    pig.add(pigLamp)
    let pigU = 0

    /* ---------------- 泄漏特效 ---------------- */
    let leakU = -1
    const leakPos = new THREE.Vector3()
    const LEAK_N = 90
    const leakPosArr = new Float32Array(LEAK_N * 3)
    const leakVelArr = new Float32Array(LEAK_N * 3)
    const leakLifeArr = new Float32Array(LEAK_N)
    const leakGeo = new THREE.BufferGeometry()
    leakGeo.setAttribute('position', new THREE.BufferAttribute(leakPosArr, 3))
    const leakPoints = new THREE.Points(
      leakGeo,
      new THREE.PointsMaterial({
        color: 0xd7e3ea,
        size: 0.22,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    )
    scene.add(leakPoints)

    const leakRing = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.85, 48),
      new THREE.MeshBasicMaterial({
        color: 0xff4d4f,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    leakRing.rotation.x = -Math.PI / 2
    scene.add(leakRing)

    const leakLabelEl = document.createElement('div')
    leakLabelEl.className = 'pipe-label leak'
    leakLabelEl.innerHTML = `<b>泄漏告警</b><i>压力骤降 · 已定位</i>`
    const leakLabel = new CSS2DObject(leakLabelEl)
    leakLabel.visible = false
    scene.add(leakLabel)

    function setLeak(on: boolean) {
      if (on) {
        leakU = 0.38 + Math.random() * 0.3
        leakPos.copy(route.getPointAt(leakU))
        leakPos.y = terrainH(leakPos.x, leakPos.z) + 0.5
        leakLabel.position.copy(leakPos).add(new THREE.Vector3(0, 1.6, 0))
        leakLabel.visible = true
        leakRing.position.set(leakPos.x, terrainH(leakPos.x, leakPos.z) + 0.05, leakPos.z)
        for (let i = 0; i < LEAK_N; i++) leakLifeArr[i] = Math.random() * 0.9
        stats.leak = true
      } else {
        leakU = -1
        leakLabel.visible = false
        stats.leak = false
        ;(leakPoints.material as THREE.PointsMaterial).opacity = 0
        ;(leakRing.material as THREE.MeshBasicMaterial).opacity = 0
      }
      fluidMat.uniforms.uLeak.value = leakU
    }
    leakFn = () => setLeak(!stats.leak)

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

    pigFn = (on: boolean) => {
      pigRunning.value = on
      if (on) {
        pigU = 0
        pig.visible = true
      } else {
        pig.visible = false
        fluidMat.uniforms.uPig.value = -1
        if (followPig.value) followPig.value = false
      }
    }

    /* ---------------- 相机跟随 ---------------- */
    const camGoal = new THREE.Vector3()
    const lookGoal = new THREE.Vector3()
    let followLerp = 0
    const prevOpacity = { v: 1 }
    watch(followPig, (on) => {
      if (on) {
        prevOpacity.v = shellOpacity.value
        shellOpacity.value = 0.28
        followLerp = 1.6
      } else {
        shellOpacity.value = prevOpacity.v
      }
    })

    /* ---------------- 每帧 ---------------- */
    let t = 0
    let statTimer = 0

    return (dtRaw) => {
      const dt = Math.min(dtRaw, 0.05)
      if (running.value) t += dt
      const flow = flowSpeed.value

      fluidMat.uniforms.uTime.value = t
      fluidMat.uniforms.uFlow.value = flow
      fan.rotation.x += dt * flow * 9 * (running.value ? 1 : 0)

      // 阀门开度 → 手轮旋转 + 标签
      const openN = valveOpen.value / 100
      for (const v of valves) {
        v.wheel.rotation.y = openN * Math.PI * 1.5
        const rim = v.wheel.children[0] as THREE.Mesh
        ;(rim.material as THREE.MeshStandardMaterial).color.setHex(
          openN > 0.5 ? 0x2fa35a : openN > 0.15 ? 0xd08a2e : 0xc23b3b,
        )
        v.labelVal.textContent = `开度 ${valveOpen.value}%`
      }

      // 清管器推进
      if (pigRunning.value && running.value) {
        pigU += (dt * flow * 2.2) / routeLen
        if (pigU >= 1) {
          pigU = 1
          pigFn?.(false)
        }
        const p = route.getPointAt(pigU)
        route.getTangentAt(pigU, tan)
        pig.position.copy(p)
        pig.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tan)
        fluidMat.uniforms.uPig.value = pigU
        ;(pigLamp.material as THREE.MeshStandardMaterial).emissiveIntensity =
          1.6 + Math.sin(t * 8) * 1.2
      }

      // 泄漏粒子
      if (leakU >= 0) {
        const mat = leakPoints.material as THREE.PointsMaterial
        mat.opacity = 0.85
        for (let i = 0; i < LEAK_N; i++) {
          if (leakLifeArr[i] <= 0) {
            if (running.value && Math.random() < 0.12) {
              leakLifeArr[i] = 0.8 + Math.random() * 0.6
              leakPosArr[i * 3] = leakPos.x
              leakPosArr[i * 3 + 1] = leakPos.y
              leakPosArr[i * 3 + 2] = leakPos.z
              leakVelArr[i * 3] = (Math.random() - 0.5) * 2.4
              leakVelArr[i * 3 + 1] = 3.2 + Math.random() * 2.4
              leakVelArr[i * 3 + 2] = (Math.random() - 0.5) * 2.4
            }
            continue
          }
          leakLifeArr[i] -= dt
          leakVelArr[i * 3 + 1] -= 4.2 * dt
          leakPosArr[i * 3] += leakVelArr[i * 3] * dt
          leakPosArr[i * 3 + 1] += leakVelArr[i * 3 + 1] * dt
          leakPosArr[i * 3 + 2] += leakVelArr[i * 3 + 2] * dt
        }
        ;(leakGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
        const k = (t * 0.6) % 1
        leakRing.scale.setScalar(0.7 + k * 4.5)
        ;(leakRing.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - k)
      }

      // 相机：跟随 pig
      if (followPig.value && pig.visible) {
        const p = route.getPointAt(Math.max(0.001, pigU))
        route.getTangentAt(pigU, tan)
        camGoal.copy(p).addScaledVector(tan, -4.5).add(new THREE.Vector3(0, 2.2, 0))
        lookGoal.copy(p)
        const k = 1 - Math.exp(-3 * dt)
        camera.position.lerp(camGoal, k)
        controls?.target.lerp(lookGoal, k)
      } else if (followLerp > 0) {
        followLerp -= dt
      }

      // 看板（2Hz）
      statTimer += dt
      if (statTimer > 0.5) {
        statTimer = 0
        const openFactor = 0.25 + 0.75 * openN
        stats.flow = Math.round(420 * flow * openFactor * (stats.leak ? 0.82 : 1) + (Math.random() - 0.5) * 6)
        stats.pressure = Math.round(1.62 * openFactor * (stats.leak ? 0.55 : 1) * 100) / 100
        stats.temp = Math.round((23.4 + flow * 2.1 + (Math.random() - 0.5)) * 10) / 10
        stats.pig = pig.visible ? Math.round(pigU * 100) : 0
        leakLabelEl.querySelector('i')!.textContent = stats.leak
          ? `压力 ${stats.pressure.toFixed(2)} MPa ↓`
          : '压力骤降 · 已定位'
      }

      shellMat.opacity = shellOpacity.value
      shellMat.transparent = shellOpacity.value < 0.99
      shellMat.depthWrite = shellOpacity.value > 0.9
      const showL = showLabels.value
      labelRenderer.domElement.style.display = showL ? 'block' : 'none'
      labelRenderer.render(scene, camera)
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>

    <div class="hud">
      <div class="hud-title">长输管道 · SCADA 看板</div>
      <div class="kpi">
        <div><span>流量 m³/h</span><b>{{ stats.flow }}</b></div>
        <div :class="{ bad: stats.leak }"><span>压力 MPa</span><b>{{ stats.pressure.toFixed(2) }}</b></div>
        <div><span>温度 ℃</span><b>{{ stats.temp.toFixed(1) }}</b></div>
        <div><span>清管进度</span><b>{{ stats.pig }}%</b></div>
      </div>
      <div class="alarm-line" :class="{ on: stats.leak }">
        {{ stats.leak ? '⚠ 检测到泄漏，已定位并降量运行' : '管线运行正常' }}
      </div>
    </div>

    <div class="panel">
      <div class="title">长输管道 · 数字孪生</div>
      <div class="row">
        <span class="label">输送流量</span>
        <input v-model.number="flowSpeed" class="range" type="range" min="0" max="2" step="0.05" />
        <span class="val">{{ flowSpeed.toFixed(2) }}×</span>
      </div>
      <div class="row">
        <span class="label">管壁透视</span>
        <input v-model.number="shellOpacity" class="range" type="range" min="0.1" max="1" step="0.01" />
        <span class="val">{{ Math.round(shellOpacity * 100) }}%</span>
      </div>
      <div class="row">
        <span class="label">阀门开度</span>
        <input v-model.number="valveOpen" class="range" type="range" min="0" max="100" step="1" />
        <span class="val">{{ valveOpen }}%</span>
      </div>
      <div class="row btns">
        <button class="chip" :class="{ on: running }" @click="running = !running">
          {{ running ? '暂停' : '继续' }}
        </button>
        <button class="chip" :class="{ on: pigRunning }" @click="togglePig">
          {{ pigRunning ? '清管中…' : '发射清管器' }}
        </button>
        <button class="chip" @click="injectLeak">{{ stats.leak ? '消除泄漏' : '注入泄漏' }}</button>
      </div>
      <div class="row btns">
        <button class="chip" :class="{ on: followPig }" @click="followPig = !followPig">跟随清管器</button>
        <button class="chip" :class="{ on: showLabels }" @click="showLabels = !showLabels">站场标签</button>
      </div>
      <div class="tip">
        内部流体是 TubeGeometry + ShaderMaterial：沿 <code>uv.x</code> 做条纹相位流动，泄漏点和清管器位置作为
        uniform 直接在着色器里局部染色。法兰、管墩用 InstancedMesh 沿弧长布设，姿态取曲线切向
        <code>setFromUnitVectors</code>。清管器按弧长匀速推进，开「管壁透视 + 跟随」可以钻进管内看它走完全程。
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
  width: 252px;
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
.alarm-line {
  margin-top: 8px;
  font-size: 11px;
  color: #7ee787;
}
.alarm-line.on {
  color: #ff6b6b;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 344px;
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

:deep(.pipe-label) {
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(11, 17, 25, 0.85);
  border: 1px solid rgba(79, 157, 255, 0.4);
  white-space: nowrap;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
}
:deep(.pipe-label b) {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #eaf2fb;
}
:deep(.pipe-label i) {
  display: block;
  font-style: normal;
  font-size: 10px;
  color: #63c9ff;
}
:deep(.pipe-label.dim) {
  border-color: rgba(120, 140, 165, 0.35);
  background: rgba(11, 17, 25, 0.7);
}
:deep(.pipe-label.dim i) {
  color: #93a7bc;
}
:deep(.pipe-label.leak) {
  border-color: rgba(255, 77, 79, 0.8);
  background: rgba(40, 10, 12, 0.92);
  animation: pulse 1.1s ease-in-out infinite;
}
:deep(.pipe-label.leak b) {
  color: #ffd7d7;
}
:deep(.pipe-label.leak i) {
  color: #ff6b6b;
}
@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(255, 77, 79, 0.55);
  }
  50% {
    box-shadow: 0 0 0 9px rgba(255, 77, 79, 0);
  }
}
</style>
