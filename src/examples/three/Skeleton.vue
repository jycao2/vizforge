<script setup lang="ts">
import { ref } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()
const status = ref('模型加载中…')
const clipName = ref('')
const clipNames = ref<string[]>([])

const MODEL_URL =
  'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb'

let mixer: THREE.AnimationMixer | null = null
let actions: THREE.AnimationAction[] = []
let current = 0
let model: THREE.Object3D | null = null

useThree(
  container,
  {
    background: 0x0e141d,
    cameraPos: [0, 1.7, 4.6],
    lookAt: [0, 1, 0],
    controls: true,
    shadows: true,
  },
  ({ scene }) => {
    // 地面 + 光照
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: 0x18222e, roughness: 0.95 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    scene.add(ground)

    const hemi = new THREE.HemisphereLight(0xbfd7ff, 0x0b1018, 1.2)
    scene.add(hemi)
    const dir = new THREE.DirectionalLight(0xffffff, 2)
    dir.position.set(3, 6, 4)
    dir.castShadow = true
    dir.shadow.mapSize.set(1024, 1024)
    scene.add(dir)

    const loader = new GLTFLoader()
    loader.load(
      MODEL_URL,
      (gltf) => {
        model = gltf.scene
        model.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (mesh.isMesh) {
            mesh.castShadow = true
            mesh.receiveShadow = true
          }
        })
        scene.add(model)

        mixer = new THREE.AnimationMixer(model)
        clipNames.value = gltf.animations.map((c) => c.name)
        actions = gltf.animations.map((clip) => {
          const action = mixer!.clipAction(clip)
          action.play()
          action.enabled = false
          return action
        })
        if (actions.length) {
          actions[0].enabled = true
          actions[0].setEffectiveWeight(1)
          clipName.value = clipNames.value[0]
        }
        status.value = `已加载 ${gltf.animations.length} 个动画片段`
      },
      undefined,
      (e) => {
        status.value = '模型加载失败：' + String(e)
      },
    )

    return (dt) => {
      mixer?.update(dt)
    }
  },
)

function playClip(index: number) {
  if (!actions.length) return
  actions[current].enabled = false
  current = index
  actions[current].reset()
  actions[current].enabled = true
  actions[current].setEffectiveWeight(1)
  actions[current].play()
  clipName.value = clipNames.value[index]
}
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="panel">
      <div class="title">{{ clipName || '骨骼动画' }}</div>
      <div class="row">
        <button
          v-for="(name, i) in clipNames"
          :key="name"
          class="btn"
          :class="{ on: i === current }"
          @click="playClip(i)"
        >
          {{ name }}
        </button>
      </div>
      <div class="tip">{{ status }} · AnimationMixer 驱动 glTF 骨骼动画</div>
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
  max-width: 340px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #d7e2ee;
  backdrop-filter: blur(8px);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 8px;
  color: #e6eef7;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.btn {
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid rgba(90, 110, 135, 0.55);
  background: transparent;
  color: #c3cfdb;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn:hover {
  border-color: #4f9dff;
  color: #4f9dff;
}
.btn.on {
  background: #4f9dff;
  border-color: #4f9dff;
  color: #fff;
}
.tip {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b9aab;
}
</style>
