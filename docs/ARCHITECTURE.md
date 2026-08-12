# Tidemark（会遗忘的记忆）—— 架构总览（同步至 SPEC v1.2.6，2026-08-10 刷新）

> CockroachDB × AWS 黑客松参赛项目。截止 2026-08-18 17:00 EDT（北京 8/19 05:00）。
> 实现细节唯一真相源：`SPEC.md`；决策日志：`../collab/CODEX_CHANNEL.md`。本文只做外化简述。

## 一句话

**A memory organ that learns from outcomes, not repetition — and proves every recall.**
想起不等于有用：记忆只有被证明帮上忙才变牢，没人再提的自然淡忘，每次想起都开一张可查账的回执。
（做梦浓缩/踩坑反省的管线——租约、幂等、revision 防竞态、provenance 台账——已实现并测试，
但生成段模型 blocked_external，本届无模型产物，见「状态」。）

## 组件

| 组件 | 角色 | 满足比赛要求 |
|---|---|---|
| CockroachDB（表 + 向量索引 cosine） | 记忆/回执/证据台账/夜间任务全量存储，语义检索 | CRDB 工具 1：Distributed Vector Indexing |
| Memory MCP（自建薄 server，**生产部署于 AWS Lambda**） | 业务路径，agent 面 5 tool：remember / recall / pin / report_outcome / log_event；生产 smoke 13/13 | （自研核心，跑在 AWS 服务 1 上） |
| CockroachDB 官方 Managed MCP | Auditor Mode：operator-facing 审计路径（隔离 demo cluster；SQL 账号面已签，控制台接线留证待补——见 AUDITOR.md） | CRDB 工具 2：Cloud Managed MCP Server |
| AWS Lambda + API Gateway + EventBridge + Secrets Manager + SQS DLQ | 主服务运行时 + 夜间批处理（幂等+租约+revision 防竞态）+ 密钥面 + 双层失败通路 | AWS 服务 |
| Lambda 内自托管 ONNX 推理 | embedding（量化 MiniLM 随部署包封存，manifest 验真、派生身份、零外部 AI 调用；结论 55——本账号 Bedrock 官方终审拒绝 resolved-negative，bedrock 分支保留为企业账号可选未验证路径） | AWS 服务内（推理跑在 Lambda 上） |
| CloudWatch | 延迟/失败率/outcome_report_rate/隔离记忆数 | AWS 服务 |
| **证据前端**（`web/evidence.html`，React + DOM/CSS，无 WebGL；**提交主入口**，公网 https://dhgwgra6nycty.cloudfront.net） | 保留强度账本（共享基线水平条 + fade 阈值参考线）、持久事件流（remember/recall/agent action/outcome 四源）、单条记忆证据（receipt 分量、plasticity before→after、服务端采样衰减曲线）、trace 与 capability 索引；单一 `selectedEvent → selectedMemoryId → selectedDetail → selectedTrace`，事件与记忆断链时显式标注而非静默展示别条记忆的证据；十步生命周期证明置于 `?demo=judge` 只读闸后 | 演示面（只读 viz 端点，与业务面隔离） |
| **记忆潮池前端**（`web/pool.html`，2D canvas 零依赖） | 总览模块，仍可直链：粒子=记忆、半径=服务端保留强度、recall 涟漪、outcome 潮痕、`/viz/activity` live 消费环、hover 卡+居中详情 modal、键盘/焦点/reduced-motion 全契约 | 演示面（同上） |
| **三臂 A/B 评测**（`src/ab/`，P0-12） | recall + outcome-gated plasticity evaluation slice：确定性脚本 agent、12 场景三组呈现（main/controls/diagnostics）、canonical experiment identity、content-free trace | 评测证据面（零 viz 依赖） |

## 记忆分层

1. **短期记忆**：当前会话上下文，不落库
2. **事件层**：发生过什么。fresh → 被 credited（任务成功且有 item 级证据）则固化 / 无人问津则按半衰期衰减 → faded 沉底（owner 可硬删，删则全副本传播）。pinned 冻结当前强度。（夜间做梦浓缩为管线就绪、模型段本届 stub）
3. **经验层**：从失败+后续成功的证据配对里提炼的教训（candidate → 2 个不同任务实例验证 → verified → 可被取代）。极慢衰减，recall 按场景注入（带独立预算）。（同上：提炼管线就绪、模型段本届 stub）
4. **证据台账（attempt_events）**：追加式，反省的输入、归因的证据、demo 的回放、审计的链条

## 塑性模型（outcome-gated）

recall 只开回执不加固；`report_outcome` 里被 item 级证据点名 credited 的记忆才加固（边际递减+饱和），有证据 blamed 的才降权；失败默认不冤枉任何记忆；迟到/取消/失踪的汇报不动塑性。utility 由证据计数派生，不存拍脑袋浮点。
实证：自然衰减 E2E（`EVIDENCE-DECAY-0810.md`）——2.3 真实天后服务面与公式逐条 |Δ|=0，credited 记忆存活曲线整体高于反事实。

## 差异化卖点

全场卷「记得多」，我们做「忘得对 + 学得会 + 查得清」——衰减引擎、结果门控塑性、Memory Receipt 三张牌（供需两侧验证见 RESEARCH.md）。

## 状态（2026-08-10）

- [x] 后端十个 P0（P0-01…P0-10）全部签收，生产部署上线（prod smoke 13/13）
- [x] P0-11 记忆潮池前端全构件签收（布局/activity/demo refresh/交互层/live 环 + 动效批）
- [x] P0-12 三臂 A/B：harness 基线终签；v4 语料（12 场景分组）实现完毕交审中
- [x] 自然衰减 E2E 留证（8/10，双 fixture 12/12 PASS）
- [ ] P0-13/14 文档冻结与 RC（本文即其中一环）
- [x] 公网 demo 上线（CloudFront→API Gateway→Lambda→CRDB，浏览器零凭证）+ Managed MCP 留证（8/12，`docs/EVIDENCE-MANAGED-MCP-0812.md`）
- [~] 证据前端（`web/evidence.html`）——数据面与 Judge 编排已交付，信息架构与视觉由 Codex 收尾（频道结论 79/80/82/84）
- [归档] 3D 潮池（`SPEC-3D-POOL.md` / `IMPLEMENTATION-3D-POOL.md` / `DESIGN-OCEAN.md` 的三维章节）——8/12 Owner 裁定结项，主交付转为无 WebGL 的证据前端（结论 79）。文档保留为实现档案，不代表当前提交形态
- conditional（诚实边界）：dream/reflection 模型段 blocked_external（Bedrock resolved-negative）
- [x] 项目名：**Tidemark**（2026-07-29 Ovo拍板）
