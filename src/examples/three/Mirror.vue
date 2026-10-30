<script setup lang="ts">
import { ref } from 'vue'
import * as THREE from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { useThree } from './useThree'

/* ============================================================
 * 实时镜面（Reflector）
 *  - 原理：镜子是一块平面几何，材质用「虚拟相机」先渲染一遍场景到 RenderTarget，
 *    再把 RT 以「屏幕空间投影坐标」采样回来 —— 虚拟相机的位置/投影 = 真实相机关于镜平面的镜像
 *  - 代价：每帧多渲一遍场景，所以拷一片 Reflector 就够了，别到处贴
 *  - 注意：镜面里不会出现透明物体的正确折射，也不参与自身的二次反射
 * ============================================================ */

const container = ref<HTMLDivElement>()
const reflectivity = ref(0.92) // 镜面反射强度（调 0 就是一块黑板）
const spinNose = ref(1) // 收纳架转不转
const showRoom = ref(true) // 是否显示地面以上的「房间框线」

useThree(
  container,
  {
    background: 0x070a10,
    cameraPos: [6.4, 3.5, 8.6],
    lookAt: [0, 0.9, 0],
    controls: true,
    shadows: true,
  },
  ({ scene, renderer }) => {
    /* ---- 环境光：程序化房间 → IBL（金属材质才有东西可反射） ---- */
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture
    scene.environment = envTex

    scene.add(new THREE.HemisphereLight(0x8ea6c8, 0x0a0d14, 0.35))

    const key = new THREE.DirectionalLight(0xfff0dd, 2.2)
    key.position.set(5.5, 8.5, 4.5)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.near = 1
    key.shadow.camera.far = 30
    key.shadow.camera.left = -10
    key.shadow.camera.right = 10
    key.shadow.camera.top = 10
    key.shadow.camera.bottom = -10
    key.shadow.bias = -0.0012
    scene.add(key)

    const rim = new THREE.DirectionalLight(0x6fa8ff, 1.1)
    rim.position.set(-6, 3.5, -5.5)
    scene.add(rim)

    /* ---- 镜面地板 ---- */
    const MIRROR_SIZE = 14
    const mirrorGeo = new THREE.PlaneGeometry(MIRROR_SIZE, MIRROR_SIZE)
    const mirror = new Reflector(mirrorGeo, {
      textureWidth: 1024 * window.devicePixelRatio,
      textureHeight: 1024 * window.devicePixelRatio,
      color: 0x8fa3bd,
    })
    mirror.rotation.x = -Math.PI / 2
    mirror.position.y = 0.001
    scene.add(mirror)

    // 镜面四周的深色包边，避免看到无限延伸的反射
    const frame = new THREE.Mesh(
      new THREE.RingGeometry(MIRROR_SIZE * 0.72, MIRROR_SIZE * 1.1, 4, 1),
      new THREE.MeshBasicMaterial({ color: 0x0a0e15, side: THREE.DoubleSide }),
    )
    frame.rotation.x = -Math.PI / 2
    frame.rotation.z = Math.PI / 4
    frame.position.y = 0.002
    scene.add(frame)

    /* ---- 地面之外：一圈微弱网格表示舞台 ---- */
    const grid = new THREE.GridHelper(28, 28, 0x1d2a3a, 0x141d29)
    grid.position.y = -0.002
    grid.visible = false
    scene.add(grid)

    /* ---- 场景内容：金属/玻璃混合的一组形体 ---- */
    const props = new THREE.Group()
    scene.add(props)

    const knotMat = new THREE.MeshStandardMaterial({
      color: 0xd9e2ee,
      metalness: 1,
      roughness: 0.08,
      envMapIntensity: 1.2,
    })
    const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.72, 0.24, 220, 32, 2, 3), knotMat)
    knot.position.set(0, 1.5, 0)
    knot.castShadow = true
    props.add(knot)

    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xa9d8ff,
      metalness: 0,
      roughness: 0.05,
      transmission: 0.92,
      thickness: 0.8,
      ior: 1.45,
      transparent: true,
      opacity: 0.55,
    })
    const glass = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 0), glassMat)
    glass.position.set(-2.6, 0.75, 1.7)
    glass.castShadow = true
    props.add(glass)

    const brass = new THREE.MeshStandardMaterial({
      color: 0xd8a54a,
      metalness: 1,
      roughness: 0.24,
      envMapIntensity: 1.1,
    })
    const brassBall = new THREE.Mesh(new THREE.SphereGeometry(0.55, 48, 32), brass)
    brassBall.position.set(2.5, 0.62, 1.4)
    brassBall.castShadow = true
    props.add(brassBall)

    const copperRing = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.12, 20, 96), brass)
    copperRing.position.set(-1.4, 1.15, -2.2)
    copperRing.rotation.x = Math.PI * 0.42
    copperRing.castShadow = true
    props.add(copperRing)

    // 三组小方块构成「阶梯」，让阴影执着地叠在镜面上
    const steps = new THREE.Group()
    for (let i = 0; i < 5; i++) {
      const h = 0.22 + i * 0.16
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.62, h, 0.62),
        new THREE.MeshStandardMaterial({
          color: [0x384a63, 0x43596f, 0x4e6a80, 0x5b7b91, 0x6a8ba3][i],
          roughness: 0.45,
          metalness: 0.35,
        }),
      )
      m.position.set(2.2 - i * 0.34, h / 2, -1.6 - i * 0.34)
      m.castShadow = true
      m.receiveShadow = true
      steps.add(m)
    }
    props.add(steps)

    // 房间框线：帮助判断反射的空间关系
    const room = new THREE.Group()
    const box = new THREE.BoxGeometry(14, 6, 14)
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x2b3d52 }),
    )
    edges.position.y = 3
    room.add(edges)
    scene.add(room)

    let t = 0
    return (dt) => {
      t += dt * spinNose.value
      knot.rotation.y = t * 0.55
      knot.rotation.x = Math.sin(t * 0.4) * 0.25
      glass.rotation.y = -t * 0.3
      copperRing.rotation.z = t * 0.8
      brassBall.position.y = 0.62 + Math.sin(t * 1.3) * 0.18
      key.position.set(Math.cos(t * 0.25) * 6.5, 8, Math.sin(t * 0.25) * 6.5)

      // 反射强度：直接改 Reflector 的 uniform，不必重建材质
      const u = (mirror.material as THREE.ShaderMaterial).uniforms
      const k = reflectivity.value
      u.color.value.setRGB(0.36 + k * 0.64, 0.42 + k * 0.58, 0.52 + k * 0.48)
      room.visible = showRoom.value
      grid.visible = !showRoom.value
      mirror.visible = reflectivity.value > 0.01
      frame.visible = reflectivity.value > 0.01
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="title">实时镜面 · Reflector</div>
      <div class="row">
        <span class="label">反射强度</span>
        <input v-model.number="reflectivity" class="range" type="range" min="0" max="1" step="0.01" />
        <span class="val">{{ (reflectivity * 100).toFixed(0) }}%</span>
      </div>
      <div class="row">
        <span class="label">旋转</span>
        <input v-model.number="spinNose" class="range" type="range" min="0" max="3" step="0.05" />
        <span class="val">{{ spinNose.toFixed(2) }}×</span>
      </div>
      <div class="row btns">
        <button class="chip" :class="{ on: showRoom }" @click="showRoom = !showRoom">
          {{ showRoom ? '隐藏房间框线' : '显示房间框线' }}
        </button>
      </div>
      <div class="tip">
        镜面本体是一块 PlaneGeometry，材质用虚拟相机（真实相机关于镜平面的镜像）先把场景渲进
        RenderTarget，再按屏幕空间投影坐标采样回来；每帧多渲染一遍场景，所以场景里只放这一面镜子。
        金属球/玻璃球用 RoomEnvironment 生成的 IBL 做环境反射，实体的投影则由 DirectionalLight
        的阴影贴图负责 —— 地面上看到的是「影子」，镜子里看到的是「虚像」，两者来源不同。
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
  width: 336px;
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
</style>
