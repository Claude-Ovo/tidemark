# SPEC：可审计的 3D 记忆潮池

来源：Owner 2026-08-11 终周需求稿。本文取代此前“随机环境雨、独立透明圆环、FBO 延后 Tier 2”的批次规格。Rainform 和外部截图只作氛围参考，不复制代码、shader、素材、文案或常量。

## 0. 优先级

1. P0：CockroachDB/AWS 真实集成、持久化、可运行公网 Demo、比赛资格。
2. P1：记忆机制和证据在三分钟视频内可见、可验证。
3. P2：雨水、水冠、材质与后期精修。

视觉层不得用 Logo、静态文字、假 telemetry 或前端随机粒子掩盖尚未完成的集成。

## 1. 数据语义

- 黑色连续水面 = CockroachDB 中持久存在的记忆状态。
- 一条 rain strand = 一条真实且后端已提交的 lifecycle event；strand 内 16–40 个珠滴只是一条轨迹。
- `remember` 形成尚未验证的短暂落点；`recall` 只产生 receipt/短波，不增加长期权重。
- `pin` 是稳定锚点。
- 只有 terminal outcome 中 `applied=true` 的 credited/blamed attribution 能留下长期变化。
- cancelled、late、unattributed、未到 outcome 的事件不产生塑性。
- `visualImpactCount === committedEventCount`，计数单位都是 strand。

极坐标半径仍是 retention strength 的唯一空间真相；圆形拓扑只用于分布、映射和命中，不绘制发光轨道。

## 2. 画面与实现

- PerspectiveCamera 低斜视角，FOV 约 35；水面位于画面下方 35%–45%。
- 近黑连续反光水面；银白、冰蓝为主，业务色克制；Bloom 只给滴头、接触点和短水冠。
- 雨用共享 `THREE.Points`/BufferGeometry（或 LineSegments），禁止一滴一个 Mesh。
- 水面必须是 512–768 HalfFloat ping-pong height field：R 高度、G 速度、四邻域 Laplacian、阻尼、圆形吸收边界。
- 本帧撞击批量写入；顶点采样高度；fragment 以有限差分法线计算 Fresnel、窄镜面与反射层次。
- 多个事件的波必须在同一场内叠加和干涉；禁止 `RingGeometry`、`LineLoop`、CSS/canvas ellipse 或独立透明圆环冒充水波。
- 同 texel 事件可合并冲击强度，但必须保留精确事件计数；容量不足顺延，不随机丢弃。
- 每条 strand 过水面时在同一 XZ 写一次 impulse，并产生 120–400ms 接触闪光或小水冠。

暂停任一密集 trace 帧，应先读成“纵向事件雨幕落在黑色水面”，而不是“同心圆灯珠和贴图线圈”。

## 3. Evidence UI

首屏展示：

`Remember → Recall receipt → Agent action → Outcome attribution → Plasticity`

点击 strand、最近落点/波或时间线记录必须选中同一真实事件。详情只绑定现有 schema 字段；缺少的 CockroachDB/AWS trace 字段显示 `unavailable`，不得生成占位成功状态。

Live 只播放当前真实事件。事件不足时，Trace Replay 只能分页读取 CRDB 历史，或播放经过真实 API/数据库路径写入并明确标记的 seeded demo；界面显示数据范围和倍速。

## 4. 回退与质量

- 浏览器不持有数据库连接串、AWS key 或服务端 secret。
- loading、connected、degraded、failed、retry 必须使用真实状态。
- WebGL2 不可用或 context lost 时回落 2D 记录/详情证明面，不白屏。
- reduced-motion 直接进入可审计静态终态，不丢事件；至少保留桌面正常档与回退档。
- 16:9 录屏和普通桌面均不遮挡 HUD、水面与交互锚点。

## 5. 验收

1. clean install、build、test、运行通过。
2. remember/recall/pin/report_outcome 行为未破坏；recall 不强化，只有已归因 terminal outcome 改变长期状态。
3. 页面刷新从 CockroachDB 重读状态；Judge Demo 走真实 API、检索、receipt、AWS action、outcome 和持久化回读。
4. Evidence 只陈述仓库中真实使用的 CockroachDB 工具和 AWS 服务。
5. 3D 主路径零几何圆环；波可叠加、干涉并随视角改变高光。
6. 事件轨和视觉落点计数闭合；点击可回到同一条持久化记录。
7. 依赖/许可证/provenance 检查通过，无 Rainform、afterimage、PolyForm Noncommercial 派生物。
