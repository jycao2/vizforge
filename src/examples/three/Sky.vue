<script setup lang="ts">
import { ref } from 'vue'
import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const elevation = ref(22)
const azimuth = ref(150)
const turbidity = ref(8)

let sky: Sky | null = null
let sunDir = new THREE.Vector3()
let dirLight: THREE.DirectionalLight | null = null

useThree(
  container,
  {
    background: 0x0b1220,
    cameraPos: [26, 9.5, 26],
    lookAt: [0, 5.5, 0],
    controls: true,
    shadows: true,
    // 天空盒尺寸 45 万，远裁剪面必须放大，否则整个天球会被裁掉
    near: 1,
    far: 2000000,
  },
  ({ scene, camera, renderer }) => {
    // 天空用一个超大盒子 + Preetham 大气散射着色器实现
    sky = new Sky()
    sky.scale.setScalar(450000)
    scene.add(sky)

    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.55

    scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x2a2f3a, 0.55))

    dirLight = new THREE.DirectionalLight(0xfff2d0, 3.2)
    dirLight.castShadow = true
    dirLight.shadow.mapSize.set(2048, 2048)
    dirLight.shadow.camera.near = 1
    dirLight.shadow.camera.far = 220
    dirLight.shadow.bias = -0.0008
    dirLight.shadow.normalBias = 0.06
    const d = 34
    const shadowCam = dirLight.shadow.camera as THREE.OrthographicCamera
    shadowCam.left = -d
    shadowCam.right = d
    shadowCam.top = d
    shadowCam.bottom = -d
    shadowCam.updateProjectionMatrix()
    scene.add(dirLight)

    // 地面
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(3000, 128),
      new THREE.MeshStandardMaterial({ color: 0x5c6879, roughness: 0.88, metalness: 0.04 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    // 一组几何体，用来展示太阳方向对明暗与投影的影响
    const geos: THREE.BufferGeometry[] = [
      new THREE.BoxGeometry(2, 5, 2),
      new THREE.IcosahedronGeometry(1.6, 1),
      new THREE.TorusKnotGeometry(1.1, 0.36, 160, 24),
      new THREE.ConeGeometry(1.6, 4, 40),
      new THREE.CylinderGeometry(0.9, 0.9, 4.4, 40),
      new THREE.SphereGeometry(1.5, 48, 32),
    ]
    const mats = [0xdbe6f2, 0x8fa6c0, 0x4f9dff, 0xffc46b, 0xb392f0, 0x7ee787]
    const heights = [2.5, 1.6, 1.5, 2.0, 2.2, 1.5]
    geos.forEach((geo, i) => {
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: mats[i],
          roughness: 0.45,
          metalness: 0.25,
        }),
      )
      const a = (i / geos.length) * Math.PI * 2
      mesh.position.set(Math.cos(a) * 7.5, heights[i], Math.sin(a) * 7.5)
      mesh.castShadow = true
      mesh.receiveShadow = true
      scene.add(mesh)
    })

    updateSun()
    void camera

    return () => {
      // 太阳方向静止，场景只做轻微展示性旋转
    }
  },
)

/** 由高度角 / 方位角算出太阳方向，同步给 Sky 与平行光 */
function updateSun() {
  if (!sky || !dirLight) return
  const phi = THREE.MathUtils.degToRad(90 - elevation.value)
  const theta = THREE.MathUtils.degToRad(azimuth.value)
  sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta)

  const uniforms = sky.material.uniforms
  uniforms.sunPosition.value.copy(sunDir)
  uniforms.turbidity.value = turbidity.value
  uniforms.rayleigh.value = 2.1
  uniforms.mieCoefficient.value = 0.005
  uniforms.mieDirectionalG.value = 0.8

  dirLight.position.copy(sunDir).multiplyScalar(80)
  dirLight.color.setHSL(
    0.09,
    0.55,
    THREE.MathUtils.clamp(0.55 + elevation.value / 120, 0.55, 0.95),
  )
}

function onElevation(v: number) {
  elevation.value = v
  updateSun()
}
function onAzimuth(v: number) {
  azimuth.value = v
  updateSun()
}
function onTurbidity(v: number) {
  turbidity.value = v
  updateSun()
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="title">大气散射天空 · Preetham</div>
      <div class="row">
        <span class="label">太阳高度</span>
        <input
          class="range"
          type="range"
          min="-3"
          max="88"
          step="1"
          :value="elevation"
          @input="onElevation(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ elevation }}°</span>
      </div>
      <div class="row">
        <span class="label">太阳方位</span>
        <input
          class="range"
          type="range"
          min="0"
          max="360"
          step="1"
          :value="azimuth"
          @input="onAzimuth(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ azimuth }}°</span>
      </div>
      <div class="row">
        <span class="label">浑浊度</span>
        <input
          class="range"
          type="range"
          min="1"
          max="20"
          step="0.5"
          :value="turbidity"
          @input="onTurbidity(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="val">{{ turbidity }}</span>
      </div>
      <div class="tip">
        Sky 着色器按太阳方向实时解算天光；拖到负高度角可看到日落后的霞光过渡。
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
  width: 300px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(15, 21, 30, 0.82);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: #e6eef7;
  margin-bottom: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
.label {
  width: 56px;
  font-size: 11.5px;
  color: #9fb0c2;
  white-space: nowrap;
}
.range {
  flex: 1;
  accent-color: #4f9dff;
}
.val {
  width: 40px;
  text-align: right;
  font-size: 11.5px;
  color: #ffc46b;
}
.tip {
  margin-top: 9px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
