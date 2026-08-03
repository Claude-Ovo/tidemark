# Tidemark（会遗忘的记忆）—— 架构总览（同步至 SPEC v1.2.2.1）

> CockroachDB × AWS 黑客松参赛项目。截止 2026-08-18 17:00 EDT（北京 8/19 05:00）。
> 实现细节唯一真相源：`SPEC.md`；决策日志：`../collab/CODEX_CHANNEL.md`。本文只做外化简述。
> 网页版（给Ovo看的傻瓜版）：https://claude.ai/code/artifact/cdcdb4b6-7e7a-44b3-901a-d78fecb7f570

## 一句话

**A memory organ that learns from outcomes, not repetition — and proves every recall.**
想起不等于有用：记忆只有被证明帮上忙才变牢，没人再提的自然淡忘，每晚做梦浓缩碎片、从踩坑证据里提炼经验，每次想起都开一张可查账的回执。

## 组件

| 组件 | 角色 | 满足比赛要求 |
|---|---|---|
| CockroachDB（表 + 向量索引 cosine） | 记忆/回执/证据台账/夜间任务全量存储，语义检索 | CRDB 工具 1：Distributed Vector Indexing |
| Memory MCP（自建薄 server，**部署于 AWS**） | 业务路径，agent 面 5 tool：remember / recall / pin / report_outcome / log_event | （自研核心，跑在 AWS 服务 1 上） |
| CockroachDB 官方 Managed MCP | Auditor Mode：operator-facing 审计路径（隔离 demo cluster，按 request_id 查回执→记忆→归因→夜间任务全链） | CRDB 工具 2：Cloud Managed MCP Server |
| AWS Lambda（+Function URL）或 ECS Fargate | **主服务运行时**（7/29 部署 spike 定型）+ EventBridge 夜间批处理（幂等+租约+revision 防竞态） | AWS 服务 1 |
| Lambda 内自托管 ONNX 推理 | embedding（量化 MiniLM 随部署包封存，manifest 验真、派生身份、零外部 AI 调用；结论 55——本账号 Bedrock 官方终审拒绝 resolved-negative，bedrock 分支保留为企业账号可选未验证路径） | AWS 服务 1 内（推理跑在 Lambda 上） |
| CloudWatch | 延迟/失败率/outcome_report_rate/隔离记忆数 | AWS 服务 3 |

## 记忆分层

1. **短期记忆**：当前会话上下文，不落库
2. **事件层**：发生过什么。fresh → 被 credited（任务成功且有 item 级证据）则固化 / 无人问津则按半衰期衰减 → 夜里被做梦浓缩 → faded 沉底（owner 可硬删，删则全副本传播）。pinned 冻结当前强度
3. **经验层**：从失败+后续成功的证据配对里提炼的教训（candidate → 2 个不同任务实例验证 → verified → 可被取代）。极慢衰减，recall 按场景注入（带独立预算）
4. **证据台账（attempt_events）**：追加式，反省的输入、归因的证据、demo 的回放、审计的链条

## 塑性模型（outcome-gated）

recall 只开回执不加固；`report_outcome` 里被 item 级证据点名 credited 的记忆才加固（边际递减+饱和），有证据 blamed 的才降权；失败默认不冤枉任何记忆；迟到/取消/失踪的汇报不动塑性。utility 由证据计数派生，不存拍脑袋浮点。

## 差异化卖点

全场卷「记得多」，我们做「忘得对 + 学得会 + 查得清」——衰减引擎、结果门控塑性、Memory Receipt 三张牌（供需两侧验证见 RESEARCH.md）。

## 状态

- [x] SPEC v1.2.2.1（含 Freeze Addendum 终版）——主体已签字，Addendum 待 ack
- [x] demo 壳：会学习仓库怪癖的编码 agent（失败→反省→相似任务召回教训→成功→查账）
- [x] CRDB Cloud 集群开通，连通性 spike 八项全绿
- [ ] AWS 账号 + 部署 spike（P0-01，开工前置）
- [x] 项目名：**Tidemark**（2026-07-29 Ovo拍板；备用 tidemark-ovo）
