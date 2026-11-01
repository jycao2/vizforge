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
          {
            id: 'terrain-dem',
            title: '三维地形高程分析',
            description:
              '程序化 DEM 建三角网：分层设色 / Horn 山体阴影 / 坡度 / 坡向 / Marching Squares 等高线，垂直夸张与太阳方位实时可调，鼠标读取任意点高程。',
            file: 'cesium/TerrainDEM.vue',
          },
          {
            id: 'cut-fill',
            title: '场地挖填方分析',
            description:
              '设计面找坡（基准标高 + 双向排水坡度）→ 差值场红挖蓝填、零线即挖填分界，格网柱体法算土方量，二分法一键求土方平衡标高；高程取自真实地形，结果贴地渲染，放大缩小不分离。',
            file: 'cesium/CutFill.vue',
          },
          {
            id: 'flood-analysis',
            title: '水库淹没分析',
            description:
              '连通淹没（河道种子洪水填充）与全域淹没对照；高程取自千岛湖真实地形，淹没范围贴地渲染（GroundPrimitive 分类），水面为水平面，随水位实时重烘。',
            file: 'cesium/FloodAnalysis.vue',
          },
          {
            id: 'viewshed',
            title: '可视域分析',
            description:
              '瞭望塔通视分析：视线逐格插值判定地形遮挡，视高 / 视距 / 方位角 / 视场角可调，点击地图搬移观察点；高程取自延庆山地真实地形，可视性着色贴地渲染。',
            file: 'cesium/Viewshed.vue',
          },
          {
            id: 'time-series',
            title: '时序影像产品',
            description:
              '2001–2025 多期影像 + 时间轴播放 + 逐期指标曲线（建成区 / 植被 / 水域），支持与基准期 2001 卷帘对比，着色器内分割。',
            file: 'cesium/TimeSeriesImagery.vue',
          },
          {
            id: 'mask-clip',
            title: '掩膜裁剪',
            description:
              'SDF 带符号距离场实现影像掩膜的羽化 / 描边 / 挖除，三种形状可调；叠加 globe.clippingPlanes 裁剪平面真实切掉地形。',
            file: 'cesium/MaskClip.vue',
          },
          {
            id: 'water-pollution',
            title: '水污染扩散',
            description:
              '二维平流-扩散-降解方程：半拉格朗日回溯对流 + 五点差分扩散 + 指数衰减，风生流由风向/风速驱动；太湖真实地形定水域，浓度场烘成纹理后用贴地图元分类渲染，排污口可点击迁移，取水口浓度超标即报警。',
            file: 'cesium/WaterPollution.vue',
          },
          {
            id: 'smart-city',
            title: '智慧城市运营',
            description:
              '路网车流 + IoT 感知 + 告警联动：520 辆车用 PointPrimitiveCollection 批量推进（单 draw call），主干路网 clampToGround 贴地；六类设备带脉冲光环与实时读数，超阈值自动入告警队列，KPI 面板展示在线车辆/平均车速/拥堵路段/设备告警。',
            file: 'cesium/SmartCity.vue',
          },
          {
            id: 'post-processing',
            title: '后期处理特效',
            description:
              '全屏后期特效链：夜视 / 边缘检测 / 黑白 / 景深来自 PostProcessStageLibrary，像素化与扫描线是自己写的 GLSL 片段着色器（colorTexture 即整帧，v_textureCoordinates 是屏幕 uv）；曝光段常驻打底，效果段按加入顺序串联，FXAA 可开关。夜景由一千多个窗户灯点铺出来，特效才有明暗可抓。',
            file: 'cesium/PostProcessing.vue',
          },
          {
            id: 'excavation',
            title: '地形剖切与地下管廊',
            description:
              '四个朝外的竖直裁剪面取交集挖出 400 m 基坑，井壁与坑底用 WallGraphics / RectangleGraphics 补（Cesium 只切面不留壁），土壁用条纹材质分层；也可切到单平面剖切看断面。760 m 管网逐顶点采样真实高程再减埋深，检查井为圆柱；地下模式用 translucency 透视地表。',
            file: 'cesium/Excavation.vue',
          },
          {
            id: 'particles',
            title: '粒子特效',
            description:
              '火炬（火核 + 火焰 + 黑烟三系统叠加）、喷泉（球形发射器）、烟羽（锥形发射器）三个场景：发射率 / 尺寸 / 生命期 / 风速实时可调，发射器可在圆形、球形、锥形、立方之间切换。重力走 updateCallback 手动积分（1.118 的 ParticleSystem 已无 gravity 选项），贴图由 canvas 径向渐变现场生成。',
            file: 'cesium/Particles.vue',
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
            id: 'sdf-text',
            title: 'SDF 文字',
            description:
              '纹理里存的不是颜色而是「到字形边缘的距离」：canvas 写字 → 二值掩膜 → 双向 chamfer 距离变换 → 0~1 归一化。渲染时 smoothstep 在 0.5 附近切一刀就是字，把阈值整体外移就是描边——放大 6 倍边缘依然锐利，一张纹理搞定填充 / 描边 / 羽化。',
            file: 'webgl/SdfText.vue',
          },
          {
            id: 'gpu-picking',
            title: 'GPU 拾取',
            description:
              '颜色即 ID：每个物体的索引编码成 RGB 渲进离屏缓冲，readPixels 读回鼠标那一个像素再解出索引——不用维护 BVH，也不怕物体形变。readPixels 是同步的，会打断 GPU 流水线，所以节流到 120ms 一次，并可切换查看 ID 缓冲。',
            file: 'webgl/PickingGpu.vue',
          },
          {
            id: 'water-surface',
            title: '水面反射与折射',
            description:
              '先把池底与柱子渲到离屏纹理，水面片元按屏幕坐标加波形扰动再采样它（近似折射），反射用反射向量采样解析天空，最后按菲涅尔混合——掠射角像镜子、俯视像玻璃。波高 / 流速 / 折射强度 / 菲涅尔实时可调。',
            file: 'webgl/Water.vue',
          },
          {
            id: 'toon',
            title: '卡通着色与描边',
            description:
              '把 N·L 量化成 2~8 档做色阶化，再用法线外扩描边：先画沿法线放大的黑色外壳（cull front），再正常画正面（cull back），没被盖住的一圈就是轮廓线。色阶数 / 描边宽度 / 光照方位实时可调。',
            file: 'webgl/Toon.vue',
          },
          {
            id: 'pbr',
            title: 'PBR 材质',
            description:
              'Cook-Torrance 直接光照：GGX 法线分布 + Smith 几何遮蔽 + Schlick 菲涅尔，能量守恒（反射掉的不能再参与漫反射）。上排金属、下排电介质，五种粗糙度横向对比——粗糙度只改高光形状，不改亮度。',
            file: 'webgl/Pbr.vue',
          },
          {
            id: 'normal-map',
            title: '法线贴图',
            description:
              '几何只是平面，凹凸全来自 RGB 法线图：高度图中心差分生成法线，解码 rgb*2-1 后乘强度、经切线空间 TBN 转到世界空间。可切换着色 / 法线图 / 高度图三种视图，光源方位与强度实时可调。',
            file: 'webgl/NormalMap.vue',
          },
          {
            id: 'tone-mapping',
            title: 'HDR 色调映射',
            description:
              '五个自发光 0.5~8 的灯箱加一颗金属球，对比直接截断 / 线性 / Reinhard / ACES / Filmic 五条曲线：前两条把 1 以上压成死白，ACES 的高光滚降最自然。曝光与 gamma 校正可开关。',
            file: 'webgl/ToneMapping.vue',
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
          {
            id: 'smart-factory',
            title: '智慧工厂产线孪生',
            description:
              '两条产线全链路：上料 → 三台加工中心（到位停线、切削火花）→ XYZ 桁架机械手码垛 → 托盘出库，AGV 按弧长匀速跑闭合路径，设备故障会就地停线并触发地面告警波纹，含 OEE 看板与三种相机机位。',
            file: 'three/SmartFactory.vue',
          },
          {
            id: 'pipeline',
            title: '长输管道数字孪生',
            description:
              '管线随地形起伏布设：内部流体用 ShaderMaterial 沿 uv.x 做相位流动，泄漏点/清管器位置在着色器里局部染色；法兰管墩沿弧长实例化布设，支持管壁透视、发射清管器并跟随视角、注入泄漏看压力流量联动。',
            file: 'three/Pipeline.vue',
          },
          {
            id: 'wind-farm',
            title: '海上风电场',
            description:
              '真实尺度风机群（轮毂 90m / 叶轮 116m）：Gerstner 波海面、叶片顶点收窄+扭转建模、机舱偏航对风、Jensen 尾流模型让下游风机降载，功率按 ½ρAv³Cp 曲线计算，风况参数实时可调。',
            file: 'three/WindFarm.vue',
          },
          {
            id: 'sokoban',
            title: '三维推箱子',
            description:
              '可玩的三维 Sokoban：方向键/WASD 推箱，木箱带金属包角与木纹、地砖逐块倒角、目标环呼吸脉动；角色行走有起伏、转身插值，拖拽旋转视角、滚轮缩放，含撤销/重来与 4 张开箱即玩的关卡（BFS 校验可解）。',
            file: 'three/Sokoban.vue',
          },
          {
            id: 'mega-city',
            title: '百万级城市',
            description:
              '程序化生成 10 万~100 万栋楼，实测三种渲染方式的差异：分块 InstancedMesh（视锥剔除逐块生效）/ 单块实例化（draw call=1 但不可剔除）/ 逐实例 Mesh（draw call 爆炸）；实时显示 FPS、draw call、三角面与生成耗时。',
            file: 'three/MegaCity.vue',
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
            id: 'geoserver',
            title: 'GeoServer 图层服务',
            description:
              '完整走一遍 GIS 服务链路：GetCapabilities 能力文档、5 个图层的 WMS GetMap 出图（浏览器内光栅化，离线可用）、CQL_FILTER 属性过滤、GetFeatureInfo 点查、WFS GetFeature 导出 GeoJSON；面板实时显示瓦片数/耗时/要素数，并给出可直接对拍真实 GeoServer 的标准请求 URL。',
            file: 'openlayers/GeoServer.vue',
          },
          {
            id: 'wfs',
            title: 'WFS 矢量图层',
            description:
              '要素级服务：GetFeature 拉 GeoJSON 并按属性符号化（人口分级 / 等级线宽 / PM2.5 色阶），点选看属性表；改属性、拖几何、删要素、点图新增后走 WFS-T Transaction 写回服务端，计数器与地图同步刷新；附 DescribeFeatureType 字段定义。',
            file: 'openlayers/Wfs.vue',
          },
          {
            id: 'coordinate-crs',
            title: '坐标系纠偏',
            description:
              'WGS84 / GCJ-02 / BD-09 三套坐标的实测对比：同一批点位按所选坐标系表达，再叠加到 WGS84 底图上，未纠偏与纠偏后各画一遍并用虚线连出位移，实时统计平均 / 最大偏移与方向。GCJ-02 用公开偏移算法（含国境判断），反解走过去初值 + 8 次不动点迭代；BD-09 在 GCJ-02 上再偏一次。',
            file: 'openlayers/CoordinateCrs.vue',
          },
          {
            id: 'vector-tile',
            title: 'MVT 矢量瓦片',
            description:
              'OGC 系列里最后补的一块：页面里手写 protobuf 编码器（varint / zigzag / 几何命令）把要素编成 MVT 字节流，交给 ol/format/MVT 解码渲染——没有网络请求，也没有 pbf 依赖。水系是面带河流中心线偏移，道路按全球经纬网铺所以跨瓦片不断头，z≥15 生成建筑面与 POI 标注；可切图层、点选看属性。',
            file: 'openlayers/VectorTile.vue',
          },
          {
            id: 'wmts',
            title: 'WMTS 切片服务',
            description:
              '切片与实时渲染的实测对比：同一组图层，WMTS 模式命中预切缓存（亚毫秒，绿色柱），WMS 直出模式每次现场渲染（数毫秒，橙色柱）；展示 TileMatrixSet / TileMatrix / TileRow / TileCol 语义，实时命中率、缓存张数与最近 40 次瓦片耗时分布。',
            file: 'openlayers/Wmts.vue',
          },
          {
            id: 'choropleth',
            title: '分级统计专题图',
            description:
              '同一份人口数据，等间距 / 分位数 / Jenks 自然断点三种分级方法并排对比，3~7 级可调，图例显示每级区间与要素数；换一种分级，同一份数据会画出完全不同的图 —— 专题图的结论取决于分级方式。',
            file: 'openlayers/Choropleth.vue',
          },
          {
            id: 'route-plan',
            title: '路网路径规划',
            description:
              '真实路网寻路：杭州西湖东侧 OpenStreetMap 数据（1394 路口 / 1538 路段，按道路等级映射限速，可切回 26×26 合成网格做对照）。A* 与 Dijkstra 同跑并对比访问节点数（实测 580 vs 1328），搜索顺序逐帧回放，能看到 Dijkstra 的同心圆扩散与 A* 朝目标收窄；权重可切最短距离 / 最快时间，点击地图重设起终点。',
            file: 'openlayers/RoutePlan.vue',
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
          {
            id: 'terrain-profile',
            title: '地形剖面分析',
            description:
              '程序化 DEM 烘晕渲底图贴进 OL，画线即得高程剖面：累计爬升 / 下降 / 最大坡度，剖面图上横移可在地图中定位。',
            file: 'openlayers/TerrainProfile.vue',
          },
          {
            id: 'isochrone',
            title: '路网等时圈',
            description:
              '带速度的合成路网上跑 Dijkstra（二叉堆），路口时间场 IDW 插值后用 Marching Squares 提取 5/10/15/20 分钟等时线，点击换出发点。',
            file: 'openlayers/Isochrone.vue',
          },
          {
            id: 'idw-interpolation',
            title: '降雨量空间插值',
            description:
              'IDW 反距离加权 + 等雨量线，幂参数 p 与邻站数 k 实时可调，留一交叉验证（LOO-CV）用 MAE / RMSE 给参数打分。',
            file: 'openlayers/IdwInterpolation.vue',
          },
          {
            id: 'hex-aggregate',
            title: '蜂窝聚合分析',
            description:
              '共享单车轨迹点做 Hexbin 分箱：pointy-top 轴坐标系 + 立方取整，六边形尺寸实时可调，密度色带与计数标注。',
            file: 'openlayers/HexAggregate.vue',
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
            id: 'sdf-text',
            title: 'SDF 文字',
            description:
              '纹理里存的不是颜色而是「到字形边缘的距离」：canvas 写字 → 二值掩膜 → 双向 chamfer 距离变换 → 0~1 归一化。渲染时 smoothstep 在 0.5 附近切一刀就是字，把阈值整体外移就是描边——放大 6 倍边缘依然锐利，一张纹理搞定填充 / 描边 / 羽化。',
            file: 'webgl/SdfText.vue',
          },
          {
            id: 'gpu-picking',
            title: 'GPU 拾取',
            description:
              '颜色即 ID：每个物体的索引编码成 RGB 渲进离屏缓冲，readPixels 读回鼠标那一个像素再解出索引——不用维护 BVH，也不怕物体形变。readPixels 是同步的，会打断 GPU 流水线，所以节流到 120ms 一次，并可切换查看 ID 缓冲。',
            file: 'webgl/PickingGpu.vue',
          },
          {
            id: 'water-surface',
            title: '水面反射与折射',
            description:
              '先把池底与柱子渲到离屏纹理，水面片元按屏幕坐标加波形扰动再采样它（近似折射），反射用反射向量采样解析天空，最后按菲涅尔混合——掠射角像镜子、俯视像玻璃。波高 / 流速 / 折射强度 / 菲涅尔实时可调。',
            file: 'webgl/Water.vue',
          },
          {
            id: 'toon',
            title: '卡通着色与描边',
            description:
              '把 N·L 量化成 2~8 档做色阶化，再用法线外扩描边：先画沿法线放大的黑色外壳（cull front），再正常画正面（cull back），没被盖住的一圈就是轮廓线。色阶数 / 描边宽度 / 光照方位实时可调。',
            file: 'webgl/Toon.vue',
          },
          {
            id: 'pbr',
            title: 'PBR 材质',
            description:
              'Cook-Torrance 直接光照：GGX 法线分布 + Smith 几何遮蔽 + Schlick 菲涅尔，能量守恒（反射掉的不能再参与漫反射）。上排金属、下排电介质，五种粗糙度横向对比——粗糙度只改高光形状，不改亮度。',
            file: 'webgl/Pbr.vue',
          },
          {
            id: 'normal-map',
            title: '法线贴图',
            description:
              '几何只是平面，凹凸全来自 RGB 法线图：高度图中心差分生成法线，解码 rgb*2-1 后乘强度、经切线空间 TBN 转到世界空间。可切换着色 / 法线图 / 高度图三种视图，光源方位与强度实时可调。',
            file: 'webgl/NormalMap.vue',
          },
          {
            id: 'tone-mapping',
            title: 'HDR 色调映射',
            description:
              '五个自发光 0.5~8 的灯箱加一颗金属球，对比直接截断 / 线性 / Reinhard / ACES / Filmic 五条曲线：前两条把 1 以上压成死白，ACES 的高光滚降最自然。曝光与 gamma 校正可开关。',
            file: 'webgl/ToneMapping.vue',
          },
          {
            id: 'bloom',
            title: '泛光 Bloom',
            description:
              '亮部提取（软阈值）→ 1/4 分辨率两趟模糊 → 加法合成。加法而不是 lerp 替换，光才会叠加；阈值用「超出量加权」而不是硬截断，边缘不会出硬边。阈值 / 强度 / 半径实时可调，可一键关闭对比。',
            file: 'webgl/Bloom.vue',
          },
          {
            id: 'gaussian-blur',
            title: '两趟高斯模糊',
            description:
              '可分离高斯：二维卷积拆成水平 + 垂直两次 1D，采样数从 N² 降到 2N；模糊本身是低通，再降到 1/2 或 1/4 分辨率执行，成本只剩 1/4、1/16。迭代次数可调，中间一条分界线对比清晰与模糊。',
            file: 'webgl/GaussianBlur.vue',
          },
          {
            id: 'image-filter',
            title: '图像滤镜链',
            description:
              '最高频的 WebGL 用法：图片当纹理，单趟片元着色器串起亮度 / 对比度 / 饱和度 / 色相 / 色调分离 / 暗角，全部实时可调。亮度按 Rec.709 权重算，饱和度与灰阶 mix，色相走 YIQ 旋转矩阵以保持亮度。',
            file: 'webgl/ImageFilter.vue',
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
