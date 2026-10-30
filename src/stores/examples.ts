import { defineStore } from 'pinia'
import type {
  TechCategory,
  ExampleMeta,
  ComponentLoader,
  SourceLoader,
} from '@/types/example'

/**
 * 通过 Vite 的 glob 能力自动收集所有示例：
 *  - 组件：`import.meta.glob(..., { lazy })` 默认懒加载
 *  - 源码：`import.meta.glob(..., { query: '?raw' })` 读取原始文本
 * 这样新增示例组件后无需再手动登记加载器。
 */
const rawComponents = import.meta.glob('../examples/**/*.vue') as unknown as Record<
  string,
  ComponentLoader
>
const rawSources = import.meta.glob('../examples/**/*.vue', {
  query: '?raw',
  import: 'default',
}) as unknown as Record<string, SourceLoader>

/** 把 glob 的 key（../examples/cesium/BasicGlobe.vue）归一化为 cesium/BasicGlobe.vue */
function normalizeKey(path: string): string {
  return path.replace(/^\.\.\/examples\//, '')
}

const componentMap: Record<string, ComponentLoader> = {}
const sourceMap: Record<string, SourceLoader> = {}
for (const path in rawComponents) componentMap[normalizeKey(path)] = rawComponents[path]
for (const path in rawSources) sourceMap[normalizeKey(path)] = rawSources[path]

/**
 * 示例目录 store
 * 大类 = 技术栈（Cesium / Three.js / OpenLayers / WebGL）
 * 小类 = 该技术栈下的具体示例
 */
export const useExamplesStore = defineStore('examples', {
  state: () => ({
    categories: [
      {
        id: 'cesium',
        name: 'Cesium',
        icon: '🌍',
        description: '三维地球与地理空间可视化引擎，基于 WebGL 的地球渲染。',
        examples: [
          {
            id: 'basic-globe',
            title: '基础地球',
            description: '内置放大/缩小/复位/全屏工具栏，支持矢量、影像、地形、浅色、深色底图切换。',
            file: 'cesium/BasicGlobe.vue',
          },
          {
            id: 'entities',
            title: '实体与标注',
            description: '添加点、标签、多边形与折线等实体要素并飞入视角。',
            file: 'cesium/Entities.vue',
          },
          {
            id: 'camera-flight',
            title: '相机飞行',
            description: '在世界多个城市之间自动巡航飞行，演示相机动画。',
            file: 'cesium/CameraFlight.vue',
          },
          {
            id: 'picking',
            title: '点击拾取坐标',
            description: '在地球上点击，实时拾取经纬度与高度并打点标记。',
            file: 'cesium/Picking.vue',
          },
          {
            id: 'draw-polygon',
            title: '交互绘制多边形',
            description: '左键加点、右键结束，动态预览并生成多边形面。',
            file: 'cesium/DrawPolygon.vue',
          },
          {
            id: 'model',
            title: '加载 glTF 模型',
            description: '通过 Model.fromGltfAsync 加载并定位一个 glTF 模型。',
            file: 'cesium/ModelLoad.vue',
          },
          {
            id: '3d-tiles',
            title: '3D Tiles 建筑',
            description: '加载 3D Tiles 瓦片集，按建筑高度分色，演示倾斜/白模数据的渲染。',
            file: 'cesium/Tiles3D.vue',
          },
          {
            id: 'trajectory',
            title: '轨迹回放',
            description: 'SampledPositionProperty + Path 让实体沿航线移动并留下发光轨迹，可暂停/倍速/重播。',
            file: 'cesium/Trajectory.vue',
          },
          {
            id: 'measure',
            title: '距离面积量算',
            description: '左键加点、右键结束，实时计算大地线长度与多边形面积并标注在地图上。',
            file: 'cesium/Measure.vue',
          },
          {
            id: 'weather',
            title: '天气特效',
            description: 'PostProcessStage 全屏 GLSL 后期，可切换下雨、下雪、大雾三种天气。',
            file: 'cesium/Weather.vue',
          },
          {
            id: 'satellite',
            title: '卫星轨道',
            description: '按轨道倾角与升交点赤经生成三条圆轨道，三颗卫星同时绕地运行。',
            file: 'cesium/Satellite.vue',
          },
          {
            id: 'swipe',
            title: '卷帘对比',
            description: '利用 scene.splitPosition 左右分屏，拖动分隔条对比两种底图。',
            file: 'cesium/Swipe.vue',
          },
          {
            id: 'fly-line',
            title: 'OD 飞线',
            description: '抛物线弧 + PolylineGlow 发光，配合 CallbackProperty 驱动的流动光点，最经典的大屏飞线。',
            file: 'cesium/FlyLine.vue',
          },
          {
            id: 'radar',
            title: '雷达扫描',
            description: '扩散圆环 + 旋转扫描扇面，用 CallbackProperty 逐帧重算半径与顶点。',
            file: 'cesium/Radar.vue',
          },
          {
            id: 'popup',
            title: '点击信息弹窗',
            description: 'scene.pick 拾取实体，postRender 里把世界坐标投影为屏幕坐标，让 DOM 弹窗跟随地图。',
            file: 'cesium/Popup.vue',
          },
          {
            id: 'sun-shadow',
            title: '日照阴影分析',
            description:
              '街区体块 + 真实太阳位置：clock 驱动 Cesium 解算日照与 shadowMap 投影，采样点用射线-长方体求交判定遮挡。',
            file: 'cesium/SunShadow.vue',
          },
          {
            id: 'typhoon',
            title: '台风路径与风圈',
            description:
              '西北太平洋台风过程：Catmull-Rom 样条路径、三层风圈随强度联动、程序化四臂螺旋云系，播放倍速与跟随视角齐备。',
            file: 'cesium/Typhoon.vue',
          },
          {
            id: 'city-model',
            title: '城市白模',
            description: '256 个街区 PolygonGraphics 按 extrudedHeight 拉伸，高度分色模拟 CBD 高楼群。',
            file: 'cesium/CityModel.vue',
          },
          {
            id: 'heatmap-overlay',
            title: '城市热力图',
            description:
              '径向渐变叠加成密度场 → 256 级色带查表 → 自定义材质的 RectangleGeometry 贴回球面，半径/强度/色带实时可调。',
            file: 'cesium/HeatmapOverlay.vue',
          },
        ],
      },
      {
        id: 'three',
        name: 'Three.js',
        icon: '🧊',
        description: '通用的 WebGL 3D 渲染库，适合任意三维场景与特效。',
        examples: [
          {
            id: 'cube',
            title: '旋转立方体',
            description: '使用 MeshNormalMaterial 渲染一个持续旋转的立方体。',
            file: 'three/Cube.vue',
          },
          {
            id: 'lights-sphere',
            title: '光照球体',
            description: '基于 MeshStandardMaterial 与方向光、环境光渲染的球体。',
            file: 'three/LightsSphere.vue',
          },
          {
            id: 'particles',
            title: '粒子星空',
            description: '使用 Points 渲染上千个粒子组成的旋转星空。',
            file: 'three/Particles.vue',
          },
          {
            id: 'orbit-controls',
            title: '轨道控制器',
            description: '使用 OrbitControls 实现拖拽旋转、滚轮缩放、右键平移。',
            file: 'three/OrbitControls.vue',
          },
          {
            id: 'gltf-model',
            title: '加载 glTF 模型',
            description: '用 GLTFLoader 加载 Duck.glb，自动居中缩放并支持交互。',
            file: 'three/GltfModel.vue',
          },
          {
            id: 'raycaster',
            title: '射线拾取',
            description: '用 Raycaster 检测鼠标命中的物体并高亮显示。',
            file: 'three/Raycaster.vue',
          },
          {
            id: 'shadow',
            title: '阴影与光照',
            description: 'DirectionalLight 投射 PCF 软阴影，几何体落地投影随动画实时更新。',
            file: 'three/Shadow.vue',
          },
          {
            id: 'instancing',
            title: '实例化渲染',
            description: 'InstancedMesh 一次 draw call 渲染 6000 个立方体，逐实例矩阵与颜色。',
            file: 'three/Instancing.vue',
          },
          {
            id: 'bloom',
            title: '泛光后期',
            description: 'EffectComposer + UnrealBloomPass 实现发光后期，可调节泛光强度。',
            file: 'three/Bloom.vue',
          },
          {
            id: 'water-shader',
            title: '着色器水波',
            description: 'ShaderMaterial 自定义顶点位移与片元配色，实时生成正弦波水面。',
            file: 'three/WaterShader.vue',
          },
          {
            id: 'skeleton',
            title: '骨骼动画',
            description: 'GLTFLoader + AnimationMixer 播放 Soldier.glb 的多个动作片段。',
            file: 'three/Skeleton.vue',
          },
          {
            id: 'env-map',
            title: '环境反射',
            description: 'PMREMGenerator + RoomEnvironment 生成 IBL 环境贴图，金属材质呈现真实反射。',
            file: 'three/EnvMap.vue',
          },
          {
            id: 'point-cloud',
            title: '点云渲染',
            description: '14 万点单次 draw call：斐波那契球面采样 + vertexColors，可调点大小。',
            file: 'three/PointCloud.vue',
          },
          {
            id: 'sky',
            title: '大气散射天空',
            description: 'Sky 着色器按太阳高度角/方位角实时解算天光，拖到负角度可见日落霞光。',
            file: 'three/Sky.vue',
          },
          {
            id: 'outline',
            title: '描边选中',
            description: 'OutlinePass 后期描边：点击模型高亮发光，模型点选的标准做法。',
            file: 'three/Outline.vue',
          },
          {
            id: 'css2d',
            title: 'HTML 标签',
            description: 'CSS2DRenderer 把 DOM 元素投影到 3D 坐标上，做数据看板的节点说明。',
            file: 'three/CSS2D.vue',
          },
          {
            id: 'cloth',
            title: '布料模拟',
            description:
              'Verlet 积分 + PBD 约束松弛：40×26 质点的平纹布料，风力湍流、球体碰撞、拖拽拉扯与双击撕裂。',
            file: 'three/Cloth.vue',
          },
          {
            id: 'dam',
            title: '大坝开闸放水',
            description:
              '重力坝 + 5 孔弧形闸门：点选闸门绕铰链抬升，水舌沿 ogee 溢流面下泄，坝趾水花与雾化随开度联动。',
            file: 'three/Dam.vue',
          },
          {
            id: 'engine',
            title: '发动机拆解',
            description:
              '程序化建模的直列四缸发动机：曲柄连杆运动学、双凸轮轴气门升程、正时链传动，可拖动拆解并点选任意部件查看说明。',
            file: 'three/Engine.vue',
          },
          {
            id: 'robot-arm',
            title: '六轴机械臂码垛',
            description:
              '工业机器人上位机仿真：腰/肩/肘/腕解析逆解、传送带按节拍送料、双指夹爪取放，把料箱码满一托盘后整托出库。',
            file: 'three/RobotArm.vue',
          },
          {
            id: 'mirror',
            title: '实时镜面',
            description:
              'Reflector 用虚拟相机（真实相机关于镜平面的镜像）先渲一遍场景再按屏幕坐标采样回来，金属与玻璃体的 IBL 反射由程序化房间环境提供。',
            file: 'three/Mirror.vue',
          },
        ],
      },
      {
        id: 'openlayers',
        name: 'OpenLayers',
        icon: '🗺️',
        description: '功能强大的二维地图库，支持瓦片、矢量与丰富的交互。',
        examples: [
          {
            id: 'basic-map',
            title: '基础地图',
            description: '可平移缩放的二维底图，内置工具栏与矢量、影像、地形、浅色、深色底图切换。',
            file: 'openlayers/BasicMap.vue',
          },
          {
            id: 'vector-layer',
            title: '矢量图层',
            description: '在地图上叠加随机生成的矢量点要素并自定义样式。',
            file: 'openlayers/VectorLayer.vue',
          },
          {
            id: 'animated-marker',
            title: '动画标记',
            description: '利用 postrender 事件实现脉冲扩散的动态标记。',
            file: 'openlayers/AnimatedMarker.vue',
          },
          {
            id: 'draw-measure',
            title: '绘制与测量',
            description: '交互绘制线/面，并实时计算长度与面积。',
            file: 'openlayers/DrawMeasure.vue',
          },
          {
            id: 'cluster',
            title: '聚合标注',
            description: '300 个点按距离聚合，缩小时显示数量、放大后展开。',
            file: 'openlayers/Cluster.vue',
          },
          {
            id: 'heatmap',
            title: '热力图',
            description: '基于加权点生成热力图，叠加在深色底图上。',
            file: 'openlayers/Heatmap.vue',
          },
          {
            id: 'geojson',
            title: 'GeoJSON 省界',
            description: '加载中国省级行政区 GeoJSON，矢量样式化并支持点击高亮查询。',
            file: 'openlayers/GeoJson.vue',
          },
          {
            id: 'wms',
            title: 'WMS 图层',
            description: '接入 NASA GIBS 的 TileWMS 服务，切换真彩色/地表温度并调整透明度。',
            file: 'openlayers/Wms.vue',
          },
          {
            id: 'modify',
            title: '要素编辑',
            description: 'Modify + Snap 交互：拖拽顶点或边线修改几何，要素之间自动吸附。',
            file: 'openlayers/Modify.vue',
          },
          {
            id: 'select',
            title: '框选查询',
            description: 'Shift + 拖拽拉框，统计并高亮框内所有要素。',
            file: 'openlayers/Select.vue',
          },
          {
            id: 'swipe',
            title: '卷帘对比',
            description: '通过 precompose/postcompose 裁剪画布，实现左右底图卷帘对比。',
            file: 'openlayers/Swipe.vue',
          },
          {
            id: 'track',
            title: '轨迹回放',
            description: '沿路线插值移动标记，实时统计已行驶里程，可暂停与倍速。',
            file: 'openlayers/Track.vue',
          },
          {
            id: 'minimap',
            title: '鹰眼图',
            description: 'OverviewMap 控件：小地图红框表示主图可视范围，可拖动快速定位。',
            file: 'openlayers/Minimap.vue',
          },
          {
            id: 'icon-label',
            title: 'POI 图标标注',
            description: '内联 SVG 图标 + 文字背景标注，declutter 自动避让，悬停放大并联动提示。',
            file: 'openlayers/IconLabel.vue',
          },
          {
            id: 'contour',
            title: '气温等值线',
            description:
              '程序化气温场 + Marching Squares 提等值线：交点缝合为折线、沿走向排布数值标注，色带与等值线同源。',
            file: 'openlayers/Contour.vue',
          },
          {
            id: 'wind-field',
            title: '风场粒子流',
            description:
              'Windy 风格风场动画：西风急流 + 涡旋合成风场，屏幕网格双线性插值驱动数千粒子，拖尾衰减并按风速分档着色。',
            file: 'openlayers/WindField.vue',
          },
          {
            id: 'layer-switch',
            title: '图层显隐控制',
            description: '面/线/点三个图层叠在一起，用开关面板独立控制显隐，最典型的 GIS 图层面板。',
            file: 'openlayers/LayerSwitch.vue',
          },
          {
            id: 'buffer-analysis',
            title: '缓冲区分析',
            description:
              '点缓冲按球面大地线推算 256 边形，线缓冲用相邻段平均法向做 miter 平移 + 端点半圆帽；面积/长度取球面真值，再叠加统计受影响点位。',
            file: 'openlayers/BufferAnalysis.vue',
          },
        ],
      },
      {
        id: 'webgl',
        name: 'WebGL',
        icon: '⚡',
        description: '原生 WebGL 编程，直接操作着色器与缓冲区，零依赖。',
        examples: [
          {
            id: 'triangle',
            title: '旋转三角形',
            description: '原生 WebGL 绘制并通过矩阵实现持续旋转的三角形。',
            file: 'webgl/Triangle.vue',
          },
          {
            id: 'shader-gradient',
            title: '着色器渐变',
            description: '全屏片元着色器实现的动态流光渐变背景。',
            file: 'webgl/ShaderGradient.vue',
          },
          {
            id: 'texture-quad',
            title: '纹理矩形',
            description: '用 Canvas 程序化生成纹理并贴到旋转矩形上。',
            file: 'webgl/TextureQuad.vue',
          },
          {
            id: 'cube-3d',
            title: '3D 立方体',
            description: '透视投影 + 深度测试，渲染持续旋转的彩色立方体。',
            file: 'webgl/Cube3D.vue',
          },
          {
            id: 'point-sprites',
            title: '点精灵',
            description: 'gl.POINTS 与 gl_PointCoord 实现柔边圆形粒子。',
            file: 'webgl/PointSprites.vue',
          },
          {
            id: 'phong',
            title: 'Phong 光照',
            description: '手写 Blinn-Phong 着色：环境光 + 漫反射 + 高光 + 边缘光。',
            file: 'webgl/Phong.vue',
          },
          {
            id: 'fbo',
            title: '帧缓冲后处理',
            description: '场景先渲染到 FBO，再用 5×5 采样做模糊与暗角后处理。',
            file: 'webgl/Fbo.vue',
          },
          {
            id: 'instancing-gl',
            title: '实例化绘制',
            description: 'ANGLE_instanced_arrays 单次绘制 2000 个立方体，并显示实时帧率。',
            file: 'webgl/InstancingGL.vue',
          },
          {
            id: 'blend',
            title: '透明混合',
            description: '开关深度测试与绘制顺序，直观看到透明物体的遮挡关系变化。',
            file: 'webgl/Blend.vue',
          },
          {
            id: 'skybox',
            title: '立方体天空盒',
            description: '程序化生成 6 张面纹理上传为 TEXTURE_CUBE_MAP，拖拽鼠标 360° 环视。',
            file: 'webgl/Skybox.vue',
          },
          {
            id: 'terrain',
            title: '噪声地形',
            description: '值噪声 fBm 生成 101×101 高度场，CPU 差分求法线，高度着色 + 线框切换。',
            file: 'webgl/Terrain.vue',
          },
          {
            id: 'gpgpu',
            title: 'GPGPU 粒子流场',
            description:
              '位置/速度存进 RGBA32F 纹理，MRT 一次写回两组，FBO 乒乓迭代；顶点用 gl_VertexID 反查纹素，14 万粒子全在 GPU 上跑。',
            file: 'webgl/Gpgpu.vue',
          },
          {
            id: 'mandelbrot',
            title: '分形探索器',
            description:
              'Mandelbrot / Julia 双模式：逐像素迭代 z←z²+c，对数平滑消除色带，滚轮以光标为中心缩放到 1e-9。',
            file: 'webgl/Mandelbrot.vue',
          },
          {
            id: 'volume-cloud',
            title: '体积云光线步进',
            description:
              'WebGL2 三维纹理 + 光线步进：程序化 64³ 噪声生成云场，二次步进求光学厚度，Beer-Lambert 透射与 HG 相位函数还原银边。',
            file: 'webgl/VolumeCloud.vue',
          },
          {
            id: 'raymarch',
            title: 'SDF 光线步进',
            description: '全屏四边形 + 片元着色器：距离场步进求交、四点梯度法线、软阴影与 AO。',
            file: 'webgl/Raymarch.vue',
          },
          {
            id: 'shadow-map',
            title: '阴影贴图',
            description:
              '双 pass：光空间把线性深度打包进 RGBA8（不依赖深度纹理扩展），主 pass 解包比对 + 3×3 PCF，可调偏移看 acne 如何被压住。',
            file: 'webgl/ShadowMap.vue',
          },
        ],
      },
    ] as TechCategory[],
  }),
  getters: {
    /** 按技术栈 id 查找大类 */
    categoryById: (state) => (id: string): TechCategory | undefined =>
      state.categories.find((c) => c.id === id),
    /** 在指定技术栈下按示例 id 查找小类 */
    exampleById:
      (state) =>
      (techId: string, exampleId: string): ExampleMeta | undefined => {
        const cat = state.categories.find((c) => c.id === techId)
        return cat?.examples.find((e) => e.id === exampleId)
      },
    /** 根据文件路径获取示例组件加载器 */
    componentOf: () => (file: string): ComponentLoader | undefined => componentMap[file],
    /** 根据文件路径获取示例源码加载器 */
    sourceOf: () => (file: string): SourceLoader | undefined => sourceMap[file],
  },
})
