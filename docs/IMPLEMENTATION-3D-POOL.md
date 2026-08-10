# 3D 潮池实现记录

## Batch 1：场景 / 相机 / 水面骨架

状态：供交叉审查的 preview，不替换已签收 2D 默认面。访问 `pool.html?renderer=3d` 才按需加载 Three.js；无参数、WebGL 不可用、初始化失败或 context lost 时继续使用原 `canvas#stage` 2D 潮池。

### 结构

- `web/src/pool/three/config.mjs`：唯一 Tier 1 参数面；包含世界半径、pixel ratio、相机约束、涟漪槽位和色板。`polarToWorld()` 是 3D 唯一空间映射，严格保持 `r -> XZ distance`，Y 固定为装饰高度。
- `camera-rig.mjs`：PerspectiveCamera + OrbitControls；damping、禁止 pan、上下水面约束、初始水平限角、5px 点击/拖拽阈值、pointer capture、空闲慢漂、双击平滑复位与 reduced-motion gate。
- `water-disk.mjs`：CircleGeometry + 自定义 shader；深水底、低饱和银灰高光带、Fresnel、视角相关镜面光、指数雾、24 槽循环撞击点。无 Reflector/FBO/physical glass。
- `data-model-group.mjs`：现有极坐标粒子在 XZ 盘面的 billboard 投影、低成本镜像 sprite、轨道标尺以及 world-to-screen anchor；不改变 layout 真相。
- `tide-pool-3d.mjs`：renderer/scene 生命周期、Lighting、raycast 空白水面撞击、resize、WebGL context lost/restored、资源 dispose 和 projection callback。

### 接入边界

- 服务端、`/viz/*` 数据结构、live coordinator、drawer/hover/focus 逻辑零改动。
- 原 overlay button 数量仍等于 `placed` 数量；overflow 继续显式。相机运动时按钮由真实 world projection 同帧更新。
- 默认 2D bundle 不静态包含 Three.js。production build 产出约 11.5 KiB gzip 的 pool 入口；约 139 KiB gzip 的 3D chunk 只在 preview gate 下载。
- reduced-motion 下停止自动漂移并把 water time 固定为静态终态；现有迁移/雨滴/涟漪的 2D gate 保持。

### Batch 1 实测

- Node：`test-pool-3d.mjs` 验证 preview gate、pixel ratio cap、半径单调与 Y 零编码、相机不钻底及 5px 阈值。
- Build：`npm run build` 通过，`dist/pool.html` hashed entry gate 通过。
- 浏览器真实 `/viz/ocean`：123 memories、2 explicit overflow -> 121 overlay buttons；默认机位水盘完整；拖拽改变投影且 overlay 同步；双击回到 home；粒子点击打开居中 modal，关闭后焦点归还原按钮；无参数路径 `stage3d` 不创建 canvas、2D stage 保持可见。

### 后续 Tier 1

Batch 1 不冒充完整 Tier 1 验收；下列尾款在 Batch 2 落地。

## Batch 2：雨 / 慢涟漪 / 潮痕 / 去圆盘感

- `water-disk.mjs` 改用 56×160 径向细分网格。原 `CircleGeometry` 只有圆心和外圈顶点，局部 vertex displacement 无法形成真实扩散；现在每个撞击点能在盘内产生宽波包，24 槽可叠加干涉，7.2s 后衰减。
- 水面 fragment 的珍珠高光由两层 value noise、视角方向和动态宽度共同打散；外缘从半径 84% 起 alpha 衰减到透明。导轨改为角向非均匀 shader，并按距离降低 opacity，不再形成等亮唱片纹。
- `rain-system.mjs` 用固定 seed 与 `r = R * sqrt(random)` 做面积均匀采样；58 个 pooled point-sprite 雨滴持续落水并写入同一 impact ring buffer。remember 的定向落滴复用既有 380ms 事件时序，着水后由原状态机生成粒子与微涟漪。
- `tide-mark-group.mjs` 接入原 outcome ring 生命周期：credited 是完整潮痕，blamed 是三段断裂侵蚀痕；二者跟随记忆当前 world position，停留 4.5s 后淡出。
- reduced-motion 保留少量静态雨滴、冻结当下水面时间、禁用自动漂移；默认 2D 路径和 WebGL 回落逻辑不变。

### Batch 2 实测

- Node：新增边缘衰减、宽波参数、雨滴 seed/面积均匀性、径向水面顶点/索引拓扑断言。
- Build：`npm run build` 通过；3D chunk 仍由 `?renderer=3d` dynamic import 隔离。
- 浏览器真实 `/viz/ocean`：123 memories、2 explicit overflow、122 overlay buttons（含 scripted remember）；WebGL console 零 error/warn。可见下落雨滴、remember 落水、慢扩散叠加涟漪、credited 完整潮痕；水面外缘融入背景，规则直线高光与等亮导轨已移除。
