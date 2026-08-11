# 3D 潮池实现记录

状态：`pool.html?renderer=3d` 使用真实 `/viz/ocean` 与 `/viz/activity`；无 WebGL2、初始化失败或 context lost 时回落到已签收的 2D 证明面。本文记录 2026-08-11 最终语义重构，取代早期“随机雨 + 独立圆环”批次。

## 结构

- `config.mjs`：FOV 35 的低斜机位、统一水面/雨丝/接触反馈参数。
- `height-field.mjs`：512² HalfFloat ping-pong RenderTarget。R 为高度、G 为速度；四邻域 Laplacian、阻尼、圆形吸收边界；每帧批量消费落点。
- `water-disk.mjs`：径向细分连续水面。vertex 采样高度，fragment 用有限差分重建法线并计算 Fresnel、窄镜面与局部 outcome 潮痕。
- `rain-system.mjs`：固定容量的共享 `THREE.Points`；一条持久化事件对应一条 strand，每条 16–40 个装饰珠滴。事件只在 strand 过水面时写一次 impulse，并复用接触闪光/水冠池。
- `data-model-group.mjs`：保持 `radius = retention strength` 的唯一数据真相；仅渲染记忆光点和投影锚点，不绘制圆形导轨。
- `tide-mark-group.mjs`：把 credited/blamed outcome 投影为水面 shader 的局部沉积/侵蚀标记，不创建几何圆环。
- `tide-pool-3d.mjs`：统一 renderer、相机、雨丝、高度场、水面、WebGL 生命周期和点击事件记录的路由。

## 真实事件到视觉事件

| 持久化事件 | 视觉结果 | 长期状态 |
| --- | --- | --- |
| `remember` | 一条 strand 落到新记忆的真实布局位置，短暂接触痕 | 只展示后端已提交的新记忆 |
| `recall` | 一条 strand、一次落点 impulse、短暂传播波 | 不强化、不移动记忆 |
| `outcome` credited/blamed 且 `applied=true` | strand + 连续波场 + 局部潮痕 | 位置变化只消费后续 CRDB 快照 |
| cancelled / late / unattributed / `applied=false` | 可审计事件仍可进入记录；无塑性潮痕 | 不改变长期状态 |

点击活动雨丝、最近落点或顶部事件记录，都会打开同一条 `/viz/activity` 记录。面板只展示现有字段；AWS trace 等当前 schema 没有的字段明确显示 `unavailable`。

## 因果与容量不变量

- `committedEventCount` 与 `visualImpactCount` 都按 strand 计数，不按珠滴计数。
- 同 texel 撞击合并强度但累加 `eventCount`；超出单帧 uniform 容量的批次顺延，绝不随机丢事件。
- 切换 reduced-motion 时，活动和排队 strand 立即落到静态终态，高度场消费一次 impulse 后停止传播，计数仍闭合。
- 3D 水波代码不含 `RingGeometry`、`LineLoop`、canvas/CSS 圆环或一滴一个 Mesh。

## 接入边界

- 服务端 API、数据库 schema、live coordinator 和 detail 真源未改。
- 2D fallback 保留其既有签名并明确作为回退；3D 主路径不复用其 canvas 圆环。
- 圆形数据拓扑继续决定半径，但导轨不可见；交互 overlay 继续由真实 world projection 同帧更新。
- Live 只消费持久化事件。Trace Replay/Judge Demo 必须由真实 CRDB 历史或显式 seeded API 流提供，不允许前端随机雨冒充吞吐。

## 验证

- `node web/test-pool-3d.mjs`：事件 strand、16–40 段、落水一次、同 texel 合并计数、shader 潮痕极性、3D 圆环禁用扫描。
- `cd web; npm run build`：生产构建与 dist gate。
- 真实浏览器：WebGL2 高度场水面、123 条记忆、持久化 recall 事件轨、同记录详情与键盘/焦点路径。
