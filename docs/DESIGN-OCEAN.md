# Tidemark 前端设计 Brief：会遗忘的海（P0-11，冻结 v1）

> 概念原作：Ovo手绘（docs/assets/ocean-concept-by-ovo.jpg，2026-08-05）。
> 风格参考：https://deadrabbit.collax.app/gs-transition（取其粒子成形+发光bloom+溶解重组，弃其3D扫描感）。

## 一句话

**整片海就是数据库的实况**：每个视觉属性绑一个真实字段，衰减公式实算驱动画面——
不是装饰画，是活的审计面。

## 场景 = 信息架构

| 场景元素 | 数据语义 | 绑定字段/机制 |
|---|---|---|
| 纵向渐变（暖沙→深蓝） | 记忆生命周期轴 | **visual_depth = 1 - effective_strength**（服务端实算，经 easing 映射；越强越浅，Codex 契约 #1） |
| 沙滩 | 重要/新鲜记忆浮层 | pinned、高强度、近期 credited |
| 沙水交界线 | 衰减阈值 | fade_threshold = 0.15（掉线即滑入水中下沉） |
| **潮水（签名元素，全场唯一）** | **recall 事件** | 每次真实 recall：一道浪涌上沙滩退去，留下一道泡沫痕 = receipt。Tidemark 之名每次被使用当场上演 |
| 气泡 | episode（一段对话/任务） | 按 (agent, episode) 聚，位置 x=时间 y=聚合强度；与 dream 的成簇逻辑同构 |
| 泡内粒子颜色 | kind | demo agent 自律打 kind 标签；悬停即见色彩构成 |
| **珍珠** | experience（reflection 产物） | 砂砾磨成珍珠 = 从失败中提炼经验；exp_status 亮度：candidate 微光 / verified 满光 |
| 白化珊瑚区 | 将忘之地 | 白化程度 = 饱和度 = 强度；faded 记忆栖息地 |
| 远处岛屿 | agent（海湾切换） | 一 agent 一海湾；岛屿大小 = 记忆量；租户/agent 隔离变成地理事实 |
| 棕榈/绿植 | 纯装饰 | 精工但安分（签名元素只有潮水） |

## 交互宪法（Ovo钦定）

1. **零方框零按钮**：控件全部融入环境。
2. 悬停（气泡/珊瑚/贝壳/浪痕）→ 就地浮出标题+一句概要（splat 质感文字，像水中晕开）。
3. 戳一下 → **上浮水泡透镜**展开整理后的详情（强度曲线、credited/blamed 归因、receipt 评分构成）——不是弹窗，是从场景里长出的大泡；关闭 = 泡破，光屑落回海中。
4. agent 切换 = 点远处岛屿，场景粒子溶解重组（gs-transition 式）游进另一片海湾。

## 风格规格（Ovo原话冻结）

2D painterly illustration with a Gaussian-splat and point-cloud aesthetic, translucent
elliptical color particles, softly fragmented edges, luminous color bloom, impressionistic
colors, dreamy layered depth, no 3D scan, no thick impasto texture.

实现注记：物体由粒子密度"凝"出而非描边；黑暗/深水为画布，发光为笔；场景过渡=粒子溶解重组。

## 技术方向

- Web（S3+CloudFront 静态托管，全 AWS 叙事到底）；响应式。
- WebGL 粒子渲染（自研轻量 splat 渲染器或 pixi/regl 层，开工时定）+ GSAP 全家桶驱动
  潮汐呼吸/气泡漂移/溶解重组（gsap-core/timeline/scrolltrigger/performance skills 已装）。
- 数据源：真实 API。内容面走 agent face（demo 租户），审计数值可走 audit views（content-free）。
- 演示协同：P0-11 demo agent 的七步闭环实时反映在海里——失败→反省→珍珠成形；
  未被使用→下沉白化；credited→上浮复色。画面即 A/B 故事。

## 数据契约（Codex kickoff 四条，冻结）

1. **深度公式**：`visual_depth = 1 - effective_strength`（再经 easing），方向不可反。
2. **单一快照**：客户端**永不**用浏览器时钟重算衰减。`GET /viz/ocean` 一次返回同一
   server/DB 快照的 `snapshot_at + fade_threshold + 各记忆 effective_strength`（服务端
   用与 recall 相同的公式计算）；多路数据必须服务端按同一快照汇合。
3. **浪的真源**：每道潮水由 **persisted completed recall receipt** 触发；
   `GET /viz/waves?after=<cursor>` 稳定游标增量流；刷新/断线重放/StrictMode remount
   必须去重——optimistic 请求与 replay 不得演成第二次召回。
4. **语义无障碍**：零方框只约束视觉。岛屿/气泡/泡破均有 keyboard/focus/ESC 等价路径，
   `prefers-reduced-motion` 尊重；Canvas 命中目标配同步 accessible DOM overlay。
   episode 的 x=时间、横向 jitter=`episode_id` 稳定散列（轮询不重排）。

## 比赛要求绑定

- CockroachDB：所有画面数据实时来自 CRDB（向量检索+生命周期字段）。
- AWS：前端托管+API+推理全在 AWS。
- 评委动线：打开 URL 即见海；三次悬停一次点击读完全部信息架构；
  录屏 3 分钟内讲完"这片海会遗忘、会学习、每道浪都有收据"。
