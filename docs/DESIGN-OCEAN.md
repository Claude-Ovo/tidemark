# Tidemark 前端设计 Brief v2：记忆潮池（P0-11 视觉重置，冻结 v2）

> v1（会遗忘的海：贴图世界 + 四带水柱 + 气泡透镜）于 2026-08-07 由 Owner 裁决退役，
> 存档见 git 历史（`3cdd2f9` 之前）。退役理由：画面盖住了数据——Owner 审美裁决
> （"太花哨、三十秒抓不到重点"）与 Codex 八审三个 P1（global percentile 越带、
> 真实数据聚簇、去壁纸不成立）为同一病的两种表述。
> 概念原作 ovo.jpg 退役，至多作品牌插画，不进主交互。
> 风格参考：https://rainform.pages.dev/ （Owner 指定）。

## 一句话

**数据即介质**：不再"先有一张画、把数据塞进画里"。潮池里的每个粒子就是一条
memory 行，每次位移都是一次 persisted、applied 的塑性事件。没有场景，只有数据。

## 首屏：单 Agent 记忆潮池

俯视一片近黑水面。一个 Agent 的全部记忆呈同心分布：

| 层 | 名称 | 语义 | 判定（绝对阈值，不按样本重排） |
|---|---|---|---|
| 中心 | 锚定层 Anchor | pinned / 长期高保留 | `pinned = true` 或 `s >= ANCHOR_MIN` |
| 中圈 | 活动潮带 Active Tide | 短期、在用、等待 outcome | `RECEDING_MAX < s < ANCHOR_MIN` |
| 外圈 | 退潮边缘 Receding Edge | 低保留、接近遗忘 | `s <= RECEDING_MAX` |
| 外缘警戒线 | fade line | 掉线即 fade 候选 | `s <= fade_threshold`（同源 TRANSITION_CFG，禁止第二真相源） |

- 层名只是**绝对阈值标尺**的注记，不是布局输入。`ANCHOR_MIN` / `RECEDING_MAX`
  是**待校准视觉假设**（初值 0.70 / 0.35——Codex 裁定：领域里唯一硬边界是
  fade_threshold=0.15，这两个值推不出天然分界，须拿真实多份 snapshot 离线看
  三层占用与 30 秒可读性后**版本化冻结**，冻结前不称常量），
  **禁止任何形式的 percentile / 按当前样本重排**——同 strength 恒同半径，
  自己不变、邻居变化不得引起径向漂移（八审 P1-1 教训的极坐标版）。
- 越靠中心越稳定，越靠外越接近遗忘。旧"深海=长期还是消失"歧义就此废除。

## 粒子模型（本轮最重要的澄清，Codex 裁定）

**一个可移动粒子 = 一条 memory，不是 episode bubble。**
episode 只作 hover/抽屉的分组维度，可画临时轮廓，不占第二套径向真相。
`episode_id IS NULL` 的 loose 记忆本来就是散粒，模型天然统一。

## 编码真相（首屏只有一条编码规则）

```
s = pinned ? 1 : clamp(effective_strength, 0, 1)
r = f(1 - s)          // f 为冻结的固定单调函数，全场唯一
theta = golden-angle 序位（保留时序 rank）+ stable hash tie-break
```

- **半径只等于绝对 retention**。没有第二个连续视觉通道：
  透明度通道**v1 删除**（Codex：不许拿 effective_strength 再映一次透明度=同一
  变量双重放大；importance 语义原型过门后再议，启用前必须先进 viz 快照字段）。
- 颜色不表达任何业务语义：近黑底 + 单一蓝白色系，明暗只用于分层背景标尺与
  焦点态。kind / 类别 / 结果一律不进颜色。
- `state=consolidated` 不强行送中心——consolidation 已通过 half-life 反映在
  effective_strength 里；径向只表达 retention，不叠第二条隐式规则。
  `pinned` 是唯一显式特例（冻结衰减），进 Anchor 小环带；pinned 拥挤时用小环
  轨道排布，不塞几何零点。
- 角度无业务语义。碰撞处理顺序：先只调角度 → 缩 mark/LOD → 显式 overflow。
  极小径向 epsilon 只能留在同一绝对层内且不得反序。求解失败必须显式 overflow，
  **禁止带碰撞冒充成功**（八审 P1-2 纪律原样继承）；落位后 pairwise 断言。

## 动态语法（签名，全场唯一）

**召回只激起涟漪，结果才留下潮痕。**
这不是隐喻装饰——它与后端已定结论 26（outcome-gated plasticity）逐条同构：
recall 只写 receipt+exposure 不动 memory 行；塑性只发生在 report_outcome 的
item 级归因上。视觉语法 = 架构真相。

| 事件 | 画面 | 位移 | 数据门 |
|---|---|---|---|
| remember | 一滴雨落入潮池，生成新粒子 | 落点即布局位 | activity 流 `kind=remember` |
| recall | 一次扩散涟漪 | **零位移、零变大** | activity 流 `kind=recall`（persisted receipt） |
| credited（applied） | 完整潮痕（settle 后停留 3–6s 淡出，非常驻） | 下一快照向中心迁移（半径终态持久） | `response_json.items[].applied === true` 且 role=credited |
| blamed（applied） | 断裂侵蚀痕（同上淡出） | 下一快照向外迁移（半径终态持久） | 同上，role=blamed |
| cancelled | 无 | **无合法粒子可动**（attempt 级事件，零 attribution） | report-outcome 已规定 |
| late / not applied | 无 | 零位移 | `applied === false`（reason 进抽屉，不进画面） |
| passive decay | 随新快照缓慢外移（明暗不变——单编码通道，无第二条连续数值编码） | 快照间差值 | 服务端 effective_strength 实算 |
| state→faded 过渡 | 一次终态 dissolve（离散状态过渡，非连续通道） | 无（粒子退场） | 快照 state 字段变化 |

- 迁移动效：1.2–1.8s ease-in-out settle，**从当前 presentation value retarget**、
  可中断、不重启不弹跳；keyboard / reduced-motion 直达终态。
- **潮痕不是常驻存量编码**（Codex 四审修正措辞）：outcome ring 在 settle 后
  停留 3–6s 淡出；半径终态持久，最新 outcome 状态留给 hover/drawer。
  事件残影不得累积成第二套长期分类图层。
- 指针只扰动近场粒子（微幅、非数据性）；没有全场呼吸滤镜。
- **事件诚实**：动画只消费持久化事件流，刷新可重放、轮询不漏不重；
  禁止 optimistic 假涟漪 / 假位移。

## 交互

1. **Hover**（120–180ms 延迟）→ 固定位小卡（不跟鼠标）：一句概要、层级、年龄、
   保留度、最近一次 outcome。首屏不泄精确数值。
2. **Click / Enter** → **右侧抽屉**：内容（principal-aware：agent 键全文 /
   viz viewer 键 content_preview，抽屉声明口径——与契约 D 同界）、来源 episode、衰减曲线、
   credited/blamed 归因、receipt 评分构成、关联记忆。
   〔v1 的水泡透镜 / "同一只泡五态" 退役——Codex 裁定它是旧表现层非架构地基，
   Owner 2026-08-07 确认收回 8/5 的五态签字。〕
3. 保留的交互契约（架构级，不随视觉走）：hover/focus/click/drawer 全部从
   **layout 最终 painted anchor** 展开（禁止第二套近似公式——八审 P2-5）；
   Tab 巡航 / ESC / 焦点恢复完整；`prefers-reduced-motion` 尊重且到达同一信息终态；
   Canvas 命中配同步 accessible DOM overlay。

## 文案合规

系统未修改任何模型参数。界面与解说词禁止出现"模型长期权重"；
统一使用「长时记忆 / 高保留权重」。

## 实验隔离（P0-12 硬闸）

画面**解释** A/B 输出，**不参与** A/B 计分。任何半径、环带、透明度、截图、
观看者交互都不得成为 P0-12 指标、oracle 输入或 trace 生成的一部分；
UI 只能事后读取同一 trace 做只读解释。P1 的 A/B dashboard 不倒灌 P0-12 harness。

## 数据契约 v2

### A. 状态快照 `GET /viz/ocean`（已有，需补字段）

- 保持：同一 SERIALIZABLE 事务内 DB now() = snapshot_at，全部 effective_strength
  服务端用与 recall 相同的 decayEffective 实算；fade_threshold 同源 TRANSITION_CFG；
  cap 触顶声明截断绝不静默；客户端永不用浏览器时钟重算衰减。
- 补：`importance`（先进快照、后启用通道；启用透明度前它必须已在字段里）。
- episodes 分组保留（供 hover/抽屉分组），但**布局输入是逐条 memory**。

### B. 活动流 `GET /viz/activity?after=<cursor>`（新增，先 contract 后实现）

快照塞 `last_outcome` 的方案否决——会吞掉两次轮询之间的多事件，动画无法幂等重放。

- 持久化 keyset 游标，排序键 `(occurred_at 微秒精确串, source_kind, source_id)`；
  游标编码沿用 waves 的 base64 方案与**微秒精度教训**（`created_at::STRING`，
  不走 JS Date 毫秒截断）。
- **提交可见性水位（Codex v2 一审 P1-1，取代"排序键即够"的假设）**：三源时间列
  都是事务内 `DEFAULT now()`，不是提交顺序的全局水位——旧时间戳的行可能晚提交，
  单纯 `> cursor` 会把它永远漏掉。v1 采用 closed-watermark 简化方案：
  1. 游标只推进到 `DB now() - SAFETY_GRACE`（closed watermark；`SAFETY_GRACE`
     必须大于写路径事务最长时限，两者一起在 config 冻结并写 SPEC）；
  2. 写路径事务时限显式强制（超时即弃，不允许长事务把行提交到水位线之后的过去）；
  3. 每轮查询窗口向前重叠回读，客户端按 `(source_kind, source_id)` 幂等去重；
  4. 回归测试必须真实复现"旧时间戳晚提交"场景（延迟提交事务 + 轮询穿越）。
  CDC/changefeed resolved timestamp 是强方案，记为 stretch，不进 v1。
  outbox + 写入时钟排序**不修复本问题**，不采用。
- 事件为三源派生（不新增业务表；endpoint、游标、索引与丢失/重复回归测试计入工期）：

| kind | 真源 | occurred_at | 载荷 |
|---|---|---|---|
| `remember` | memories 行 | created_at | event_id=memory_id, memory_ids=[memory_id] |
| `recall` | recall_requests 行 | created_at | event_id=request_id, episode_id, items_count |
| `outcome` | outcomes 行 | reported_at | event_id=outcome_request_id, status, items=[{memory_id, role, applied, reason}] |

- 确定性：同一游标区间重放返回逐字节相同序列。
- 消费规则：`remember` 生成粒子；`recall` 只涟漪；只有 `applied=true` 的
  credited/blamed item 触发位移；cancelled 状态事件不含 item（无粒子可动）；
  `applied=false` 的 reason 只进抽屉。
- 回归测试硬性要求：断线重连不漏不重；StrictMode remount 去重；
  游标推进过最后一行（waves n=1 复现教训）。

### C. 现有 `GET /viz/waves` 处置

活动流 B 是 waves 的超集（recall 事件 ≙ waves 行）。实现期两者并存，
原型过门后 waves 合并进 activity 或保留为兼容别名——届时定，不留双真相源。

### D. 记忆详情 `GET /viz/memory/:memory_id`（新增，hover/抽屉冷启动真源）

forward-only 的 activity 流不能保证首次打开就有历史详情（Codex v2 一审 P1-2）。

- agent-scoped（沿用 principal 隔离）；有界：全文按 cap 截断声明、归因列表分页上限。
- 返回：内容（**按 principal 界定：agent 键得全文，viz viewer 键只得
  content_preview——与 /viz/ocean 同界，抽屉文案须声明口径，不承诺 viewer 全文**，
  三审遗留修正）、层级、年龄、effective_strength（同快照口径服务端实算）、
  credited/blamed 归因（关联 receipt 评分构成）、**衰减曲线服务端采样点**
  （有界点数组，同一 decayEffective 实算——客户端只描点，
  不按 anchor/half_life 参数重算衰减，"客户端永不重算衰减"契约无例外，
  三审遗留修正）、关联记忆（derived_from / credited_in / blamed_in 薄边）、
  **latest-outcome projection**。
- 边界：latest-outcome projection 只许用于展示；**动画只认 activity 流**，
  projection 不得成为第二事件源。
- 脱敏：content 走 agent face 权限（viewer 键只见 content_preview 口径，
  与 /viz/ocean 同界）。

## Demo refresh 契约（三审阈值裁决：b 为主，不迁就陈旧快照）

真实 74 快照三层占用 0/3/71 证明系统确实会遗忘——这不是要修的 bug，
但 30 秒可读性需要一份"活着"的演示数据。约束（Codex 裁定原文照录）：

- **可重复脚本**，只走正常 `remember / log_event / report_outcome / pin` 路径；
- **禁止**直接 UPDATE strength / created_at，**禁止**伪造时间；
- 构成：保留一批真实旧记忆作 Receding；临演示创建新鲜记忆作 Anchor；
  挑合法证据链走 credited/blamed 形成 Active 与迁移；
- 0.70 / 0.35 仍是待校准视觉假设，不因单份 snapshot 冻结；
  demo refresh 后的多份 snapshot 一并计入校准证据。

## 视觉验收清单 V2（Codex 起草 2026-08-07，取代旧 V-1~V-7；Codex 有权改）

1. **V-1 / 30 秒命题**：不操作即可看懂"哪些稳定、哪些正在消退"；首屏只呈现
   一个 Agent 潮池和必要三层标尺。
2. **V-2 / 编码真相**：半径只等于绝对 retention；透明度只在 importance 定义
   清楚时启用；颜色、大小不再重复抢语义。
3. **V-3 / 因果动效**：remember 落点、recall 只涟漪、applied credited 向内、
   applied blamed 向外、cancelled/late/no outcome 零位移、passive decay 随
   新 snapshot 外移。
4. **V-4 / 事件诚实**：只消费持久化事件；刷新可重放、轮询不漏不重，
   禁止 optimistic 假波纹/假位移。
5. **V-5 / 极坐标布局**：绝对阈值、强弱不反序、ties 不跨层、稳定角度、
   密集数据零重叠或显式 LOD/overflow；真实快照验收，不用 fixture 结案。
6. **V-6 / 同一交互真相**：hover/focus/click/drawer 从最终粒子锚点展开；
   Tab/ESC/焦点恢复完整；reduced-motion 直达同一信息终态。
7. **V-7 / 克制与性能**：近黑蓝白，首屏不回填景物或六通道装饰；唯一 signature
   是 outcome-gated movement；桌面/移动端帧率和信息密度过门。
8. **V-8 / 实验隔离**：layout/version 不进入 P0-12 指标、oracle 或 trace 生成，
   只作为同一实验输出的只读解释器。

## 布局回归断言（必须全绿才交批）

真实 74-memory 快照 + 构造集（全高 / 全低 / 同强度 ties / 密集 pinned）：

- pinned 与 `s >= ANCHOR_MIN` 恒在 Anchor 层；`s <= fade_threshold` 恒在
  fade line 外缘侧
- 强弱不反序（r 随 s 单调）；同强度 ties 同/近同半径且不跨层
- 密集布点零重叠或诚实 overflow（pairwise 断言，禁止静默失真）
- 刷新确定性（同快照同布局，stable hash）
- 最终 painted anchor = pointer/keyboard 唯一坐标源
- 真实快照角向无聚簇退化（x 聚簇教训转移到 angle，P1-3 整项保留）

## 开工门（Codex 2026-08-07 裁定）

1. 本文档 + V2 清单 + A/B/C 数据契约冻结 ← **本次提交**
2. 真实单 Agent 74-memory 一屏静态极坐标原型 + 一条 scripted 因果序列
3. 过门后才扩交互；不再维护旧海底双轨

## 技术方向（承 v1，范围收窄)

- Web（S3+CloudFront 静态托管）；响应式。
- Canvas 2D 优先评估（未必需要 WebGL；原型期实测帧率后定）。粒子规模 cap
  以实测预算为准：布局回归对 74 / 500 / 2000 三档计时，产品 cap 取实测可交互
  的档位，不保留未经证据的规模宣传数。GSAP 只驱动 settle 迁移与涟漪，
  不再有场景过渡。
- 数据源：真实 API（agent face / audit views，content-free 路径不变）。

## 比赛要求绑定（不变）

- CockroachDB：所有画面数据实时来自 CRDB（向量检索+生命周期字段）。
- AWS：前端托管+API+推理全在 AWS。
- 评委动线：打开 URL 即见潮池；30 秒看懂稳定/消退；一次 hover 一次 click
  读完全部信息架构；录屏 3 分钟讲完"这片记忆会遗忘、会学习，
  召回只激起涟漪，结果才留下潮痕——而每道痕都有收据"。
