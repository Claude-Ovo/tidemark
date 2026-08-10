# SPEC：潮池 3D 化（施工方：Codex；规格与验收：Claude；方向：Owner）

来源：Owner 需求稿（GPT 整理，2026-08-10）+ 比赛现实约束下的分层取舍。
参考站 Rainform 仅借鉴思路——**PolyForm Noncommercial 协议，一行代码不得复制**。

## 0. 不可动摇项（先于一切美学）

1. **数据语义红线**：极坐标「半径 = 保留强度」是唯一空间真相。3D 化只改观察方式：
   平面映射到 XZ 盘面，Y 仅作装饰性微浮/雨滴下落轴，**不得新增空间编码**；
   数据→视觉参数映射（雨量/涟漪强度等）只做氛围增强，不得改变原语义。
2. **交互契约保留**（已签面）：hover 卡出现在鼠标位（**不动**）；详情居中 modal（**不动**）；
   a11y overlay 按钮 = world→screen 投影后的 painted anchor，与 motion-sync 的
   dirty 消费管道同帧同步；键盘 Tab/Enter/ESC、焦点归还、drawer-guard、live 环、
   reduced-motion（禁自动漂移、雨密度降级、涟漪静态化）全部原样成立。
3. **服务端零改动**：不碰接口、数据结构、路由；`pool.html` 现有 2D 版**保留为
   WebGL 不可用时的降级页**（天然 fallback，不另造静态图）。
4. 时间盒：**Tier 1 若 8/14 晚未到可验收状态，果断回落 2D 版录屏**——2D 版已是
   完整签收的产品面，3D 是加分不是地基。

## Tier 1（必做，目标 ≤2 个工作日）——「3D 最小完整形态」

- **场景**：Three.js + PerspectiveCamera；现有 layout 极坐标 → XZ 平面，节点 Y 微浮于水面上方。
- **相机**（参数照 Owner 稿）：OrbitControls；enableDamping=true, dampingFactor≈0.08,
  enablePan=false, rotateSpeed≈0.55, zoomSpeed≈0.8；俯仰角钳制在水面上方（禁止钻底）；
  水平先限角、验收后放宽 360°；双击平滑复位；pointer capture + ~5px 拖拽阈值区分
  点击/拖动；UI 交互不带动旋转；resize 保持圆盘居中完整。长时间无操作极慢自动漂移，
  触碰即停（reduced-motion 下禁用漂移）。
- **水面**：CircleGeometry（半径 = 最外圈 × 1.15-1.2），自定义 ShaderMaterial——
  黑色深水底色 + 银灰-珍珠白程序化高光带 + Fresnel 边缘光 + 冷蓝极弱染色 +
  与相机角度相关的镜面高光 + FogExp2。**反射走廉价路线**：节点镜像 billboard
  （倒影 sprite + 距离衰减 + 涟漪扰动其抖动/透明度），不做真 Reflector pass。
- **涟漪**：shader 循环缓冲 16-32 个活动撞击点（Owner 稿自带的替代路径），扰动
  normal/高光/倒影；圆形边界振幅衰减；平时保留极轻微波动。**不做 ping-pong FBO
  heightfield**（Tier 2）。
- **雨滴**：Points/InstancedMesh + shader 点精灵（柔软雨珠+拖尾），极坐标均匀采样
  `r = R·sqrt(random)`，seeded random（同数据同种子构图稳定）；落点触发涟漪；
  长度/速度/亮度轻微差异，偏冷白蓝灰；数量/速度/强度集中一个 CONFIG 对象。
- **节点材质**：保留白色亮核 + 受控柔光（现 2D glow sprite 思路 billboard 化）；
  中心核最亮、外层随数据渐变；**不上 MeshPhysicalMaterial 透射玻璃**（Tier 3）；
  Bloom 不上或仅极轻 selective（Owner 明确否决大面积发白棉团）。
- **轨道线**：极细、低透明度冷灰蓝，贴近水面。
- **灯光**：低调深蓝黑环境，数个大面积冷色软光/emissive cards 拉长水面反光，
  轻 rim light + 指数雾；ACESFilmicToneMapping、适度曝光。
- **工程**：分层 DataModelGroup / WaterDisk / RainSystem / CameraRig / Lighting；
  实例化+对象池+活动涟漪上限；pixelRatio ≤1.5-2；rAF 生命周期与 dispose 完整；
  webglcontextlost/restored 处理；组件卸载 dispose 全部 GPU 资源。
- **命中层**：raycast 或投影 anchor 命中（与 overlay 按钮同一坐标源）；点击水面
  空白处产生一次波纹（拖动结束不误触发）。

## Tier 2（Tier 1 验收后、时间富余才做）

ping-pong FBO heightfield（R 高度/G 速度、四邻域 Laplacian、圆形吸收边界、
桌面 768²/移动 512²）；真 Reflector 平面反射；轻 vignette/景深；程序化雨声
（首次点击启用+静音钮，数据驱动强度）；DEV 调参面板（生产隐藏）；
固定种子视觉回归截图 + 拖拽/点击/复位交互测试。

## Tier 3（明确砍掉，本届不做）

全节点 MeshPhysicalMaterial 透射/clearcoat/ior；皇冠水花与泡沫堆砌（Owner 稿
自己也否决）；移动端精细质量分级（demo 为桌面录屏）；雨声多层次混音。

## 验收（Tier 1）

1. 开页即见持续降雨、动态水面、涟漪与灯光倒影，静置画面不死（reduced-motion 除外）。
2. 每个可见落点触发自然扩散衰减的波纹并扰动对应区域反射/倒影。
3. 拖拽顺滑带惯性，可环绕看结构厚度、节点高度与倒影；圆形模型始终是主体。
4. hover 卡/居中 modal/键盘/焦点/live 环/reduced-motion 全部按签收契约工作。
5. 构建+检查通过；改动文件、实现结构、可调参数成文。
6. **30 秒可读性命题**在默认机位复验（数据仍一眼可读，不被氛围吃掉）。

## 排期位

P0-12 收尾与 P0-13/14 文档冻结优先；3D Tier 1 目标窗口 8/12-8/14，与文档批并行；
8/15 集成验收；8/16-17 录屏。回落线见「不可动摇项 4」。
