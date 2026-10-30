<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { useThree } from './useThree'

/* ============================================================
 * 海上风电场 · 风机群仿真
 *  - 海面：Gerstner 波叠加的 ShaderMaterial，顶点算位移+解析法线，
 *    片元做菲涅尔天空反射 + 太阳高光 + 距离雾，波幅随风速变化
 *  - 风机：真实尺度（轮毂 90m / 叶轮 116m），叶片用顶点收窄 + 扭转建模
 *  - 偏航对风：机舱平滑转向风向；转速按叶尖速比 λ=vR 推进
 *  - 尾流：Jensen 模型算下游风速亏量 → 下游风机转慢、出力下降，
 *    尾流锥用透明度沿程衰减的着色器可视化
 *  - 功率：P = ½ρAv³Cp，切入 3 / 额定 12 / 切出 25 m/s，单机 5MW
 * ============================================================ */

const container = ref<HTMLDivElement>()
const windSpeed = ref(11)
const windDirDeg = ref(0)
const showWake = ref(true)
const showLabels = ref(true)
const view = ref<'far' | 'near'>('far')

const stats = reactive({
  total: 0,
  avgWind: 0,
  cf: 0,
  stopped: 0,
})

const R = 58 // 叶轮半径 m
const RATED = 5 // 单机额定 MW
const CAPACITY = 6 * RATED

useThree(
  container,
  {
    background: 0x9db8d4,
    cameraPos: [300, 170, 360],
    lookAt: [0, 55, 0],
    controls: true,
    far: 6000,
  },
  ({ scene, camera, controls }) => {
    const sunDir = new THREE.Vector3(0.55, 0.42, 0.72).normalize()
    scene.fog = new THREE.Fog(0xa8c2dd, 700, 2400)
    scene.add(new THREE.HemisphereLight(0xcfe0f2, 0x1c2a35, 1.0))
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.0)
    sun.position.copy(sunDir).multiplyScalar(500)
    scene.add(sun)

    /* ---------------- 天空穹顶 ---------------- */
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uSunDir: { value: sunDir } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        varying vec3 vWorld;
        void main() {
          vec3 d = normalize(vWorld);
          vec3 horizon = vec3(0.72, 0.80, 0.88);
          vec3 zenith = vec3(0.18, 0.36, 0.62);
          vec3 col = mix(horizon, zenith, smoothstep(0.0, 0.45, d.y));
          float s = max(dot(d, uSunDir), 0.0);
          col += vec3(1.0, 0.92, 0.75) * pow(s, 220.0) * 1.4;
          col += vec3(1.0, 0.85, 0.6) * pow(s, 6.0) * 0.12;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(2600, 32, 16), skyMat))

    /* ---------------- 海面（Gerstner 波 + 菲涅尔） ---------------- */
    const seaMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0.9 },
        uSunDir: { value: sunDir },
        uDeep: { value: new THREE.Color(0x0d3350) },
        uSky: { value: new THREE.Color(0x9db8d4) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uAmp;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vec3 pos = position;
          vec2 p = pos.xz;
          float h = 0.0;
          vec2 grad = vec2(0.0);
          // 4 列方向、频率、相速度不同的波
          vec2 d1 = normalize(vec2(1.0, 0.35));
          vec2 d2 = normalize(vec2(0.7, -0.7));
          vec2 d3 = normalize(vec2(-0.4, 1.0));
          vec2 d4 = normalize(vec2(0.95, 0.6));
          float f1 = 2.0 * 3.14159 / 62.0, s1 = 1.1;
          float f2 = 2.0 * 3.14159 / 34.0, s2 = 1.5;
          float f3 = 2.0 * 3.14159 / 21.0, s3 = 2.1;
          float f4 = 2.0 * 3.14159 / 12.0, s4 = 2.9;
          float a1 = 0.55, a2 = 0.3, a3 = 0.16, a4 = 0.08;
          h += a1 * sin(dot(p, d1) * f1 + uTime * s1);
          grad += a1 * f1 * cos(dot(p, d1) * f1 + uTime * s1) * d1;
          h += a2 * sin(dot(p, d2) * f2 + uTime * s2);
          grad += a2 * f2 * cos(dot(p, d2) * f2 + uTime * s2) * d2;
          h += a3 * sin(dot(p, d3) * f3 + uTime * s3);
          grad += a3 * f3 * cos(dot(p, d3) * f3 + uTime * s3) * d3;
          h += a4 * sin(dot(p, d4) * f4 + uTime * s4);
          grad += a4 * f4 * cos(dot(p, d4) * f4 + uTime * s4) * d4;
          pos.y += h * uAmp;
          vN = normalize(vec3(-grad.x * uAmp, 1.0, -grad.y * uAmp));
          vec4 wp = modelMatrix * vec4(pos, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform vec3 uDeep;
        uniform vec3 uSky;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          vec3 col = mix(uDeep, uSky, fres * 0.8);
          vec3 H = normalize(uSunDir + V);
          float spec = pow(max(dot(N, H), 0.0), 160.0);
          col += vec3(1.0, 0.95, 0.8) * spec * 1.1;
          float fog = smoothstep(500.0, 2200.0, length(cameraPosition - vWorld));
          col = mix(col, uSky * 0.96, fog * 0.85);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
    const seaGeo = new THREE.PlaneGeometry(3200, 3200, 190, 190)
    seaGeo.rotateX(-Math.PI / 2)
    const sea = new THREE.Mesh(seaGeo, seaMat)
    scene.add(sea)

    /* ---------------- 风机 ---------------- */
    const steelWhite = new THREE.MeshStandardMaterial({ color: 0xe9edf2, metalness: 0.15, roughness: 0.42 })
    const nacelleMat = new THREE.MeshStandardMaterial({ color: 0xdfe5ec, metalness: 0.3, roughness: 0.38 })
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x39434e, metalness: 0.7, roughness: 0.4 })

    // 叶片：BoxGeometry 顶点收窄 + 几何扭转
    function bladeGeometry() {
      const L = 56
      const geo = new THREE.BoxGeometry(3.6, L, 0.85, 1, 32, 1)
      const pos = geo.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i)
        const t = (y + L / 2) / L // 0 根部 → 1 叶尖
        const chord = 0.26 + 0.74 * Math.sin(Math.PI * Math.pow(t, 0.85))
        const thick = 0.18 + 0.82 * chord
        let x = pos.getX(i) * chord
        let z = pos.getZ(i) * thick
        const twist = (1 - t) * 0.5
        const cx = x * Math.cos(twist) - z * Math.sin(twist)
        const cz = x * Math.sin(twist) + z * Math.cos(twist)
        pos.setX(i, cx)
        pos.setZ(i, cz)
        pos.setY(i, y + L / 2 + 2.4)
      }
      geo.computeVertexNormals()
      return geo
    }
    const bladeGeo = bladeGeometry()

    interface Turbine {
      root: THREE.Group // 底座（固定）
      yaw: THREE.Group // 机舱+叶轮（随风向）
      rotor: THREE.Group // 叶轮
      labelEl: HTMLElement
      valEl: HTMLElement
      x: number
      z: number
      yawCur: number
      effV: number
      power: number
    }
    const turbines: Turbine[] = []
    const beacons: THREE.Mesh[] = []

    function makeTurbine(id: number, x: number, z: number) {
      const root = new THREE.Group()
      root.position.set(x, 0, z)
      scene.add(root)

      const monopile = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.0, 24, 20), steelWhite)
      monopile.position.y = 2
      root.add(monopile)
      const tp = new THREE.Mesh(new THREE.CylinderGeometry(2.45, 2.45, 6, 20), darkMetal)
      tp.position.y = 15
      root.add(tp)
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.45, 74, 24), steelWhite)
      tower.position.y = 55
      root.add(tower)

      // 吃水线泡沫圈
      const foam = new THREE.Mesh(
        new THREE.TorusGeometry(3.05, 0.28, 10, 36),
        new THREE.MeshBasicMaterial({ color: 0xe8f2f8, transparent: true, opacity: 0.55 }),
      )
      foam.rotation.x = -Math.PI / 2
      foam.position.y = 0.3
      root.add(foam)

      const yaw = new THREE.Group()
      yaw.position.y = 92
      root.add(yaw)

      const nacelle = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.2, 11), nacelleMat)
      nacelle.position.z = -1.5
      yaw.add(nacelle)
      const vent = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.5, 9.6), darkMetal)
      vent.position.set(0, 1.75, -1.5)
      yaw.add(vent)

      const rotor = new THREE.Group()
      rotor.position.z = 4.6
      yaw.add(rotor)
      const hub = new THREE.Mesh(
        new THREE.SphereGeometry(1.7, 20, 16),
        new THREE.MeshStandardMaterial({ color: 0xf2f5f8, metalness: 0.2, roughness: 0.35 }),
      )
      hub.scale.set(1, 1, 1.5)
      rotor.add(hub)
      for (let i = 0; i < 3; i++) {
        const holder = new THREE.Group()
        holder.rotation.z = (i / 3) * Math.PI * 2
        const blade = new THREE.Mesh(bladeGeo, steelWhite)
        holder.add(blade)
        rotor.add(holder)
      }

      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 10, 8),
        new THREE.MeshStandardMaterial({
          color: 0xff3b30,
          emissive: new THREE.Color(0xff3b30),
          emissiveIntensity: 2,
        }),
      )
      beacon.position.set(0, 2.1, -6)
      yaw.add(beacon)
      beacons.push(beacon)

      const el = document.createElement('div')
      el.className = 'wt-label'
      el.innerHTML = `<b>WT-0${id}</b><i>--</i>`
      const label = new CSS2DObject(el)
      label.position.y = 7
      yaw.add(label)

      turbines.push({
        root,
        yaw,
        rotor,
        labelEl: el,
        valEl: el.querySelector('i') as HTMLElement,
        x,
        z,
        yawCur: 0,
        effV: windSpeed.value,
        power: 0,
      })
    }
    // 2 行 × 3 列，间距 7D
    const SP = 7 * 2 * R
    let id = 1
    for (const z of [-SP / 2, SP / 2]) {
      for (const x of [-SP, 0, SP]) makeTurbine(id++, x, z)
    }

    /* ---------------- 尾流锥 ---------------- */
    const wakeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(0xbfd6ea) } },
      vertexShader: /* glsl */ `
        varying float vT;
        void main() {
          vT = uv.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vT;
        void main() {
          gl_FragColor = vec4(uColor, (1.0 - vT) * 0.08);
        }
      `,
    })
    const WAKE_LEN = 560
    const wakeCones: THREE.Mesh[] = []
    for (let i = 0; i < turbines.length; i++) {
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.9, R * 0.95, WAKE_LEN, 24, 1, true), wakeMat)
      cone.geometry.translate(0, -WAKE_LEN / 2, 0)
      cone.position.y = 92
      cone.visible = false
      scene.add(cone)
      wakeCones.push(cone)
    }

    /* ---------------- 海上升压站 ---------------- */
    const ss = new THREE.Group()
    ss.position.set(SP * 1.6 + 120, 0, 0)
    scene.add(ss)
    for (const [lx, lz] of [
      [-16, -10],
      [16, -10],
      [-16, 10],
      [16, 10],
    ] as const) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 26, 14), steelWhite)
      leg.position.set(lx, 5, lz)
      ss.add(leg)
    }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(44, 3, 30), nacelleMat)
    deck.position.y = 19
    ss.add(deck)
    const transformer = new THREE.Mesh(new THREE.BoxGeometry(9, 6, 7), darkMetal)
    transformer.position.set(-10, 23.5, 0)
    ss.add(transformer)
    const control = new THREE.Mesh(new THREE.BoxGeometry(7, 4.5, 6), new THREE.MeshStandardMaterial({ color: 0x4a6b8a, metalness: 0.4, roughness: 0.5 }))
    control.position.set(6, 22.75, -6)
    ss.add(control)
    // 吊机塔
    const crane = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 18, 10), darkMetal)
    crane.position.set(14, 29, 8)
    ss.add(crane)
    const ssBeacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 10, 8),
      new THREE.MeshStandardMaterial({
        color: 0xff3b30,
        emissive: new THREE.Color(0xff3b30),
        emissiveIntensity: 2.4,
      }),
    )
    ssBeacon.position.set(14, 38.4, 8)
    ss.add(ssBeacon)

    const ssEl = document.createElement('div')
    ssEl.className = 'wt-label'
    ssEl.innerHTML = `<b>海上升压站</b><i>220kV 送出</i>`
    const ssLabel = new CSS2DObject(ssEl)
    ssLabel.position.y = 16
    ss.add(ssLabel)

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

    /* ---------------- 相机 ---------------- */
    const camGoal = new THREE.Vector3(300, 170, 360)
    const lookGoal = new THREE.Vector3(0, 55, 0)
    let camLerp = 0
    watch(view, (v) => {
      camLerp = 1.6
      if (v === 'far') {
        camGoal.set(300, 170, 360)
        lookGoal.set(0, 55, 0)
      } else {
        camGoal.set(SP * 0.62 + 34, 26, SP / 2 + 46)
        lookGoal.set(SP * 0.62, 88, SP / 2)
      }
    })

    /* ---------------- 风资源 / 尾流计算 ---------------- */
    const windDir = new THREE.Vector3(1, 0, 0)
    function powerCurve(v: number) {
      if (v < 3 || v > 25) return 0
      if (v >= 12) return RATED
      return Math.round(Math.min(RATED, RATED * Math.pow((v - 3) / 9, 3) * 1.35) * 100) / 100
    }

    /* ---------------- 每帧 ---------------- */
    let t = 0
    let statTimer = 0
    const tmp = new THREE.Vector3()

    return (dtRaw) => {
      const dt = Math.min(dtRaw, 0.05)
      t += dt

      const v = windSpeed.value
      const rad = (windDirDeg.value * Math.PI) / 180
      windDir.set(Math.sin(rad), 0, Math.cos(rad))
      seaMat.uniforms.uTime.value = t
      seaMat.uniforms.uAmp.value = 0.35 + (v / 25) * 1.15

      // 尾流（Jensen 模型）：每台机组取上游风机的最大风速亏量
      const D = 2 * R
      let stopped = 0
      let total = 0
      for (const ti of turbines) {
        let deficit = 0
        for (const tj of turbines) {
          if (ti === tj) continue
          tmp.set(ti.x - tj.x, 0, ti.z - tj.z)
          const along = tmp.dot(windDir)
          if (along < D * 1.5) continue
          const lateral = tmp.addScaledVector(windDir, -along).length()
          if (lateral > R * 0.6 + 0.075 * along) continue
          const d = (1 - Math.sqrt(1 - 0.78)) / Math.pow(1 + 0.075 * (along / D), 2)
          deficit = Math.max(deficit, d)
        }
        ti.effV = v * (1 - deficit)
        ti.power = powerCurve(ti.effV)
        if (ti.power === 0) stopped++
        total += ti.power

        // 偏航对风：机舱平滑转向来风反方向
        const targetYaw = Math.atan2(-windDir.x, -windDir.z)
        let diff = targetYaw - ti.yawCur
        while (diff > Math.PI) diff -= Math.PI * 2
        while (diff < -Math.PI) diff += Math.PI * 2
        ti.yawCur += diff * Math.min(1, dt * 0.9)
        ti.yaw.rotation.y = ti.yawCur

        // 转速：叶尖速比 λ≈8，叶尖限速
        const omega = ti.power === 0 ? 0 : Math.min(1.35, (ti.effV * 8) / R)
        ti.rotor.rotation.z -= omega * dt

        // 尾流锥：顺下游方向
        const idx = turbines.indexOf(ti)
        const cone = wakeCones[idx]
        cone.visible = showWake.value && ti.power > 0
        if (cone.visible) {
          // 从叶轮下游 1.5D 处开始铺
          cone.position.set(ti.x + windDir.x * 3 * R, 92, ti.z + windDir.z * 3 * R)
          cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), windDir)
        }
      }

      // 航空障碍灯呼吸
      const blink = 1.2 + Math.sin(t * 2.4) * 1.6
      for (const b of beacons) {
        ;(b.material as THREE.MeshStandardMaterial).emissiveIntensity = blink
      }
      ;(ssBeacon.material as THREE.MeshStandardMaterial).emissiveIntensity = blink

      // 相机
      if (camLerp > 0) {
        const k = 1 - Math.exp(-2.6 * dt)
        camera.position.lerp(camGoal, k)
        controls?.target.lerp(lookGoal, k)
        camLerp -= dt
      }

      // 看板 2Hz
      statTimer += dt
      if (statTimer > 0.5) {
        statTimer = 0
        stats.total = Math.round(total * 10) / 10
        stats.avgWind = Math.round((turbines.reduce((s, x) => s + x.effV, 0) / turbines.length) * 10) / 10
        stats.cf = Math.round((total / CAPACITY) * 100)
        stats.stopped = stopped
        for (const ti of turbines) {
          const state = ti.power === 0 ? '停机' : ti.power >= RATED ? '满发' : ti.effV < v * 0.85 ? '尾流降载' : '发电'
          ti.valEl.textContent = `${ti.effV.toFixed(1)} m/s · ${ti.power.toFixed(2)} MW · ${state}`
          ti.labelEl.classList.toggle('stop', ti.power === 0)
          ti.labelEl.classList.toggle('wake', state === '尾流降载')
        }
      }

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
      <div class="hud-title">海上风电场 · 集控看板</div>
      <div class="kpi">
        <div><span>总有功 MW</span><b>{{ stats.total.toFixed(1) }}</b></div>
        <div><span>均风速 m/s</span><b>{{ stats.avgWind.toFixed(1) }}</b></div>
        <div><span>容量系数</span><b>{{ stats.cf }}%</b></div>
        <div :class="{ bad: stats.stopped > 0 }"><span>停机</span><b>{{ stats.stopped }}</b></div>
      </div>
      <div class="sub">装机 6 × {{ RATED }}MW = {{ CAPACITY }}MW</div>
    </div>

    <div class="panel">
      <div class="title">海上风电场 · 风机群仿真</div>
      <div class="row">
        <span class="label">风速</span>
        <input v-model.number="windSpeed" class="range" type="range" min="2" max="28" step="0.5" />
        <span class="val">{{ windSpeed.toFixed(1) }}</span>
      </div>
      <div class="row">
        <span class="label">风向</span>
        <input v-model.number="windDirDeg" class="range" type="range" min="0" max="360" step="1" />
        <span class="val">{{ windDirDeg }}°</span>
      </div>
      <div class="row btns">
        <button class="chip" :class="{ on: view === 'far' }" @click="view = 'far'">全景</button>
        <button class="chip" :class="{ on: view === 'near' }" @click="view = 'near'">机位特写</button>
        <button class="chip" :class="{ on: showWake }" @click="showWake = !showWake">尾流</button>
        <button class="chip" :class="{ on: showLabels }" @click="showLabels = !showLabels">标签</button>
      </div>
      <div class="tip">
        海面是 4 列不同方向/波长的正弦波叠加：顶点着色器算位移和解析法线，片元做菲涅尔天空反射与太阳高光。
        风机按真实尺度建模（轮毂 90m / 叶轮 116m），叶片由顶点收窄 + 几何扭转生成；机舱按风向平滑偏航，
        转速按叶尖速比 λ=vR 推进。下游风速亏量用 Jensen 尾流模型计算，尾流锥的透明度沿程衰减——
        把风向转到正对队列方向，能看到后排风机明显降载。
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
  background: rgba(12, 18, 26, 0.85);
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
.sub {
  margin-top: 8px;
  font-size: 11px;
  color: #9fb0c2;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 360px;
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
  flex: 0 0 40px;
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

:deep(.wt-label) {
  padding: 3px 8px;
  border-radius: 6px;
  background: rgba(11, 17, 25, 0.82);
  border: 1px solid rgba(79, 157, 255, 0.4);
  white-space: nowrap;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
}
:deep(.wt-label b) {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #eaf2fb;
}
:deep(.wt-label i) {
  display: block;
  font-style: normal;
  font-size: 10px;
  color: #63c9ff;
}
:deep(.wt-label.wake i) {
  color: #ffd76b;
}
:deep(.wt-label.stop) {
  border-color: rgba(255, 77, 79, 0.7);
}
:deep(.wt-label.stop i) {
  color: #ff6b6b;
}
</style>
