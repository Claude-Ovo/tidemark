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

Batch 2 再接 `RainSystem`（seeded polar sampling + pooled drops）、撞击点的可见雨滴来源、outcome 潮痕的 3D 表达和更完整的 reflection 扰动。Batch 1 不冒充完整 Tier 1 验收。
