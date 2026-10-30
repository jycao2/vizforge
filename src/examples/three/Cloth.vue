<script setup lang="ts">
import { ref } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

/* ============================================================
 * 布料模拟 · Verlet 积分 + PBD 约束松弛
 *  - 质点：40×26 网格，Verlet 积分（只需位置，速度由位置差隐含）
 *  - 约束：结构（经纬）、剪切（对角）、弯曲（隔点），按刚度分组迭代
 *  - 碰撞：球体（绕 X 摆动）+ 地面
 *  - 交互：拖拽质点、双击在该处撕裂（同时删约束与面片）
 * ============================================================ */

const container = ref<HTMLDivElement>()

const wind = ref(1.15)
const running = ref(true)
const stiffness = ref(1)
const vertCount = ref(0)
const linkCount = ref(0)

const NX = 40
const NY = 26
const SP = 0.13
const NP = NX * NY
const TOP_Y = 2.0
const FLOOR_Y = -1.55
const ITER = 6

const pos = new Float32Array(NP * 3)
const prev = new Float32Array(NP * 3)
const pinned = new Uint8Array(NP)

interface Link {
  a: number
  b: number
  rest: number
  k: number
  dead: boolean
}
let links: Link[] = []
const deadQuad = new Uint8Array((NX - 1) * (NY - 1))

const SPHERE_C = new THREE.Vector3(0, -0.5, -0.86)
const SPHERE_R = 0.7

/** 布料纹理：平纹织物（经纬线 + 纤维噪点） */
function clothTexture(): THREE.CanvasTexture {
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const g = cv.getContext('2d')!
  g.fillStyle = '#c9bda6'
  g.fillRect(0, 0, S, S)
  // 经线
  for (let x = 0; x < S; x += 4) {
    g.fillStyle = `rgba(150,138,116,${0.18 + Math.random() * 0.1})`
    g.fillRect(x, 0, 1.6, S)
  }
  // 纬线
  for (let y = 0; y < S; y += 4) {
    g.fillStyle = `rgba(240,232,214,${0.16 + Math.random() * 0.1})`
    g.fillRect(0, y, S, 1.6)
  }
  // 纤维噪点
  for (let i = 0; i < 9000; i++) {
    const v = Math.random()
    g.fillStyle = `rgba(${(150 + v * 90) | 0},${(142 + v * 84) | 0},${(120 + v * 72) | 0},0.14)`
    g.fillRect(Math.random() * S, Math.random() * S, 1, 1)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(5, 3.4)
  tex.anisotropy = 4
  return tex
}

useThree(
  container,
  {
    fov: 42,
    cameraPos: [0.55, 1.3, 6.4],
    lookAt: [0, 0.15, 0],
    controls: true,
    shadows: true,
    background: 0x0d1015,
    near: 0.05,
  },
  (ctx) => {
    const { scene, renderer, controls } = ctx

    scene.fog = new THREE.Fog(0x0d1015, 9, 22)

    /* ---------------- 灯光 ---------------- */
    scene.add(new THREE.HemisphereLight(0x9db6d0, 0x171a1f, 0.34))
    const key = new THREE.DirectionalLight(0xfff1dc, 3.2)
    key.position.set(4.2, 6.4, 5.2)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -5.5
    key.shadow.camera.right = 5.5
    key.shadow.camera.top = 5.5
    key.shadow.camera.bottom = -5.5
    key.shadow.camera.near = 0.5
    key.shadow.camera.far = 24
    key.shadow.bias = -0.0012
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x7fb4ff, 0.9)
    rim.position.set(-5, 2.6, -4)
    scene.add(rim)
    const fill = new THREE.DirectionalLight(0xffe9cc, 0.55)
    fill.position.set(-4.5, 1.2, 5)
    scene.add(fill)

    /* ---------------- 地面与横杆 ---------------- */
    const floorTex = (() => {
      const S = 512
      const cv = document.createElement('canvas')
      cv.width = cv.height = S
      const g = cv.getContext('2d')!
      g.fillStyle = '#2a2e34'
      g.fillRect(0, 0, S, S)
      for (let i = 0; i < 9000; i++) {
        const v = Math.random()
        g.fillStyle = `rgba(${(40 + v * 40) | 0},${(44 + v * 40) | 0},${(50 + v * 40) | 0},0.5)`
        g.fillRect(Math.random() * S, Math.random() * S, 2, 2)
      }
      const t = new THREE.CanvasTexture(cv)
      t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(4, 4)
      return t
    })()
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 24),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95, metalness: 0.02 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = FLOOR_Y
    floor.receiveShadow = true
    scene.add(floor)

    const steel = new THREE.MeshStandardMaterial({
      color: 0x8e97a2,
      roughness: 0.35,
      metalness: 0.85,
    })
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 5.6, 16), steel)
    bar.rotation.z = Math.PI / 2
    bar.position.set(0, TOP_Y + 0.03, 0)
    bar.castShadow = true
    scene.add(bar)
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 12), steel)
      post.position.set(s * 2.8, TOP_Y + 0.03, 0)
      scene.add(post)
    }

    // 球体碰撞体
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0x8f4130,
      roughness: 0.58,
      metalness: 0.12,
    })
    const ball = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_R, 40, 28), ballMat)
    ball.castShadow = true
    ball.receiveShadow = true
    scene.add(ball)

    /* ---------------- 布料网格 ---------------- */
    const geo = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(new Float32Array(NP * 3), 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', posAttr)
    const uvArr = new Float32Array(NP * 2)
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = (j * NX + i) * 2
        uvArr[k] = i / (NX - 1)
        uvArr[k + 1] = 1 - j / (NY - 1)
      }
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2))
    geo.setIndex([])
    geo.computeVertexNormals()

    const cloth = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        map: clothTexture(),
        color: 0xffffff,
        roughness: 0.86,
        metalness: 0.03,
        side: THREE.DoubleSide,
      }),
    )
    cloth.castShadow = true
    cloth.receiveShadow = true
    cloth.frustumCulled = false
    scene.add(cloth)

    function buildIndex() {
      const idx: number[] = []
      for (let j = 0; j < NY - 1; j++) {
        for (let i = 0; i < NX - 1; i++) {
          if (deadQuad[j * (NX - 1) + i]) continue
          const a = j * NX + i
          const b = a + 1
          const c = a + NX
          const d = c + 1
          idx.push(a, c, b, b, c, d)
        }
      }
      geo.setIndex(idx)
    }

    function addLink(a: number, b: number, k: number) {
      const dx = pos[a * 3] - pos[b * 3]
      const dy = pos[a * 3 + 1] - pos[b * 3 + 1]
      const dz = pos[a * 3 + 2] - pos[b * 3 + 2]
      links.push({ a, b, rest: Math.hypot(dx, dy, dz), k, dead: false })
    }

    function reset() {
      links = []
      deadQuad.fill(0)
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          const id = j * NX + i
          const x = (i - (NX - 1) / 2) * SP
          const y = TOP_Y - j * SP
          pos[id * 3] = x
          pos[id * 3 + 1] = y
          pos[id * 3 + 2] = Math.sin(i * 0.5) * 0.02
          prev[id * 3] = x
          prev[id * 3 + 1] = y
          prev[id * 3 + 2] = pos[id * 3 + 2]
          // 顶边每 4 个质点固定一次，形成扇贝状悬挂
          pinned[id] = j === 0 && i % 4 === 0 ? 1 : 0
        }
      }
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          const id = j * NX + i
          if (i < NX - 1) addLink(id, id + 1, 1)
          if (j < NY - 1) addLink(id, id + NX, 1)
          if (i < NX - 1 && j < NY - 1) {
            addLink(id, id + NX + 1, 0.36) // 剪切
            addLink(id + 1, id + NX, 0.36)
          }
          if (i < NX - 2) addLink(id, id + 2, 0.14) // 弯曲
          if (j < NY - 2) addLink(id, id + NX * 2, 0.14)
        }
      }
      buildIndex()
      vertCount.value = NP
      linkCount.value = links.length
    }
    reset()

    /* ---------------- 交互：拖拽 / 撕裂 ---------------- */
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const dragPlane = new THREE.Plane()
    const grabOrigin = new THREE.Vector3()
    /** 拖拽位移上限：拉得太远会把布料抽成一条带子 */
    const DRAG_MAX = 0.85
    const hitPoint = new THREE.Vector3()
    let dragIdx = -1

    function setNdc(ev: PointerEvent) {
      const r = renderer.domElement.getBoundingClientRect()
      ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1
      ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1
      ray.setFromCamera(ndc, ctx.camera)
    }

    function nearestVertex(p: THREE.Vector3) {
      let best = -1
      let bestD = 1e9
      for (let i = 0; i < NP; i++) {
        const dx = pos[i * 3] - p.x
        const dy = pos[i * 3 + 1] - p.y
        const dz = pos[i * 3 + 2] - p.z
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      return best
    }

    function onDown(ev: PointerEvent) {
      setNdc(ev)
      const hit = ray.intersectObject(cloth, false)[0]
      if (!hit) return
      dragIdx = nearestVertex(hit.point)
      if (dragIdx < 0) return
      const n = new THREE.Vector3()
      ctx.camera.getWorldDirection(n)
      dragPlane.setFromNormalAndCoplanarPoint(n, hit.point)
      grabOrigin.copy(hit.point)
      if (controls) controls.enabled = false
      renderer.domElement.setPointerCapture(ev.pointerId)
    }

    function onMove(ev: PointerEvent) {
      if (dragIdx < 0) return
      setNdc(ev)
      if (!ray.ray.intersectPlane(dragPlane, hitPoint)) return
      const off = hitPoint.clone().sub(grabOrigin)
      if (off.length() > DRAG_MAX) off.setLength(DRAG_MAX)
      const tx = grabOrigin.x + off.x
      const ty = grabOrigin.y + off.y
      const tz = grabOrigin.z + off.z
      const i = dragIdx * 3
      pos[i] = tx
      pos[i + 1] = ty
      pos[i + 2] = tz
      // 同步 prev，避免拖拽产生极大的隐含速度把布料弹飞
      prev[i] = tx
      prev[i + 1] = ty
      prev[i + 2] = tz
    }

    function onUp() {
      if (dragIdx >= 0) {
        dragIdx = -1
        if (controls) controls.enabled = true
      }
    }

    /** 双击撕裂：半径内的约束与面片一起删掉 */
    function onTear(ev: MouseEvent) {
      const r = renderer.domElement.getBoundingClientRect()
      ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1
      ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1
      ray.setFromCamera(ndc, ctx.camera)
      const hit = ray.intersectObject(cloth, false)[0]
      if (!hit) return
      const p = hit.point
      // 必须是三维球半径：只按 XZ 距离判断会把整条纵向布幅都剪断，布直接塌成一条带子
      const R = 0.34
      const hit3 = (i: number) => {
        const dx = pos[i * 3] - p.x
        const dy = pos[i * 3 + 1] - p.y
        const dz = pos[i * 3 + 2] - p.z
        return dx * dx + dy * dy + dz * dz < R * R
      }
      for (const l of links) {
        if (!l.dead && hit3(l.a)) l.dead = true
      }
      for (let j = 0; j < NY - 1; j++) {
        for (let i = 0; i < NX - 1; i++) {
          if (hit3(j * NX + i)) deadQuad[j * (NX - 1) + i] = 1
        }
      }
      buildIndex()
    }

    renderer.domElement.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('dblclick', onTear)

    /* ---------------- 求解 ---------------- */
    const GRAV = -9.8
    let acc = 0
    const FIXED = 1 / 200
    let time = 0

    function solve(dt: number) {
      const w = wind.value
      const t = time

      // 积分
      for (let i = 0; i < NP; i++) {
        if (pinned[i] || i === dragIdx) continue
        const c = i * 3
        const vx = (pos[c] - prev[c]) * 0.9992
        const vy = (pos[c + 1] - prev[c + 1]) * 0.9992
        const vz = (pos[c + 2] - prev[c + 2]) * 0.9992
        prev[c] = pos[c]
        prev[c + 1] = pos[c + 1]
        prev[c + 2] = pos[c + 2]

        const x = pos[c]
        const y = pos[c + 1]
        // 风：主方向沿 +Z，叠加随位置与时间变化的湍流，布面才会翻滚而不是整体平移
        const gust = 0.55 + 0.45 * Math.sin(t * 0.85) * Math.sin(t * 0.31 + 1.2)
        const fz = -w * (4.4 * gust + Math.sin(t * 3.1 + x * 2.3 + y * 1.5) * 2.8)
        const fx = w * Math.sin(t * 2.2 + y * 1.9) * 1.2
        const fy = w * Math.sin(t * 1.6 + x * 1.2) * 0.6 + GRAV

        pos[c] = x + vx + fx * dt * dt
        pos[c + 1] = y + vy + fy * dt * dt
        pos[c + 2] = pos[c + 2] + vz + fz * dt * dt
      }

      // 约束松弛
      const K = stiffness.value
      for (let it = 0; it < ITER; it++) {
        for (let l = 0; l < links.length; l++) {
          const link = links[l]
          if (link.dead) continue
          const a = link.a * 3
          const b = link.b * 3
          const dx = pos[b] - pos[a]
          const dy = pos[b + 1] - pos[a + 1]
          const dz = pos[b + 2] - pos[a + 2]
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
          if (d < 1e-6) continue
          const diff = ((d - link.rest) / d) * link.k * K * 0.5
          const wa = pinned[link.a] || link.a === dragIdx ? 0 : 1
          const wb = pinned[link.b] || link.b === dragIdx ? 0 : 1
          const sum = wa + wb
          if (sum === 0) continue
          const ka = (diff * 2 * wa) / sum
          const kb = (diff * 2 * wb) / sum
          pos[a] += dx * ka
          pos[a + 1] += dy * ka
          pos[a + 2] += dz * ka
          pos[b] -= dx * kb
          pos[b + 1] -= dy * kb
          pos[b + 2] -= dz * kb
        }

        // 球体碰撞（两遍：先投影出去，再补一次约束附近的自穿插）
        for (let i = 0; i < NP; i++) {
          if (pinned[i]) continue
          const c = i * 3
          const dx = pos[c] - SPHERE_C.x
          const dy = pos[c + 1] - SPHERE_C.y
          const dz = pos[c + 2] - SPHERE_C.z
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
          if (d < SPHERE_R && d > 1e-5) {
            const s = SPHERE_R / d
            pos[c] = SPHERE_C.x + dx * s
            pos[c + 1] = SPHERE_C.y + dy * s
            pos[c + 2] = SPHERE_C.z + dz * s
          }
          if (pos[c + 1] < FLOOR_Y + 0.004) {
            pos[c + 1] = FLOOR_Y + 0.004
            // 地面摩擦：水平速度衰减
            prev[c] = prev[c] * 0.55 + pos[c] * 0.45
            prev[c + 2] = prev[c + 2] * 0.55 + pos[c + 2] * 0.45
          }
        }
      }
    }

    return (dt: number) => {
      time += dt
      const bx = Math.sin(time * 0.55) * 1.45
      ball.position.x = bx
      SPHERE_C.x = bx

      if (running.value) {
        acc = Math.min(acc + dt, 0.05)
        let steps = 0
        while (acc >= FIXED && steps < 6) {
          solve(FIXED)
          acc -= FIXED
          steps++
        }
      }

      const arr = posAttr.array as Float32Array
      arr.set(pos)
      posAttr.needsUpdate = true
      geo.computeVertexNormals()
      geo.computeBoundingSphere()
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>

    <div class="panel">
      <div class="title">
        <span class="dot" :class="{ live: running }"></span>
        布料模拟 · Verlet + PBD
      </div>
      <div class="sub">{{ vertCount }} 质点 · {{ linkCount }} 约束 · 每帧 6 次松弛</div>

      <div class="row">
        <button class="btn primary" @click="running = !running">
          {{ running ? '冻结' : '继续' }}
        </button>
      </div>

      <div class="ctrl">
        <span class="lab">风力</span>
        <input v-model.number="wind" type="range" min="0" max="3" step="0.05" />
        <b>{{ wind.toFixed(2) }}</b>
      </div>
      <div class="ctrl">
        <span class="lab">刚度</span>
        <input v-model.number="stiffness" type="range" min="0.4" max="1" step="0.02" />
        <b>{{ stiffness.toFixed(2) }}</b>
      </div>

      <div class="tip">
        速度由「当前位置 − 上一帧位置」隐含表达，无需显式存速度；约束用位置投影（PBD）迭代满足。
        <br />按住布料拖拽可拉扯，双击可撕裂，红色的球会来回穿过布面。
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
  width: 285px;
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
.ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 11px;
}
.ctrl .lab {
  flex: 0 0 26px;
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
  background: #6fb3f2;
  border: 2px solid #0e141c;
  cursor: pointer;
}
.ctrl b {
  flex: 0 0 34px;
  text-align: right;
  font-family: ui-monospace, monospace;
  color: #ffd479;
  font-size: 11.5px;
}
.tip {
  margin-top: 9px;
  font-size: 11px;
  line-height: 1.6;
  color: #7d8fa2;
}
</style>
