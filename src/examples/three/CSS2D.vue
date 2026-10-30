<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { useThree } from './useThree'

const container = ref<HTMLDivElement>()

const NODES = [
  { name: '数据接入', value: '12.4k/s', pos: [-3.4, 2.6, -1.2], color: 0x4f9dff },
  { name: '实时计算', value: '86 ms', pos: [-0.6, 3.6, 0.9], color: 0x7ee787 },
  { name: '特征存储', value: '94.2%', pos: [2.6, 2.4, -1.6], color: 0x22d3ee },
  { name: '模型推理', value: '1.8k qps', pos: [3.8, 1.2, 1.4], color: 0xffc46b },
  { name: '告警中心', value: '3 待处理', pos: [0.4, 1.2, 2.8], color: 0xff7b72 },
  { name: '日志归档', value: '218 GB', pos: [-2.4, 1.0, 2.2], color: 0xb392f0 },
] as const

useThree(
  container,
  {
    background: 0x070a11,
    cameraPos: [0, 4.6, 9.4],
    lookAt: [0, 2.0, 0],
    controls: true,
  },
  ({ scene, camera }) => {
    // CSS2DRenderer 把 DOM 元素按投影坐标平铺在 canvas 之上
    const labelRenderer = new CSS2DRenderer()
    labelRenderer.domElement.style.position = 'absolute'
    labelRenderer.domElement.style.top = '0'
    labelRenderer.domElement.style.left = '0'
    labelRenderer.domElement.style.pointerEvents = 'none'
    container.value?.appendChild(labelRenderer.domElement)

    const group = new THREE.Group()
    scene.add(group)

    const points: THREE.Vector3[] = []

    NODES.forEach((n) => {
      const p = new THREE.Vector3(...n.pos)
      points.push(p)

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 32, 24),
        new THREE.MeshStandardMaterial({
          color: n.color,
          emissive: new THREE.Color(n.color),
          emissiveIntensity: 1.1,
          roughness: 0.3,
        }),
      )
      mesh.position.copy(p)
      group.add(mesh)

      // 地面光柱，增强空间感
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, p.y, 8),
        new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.22 }),
      )
      beam.position.set(p.x, p.y / 2, p.z)
      group.add(beam)

      // HTML 标签：两行文字，由 CSS 控制样式（不受 canvas 分辨率影响）
      const el = document.createElement('div')
      el.className = 'node-label'
      el.innerHTML = `<b>${n.name}</b><i>${n.value}</i>`
      const label = new CSS2DObject(el)
      label.position.set(0, 0.62, 0)
      mesh.add(label)
    })

    // 节点之间的连线
    const linePositions: number[] = []
    const links: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [1, 4], [0, 5], [4, 5], [2, 4],
    ]
    for (const [a, b] of links) {
      linePositions.push(points[a].x, points[a].y, points[a].z)
      linePositions.push(points[b].x, points[b].y, points[b].z)
    }
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3))
    group.add(
      new THREE.LineSegments(
        lineGeo,
        new THREE.LineBasicMaterial({ color: 0x2f6ea8, transparent: true, opacity: 0.55 }),
      ),
    )

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(14, 72),
      new THREE.MeshStandardMaterial({ color: 0x0e141d, roughness: 1 }),
    )
    ground.rotation.x = -Math.PI / 2
    scene.add(ground)

    scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x11151c, 1.1))

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

    return (dt) => {
      group.rotation.y += dt * 0.22
      labelRenderer.render(scene, camera)
    }
  },
)
</script>

<template>
  <div class="wrap">
    <div ref="container" class="three-container"></div>
    <div class="tip">
      CSS2DRenderer 把 DOM 元素按 3D 坐标投影到屏幕上，标签始终正对屏幕、文字清晰，适合数据看板的
      节点说明。
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
.tip {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 5;
  width: 360px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(17, 24, 34, 0.86);
  border: 1px solid rgba(90, 110, 135, 0.45);
  color: #b9c8d8;
  font-size: 11.5px;
  line-height: 1.55;
  pointer-events: none;
}

/* CSS2DObject 的 DOM 由 JS 创建，需用 :deep 才能命中 scoped 样式 */
:deep(.node-label) {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 4px 9px;
  border-radius: 7px;
  background: rgba(13, 19, 27, 0.86);
  border: 1px solid rgba(79, 157, 255, 0.45);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
  transform: translateY(-4px);
}
:deep(.node-label b) {
  font-size: 11.5px;
  font-weight: 600;
  color: #eaf2fb;
}
:deep(.node-label i) {
  font-style: normal;
  font-size: 10.5px;
  color: #63c9ff;
}
</style>
