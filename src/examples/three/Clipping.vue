<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import * as THREE from 'three'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const axis = ref<'x' | 'y' | 'z'>('x')
const position = ref(0)
const showPlane = ref(true)
const groupRef = shallowRef<THREE.Group | null>(null)

/**
 * 截面剖切（参考 three.js 官方 webgl_clipping / webgl_clipping_stencil）：
 * - renderer.localClippingEnabled + material.clippingPlanes，GPU 按平面半空间裁剪片元。
 * - 剖面盖帽不做 stencil（那需要一整套模板缓冲流程），用「双面材质 + gl_FrontFacing
 *   分支给背面染发光橙」的经典近似：剖开后看到的内壁就是剖面，效果直观且代码量小。
 * - 平面指示器：半透明青色平面随剖切参数同步移动。
 */

const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0)

/** 给 MeshStandardMaterial 注入剖面着色：背面 = 剖面 */
function withSectionGlow(mat: THREE.MeshStandardMaterial) {
  mat.side = THREE.DoubleSide
  mat.onBeforeCompile = (shader) => {
    // 手动补一个世界坐标 varying（标准材质默认不带）
    shader.vertexShader =
      'varying vec3 vWorldPosition;\n' +
      shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )
    shader.fragmentShader =
      'varying vec3 vWorldPosition;\n' +
      shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        /* glsl */ `
          #include <dithering_fragment>
          if (!gl_FrontFacing) {
            // 剖面：暖橙发光色 + 立体网格刻度（三轴取 max，任意剖切方向都能看到刻度）
            vec3 wp = vWorldPosition * 4.0;
            float grid = max(
              max(smoothstep(0.44, 0.5, abs(fract(wp.x) - 0.5)),
                  smoothstep(0.44, 0.5, abs(fract(wp.y) - 0.5))),
              smoothstep(0.44, 0.5, abs(fract(wp.z) - 0.5))
            );
            vec3 secCol = mix(vec3(1.0, 0.42, 0.10), vec3(1.0, 0.88, 0.62), grid * 0.7);
            gl_FragColor.rgb = secCol;
          }
        `,
      )
  }
  return mat
}

useThree(
  container,
  {
    background: 0x0a0e18,
    cameraPos: [4.6, 3.2, 5.4],
    lookAt: [0, 0, 0],
    controls: true,
    shadows: true,
  },
  ({ scene, renderer }) => {
    // 剖切必须打开这个开关（局部剖切指材质级 clippingPlanes）
    renderer.localClippingEnabled = true

    scene.add(new THREE.AmbientLight(0x8899bb, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 2.4)
    key.position.set(5, 8, 4)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x4f9dff, 1.1)
    rim.position.set(-6, 2, -5)
    scene.add(rim)

    const group = new THREE.Group()
    groupRef.value = group

    // 「神秘装置」：中心环面结 + 内核球 + 两圈轨道球
    const knotMat = withSectionGlow(
      new THREE.MeshStandardMaterial({
        color: 0x9fb6d8,
        metalness: 0.85,
        roughness: 0.3,
        clippingPlanes: [clipPlane],
      }),
    )
    const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.15, 0.42, 220, 36), knotMat)
    knot.castShadow = true
    group.add(knot)

    const coreMat = withSectionGlow(
      new THREE.MeshStandardMaterial({
        color: 0x66ffd0,
        metalness: 0.4,
        roughness: 0.25,
        emissive: 0x0d5c46,
        clippingPlanes: [clipPlane],
      }),
    )
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 2), coreMat)
    group.add(core)

    const orbitMat = withSectionGlow(
      new THREE.MeshStandardMaterial({
        color: 0xd8b24f,
        metalness: 0.9,
        roughness: 0.35,
        clippingPlanes: [clipPlane],
      }),
    )
    for (let ring = 0; ring < 2; ring++) {
      const r = ring === 0 ? 2.1 : 2.7
      const n = ring === 0 ? 10 : 14
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + ring * 0.3
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 18, 14), orbitMat)
        m.position.set(
          Math.cos(a) * r,
          Math.sin(a * 2 + ring) * 0.55,
          Math.sin(a) * r,
        )
        m.castShadow = true
        group.add(m)
      }
    }
    // 包一层透明外壳：剖切开关演示「外亮内暗」
    const shellMat = new THREE.MeshPhysicalMaterial({
      color: 0x88ccff,
      transparent: true,
      opacity: 0.08,
      roughness: 0.1,
      metalness: 0,
      side: THREE.DoubleSide,
    })
    group.add(new THREE.Mesh(new THREE.SphereGeometry(3.4, 48, 32), shellMat))
    scene.add(group)

    // 地面接收阴影
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(7, 64),
      new THREE.MeshStandardMaterial({ color: 0x121a2a, roughness: 0.95 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -3.6
    ground.receiveShadow = true
    scene.add(ground)

    // 剖切平面指示器
    const planeHelper = new THREE.Mesh(
      new THREE.PlaneGeometry(7.6, 7.6),
      new THREE.MeshBasicMaterial({
        color: 0x53e0ff,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    const planeOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(7.6, 7.6)),
      new THREE.LineBasicMaterial({ color: 0x53e0ff }),
    )
    const planeGroup = new THREE.Group()
    planeGroup.add(planeHelper, planeOutline)
    scene.add(planeGroup)

    function applyClip() {
      const n = new THREE.Vector3(
        axis.value === 'x' ? 1 : 0,
        axis.value === 'y' ? 1 : 0,
        axis.value === 'z' ? 1 : 0,
      )
      // 平面法线取负方向：constant 增大 = 剖掉的越多
      clipPlane.normal.copy(n).multiplyScalar(-1)
      clipPlane.constant = position.value
      // 指示器姿态对齐平面
      planeGroup.position.copy(n).multiplyScalar(-position.value)
      planeGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n)
      planeGroup.visible = showPlane.value
    }
    applyClip()

    return (dt) => {
      group.rotation.y += dt * 0.25
      applyClip()
    }
  },
)

function setAxis(a: 'x' | 'y' | 'z') {
  axis.value = a
  position.value = 0
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="row">
        <span class="label">剖切轴</span>
        <button
          v-for="a in ['x', 'y', 'z'] as const"
          :key="a"
          class="btn"
          :class="{ active: axis === a }"
          @click="setAxis(a)"
        >
          {{ a.toUpperCase() }}
        </button>
        <button class="btn" :class="{ active: showPlane }" @click="showPlane = !showPlane">
          平面
        </button>
      </div>
      <div class="row">
        <span class="label">剖切位置</span>
        <input
          class="range"
          type="range"
          min="-3.5"
          max="3.5"
          step="0.05"
          :value="position"
          @input="position = Number(($event.target as HTMLInputElement).value)"
        />
        <span class="val">{{ position.toFixed(2) }}</span>
      </div>
      <div class="tip">
        material.clippingPlanes 在 GPU 上按半空间裁剪片元；剖开后内壁用 gl_FrontFacing
        分支染成发光橙（stencil 盖帽的轻量替代），拖「剖切位置」即可看穿装置内部结构。
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
  width: 320px;
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
  gap: 8px;
  margin-bottom: 8px;
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
  width: 42px;
  text-align: right;
}
.btn {
  padding: 2px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.5);
  background: rgba(30, 42, 60, 0.7);
  color: #9fb0c2;
  cursor: pointer;
}
.btn.active {
  background: #1f5c9e;
  color: #fff;
  border-color: #4f9dff;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
