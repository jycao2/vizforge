# VizForge · 可视化实验室

[![Deploy to GitHub Pages](https://github.com/jycao2/vizforge/actions/workflows/deploy.yml/badge.svg)](https://github.com/jycao2/vizforge/actions/workflows/deploy.yml)
[![Demo](https://img.shields.io/badge/demo-online-brightgreen?logo=githubpages)](https://jycao2.github.io/vizforge/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3.4-brightgreen?logo=vuedotjs)](https://vuejs.org/)
[![WebGL 2](https://img.shields.io/badge/WebGL-2-blue?logo=webgl)](https://developer.mozilla.org/docs/Web/API/WebGL2RenderingContext)

**在线体验（GitHub Pages，无需安装）：https://jycao2.github.io/vizforge/**

一个「读得懂、拷得走」的前端可视化示例库：用 Vue 3 + TypeScript 单文件组件手写 **99 个可运行示例**，覆盖 **Cesium**（三维地球 / 地理空间）、**Three.js**（通用三维场景）、**OpenLayers**（二维地图 / GIS）、**原生 WebGL**（手写着色器，零依赖）四条技术栈。

每个示例页右上角都有「查看源码」按钮，点开就是该示例的完整实现，可一键复制——它不是一个封装好的组件库，而是一本可以直接拆开看的、跑得起来的代码手册。从 Cesium 的 DEM 地形/挖填方/淹没/可视域/时序影像/掩膜裁剪，到 Three.js 智慧工厂/海上风电场，再到 OpenLayers 的地形剖面/路网等时圈/IDW 插值/蜂窝聚合，以及体积云光线步进、GPGPU 粒子流场、SDF 光线步进、阴影贴图，都能在这里直接读源码。

> **Keywords**：Vue 3 · TypeScript · Vite · Pinia · Cesium · Three.js · OpenLayers · WebGL2 · GLSL shader · GIS · 三维地球 · 数字孪生 · 数据可视化 · 热力图 · 等值线 · 风场粒子 · 体积云 · GPGPU · 光线步进 · 阴影贴图 · 日照分析 · 挖填方 · 淹没分析 · 可视域 · 时序影像 · 掩膜裁剪 · 等时圈 · IDW 插值 · 蜂窝聚合 · 前端可视化示例集

## 项目预览

> 点任意一张图即可跳转到对应的在线示例页面（可直接操作参数面板）。

[![首页](docs/screenshots/home.png)](https://jycao2.github.io/vizforge/)

**首页**：四条技术栈 99 个示例的总览入口，点卡片进入对应示例。

| [Cesium · 台风路径与风圈](https://jycao2.github.io/vizforge/#/e/cesium/typhoon) | [Cesium · 日照阴影分析](https://jycao2.github.io/vizforge/#/e/cesium/sun-shadow) |
| --- | --- |
| [![台风路径与风圈](docs/screenshots/cesium-typhoon.png)](https://jycao2.github.io/vizforge/#/e/cesium/typhoon) | [![日照阴影分析](docs/screenshots/cesium-sun-shadow.png)](https://jycao2.github.io/vizforge/#/e/cesium/sun-shadow) |
| **[Three.js · 大坝开闸放水](https://jycao2.github.io/vizforge/#/e/three/dam)** | **[Three.js · 六轴机械臂码垛](https://jycao2.github.io/vizforge/#/e/three/robot-arm)** |
| [![大坝开闸放水](docs/screenshots/three-dam.png)](https://jycao2.github.io/vizforge/#/e/three/dam) | [![六轴机械臂码垛](docs/screenshots/three-robot-arm.png)](https://jycao2.github.io/vizforge/#/e/three/robot-arm) |
| **[OpenLayers · 风场粒子流](https://jycao2.github.io/vizforge/#/e/openlayers/wind-field)** | **[WebGL · 体积云光线步进](https://jycao2.github.io/vizforge/#/e/webgl/volume-cloud)** |
| [![风场粒子流](docs/screenshots/ol-wind-field.png)](https://jycao2.github.io/vizforge/#/e/openlayers/wind-field) | [![体积云光线步进](docs/screenshots/webgl-volume-cloud.png)](https://jycao2.github.io/vizforge/#/e/webgl/volume-cloud) |
| **[Cesium · 三维地形高程分析](https://jycao2.github.io/vizforge/#/e/cesium/terrain-dem)** | **[Cesium · 水库淹没分析](https://jycao2.github.io/vizforge/#/e/cesium/flood-analysis)** |
| [![三维地形高程分析](docs/screenshots/cesium-terrain-dem.png)](https://jycao2.github.io/vizforge/#/e/cesium/terrain-dem) | [![水库淹没分析](docs/screenshots/cesium-flood-analysis.png)](https://jycao2.github.io/vizforge/#/e/cesium/flood-analysis) |
| **[Cesium · 场地挖填方分析](https://jycao2.github.io/vizforge/#/e/cesium/cut-fill)** | **[OpenLayers · 路网等时圈](https://jycao2.github.io/vizforge/#/e/openlayers/isochrone)** |
| [![场地挖填方分析](docs/screenshots/cesium-cut-fill.png)](https://jycao2.github.io/vizforge/#/e/cesium/cut-fill) | [![路网等时圈](docs/screenshots/ol-isochrone.png)](https://jycao2.github.io/vizforge/#/e/openlayers/isochrone) |
| **[Cesium · 掩膜裁剪](https://jycao2.github.io/vizforge/#/e/cesium/mask-clip)** | **[Three.js · 三维推箱子](https://jycao2.github.io/vizforge/#/e/three/sokoban)** |
| [![掩膜裁剪](docs/screenshots/cesium-mask-clip.png)](https://jycao2.github.io/vizforge/#/e/cesium/mask-clip) | [![三维推箱子](docs/screenshots/three-sokoban.png)](https://jycao2.github.io/vizforge/#/e/three/sokoban) |
| **[Three.js · 百万级城市](https://jycao2.github.io/vizforge/#/e/three/mega-city)** | **[Cesium · 水污染扩散](https://jycao2.github.io/vizforge/#/e/cesium/water-pollution)** |
| [![百万级城市](docs/screenshots/three-mega-city.png)](https://jycao2.github.io/vizforge/#/e/three/mega-city) | [![水污染扩散](docs/screenshots/cesium-water-pollution.png)](https://jycao2.github.io/vizforge/#/e/cesium/water-pollution) |
| **[Cesium · 智慧城市运营](https://jycao2.github.io/vizforge/#/e/cesium/smart-city)** | **[OpenLayers · GeoServer 图层服务](https://jycao2.github.io/vizforge/#/e/openlayers/geoserver)** |
| [![智慧城市运营](docs/screenshots/cesium-smart-city.png)](https://jycao2.github.io/vizforge/#/e/cesium/smart-city) | [![GeoServer 图层服务](docs/screenshots/ol-geoserver.png)](https://jycao2.github.io/vizforge/#/e/openlayers/geoserver) |
| **[OpenLayers · WFS 矢量图层](https://jycao2.github.io/vizforge/#/e/openlayers/wfs)** | **[OpenLayers · WMTS 切片服务](https://jycao2.github.io/vizforge/#/e/openlayers/wmts)** |
| [![WFS 矢量图层](docs/screenshots/ol-wfs.png)](https://jycao2.github.io/vizforge/#/e/openlayers/wfs) | [![WMTS 切片服务](docs/screenshots/ol-wmts.png)](https://jycao2.github.io/vizforge/#/e/openlayers/wmts) |
| **[OpenLayers · 分级统计专题图](https://jycao2.github.io/vizforge/#/e/openlayers/choropleth)** | **[OpenLayers · 路网路径规划](https://jycao2.github.io/vizforge/#/e/openlayers/route-plan)** |
| [![分级统计专题图](docs/screenshots/ol-choropleth.png)](https://jycao2.github.io/vizforge/#/e/openlayers/choropleth) | [![路网路径规划](docs/screenshots/ol-route-plan.png)](https://jycao2.github.io/vizforge/#/e/openlayers/route-plan) |
| **[Cesium · 后期处理特效](https://jycao2.github.io/vizforge/#/e/cesium/post-processing)** | **[Cesium · 地形剖切与地下管廊](https://jycao2.github.io/vizforge/#/e/cesium/excavation)** |
| [![后期处理特效](docs/screenshots/cesium-post-processing.png)](https://jycao2.github.io/vizforge/#/e/cesium/post-processing) | [![地形剖切与地下管廊](docs/screenshots/cesium-excavation.png)](https://jycao2.github.io/vizforge/#/e/cesium/excavation) |
| **[Cesium · 粒子特效](https://jycao2.github.io/vizforge/#/e/cesium/particles)** |  |
| [![粒子特效](docs/screenshots/cesium-particles.png)](https://jycao2.github.io/vizforge/#/e/cesium/particles) |  |

更多：时序影像、可视域、掩膜裁剪、地形剖面、IDW 插值、蜂窝聚合、缓冲区分析、阴影贴图等另外 68 个示例，[在线 Demo](https://jycao2.github.io/vizforge/) 直接体验。

---

## 特性

- **99 个完整示例**：从「旋转三角形」到「体积云光线步进」「GPGPU 粒子流场」，全部是真实场景而非占位 demo，参数和交互都是活的。
- **源码即看即拷**：基于 Vite 的 `import.meta.glob(..., { query: '?raw' })` 直接读取组件原始文本，配合 highlight.js 高亮，改完代码刷新即同步，不存在「文档和实现对不上」。
- **零后端、免 Token**：纯前端静态站点，不依赖 Cesium Ion Token，不依赖任何自建服务。
- **统一交互外壳**：每个示例自带参数面板（滑杆 / 开关 / 按钮）与画布工具条（放大、缩小、复位、全屏），切换示例时资源完整释放，长时间浏览不会泄漏。
- **按需懒加载**：示例组件全部异步加载，Cesium / Three / OL 各自的重量级依赖只在进入对应页面时才下载。

## 在线 Demo 与自动部署

- **Demo 地址**：https://jycao2.github.io/vizforge/ （GitHub Pages，纯静态托管）
- **自动部署**：`.github/workflows/deploy.yml`。**每次推送到 `main`** 都会自动跑一次 `npm ci` → `vue-tsc` 类型检查 → `vite build` → 部署到 Pages；也可以在仓库的 Actions 页面手动触发。类型检查不通过就不会部署，不会把坏掉的版本推上线。
- **换仓库名 / 换域名无需改配置**：构建时用的是相对 `base`（`./`），页面里所有资源都相对 `index.html` 解析。因为本项目是 hash 路由的 SPA，页面路径恒为 `/<仓库名>/index.html`，所以同一份产物放在任何子路径下都能跑。用自定义域名（站点在根路径）时同样无需改动。
- **为什么不用 `/<仓库名>/` 作为 base**：`vite-plugin-cesium` 会把 Cesium 静态资源拷到 `outDir + base + '/cesium'`；若 base 是 `/vizforge/`，资源就落到 `dist/vizforge/cesium/`，而 Pages 把上传的 `dist` 根映射成 `/vizforge/`，浏览器请求的 `/vizforge/cesium/Cesium.js` 实际找的是 `dist/cesium/` —— 404。相对 base 下资源落到 `dist/cesium/`，正好命中。
- **首次启用**：仓库 Settings → Pages → Source 选择 **GitHub Actions**（只需设置一次）。

## 快速开始

环境要求：**Node.js >= 18**（推荐 20+），浏览器需支持 **WebGL 2**（体积云、GPGPU 等示例必需）。

```bash
# 安装依赖
npm install

# 启动开发服务器（默认 http://localhost:5173）
npm run dev

# 类型检查 + 生产构建（输出到 dist/）
npm run build

# 仅类型检查
npm run typecheck

# 预览构建产物
npm run preview
```

## 界面说明

| 区域 | 作用 |
| --- | --- |
| 左侧栏 | 按技术栈分组的全部示例，底部实时统计技术栈数与示例总数 |
| 首页 | 四张技术栈卡片，点击直接进入该栈的第一个示例 |
| 示例页头部 | 面包屑（技术栈 / 示例名）+ 一句话原理说明 + 「查看源码」开关 |
| 示例页画布 | 场景本体，带工具条（放大 / 缩小 / 复位 / 全屏，Cesium 的缩放以屏幕中心地物为锚点） |
| 参数面板 | 该示例可调的参数，改动即时生效 |
| 源码面板 | 完整源码 + 行号 + 复制按钮；展开时会派发 `resize` 事件让画布自适应 |

路由为 hash 模式：`#/e/:techId/:exampleId`，例如 `#/e/cesium/typhoon`。

## 示例清单

### Cesium（30 个）

三维地球与地理空间可视化引擎，基于 WebGL 的地球渲染。


| 示例 | 说明 | 源文件 |
| --- | --- | --- |
| 基础地球 | 内置放大/缩小/复位/全屏工具栏，支持矢量、影像、地形、浅色、深色底图切换。 | `src/examples/cesium/BasicGlobe.vue` |
| 实体与标注 | 添加点、标签、多边形与折线等实体要素并飞入视角。 | `src/examples/cesium/Entities.vue` |
| 相机飞行 | 在世界多个城市之间自动巡航飞行，演示相机动画。 | `src/examples/cesium/CameraFlight.vue` |
| 点击拾取坐标 | 在地球上点击，实时拾取经纬度与高度并打点标记。 | `src/examples/cesium/Picking.vue` |
| 交互绘制多边形 | 左键加点、右键结束，动态预览并生成多边形面。 | `src/examples/cesium/DrawPolygon.vue` |
| 加载 glTF 模型 | 通过 Model.fromGltfAsync 加载并定位一个 glTF 模型。 | `src/examples/cesium/ModelLoad.vue` |
| 3D Tiles 建筑 | 加载 3D Tiles 瓦片集，按建筑高度分色，演示倾斜/白模数据的渲染。 | `src/examples/cesium/Tiles3D.vue` |
| 轨迹回放 | SampledPositionProperty + Path 让实体沿航线移动并留下发光轨迹，可暂停/倍速/重播。 | `src/examples/cesium/Trajectory.vue` |
| 距离面积量算 | 左键加点、右键结束，实时计算大地线长度与多边形面积并标注在地图上。 | `src/examples/cesium/Measure.vue` |
| 天气特效 | PostProcessStage 全屏 GLSL 后期，可切换下雨、下雪、大雾三种天气。 | `src/examples/cesium/Weather.vue` |
| 卫星轨道 | 按轨道倾角与升交点赤经生成三条圆轨道，三颗卫星同时绕地运行。 | `src/examples/cesium/Satellite.vue` |
| 卷帘对比 | 利用 scene.splitPosition 左右分屏，拖动分隔条对比两种底图。 | `src/examples/cesium/Swipe.vue` |
| OD 飞线 | 抛物线弧 + PolylineGlow 发光，配合 CallbackProperty 驱动的流动光点，最经典的大屏飞线。 | `src/examples/cesium/FlyLine.vue` |
| 雷达扫描 | 扩散圆环 + 旋转扫描扇面，用 CallbackProperty 逐帧重算半径与顶点。 | `src/examples/cesium/Radar.vue` |
| 点击信息弹窗 | scene.pick 拾取实体，postRender 里把世界坐标投影为屏幕坐标，让 DOM 弹窗跟随地图。 | `src/examples/cesium/Popup.vue` |
| 日照阴影分析 | 街区体块 + 真实太阳位置：clock 驱动 Cesium 解算日照与 shadowMap 投影，采样点用射线-长方体求交判定遮挡。 | `src/examples/cesium/SunShadow.vue` |
| 台风路径与风圈 | 西北太平洋台风过程：Catmull-Rom 样条路径、三层风圈随强度联动、程序化四臂螺旋云系，播放倍速与跟随视角齐备。 | `src/examples/cesium/Typhoon.vue` |
| 城市白模 | 256 个街区 PolygonGraphics 按 extrudedHeight 拉伸，高度分色模拟 CBD 高楼群。 | `src/examples/cesium/CityModel.vue` |
| 城市热力图 | 径向渐变叠加成密度场 → 256 级色带查表 → 自定义材质的 RectangleGeometry 贴回球面，半径/强度/色带实时可调。 | `src/examples/cesium/HeatmapOverlay.vue` |
| 三维地形高程分析 | 程序化 DEM 建三角网：分层设色 / Horn 山体阴影 / 坡度 / 坡向 / Marching Squares 等高线，垂直夸张与太阳方位实时可调，鼠标读取任意点高程。 | `src/examples/cesium/TerrainDEM.vue` |
| 场地挖填方分析 | 设计面找坡（基准标高 + 双向排水坡度）→ 差值场红挖蓝填、零线即挖填分界，格网柱体法算土方量，二分法一键求土方平衡标高；高程取自真实地形，结果贴地渲染，放大缩小不分离。 | `src/examples/cesium/CutFill.vue` |
| 水库淹没分析 | 连通淹没（河道种子洪水填充）与全域淹没对照；高程取自千岛湖真实地形，淹没范围贴地渲染（GroundPrimitive 分类），水面为水平面，随水位实时重烘。 | `src/examples/cesium/FloodAnalysis.vue` |
| 可视域分析 | 瞭望塔通视分析：视线逐格插值判定地形遮挡，视高 / 视距 / 方位角 / 视场角可调，点击地图搬移观察点；高程取自延庆山地真实地形，可视性着色贴地渲染。 | `src/examples/cesium/Viewshed.vue` |
| 时序影像产品 | 2001–2025 多期影像 + 时间轴播放 + 逐期指标曲线（建成区 / 植被 / 水域），支持与基准期 2001 卷帘对比，着色器内分割。 | `src/examples/cesium/TimeSeriesImagery.vue` |
| 掩膜裁剪 | SDF 带符号距离场实现影像掩膜的羽化 / 描边 / 挖除，三种形状可调；叠加 globe.clippingPlanes 裁剪平面真实切掉地形。 | `src/examples/cesium/MaskClip.vue` |
| 水污染扩散 | 二维平流-扩散-降解方程：半拉格朗日回溯对流 + 五点差分扩散 + 指数衰减，风生流由风向/风速驱动；太湖真实地形定水域，浓度场烘成纹理后用贴地图元分类渲染，排污口可点击迁移，取水口浓度超标即报警。 | `src/examples/cesium/WaterPollution.vue` |
| 智慧城市运营 | 路网车流 + IoT 感知 + 告警联动：520 辆车用 PointPrimitiveCollection 批量推进（单 draw call），主干路网 clampToGround 贴地；六类设备带脉冲光环与实时读数，超阈值自动入告警队列，KPI 面板展示在线车辆/平均车速/拥堵路段/设备告警。 | `src/examples/cesium/SmartCity.vue` |
| 后期处理特效 | 全屏后期特效链：夜视 / 黑白 / 景深取自 PostProcessStageLibrary，描边（Sobel）/ 像素化 / 扫描线是自己写的 GLSL 片段着色器（colorTexture 即整帧，v_textureCoordinates 是屏幕 uv）；曝光段常驻打底，效果段按加入顺序串联，FXAA 可开关，景深依赖 WEBGL_depth_texture 不支持时按钮自动禁用。 | `src/examples/cesium/PostProcessing.vue` |
| 地形剖切与地下管廊 | 四个朝外的竖直裁剪面取交集挖出 400 m 基坑，井壁与坑底用 WallGraphics / RectangleGraphics 补（Cesium 只切面不留壁），土壁用条纹材质分层；也可切到单平面剖切看断面。760 m 管网逐顶点采样真实高程再减埋深（clampToGround 会把管线贴回地表），检查井为圆柱；地下模式用 translucency 透视地表，此时必须关掉 depthTestAgainstTerrain。 | `src/examples/cesium/Excavation.vue` |
| 粒子特效 | 火炬（火核 + 火焰 + 黑烟三系统叠加）、喷泉（球形发射器）、烟羽（锥形发射器）三个场景：发射率 / 尺寸 / 生命期 / 风速实时可调，发射器可在圆形、球形、锥形、立方之间切换。Cesium 1.118 的 ParticleSystem 已没有 gravity 选项，重力走 updateCallback 手动积分；贴图由 canvas 径向渐变现场生成，零外部资源。 | `src/examples/cesium/Particles.vue` |

### Three.js（26 个）

通用的 WebGL 3D 渲染库，适合任意三维场景与特效。


| 示例 | 说明 | 源文件 |
| --- | --- | --- |
| 旋转立方体 | 使用 MeshNormalMaterial 渲染一个持续旋转的立方体。 | `src/examples/three/Cube.vue` |
| 光照球体 | 基于 MeshStandardMaterial 与方向光、环境光渲染的球体。 | `src/examples/three/LightsSphere.vue` |
| 粒子星空 | 使用 Points 渲染上千个粒子组成的旋转星空。 | `src/examples/three/Particles.vue` |
| 轨道控制器 | 使用 OrbitControls 实现拖拽旋转、滚轮缩放、右键平移。 | `src/examples/three/OrbitControls.vue` |
| 加载 glTF 模型 | 用 GLTFLoader 加载 Duck.glb，自动居中缩放并支持交互。 | `src/examples/three/GltfModel.vue` |
| 射线拾取 | 用 Raycaster 检测鼠标命中的物体并高亮显示。 | `src/examples/three/Raycaster.vue` |
| 阴影与光照 | DirectionalLight 投射 PCF 软阴影，几何体落地投影随动画实时更新。 | `src/examples/three/Shadow.vue` |
| 实例化渲染 | InstancedMesh 一次 draw call 渲染 6000 个立方体，逐实例矩阵与颜色。 | `src/examples/three/Instancing.vue` |
| 泛光后期 | EffectComposer + UnrealBloomPass 实现发光后期，可调节泛光强度。 | `src/examples/three/Bloom.vue` |
| 着色器水波 | ShaderMaterial 自定义顶点位移与片元配色，实时生成正弦波水面。 | `src/examples/three/WaterShader.vue` |
| 骨骼动画 | GLTFLoader + AnimationMixer 播放 Soldier.glb 的多个动作片段。 | `src/examples/three/Skeleton.vue` |
| 环境反射 | PMREMGenerator + RoomEnvironment 生成 IBL 环境贴图，金属材质呈现真实反射。 | `src/examples/three/EnvMap.vue` |
| 点云渲染 | 14 万点单次 draw call：斐波那契球面采样 + vertexColors，可调点大小。 | `src/examples/three/PointCloud.vue` |
| 大气散射天空 | Sky 着色器按太阳高度角/方位角实时解算天光，拖到负角度可见日落霞光。 | `src/examples/three/Sky.vue` |
| 描边选中 | OutlinePass 后期描边：点击模型高亮发光，模型点选的标准做法。 | `src/examples/three/Outline.vue` |
| HTML 标签 | CSS2DRenderer 把 DOM 元素投影到 3D 坐标上，做数据看板的节点说明。 | `src/examples/three/CSS2D.vue` |
| 布料模拟 | Verlet 积分 + PBD 约束松弛：40×26 质点的平纹布料，风力湍流、球体碰撞、拖拽拉扯与双击撕裂。 | `src/examples/three/Cloth.vue` |
| 大坝开闸放水 | 重力坝 + 5 孔弧形闸门：点选闸门绕铰链抬升，水舌沿 ogee 溢流面下泄，坝趾水花与雾化随开度联动。 | `src/examples/three/Dam.vue` |
| 发动机拆解 | 程序化建模的直列四缸发动机：曲柄连杆运动学、双凸轮轴气门升程、正时链传动，可拖动拆解并点选任意部件查看说明。 | `src/examples/three/Engine.vue` |
| 六轴机械臂码垛 | 工业机器人上位机仿真：腰/肩/肘/腕解析逆解、传送带按节拍送料、双指夹爪取放，把料箱码满一托盘后整托出库。 | `src/examples/three/RobotArm.vue` |
| 实时镜面 | Reflector 用虚拟相机（真实相机关于镜平面的镜像）先渲一遍场景再按屏幕坐标采样回来，金属与玻璃体的 IBL 反射由程序化房间环境提供。 | `src/examples/three/Mirror.vue` |
| 智慧工厂产线孪生 | 两条产线全链路：上料 → 三台加工中心（到位停线、切削火花）→ XYZ 桁架机械手码垛 → 托盘出库，AGV 按弧长匀速跑闭合路径，设备故障会就地停线并触发地面告警波纹，含 OEE 看板与三种相机机位。 | `src/examples/three/SmartFactory.vue` |
| 长输管道数字孪生 | 管线随地形起伏布设：内部流体用 ShaderMaterial 沿 uv.x 做相位流动，泄漏点/清管器位置在着色器里局部染色；法兰管墩沿弧长实例化布设，支持管壁透视、发射清管器并跟随视角、注入泄漏看压力流量联动。 | `src/examples/three/Pipeline.vue` |
| 海上风电场 | 真实尺度风机群（轮毂 90m / 叶轮 116m）：Gerstner 波海面、叶片顶点收窄+扭转建模、机舱偏航对风、Jensen 尾流模型让下游风机降载，功率按 ½ρAv³Cp 曲线计算，风况参数实时可调。 | `src/examples/three/WindFarm.vue` |
| 三维推箱子 | 可玩的三维 Sokoban：方向键/WASD 推箱，木箱带金属包角与木纹、地砖逐块倒角、目标环呼吸脉动；角色行走有起伏、转身插值，拖拽旋转视角、滚轮缩放，含撤销/重来与 4 张开箱即玩的关卡（BFS 校验可解）。 | `src/examples/three/Sokoban.vue` |
| 百万级城市 | 程序化生成 10 万~100 万栋楼，实测三种渲染方式的差异：分块 InstancedMesh（视锥剔除逐块生效）/ 单块实例化（draw call=1 但不可剔除）/ 逐实例 Mesh（draw call 爆炸）；实时显示 FPS、draw call、三角面与生成耗时。 | `src/examples/three/MegaCity.vue` |

### OpenLayers（27 个）

功能强大的二维地图库，支持瓦片、矢量与丰富的交互。


| 示例 | 说明 | 源文件 |
| --- | --- | --- |
| 基础地图 | 可平移缩放的二维底图，内置工具栏与矢量、影像、地形、浅色、深色底图切换。 | `src/examples/openlayers/BasicMap.vue` |
| 矢量图层 | 在地图上叠加随机生成的矢量点要素并自定义样式。 | `src/examples/openlayers/VectorLayer.vue` |
| 动画标记 | 利用 postrender 事件实现脉冲扩散的动态标记。 | `src/examples/openlayers/AnimatedMarker.vue` |
| 绘制与测量 | 交互绘制线/面，并实时计算长度与面积。 | `src/examples/openlayers/DrawMeasure.vue` |
| 聚合标注 | 300 个点按距离聚合，缩小时显示数量、放大后展开。 | `src/examples/openlayers/Cluster.vue` |
| 热力图 | 基于加权点生成热力图，叠加在深色底图上。 | `src/examples/openlayers/Heatmap.vue` |
| GeoJSON 省界 | 加载中国省级行政区 GeoJSON，矢量样式化并支持点击高亮查询。 | `src/examples/openlayers/GeoJson.vue` |
| WMS 图层 | 接入 NASA GIBS 的 TileWMS 服务，切换真彩色/地表温度并调整透明度。 | `src/examples/openlayers/Wms.vue` |
| GeoServer 图层服务 | 完整走一遍 GIS 服务链路：GetCapabilities 能力文档、5 个图层的 WMS GetMap 出图（浏览器内光栅化，离线可用）、CQL_FILTER 属性过滤、GetFeatureInfo 点查、WFS GetFeature 导出 GeoJSON；面板实时显示瓦片数/耗时/要素数，并给出可直接对拍真实 GeoServer 的标准请求 URL。 | `src/examples/openlayers/GeoServer.vue` |
| WFS 矢量图层 | 要素级服务：GetFeature 拉 GeoJSON 并按属性符号化（人口分级 / 等级线宽 / PM2.5 色阶），点选看属性表；改属性、拖几何、删要素、点图新增后走 WFS-T Transaction 写回服务端，计数器与地图同步刷新；附 DescribeFeatureType 字段定义。 | `src/examples/openlayers/Wfs.vue` |
| WMTS 切片服务 | 切片与实时渲染的实测对比：同一组图层，WMTS 模式命中预切缓存（亚毫秒，绿色柱），WMS 直出模式每次现场渲染（数毫秒，橙色柱）；展示 TileMatrixSet / TileMatrix / TileRow / TileCol 语义，实时命中率、缓存张数与最近 40 次瓦片耗时分布。 | `src/examples/openlayers/Wmts.vue` |
| 分级统计专题图 | 同一份人口数据，等间距 / 分位数 / Jenks 自然断点三种分级方法并排对比，3~7 级可调，图例显示每级区间与要素数；换一种分级，同一份数据会画出完全不同的图 —— 专题图的结论取决于分级方式。 | `src/examples/openlayers/Choropleth.vue` |
| 路网路径规划 | 真实路网寻路：杭州西湖东侧 OpenStreetMap 数据（1394 路口 / 1538 路段，按道路等级映射限速，可切回 26×26 合成网格做对照）。A* 与 Dijkstra 同跑并对比访问节点数（实测 580 vs 1328），搜索顺序逐帧回放，能看到 Dijkstra 的同心圆扩散与 A* 朝目标收窄；权重可切最短距离 / 最快时间，点击地图重设起终点。 | `src/examples/openlayers/RoutePlan.vue` |
| 要素编辑 | Modify + Snap 交互：拖拽顶点或边线修改几何，要素之间自动吸附。 | `src/examples/openlayers/Modify.vue` |
| 框选查询 | Shift + 拖拽拉框，统计并高亮框内所有要素。 | `src/examples/openlayers/Select.vue` |
| 卷帘对比 | 通过 precompose/postcompose 裁剪画布，实现左右底图卷帘对比。 | `src/examples/openlayers/Swipe.vue` |
| 轨迹回放 | 沿路线插值移动标记，实时统计已行驶里程，可暂停与倍速。 | `src/examples/openlayers/Track.vue` |
| 鹰眼图 | OverviewMap 控件：小地图红框表示主图可视范围，可拖动快速定位。 | `src/examples/openlayers/Minimap.vue` |
| POI 图标标注 | 内联 SVG 图标 + 文字背景标注，declutter 自动避让，悬停放大并联动提示。 | `src/examples/openlayers/IconLabel.vue` |
| 气温等值线 | 程序化气温场 + Marching Squares 提等值线：交点缝合为折线、沿走向排布数值标注，色带与等值线同源。 | `src/examples/openlayers/Contour.vue` |
| 风场粒子流 | Windy 风格风场动画：西风急流 + 涡旋合成风场，屏幕网格双线性插值驱动数千粒子，拖尾衰减并按风速分档着色。 | `src/examples/openlayers/WindField.vue` |
| 图层显隐控制 | 面/线/点三个图层叠在一起，用开关面板独立控制显隐，最典型的 GIS 图层面板。 | `src/examples/openlayers/LayerSwitch.vue` |
| 缓冲区分析 | 点缓冲按球面大地线推算 256 边形，线缓冲用相邻段平均法向做 miter 平移 + 端点半圆帽；面积/长度取球面真值，再叠加统计受影响点位。 | `src/examples/openlayers/BufferAnalysis.vue` |
| 地形剖面分析 | 程序化 DEM 烘晕渲底图贴进 OL，画线即得高程剖面：累计爬升 / 下降 / 最大坡度，剖面图上横移可在地图中定位。 | `src/examples/openlayers/TerrainProfile.vue` |
| 路网等时圈 | 带速度的合成路网上跑 Dijkstra（二叉堆），路口时间场 IDW 插值后用 Marching Squares 提取 5/10/15/20 分钟等时线，点击换出发点。 | `src/examples/openlayers/Isochrone.vue` |
| 降雨量空间插值 | IDW 反距离加权 + 等雨量线，幂参数 p 与邻站数 k 实时可调，留一交叉验证（LOO-CV）用 MAE / RMSE 给参数打分。 | `src/examples/openlayers/IdwInterpolation.vue` |
| 蜂窝聚合分析 | 共享单车轨迹点做 Hexbin 分箱：pointy-top 轴坐标系 + 立方取整，六边形尺寸实时可调，密度色带与计数标注。 | `src/examples/openlayers/HexAggregate.vue` |

### WebGL（16 个）

原生 WebGL 编程，直接操作着色器与缓冲区，零依赖。


| 示例 | 说明 | 源文件 |
| --- | --- | --- |
| 旋转三角形 | 原生 WebGL 绘制并通过矩阵实现持续旋转的三角形。 | `src/examples/webgl/Triangle.vue` |
| 着色器渐变 | 全屏片元着色器实现的动态流光渐变背景。 | `src/examples/webgl/ShaderGradient.vue` |
| 纹理矩形 | 用 Canvas 程序化生成纹理并贴到旋转矩形上。 | `src/examples/webgl/TextureQuad.vue` |
| 3D 立方体 | 透视投影 + 深度测试，渲染持续旋转的彩色立方体。 | `src/examples/webgl/Cube3D.vue` |
| 点精灵 | gl.POINTS 与 gl_PointCoord 实现柔边圆形粒子。 | `src/examples/webgl/PointSprites.vue` |
| Phong 光照 | 手写 Blinn-Phong 着色：环境光 + 漫反射 + 高光 + 边缘光。 | `src/examples/webgl/Phong.vue` |
| 帧缓冲后处理 | 场景先渲染到 FBO，再用 5×5 采样做模糊与暗角后处理。 | `src/examples/webgl/Fbo.vue` |
| 实例化绘制 | ANGLE_instanced_arrays 单次绘制 2000 个立方体，并显示实时帧率。 | `src/examples/webgl/InstancingGL.vue` |
| 透明混合 | 开关深度测试与绘制顺序，直观看到透明物体的遮挡关系变化。 | `src/examples/webgl/Blend.vue` |
| 立方体天空盒 | 程序化生成 6 张面纹理上传为 TEXTURE_CUBE_MAP，拖拽鼠标 360° 环视。 | `src/examples/webgl/Skybox.vue` |
| 噪声地形 | 值噪声 fBm 生成 101×101 高度场，CPU 差分求法线，高度着色 + 线框切换。 | `src/examples/webgl/Terrain.vue` |
| GPGPU 粒子流场 | 位置/速度存进 RGBA32F 纹理，MRT 一次写回两组，FBO 乒乓迭代；顶点用 gl_VertexID 反查纹素，14 万粒子全在 GPU 上跑。 | `src/examples/webgl/Gpgpu.vue` |
| 分形探索器 | Mandelbrot / Julia 双模式：逐像素迭代 z←z²+c，对数平滑消除色带，滚轮以光标为中心缩放到 1e-9。 | `src/examples/webgl/Mandelbrot.vue` |
| 体积云光线步进 | WebGL2 三维纹理 + 光线步进：程序化 64³ 噪声生成云场，二次步进求光学厚度，Beer-Lambert 透射与 HG 相位函数还原银边。 | `src/examples/webgl/VolumeCloud.vue` |
| SDF 光线步进 | 全屏四边形 + 片元着色器：距离场步进求交、四点梯度法线、软阴影与 AO。 | `src/examples/webgl/Raymarch.vue` |
| 阴影贴图 | 双 pass：光空间把线性深度打包进 RGBA8（不依赖深度纹理扩展），主 pass 解包比对 + 3×3 PCF，可调偏移看 acne 如何被压住。 | `src/examples/webgl/ShadowMap.vue` |

## 目录结构

```
src/
├─ components/
│  ├─ Sidebar.vue          左侧示例导航（从 store 读取目录）
│  └─ MapControls.vue      画布工具条：放大 / 缩小 / 复位 / 全屏
├─ stores/
│  └─ examples.ts          示例目录（唯一需要手动维护的注册表）
├─ views/
│  ├─ Home.vue             首页技术栈卡片
│  └─ ExamplePage.vue      示例页：懒加载组件 + 源码面板
├─ examples/
│  ├─ basemap-defs.ts      底图统一定义（Cesium / OpenLayers 共用）
│  ├─ shared/terrain.ts     DEM 合成与算法工具（噪声场 / 双线性采样 / Horn 晕渲 / Marching Squares 等），地形类示例共用
│  ├─ cesium/              25 个示例 + demMesh.ts（DEM 转 Cesium 几何 / 贴图材质）+ useCesium.ts + basemaps.ts
│  ├─ three/               24 个示例 + useThree.ts（Renderer / 相机 / OrbitControls / 自适应）
│  ├─ openlayers/          22 个示例 + useOl.ts（Map 脚手架）+ basemaps.ts
│  └─ webgl/               16 个示例 + gl.ts（着色器编译、FBO、纹理、矩阵工具）
├─ utils/highlight.ts      highlight.js 封装
├─ types/                  ExampleMeta / TechCategory 等类型
└─ styles/global.css       主题变量（面板、边框、强调色）与公共样式
public/3dtiles/            3D Tiles 示例使用的本地瓦片集
```

## 新增一个示例（三步）

1. 在 `src/examples/<技术栈>/` 下新建 `Foo.vue`；
2. 在 `src/stores/examples.ts` 对应技术栈的 `examples` 数组里加一条：

   ```ts
   {
     id: 'foo',                      // 路由里用的短 id，全栈唯一
     title: '某某效果',
     description: '一句话讲清实现方式与可调参数。',
     file: 'three/Foo.vue',
   }
   ```

3. 完成。组件和源码都由 `import.meta.glob` 自动收集，不需要再登记任何加载器。

写示例时的几个约定：

- 复用对应技术栈的脚手架（`useCesium` / `useThree` / `useOl` / `gl.ts`），不要每个文件重复搭一遍渲染循环；
- Cesium 示例给 `home` 带上 `focus`（内容中心 + 半径），复位与缩放才会围着内容转，而不是围着随手写的相机位置转；
- 在 `onBeforeUnmount` 里销毁 viewer / renderer / 事件监听 / 定时器 / 位图，切换示例不能留下悬挂的 RAF；
- 控制面板沿用 `global.css` 里的 `.panel` `.stat` `.tip` 等类，保持视觉统一；
- 描述里写清「用了什么算法 / 什么原理」，而不是只写效果名。

## 实现要点与踩坑记录

这些都是本项目里真实踩过并修掉的坑，做法已固化在对应示例的注释里：

- **Cesium 动态贴图闪烁**：反复给 `ImageMaterialProperty.image` 赋 dataURL，Cesium 会先把纹理退回 `defaultTexture` 再异步 `fetchImage()`，加载完成前的帧整块渲染成默认图 → 地面一闪一闪。正解：`createImageBitmap(canvas)` 解码完成后再赋给 `material.uniforms.image`，同帧原子替换；材质初始值用 `Material.DefaultImageId`，避免其异步加载完成时把常驻纹理销毁。
- **canvas `ctx.filter = 'blur()'` 不保证进入纹理上传**：`getImageData()` 能读到模糊像素，GPU 纹理里却可能没有（且时有时无）。需要半影时不要用画布滤镜，改用「凸包核心 + 两层绕形心外扩的低透明度叠加」。
- **Entity 的动态材质会重建几何**：材质属性一变，`GeometryVisualizer` 就重建图元，那一帧不画。高频更新的贴图应挂在静态 `Primitive` 上，只换 uniform。
- **Cesium 倾斜视角下 `camera.zoomIn/zoomOut` 会把地球推出画面**：那是沿视线后退。改成以屏幕中心射线命中的地面点为锚点、沿「锚点→相机」改变距离（`useCesium.ts` 的 `zoomCesiumCamera`）。这里还有两个坑：① 瓦片没加载完时 `globe.pick` 返回 `null`，若退回「相机正下方地面」当锚点，视线中心与锚点根本不是同一个点，一缩放内容就整体滑走 —— 正解是再退一步用视线与椭球求交，仍失败就干脆不响应；② 距离不设上下限，缩到底就是贴地穿模，放到底地球只剩一个点。
- **手写 `destination` 保证不了「内容在画面中间」**：`destination + orientation` 只说明相机在哪、朝哪，内容偏在角落是常见结果，缩两下更容易推出画面。给 `home` 加 `focus`（内容中心 + 包围半径 + 复位距离），复位与缩放就都锚在内容上，range 夹在 `[1.3r, 9r]`，既居中又不会缩穿。`useCesiumView` 会轮询最多 6 秒等 `focus` 就绪（有的焦点要等地形采样 / 瓦片加载），并在取景前 `cancelFlight()` 掐掉页面自己的飞行动画，否则它会在取景之后把相机再拽走。
- **Cesium 自带的太阳与阴影对自定义几何无效**：`SunLight.directionWC` 恒为 `undefined`，`viewer.shadows` 对 entity 多边形不起作用。日照分析是自己按方位角/高度角算太阳向量，再在 fabric 材质里用 `czm_viewRotation * uSun` 自算漫反射，落影则用「底面四点 + 顶面四点投影取凸包」解析求出后烘进贴图。
- **`RectangleGraphics.stRotation` 旋转的是整个 UV**：贴图会越界被 `REPEAT` 采样，台风图因此变成方框。要让贴图自转，必须用 `Primitive` + 三角/椭圆几何，在 shader 里转 UV，并把 `minificationFilter` 设为 `LINEAR` 关掉 mipmap。
- **OpenLayers 9 移除了 `ol/sphere.circular()`**：点缓冲改为自己按「起点 + 方位角 + 距离」的球面大地线公式推 256 边形（在 Web Mercator 投影坐标里直接画圆，中高纬会明显拉伸失真）；线缓冲用相邻段的**平均法向**做 miter 平移（并 clamp miter 系数）+ 端点半圆帽；面积与长度取 `ol/sphere` 的 `getArea` / `getLength` 球面真值。
- **底图选型**：CARTO basemaps 已强制要求 API Key（返回「API KEY REQUIRED」水印瓦片），OSM 官方瓦片对非规范客户端返回 403。本项目统一使用 Esri ArcGIS Online 公开服务：无需 Token，且响应头带 `Access-Control-Allow-Origin: *`，Cesium 才能把瓦片当纹理用。
- **Three.js `Reflector.material` 类型上是 `Material`**：想改 uniforms 需要 `as THREE.ShaderMaterial` 断言。
- **阴影贴图的光锥必须覆盖整个场景**：`fwd` / `back` 范围不够会把远端几何裁掉、影子整段消失；自阴影摩尔纹（acne）用「沿法线偏移采样点」的 slope-scaled bias 压制，比加常量偏移更能压住斜面上的条纹。
- **GPGPU 粒子会聚成球壳**：每个粒子的刚度要在速度纹理的 w 通道里随机化，否则所有粒子同步运动，看起来像一层壳。
- **`!scene3DOnly` 下不能给含原点的 DOUBLE 顶点配 `modelMatrix`**：Cesium 会对几何做 `GeometryPipeline.projectTo2D`（为了二维/哥伦布视图），局部坐标里的 `(0,0,0)` 转不成经纬度，直接抛 `DeveloperError: Could not project point to 2D`。DEM 三角网、设计面、水面这类自定义几何一律直接建在**世界坐标**（`Cartesian3.fromDegrees`），不要用「ENU 局部坐标 + modelMatrix」。
- **`new Cesium.Geometry({ attributes })` 要用 `new Cesium.GeometryAttributes()`**：直接写字面量对象会报缺少 `bitangent` / `tangent` / `color`（TS2739），必须建实例后逐个赋值。
- **`RectangleGeometry` 收的是经纬度不是米**：把以米为单位的跨度直接塞进去会抛 `Expected north to be less than or equal to 1.5707963, actual 245`，需先除以 `111320·cosφ`（经度）与 `110540`（纬度）。
- **Cesium 材质贴图 `flipY = false`**：`t = 0` 对应画布第一行，所以「北」行的 `st.y` 应该是 `0` 而不是 `1 - v`，写反了贴图和指北针会南北颠倒。
- **同一材质里的多张纹理要走同一条上传路径**：一张用 `HTMLCanvasElement`、另一张用 `ImageBitmap` 时，两边的采样行为不一致——卷帘右半边与「纯基准期」截图直方图几乎完全相同，逐像素相关系数却接近 0。统一都过 `createImageBitmap` 后相关系数回到 1.000。
- **shader 里的开关别忘了乘在整个 terms 上**：`1.0 - smoothstep(...) * uCompare` 在 `uCompare = 0` 时等于 `1`，整块被 `mix` 成白色；正确写法是 `(1.0 - smoothstep(...)) * uCompare`。这类「看起来偶尔白屏」的问题先怀疑表达式括号，别急着怀疑纹理上传。
- **OpenLayers `ImageStatic` 的 `imageExtent` 顺序是 `[minX, minY, maxX, maxY]`**：写成「西、北、东、南」（把 maxY 放前面）minY/maxY 颠倒，整个图层会静默不显示——不报错、只消失，很难查。
- **调试 Cesium 渲染时先掐掉远程瓦片**：Esri 底图瓦片会在后台持续加载，同一状态前后两次截图平均差可达 17/255，任何基于像素差分的验证都会失效。用 Playwright 的 `page.route` 拦掉瓦片域名后噪声底为 0，差分结论才可信。
- **分析结果要「贴地」，不要自己搭一块悬空的块**：早期版本用「自建三角网 + 按场地高程整体抬高 + 垂直裙边」把分析块放到真实地形上，结果放大后必然露馅——块体像浮在地面的板，边缘出现竖向剖切面。正确做法是分开两件事：**计算用真实高程，渲染用贴地图元**。① 用 `Cesium.sampleTerrain`（65×65、层级 12，约 400ms）把真实地面高程采样进 DEM，分析的基底就是真实地形；② 结果纹理用 `GroundPrimitive` + `RectangleGeometry` + `MaterialAppearance`（`classificationType: TERRAIN`）分类渲染，Cesium 会把它贴在真实地表上，缩放/倾斜都不会分离。
- **贴地图元必须带 alpha**：不透明的贴图在放大后就是一整块纯色，地面细节全被盖住。把分析色块的 alpha 写进 canvas（可见区 ~0.6、遮挡区 ~0.5、未覆盖 ~0.15），并给四周做 `smoothstep` 边缘羽化，矩形范围才会自然淡入地形，而不是「切一刀」。
- **`GroundPrimitive` 同步构建要额外初始化**：`asynchronous: false` 时必须先 `await Cesium.GroundPrimitive.initializeTerrainHeights()`，否则抛 `DeveloperError`；保持默认异步构建最省事（首帧后出现）。
- **Cesium 的粒子系统全靠 `clock` 推进**：`ParticleSystem` 用 `frameState.time` 的增量算 dt，而 Viewer 的 `clock.shouldAnimate` 默认是 `false`——时钟不走，dt 恒为 0，一颗粒子都不会发射，也不报错（`_particles` 长度为 0，只有贴图池看不出问题）。示例里第一句就是 `viewer.clock.shouldAnimate = true`。
- **1.118 的 `ParticleSystem` 已经没有 `gravity` 选项**：重力要在 `updateCallback` 里自己积分（`velocity += g * dt`，position / velocity 都是世界坐标）。想要「垂直下落」得先求当地法线，直接写 `(0,0,-9.8)` 在赤道以外会歪成斜坡；热浮力就用负重力。
- **地形自适应要先等服务就位**：`enableWorldTerrain` 是异步的，紧跟着采样海拔会拿到光滑椭球的 0 米。轮询 `viewer.terrainProvider instanceof ArcGISTiledElevationTerrainProvider` 之后再采样。
- **Esri ImageServer 的 `identify` 接口返回的是概览金字塔值**（WorldDTM_OV256），10km 范围内可能恒为同一个数，不能用它判断局地起伏；要全精度就老老实实走 `sampleTerrainMostDetailed`。
- **垂直拉伸（exag）必须为 1 的两种场景**：水面高程要与 DEM 判定精确一致（exag≠1 时水岸线对不上）；`pickUV` 这类射线步进拾取拿的是渲染后的世界坐标（exag≠1 时读数偏差可达数百米）。要立体感宁可换真实地形，别拉 z 轴。
- **dark 底图 + 无雾 = 三维也像二维**：真实地形开了、云也在转，但深色底图下远处山体融进黑背景，画面仍是平面感。影像底图 + `scene.fog` + `showGroundAtmosphere` 三件一起开，山才有前后景深。
- **动画状态别"每帧取整"**：`level.value = Math.round((level.value + rate * dt) * 10) / 10` 会让动画永久卡住——每帧只涨 0.04，四舍五入回原值，累加基准被钉死。正确做法是另存一个未取整的浮点累加器，只在写回时取整。
- **ImageBitmap 当纹理源不能立即 `close()`**：Cesium 是在下一帧 `Material.update` 里才把 uniform 上的位图上传成纹理，换帧瞬间释放会让它读到 `width = 0`，抛 `DeveloperError: Expected width to be greater than 0` 并中断整页渲染。实测「播放动画 + 切换卷帘对比」必现。延后一两秒再回收即可（真正没挂上 uniform 的位图仍可立即释放）。
- **SDF 的符号约定要统一**：`length(p) - r` 这类标准 SDF 是**内部为负**，若着色器按「正 = 内部」写，保留/挖除会整体反向；编码进 R 通道时先取反（`0.5 - 0.5 * d / RANGE`）最省事。
- **立方坐标取整要写回返回值**：六边形聚合里 `rx/ry/rz` 修正后必须返回修正值，返回未取整的原始分量会让每个点自成一格——聚合结果「一点一格、峰值恒为 1」，且不会报错。
- **累加距离要以上一个采样点为基准**：等距采样算剖面长度时，用「当前点 − 所在线段起点」会在线段内重复累加，320 个采样点能把 9km 放大成 800km。

## 说明与限制

- 需要联网：底图瓦片来自 Esri 公开服务，`ModelLoad` 示例引用的 glTF 模型为外部 URL；`Tiles3D` 使用的是 `public/3dtiles/` 下的本地瓦片集，可离线运行。
- 示例中的点位、轨迹、气象、建筑等数据均为**程序化合成**（固定随机种子），用于演示算法与渲染，不代表真实业务数据。
- 项目定位是学习与参考：代码以「可读、可拆、可拷」为第一目标，未做通用组件抽象与生产级错误兜底。
- 路网路径规划示例使用 **OpenStreetMap** 数据（© OpenStreetMap contributors, ODbL 1.0）：由 `scripts/fetch-osm-roadnet.mjs` 预先抓取指定 bbox 并精简成 51KB 的本地 JSON，页面不发起网络请求；换城市只需改脚本参数重跑一次（公开 Overpass 镜像在国内基本连不上，所以不做运行时拉取）。
- 全站回归的测试方法与缺陷记录见 [docs/TEST-REPORT.md](docs/TEST-REPORT.md)（91 个示例冒烟 + 交互语义断言 + 压力测试）。

## 技术栈

Vue 3 · TypeScript · Pinia · Vue Router · Vite · Cesium 1.118 · Three.js 0.160 · OpenLayers 9 · highlight.js

## 许可

[MIT License](LICENSE) © 2026 jycao2 —— 代码可自由使用、修改与分发（包括商业用途），只需保留版权声明。

需要注意：底图瓦片来自 Esri ArcGIS Online 公开服务，示例中的 glTF 模型引用自外部 URL，二者遵循各自的使用条款，不包含在本项目的 MIT 授权范围内。
