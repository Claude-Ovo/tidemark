> **〔历史计划稿存档，2026-07-29〕** 本文为当时的评审记录，不再随现状更新——现状以
> `SPEC.md`（实现真相源）与 `../collab/CODEX_CHANNEL.md` 结论区（决策日志）为准。
> 与现实的已知偏差：Bedrock 已 resolved-negative（结论 55，embedding 转 local-onnx）；
> "full lifecycle" 臂现名 `full`，评测口径冻结为 recall + outcome-gated plasticity
> evaluation slice（不宣称完整生命周期）；P0-11 前端为「记忆潮池」而非本文的 Demo UI 描述。

我先签结论：基于你贴出的 v1.2.1 摘要，架构有条件通过，可以明天开工。 Codex 三轮没有白吵，绝大多数裁决我同意；没有任何理由推倒重来。真正需要今天补进冻结附录的，是一项窄翻案和七个实现不变量。

我尚未拿到 SPEC.md 原文，因此这是架构级签字，不冒充逐行签字。把两个 Markdown 直接拖进来后，我还能补查 DDL/FK/状态机是否与摘要一致。

最终翻案裁决

被砍/修改项	裁决	最终处理
confidence 第三数轴	同意砍	vitality + utility 足够；source trust 只叫“来源等级”，不要宣传成统计置信度
墓碑保留 content hash	同意砍	低熵内容确有枚举风险，随机 ID、时间、原因更干净
remember.supersedes	窄翻案	不恢复 Agent 可传的参数；但今天应预留 owner/admin 原子纠错通道
通用因果图	同意砍	derived_from、事件证据、归因表已经足够支撑比赛叙事
显式正反馈捷径	同意砍	不为一个尚不存在的事件类型制造不可达分支
KMS 回执签名	同意砍	首版成本和失败语义太重；放 P2
SHA-256 回执校验	保留但改措辞	建议叫 serialization_checksum，只能证明序列化一致性，不宣称防篡改
failure 默认不惩罚	强烈同意	只有证据明确指认的 blamed 才减 utility，避免环境故障冤枉记忆

窄翻案的 owner/admin 纠错不是自动矛盾裁决。建议今天只把状态与 DDL 位置预留出来：

admin_replace_memory(old_id, new_payload, reason, idempotency_key)

同一事务内创建新记忆、将旧记忆标记为 superseded、写生命周期事件；禁止跨 tenant/agent。实现可以放 P1，但 schema 今天必须容得下，否则将来只能“删除再新增”，既不原子，也会丢失纠错血缘。

冻结前必须补死的七个问题

1. 到底四个还是五个 MCP 工具。
    摘要前面仍是四个，后面写“全部五个工具请求级幂等”。今天必须导出唯一的 tools/list 快照，锁定名称、schema、权限和版本；README、SPEC、测试只认这一份。
2. success 的 credited 也要有证据。
    不能只要求 blamed 有证据，否则 Agent 可以把一次成功归功给所有召回内容。credited 必须：
    * 属于本 attempt 的已注入 receipt item；
    * 携带合法 attempt_event_id 或受控 usage event；
    * 与 blamed 集合互斥；
    * 每个 (attempt_id, memory_id, attribution_type) 唯一；
    * 没有证据时保存 outcome，但不产生塑性。
3. pin 必须是 capability，不是默认权力。
    默认 Agent 账号不应天然拥有永久 pin 权限。至少锁定：
    * 需要 memory:pin capability；
    * 仅 accepted memory 可 pin；
    * 不能改变 source trust 或 utility；
    * 有租户配额、审计事件和 owner/admin unpin；
    * superseded/deleted/quarantined 不可 pin。
4. 主业务运行路径必须真的在 AWS。
    不能只有夜间 Lambda 在 AWS，而 Memory MCP 主服务和参考 Agent 跑在别处，否则容易被认为 AWS 只是挂名。比赛要求各组件“meaningfully integrated”。官方规则⁠
    7 月 29 日做部署 spike：
    * 无长连接需求：Lambda + API Gateway/Function URL。
    * MCP transport/session 与 Lambda 不兼容：立刻切 ECS Fargate。
    * spike 截止当日，不能拖到业务代码写完才发现部署形态不成立。
5. hard delete 必须删除所有内容副本。
    不只删 memories.content 和 embedding，还要检查：
    * receipt 是否保存过原文；
    * attempt event 是否复制过原文；
    * dream/reflection 是否包含派生内容；
    * CloudWatch 是否记录请求正文；
    * Bedrock 调用日志是否存 prompt。
    推荐 receipt 只存随机 memory ID 和分数组件；删除后 UI 显示 [deleted]。〔v1.2.2.1 修订：依赖被删除源的 derived memory 沿 provenance 递归 DELETE 整行，只在无正文 rebuild queue 留随机 ID+剩余 source IDs；不采用保留 content 的 quarantine。〕
6. 五级 source 必须都有可达路径。〔v1.2.2.1 裁定：`tool_verified` 与 `external_untrusted` v1 均标 reserved，agent 不得自报，伪造则 server 按调用路径重新赋值。〕
    tool_verified 既然不能由 Agent 自报，就必须说明由哪个经过认证的内部入口赋值。没有实现路径的枚举值应标为 reserved。必须有 property test：Agent 伪造 tool_verified 时，服务端忽略或拒绝。
7. candidate experience 如何获得第一次验证。
    候选经验若完全不能被 recall/inject，就永远不可能获得两次 task-instance 验证。今天要写死：
    * candidate 是否可低权重、限量注入；
    * 注入时如何显式标识 provisional；
    * 第一次 credited 后如何更新；
    * 两个不同 task instance 后何时原子晋级；
    * 中途出现 blamed 如何处理。

这七条补完，我就不再翻设计，只允许实现发现的 bug 修正。

⸻

P0：必须完成

统一 Definition of Done：代码、迁移、自动测试、可复现 trace、英文文档五项齐全才算完成。

ID	日期	Claude Code 任务	验收标准
P0-00	7/29	写 SPEC v1.2.2 Freeze Addendum，处理上述七项；冻结工具清单和状态机	tools/list、DDL、状态图、README 名称完全一致；新增决策日志
P0-01	7/29	AWS runtime spike；选 Lambda 或 ECS；打通 Bedrock、CRDB、公开健康端点	从公网调用一次真实 Memory MCP 请求；AWS 日志与 CRDB 行可对应；〔v1.2.2.1 补〕认证上下文→tenant/agent 映射、真实 MCP transport/session、冷启动重连、CRDB TLS/连接上限四项全验
P0-02	7/30–31	完成 migrations：tenant/agent、memory、tool_requests、receipt、attempt/event/outcome、attribution、pipeline run/lease、derived/evidence links	空库一键迁移；关键 unique/FK/check 约束齐全；跨租户 FK 不可能成立
P0-03	8/1	实现 admission + remember + 请求幂等	100 个同 request ID 并发请求只产生一条；语义重复不误当网络重试；quarantine 不 embedding
P0-04	8/2–3	实现 Bedrock embedding、CockroachDB vector index、recall、receipt、曝光	EXPLAIN 确认向量索引命中；tenant/agent 前缀强制；recall 不改变 vitality；重试返回原 receipt
P0-05	8/4–5	实现 attempt/event/outcome 状态机与 item-level plasticity	一个 attempt 恰一终态；冲突终态拒绝；credited/blamed 互斥；late/cancelled 不变塑性；重复 report 不重复计账
P0-06	8/6	实现 vitality/utility、pin 权限、lazy decay、policy materialize/revision	固定时钟 property tests；策略切换不复活记忆；无 pin capability 必须拒绝
P0-07	8/7–8	实现 dream/reflection/experience lifecycle、幂等租约与崩溃恢复	Bedrock 调用不包在 DB 长事务内；强杀后可恢复；revision 变化则旧结果不可提交；provenance 完整
P0-08	8/9	实现 forget、墓碑及删除传播	原文、embedding、缓存、日志均不存在；派生 memory rows 沿 provenance 递归 DELETE；无正文 rebuild queue 仅留随机 ID + 剩余 source IDs；审计链只余随机 ID
P0-09	8/9–10	完成 AWS 部署：主服务、夜间 Lambda/EventBridge、CloudWatch、Secrets；连接池 max=1	完整线上 smoke test；重复 EventBridge 触发只提交一次；仓库无 secret
P0-10	8/10	完成 Auditor Mode：官方 Managed MCP、单集群、只读账号、审计视图	能查 receipt/attempt/pipeline；所有 INSERT/UPDATE/DELETE 实测失败；不暴露原文或凭据
P0-11	8/11–12	完成编码参考 Agent 七步闭环及最小 Demo UI：Receipt、Time Travel、pipeline 状态	固定 fixture 连续运行三次均走通“失败→学习→相似任务成功→审计”
P0-12	8/13	完成三档 A/B harness：no-memory / vector-only / full lifecycle	相同模型、任务、seed、工具与 token budget；各 arm 独立 tenant/snapshot；外部 oracle 判分；公开脱敏 trace
P0-13	8/14	全量测试、故障注入、英文 README、架构图、测试说明、Devpost 初稿	retry、lease、TOCTOU、跨租户、删除、迟到 outcome 全绿；仓库一键启动
P0-14	8/15	功能冻结，部署 RC，完整录屏彩排，打 tag	v1.0.0-rc1；全新环境按 README 可运行；Demo 连跑五次；禁止新增依赖和 schema

A/B 特别注意：vector-only 必须和 full lifecycle 使用相同 embedding、top-k 和模型，只关闭 outcome plasticity、dream/reflection、生命周期重排；否则评委会说实验不公平。

P1：冲奖增强

只在 8 月 11 日晚 P0 主闭环全绿 后开始，最晚 8 月 14 日停手。

* 实现 owner/admin 原子 replace_memory，保留纠错血缘。
* Receipt 增加 score decomposition 与少量 rejected-candidate “why not”，不要保存原文快照。
* Recall 加多样性去重/MMR，防止 3 条注入全是同义经验。
* 增加“无可靠记忆时主动 abstain”，不要硬凑三条。
* CloudWatch alarm、夜间任务 DLQ、租约堆积/隔离记忆告警。
* Dashboard 展示 A/B 成功率、重复犯错率、p95、token overhead、重复抑制率。
* Auditor Mode 准备三条评委可直接复制的英文查询。
* 整理市场研究为克制的差异化叙事：只使用可复现结果，不在提交页拿 GitHub issue 或 HN 抱怨当统计事实。
* 如果一切提前完成，再接 ccloud CLI 做只读运营健康检查，作为第三种 CockroachDB 工具；不能为凑工具影响主线。

P2：有余力再做

这些全部允许不做，不应进入三分钟主 Demo：

* Contradiction Link 与矛盾候选检测。
* AWS KMS 签名和公开验签。
* owner feedback 事件及单次显式确认晋级。
* 真正多区域故障切换/压力测试。
* 更完整的 ccloud 运维 Agent。
* 自动重建受删除影响的 derived memories。
* memory export/import 与可携带性。
* learned half-life、贝叶斯置信区间或通用因果图。
* 与 Hindsight/Mem0 的大规模正式 benchmark。

视频与提交倒排

* **8/15：**冻结、最终彩排、截图和架构图定稿。
* **8/16：**录主素材，先录数据库与 Auditor Mode 真实工作画面。
* **8/17：**剪辑、英文字幕、YouTube/Vimeo 公开上传，同时做第二份备用视频。
* **8/18 北京时间中午前：**填完并预览全部 Devpost 字段；当天提交，不碰北京时间 8/19 05:00 的官方极限截止线。视频必须少于三分钟、展示真实功能和 CockroachDB 记忆层。提交要求⁠

三分钟只讲一条故事：第一次犯错 → 证据入账 → 睡眠反省 → 第二个相似任务想起教训 → 成功 → 回执和官方 MCP 查账。 其余 14 项放 UI、README 和架构图里，别把视频拍成功能报菜名。

明天 Claude Code 的开工顺序只能是：P0-00 → P0-01 → P0-02。AWS runtime spike 没绿之前，不许埋头写十天本地代码。你们这版已经不是“想法好玩”的阶段了，架构骨头够硬；现在赢不赢，看的就是二十天里能不能把证据做得比功能更扎实。