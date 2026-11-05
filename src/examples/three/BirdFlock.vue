<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js'

const container = ref<HTMLDivElement>()
const cohesion = ref(0.9)
const separation = ref(1.0)
const alignment = ref(0.6)
const fpsRef = ref(0)
const birdMatRef = shallowRef<THREE.ShaderMaterial | null>(null)

/**
 * GPGPU 鸟群（参考 three.js 官方 webgl_gpgpu_birds，核心逻辑重写）：
 * - 4096 只鸟的位置与速度各存一张 64×64 浮点纹理，每帧在片元着色器里整张重算。
 * - 速度着色器就是经典 Boids 三原则：分离（别撞车）/ 对齐（朝向邻居）/ 聚合（抱团），
 *   再叠加一个游走目标的吸引力；全部 4096×4096 的邻居关系都在 GPU 里暴力遍历。
 * - 几何只是每鸟一个三角形，顶点着色器按速度构造朝向、按速度大小扇翅膀——CPU 每帧
 *   只做一次 compute()，不碰任何单只鸟的数据。
 */

const WIDTH = 64 // 64×64 = 4096 只

// —— 位置纹理：上帧位置 + 速度 × dt，边界回卷 ——
const positionShader = /* glsl */ `
uniform float uDelta;
void main() {
  // GPUComputationRenderer 的 pass-through 顶点着色器不带 uv varying，
  // 所以纹理坐标只能自己从屏幕坐标反算（resolution 由它注入的 define 提供）
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pos = texture2D(texturePosition, uv);
  vec4 vel = texture2D(textureVelocity, uv);
  pos.xyz += vel.xyz * uDelta;
  // 飞出围栏就从对面回来（torus 空间，群永远在画面里）
  if (pos.x > 22.0) pos.x = -22.0; else if (pos.x < -22.0) pos.x = 22.0;
  if (pos.y > 12.0) pos.y = -12.0; else if (pos.y < -12.0) pos.y = 12.0;
  if (pos.z > 22.0) pos.z = -22.0; else if (pos.z < -22.0) pos.z = 22.0;
  gl_FragColor = pos;
}
`

// —— 速度纹理：Boids 三原则 + 目标吸引 + 限速 ——
const velocityShader = /* glsl */ `
uniform float uDelta;
uniform float uCohesion;
uniform float uSeparation;
uniform float uAlignment;
uniform vec3 uTarget;
uniform float uTime;

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 pos = texture2D(texturePosition, uv);
  vec4 vel = texture2D(textureVelocity, uv);

  vec3 sep = vec3(0.0);
  vec3 ali = vec3(0.0);
  vec3 coh = vec3(0.0);
  float cnt = 0.0;

  // 暴力遍历所有鸟找「邻居」。GLSL ES 1.0 循环边界必须是常量
  for (int y = 0; y < 64; y++) {
    for (int x = 0; x < 64; x++) {
      vec2 ref = (vec2(float(x), float(y)) + 0.5) / 64.0;
      vec4 otherPos = texture2D(texturePosition, ref);
      if (otherPos == pos) continue; // 自己
      vec3 d = otherPos.xyz - pos.xyz;
      float dist = length(d);
      if (dist < 4.0) {
        sep -= (d / max(dist * dist, 0.1)) * 3.0; // 越近斥力越强（1/d²）
        ali += texture2D(textureVelocity, ref).xyz;
        coh += otherPos.xyz;
        cnt += 1.0;
      }
    }
  }

  if (cnt > 0.0) {
    coh = (coh / cnt - pos.xyz) * 0.06 * uCohesion;    // 向邻居质心靠
    ali = (ali / cnt - vel.xyz) * 0.12 * uAlignment;   // 速度向邻居平均对齐
  }
  sep *= uSeparation;

  // 目标吸引：无人机视角下像一团被牵着的蜂群
  vec3 attract = (uTarget - pos.xyz) * 0.02;

  vec3 acc = sep + ali + coh + attract;
  vel.xyz += acc * uDelta * 60.0 * 0.45;

  // 轻微扰动，避免整群收敛成完美直线
  vel.xyz += vec3(
    sin(uTime * 3.1 + pos.x * 0.7),
    cos(uTime * 2.3 + pos.y * 0.9),
    sin(uTime * 2.7 + pos.z * 0.5)
  ) * 0.02;

  // 限速：太快太慢都拉回带内
  float speed = length(vel.xyz);
  if (speed > 4.5) vel.xyz = normalize(vel.xyz) * 4.5;
  else if (speed < 1.5) vel.xyz = normalize(vel.xyz + vec3(0.001)) * 1.5;

  gl_FragColor = vel;
}
`

// —— 鸟的几何：一个三角形（头 + 左右翼尖），朝向与扇翅在顶点着色器做 ——
const birdVertex = /* glsl */ `
uniform sampler2D texturePosition;
uniform sampler2D textureVelocity;
uniform float uTime;
attribute vec2 reference;
varying float vSpeed;

void main() {
  vec4 pos = texture2D(texturePosition, reference);
  vec4 vel = texture2D(textureVelocity, reference);
  float speed = length(vel.xyz);
  vSpeed = speed;

  // 按速度构造正交基（forward / right / up2）。
  // 参考轴不能写死 (0,1,0)：鸟近似垂直飞行时叉积趋近 0，normalize 出 NaN，
  // 光栅化会变成横扫全屏的垃圾三角形
  vec3 forward = normalize(vel.xyz + vec3(0.0001));
  vec3 ref0 = abs(forward.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(forward, ref0));
  vec3 up2 = cross(right, forward);

  // 翅膀扇动：频率随速度，折叠量随 |x|（翼尖动得多，身体不动）
  vec3 p = position;
  float flap = sin(uTime * (4.0 + speed * 1.6) + pos.x * 0.5) * 0.65;
  p.y += flap * abs(p.x);

  vec3 world = pos.xyz + right * p.x + up2 * p.y + forward * p.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`

const birdFragment = /* glsl */ `
varying float vSpeed;
void main() {
  // 慢 = 冷蓝，快 = 暖橙，一眼看出哪里在「冲刺」
  float t = clamp((vSpeed - 1.8) / 3.2, 0.0, 1.0);
  vec3 slow = vec3(0.18, 0.45, 0.95);
  vec3 fast = vec3(1.0, 0.62, 0.15);
  vec3 col = mix(slow, fast, t);
  gl_FragColor = vec4(col, 1.0);
}
`

useThree(
  container,
  {
    background: 0x070b14,
    cameraPos: [0, 16, 66],
    lookAt: [0, 0, 0],
    controls: true,
    far: 400,
  },
  ({ scene, renderer, camera }) => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))

    const gpu = new GPUComputationRenderer(WIDTH, WIDTH, renderer)

    // 初始位置：立方体内随机；初始速度：随机方向
    const posTex = gpu.createTexture()
    const velTex = gpu.createTexture()
    const pa = posTex.image.data as unknown as Float32Array
    const va = velTex.image.data as unknown as Float32Array
    for (let i = 0; i < pa.length; i += 4) {
      pa[i] = (Math.random() - 0.5) * 48
      pa[i + 1] = (Math.random() - 0.5) * 24
      pa[i + 2] = (Math.random() - 0.5) * 48
      const d = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5,
      ).normalize().multiplyScalar(4)
      va[i] = d.x
      va[i + 1] = d.y
      va[i + 2] = d.z
    }

    const posVar = gpu.addVariable('texturePosition', positionShader, posTex)
    const velVar = gpu.addVariable('textureVelocity', velocityShader, velTex)
    gpu.setVariableDependencies(posVar, [posVar, velVar])
    gpu.setVariableDependencies(velVar, [posVar, velVar])

    posVar.material.uniforms.uDelta = { value: 0 }
    velVar.material.uniforms.uDelta = { value: 0 }
    velVar.material.uniforms.uCohesion = { value: cohesion.value }
    velVar.material.uniforms.uSeparation = { value: separation.value }
    velVar.material.uniforms.uAlignment = { value: alignment.value }
    velVar.material.uniforms.uTarget = { value: new THREE.Vector3() }
    velVar.material.uniforms.uTime = { value: 0 }

    const err = gpu.init()
    if (err) console.error(err)
    // 切页释放 GPU 端的浮点纹理与 render target
    onBeforeUnmount(() => gpu.dispose())

    // —— 鸟群 mesh：每鸟一个三角形 ——
    const BIRDS = WIDTH * WIDTH
    const verts = new Float32Array(BIRDS * 3 * 3) // 3 顶点 xyz
    const refs = new Float32Array(BIRDS * 3 * 2) // 每顶点指向鸟的纹理坐标
    // 尺寸要和活动范围匹配：5 单位的大三角 × 4096 只会把整个视口糊满
    const tri = [
      [0, 0, 1.0], // 头（朝 +z）
      [0.72, 0, -0.7], // 右翼尖
      [-0.72, 0, -0.7], // 左翼尖
    ]
    for (let b = 0; b < BIRDS; b++) {
      const u = ((b % WIDTH) + 0.5) / WIDTH
      const v = (Math.floor(b / WIDTH) + 0.5) / WIDTH
      for (let t = 0; t < 3; t++) {
        verts.set(tri[t], (b * 3 + t) * 3)
        refs[(b * 3 + t) * 2] = u
        refs[(b * 3 + t) * 2 + 1] = v
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geo.setAttribute('reference', new THREE.BufferAttribute(refs, 2))

    const mat = new THREE.ShaderMaterial({
      vertexShader: birdVertex,
      fragmentShader: birdFragment,
      uniforms: {
        texturePosition: { value: null },
        textureVelocity: { value: null },
        uTime: { value: 0 },
      },
      side: THREE.DoubleSide,
    })
    birdMatRef.value = mat
    scene.add(new THREE.Mesh(geo, mat))

    // —— 鼠标目标：按住画布时鸟群被吸向指针射线上的一个点 ——
    const raycaster = new THREE.Raycaster()
    const mouseTarget = new THREE.Vector3(0, 0, 0)
    let holding = false
    const onDown = () => (holding = true)
    const onUp = () => (holding = false)
    const onMove = (e: PointerEvent) => {
      if (!holding) return
      const el = renderer.domElement
      const ndc = new THREE.Vector2(
        ((e.clientX - el.getBoundingClientRect().left) / el.clientWidth) * 2 - 1,
        -((e.clientY - el.getBoundingClientRect().top) / el.clientHeight) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      // 取视线上离相机 60 单位的点，跟随感自然
      mouseTarget.copy(raycaster.ray.at(60, new THREE.Vector3()))
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointermove', onMove)

    let t = 0
    let frames = 0
    let fpsClock = 0

    return (dt) => {
      t += dt
      posVar.material.uniforms.uDelta.value = dt
      velVar.material.uniforms.uDelta.value = dt
      velVar.material.uniforms.uCohesion.value = cohesion.value
      velVar.material.uniforms.uSeparation.value = separation.value
      velVar.material.uniforms.uAlignment.value = alignment.value
      velVar.material.uniforms.uTime.value = t
      // 没按住鼠标时目标沿 Lissajous 曲线游走
      if (!holding) {
        mouseTarget.set(
          Math.sin(t * 0.35) * 11,
          Math.sin(t * 0.5) * 5,
          Math.cos(t * 0.28) * 11,
        )
      }
      velVar.material.uniforms.uTarget.value.copy(mouseTarget)
      gpu.compute()
      mat.uniforms.texturePosition.value = gpu.getCurrentRenderTarget(posVar).texture
      mat.uniforms.textureVelocity.value = gpu.getCurrentRenderTarget(velVar).texture
      mat.uniforms.uTime.value = t

      frames++
      fpsClock += dt
      if (fpsClock > 0.5) {
        fpsRef.value = Math.round(frames / fpsClock)
        frames = 0
        fpsClock = 0
      }
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">聚合</span>
        <input
          class="range"
          type="range"
          min="0"
          max="2"
          step="0.05"
          :value="cohesion"
          @input="cohesion = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ cohesion.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">分离</span>
        <input
          class="range"
          type="range"
          min="0"
          max="2"
          step="0.05"
          :value="separation"
          @input="separation = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ separation.toFixed(2) }}</span>
      </div>
      <div class="row">
        <span class="label">对齐</span>
        <input
          class="range"
          type="range"
          min="0"
          max="2"
          step="0.05"
          :value="alignment"
          @input="alignment = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ alignment.toFixed(2) }}</span>
      </div>
      <div class="meta">4096 只 · {{ fpsRef }} FPS</div>
      <div class="tip">
        位置与速度各是一张 64×64 纹理，Boids 三原则（分离 / 对齐 / 聚合）在片元着色器里暴力遍历邻居；
        按住画布拖动可把鸟群吸向指针。颜色按速度从蓝到橙。
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
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 310px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.label {
  font-size: 12px;
  color: #9fb0c2;
  white-space: nowrap;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  font-size: 12px;
  color: #7ee787;
  width: 36px;
  text-align: right;
}
.meta {
  font-size: 11.5px;
  color: #7ee787;
  margin-top: 2px;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
