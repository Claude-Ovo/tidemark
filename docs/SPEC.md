# SPEC v1.2.5 — Tidemark（会遗忘的记忆）

> v1.2.5（2026-08-01，P0-07 dream/reflection，Codex 方案两审+代码一审驱动）：nightly 三 job（dream/reflection/transition）共用 run harness（claim/lease/fencing/future-gate/frozen-control）；dream=due 队列低权重簇浓缩（(agent,episode) 分组、derived 硬排除防回流、每簇独立 fingerprint 与确定性 derived_memory_id、全簇或零、server 算 time_range、salient canonical rendering 入正文）；reflection=failure->success 配对提炼 candidate 经验（`reflection_pairs` 账本 exactly-once、outcome 锚定终态真相、anchors 优先截断 32/16KiB、(agent,scope) 分区双层 dedup 0.92、evidence_ids server 封口、事件全字段 hash 快照）；orchestrator 单入口 dream->reflection->transition（dream 占源故 stale/暂态短路，reflection 不占源故任何结果不阻 transition）；Dream/Reflection Receipt 落 `result_receipt`（028）。常数：min_cluster=3/max_clusters=5/max_sources=8/window=72h/retention=120h/max_pairs=5/32ev/16KiB/dedup=0.92。migrations 024-032。Bedrock 前保持 conditional / blocked_external（结论 36）。

> v1.2.4（2026-07-31，P0-06 生命周期调度，Codex 两轮方案审驱动）：状态机边界统一 `<=`（消除阈值等值热循环）；consolidation progress 独立于 lifetime count（`consolidation_baseline`，migration 020/021，"复活后重新挣"可执行化）；`next_transition_at` canonical scheduler 收口（结论 39 债务清偿，migration 022 回填 + PREFLIGHTS[22]）；nightly_runs 增 `control_config`（023，takeover 只读冻结控制面）；transition job 契约=evaluation_at=scheduled_for 进 fingerprint、lease 用墙钟、fencing generation token、no-work 不落 run、整批 stale 零写入。
> v1.2.3（2026-07-31，P0-05 实现修正同步，Codex 二审/三审驱动）：outcomes 终态唯一改 per `(tenant, agent, attempt)`（migrations 018/019）；幂等归属 outcomes 本表（payload_hmac/response_json 两列，013/016/017）；`max_attributions=32` 冻结；attempt ledger 锚降为一致性检测。仅同步已实现并经交叉审查的行为，无新增 feature。

> **Tidemark — memory that ebbs, and proves what the tide left.**（2026-07-29 Ovo定名）

> 状态：**主体 Codex 已签字（2026-07-29）；v1.2.2.1 = Freeze Addendum（§12）终版，待 Codex Addendum ack 后架构冻结。**治理规则：**本文是 implementation contract，CODEX_CHANNEL.md 已定结论区是 decision log**；任何变更两者同一提交同步。
> `[pending spike]` 小节以 SPIKE-MCP.md 为准。`[A/B]` 标注的取舍进评测假设。
> **TTL 总策略（回应 correctness）**：v1 首版**任何表都不开 Row-Level TTL**——receipt/attempt_events/quarantined 全部靠 retention 参数 + 手动/nightly 清理脚本，不做半声明。

## 0. 一句话与非目标

**A memory organ that learns from outcomes, not repetition — and proves every recall.**

非目标：多租户生产隔离；自动矛盾 Tombstone（stretch: Contradiction Link）；KMS 签名（stretch，若做必须 DB commit 后异步）；多 batch nightly；通用 graph engine；lineage 级联删除做不完则只承诺删除直接记录并明示。

## 1. 数据模型（CockroachDB）

通用约定：所有表主键含 `tenant_id`；tenant_id/agent_id 来自认证上下文；所有 enum 列带 `CHECK`；影响 nightly eligibility 的写入必须 `revision = revision + 1`。

### 1.1 memories

```sql
CREATE TABLE memories (
  tenant_id      STRING NOT NULL,
  agent_id       STRING NOT NULL,
  memory_id      UUID   NOT NULL DEFAULT gen_random_uuid(),
  layer          STRING NOT NULL CHECK (layer IN ('event','experience')),
  kind           STRING,                                   -- tool 入参 kind 落点（fact/preference/task_state/...，自由枚举）
  episode_id     STRING,                                   -- 写入时所处 episode
  content        STRING NOT NULL,
  embedding      VECTOR(1024),                             -- 维度以 Bedrock 模型为准 [pending spike]
  experience_body JSONB,                                   -- 仅 experience：{trigger, wrong_action, correct_action, caution, evidence_ids[]}
  exp_status     STRING CHECK (exp_status IN ('candidate','verified','superseded')),  -- 仅 experience，NOT NULL when layer='experience'
  source         STRING NOT NULL CHECK (source IN ('user_asserted','tool_verified','agent_inferred','external_untrusted','derived')),  -- server 分配
  admission      STRING NOT NULL CHECK (admission IN ('accepted','quarantined','rejected')),
  quarantine_expires_at TIMESTAMPTZ,                       -- 仅 quarantined
  state          STRING NOT NULL DEFAULT 'fresh' CHECK (state IN ('fresh','consolidated','faded')),
  pinned         BOOL   NOT NULL DEFAULT false,
  importance     FLOAT  NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  strength_anchor    FLOAT NOT NULL DEFAULT 1.0 CHECK (strength_anchor BETWEEN 0 AND 1),
  strength_anchor_at TIMESTAMPTZ NOT NULL,
  last_rewarded_at   TIMESTAMPTZ NOT NULL,                 -- 创建时 = created_at
  half_life_hours    FLOAT NOT NULL CHECK (half_life_hours > 0),
  credited_success_count INT NOT NULL DEFAULT 0 CHECK (credited_success_count >= 0),
  consolidation_baseline INT8 NOT NULL DEFAULT 0,  -- v1.2.4：本轮固化进度基线（migration 020），lifetime count 永不重置
  evidenced_blame_count  INT NOT NULL DEFAULT 0 CHECK (evidenced_blame_count >= 0),
  revision       INT8 NOT NULL DEFAULT 0,
  next_transition_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, memory_id),
  -- 跨列约束（回应 correctness）：
  CONSTRAINT exp_body_iff_experience CHECK ((layer = 'experience') = (experience_body IS NOT NULL)),
  CONSTRAINT exp_status_iff_experience CHECK ((layer = 'experience') = (exp_status IS NOT NULL)),
  CONSTRAINT quarantine_expiry_iff_quarantined CHECK ((admission = 'quarantined') = (quarantine_expires_at IS NOT NULL)),
  CONSTRAINT accepted_has_embedding CHECK (admission <> 'accepted' OR embedding IS NOT NULL)
);
CREATE VECTOR INDEX mem_vec_idx ON memories (tenant_id, agent_id, embedding vector_cosine_ops);
CREATE INDEX mem_due_idx  ON memories (tenant_id, next_transition_at, memory_id);
CREATE INDEX mem_pin_idx  ON memories (tenant_id, agent_id, pinned, importance DESC);  -- 第二路候选
```

**硬删除**（forget，owner/admin 面）：`DELETE FROM memories`，同时写 `memory_tombstones`：

```sql
CREATE TABLE memory_tombstones (
  tenant_id STRING NOT NULL,
  memory_id UUID   NOT NULL,          -- 随机 ID 本身不泄露内容
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason    STRING,
  PRIMARY KEY (tenant_id, memory_id)
);
```

不存在 `deleted_at` 软删列（v1.0 的软删/硬删矛盾按结论 31 收敛为真删+最小墓碑）。派生产物沿 `memory_derivations` 递归删除；首版若递归未实现，README 明示"删除直接记录"。

**正常 recall 候选过滤（写死）**：`admission='accepted' AND state <> 'faded' AND (layer='event' OR exp_status <> 'superseded')`；tombstoned 行已物理不存在。

### 1.2 attempt_events（追加式证据台账——reflection 的输入，blame 的证据，demo 的回放源）

```sql
CREATE TABLE attempt_events (
  tenant_id        STRING NOT NULL,
  agent_id         STRING NOT NULL,
  episode_id       STRING NOT NULL,
  task_instance_id STRING NOT NULL,
  attempt_id       STRING NOT NULL,
  event_id         UUID   NOT NULL DEFAULT gen_random_uuid(),
  event_type       STRING NOT NULL CHECK (event_type IN ('tool_call','tool_error','user_correction','attempt_start','attempt_end','memory_used','note')),
  tool_name        STRING,
  payload          JSONB,                                  -- error_type/trace 摘要/evidence 内容
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, attempt_id, event_id)
);
CREATE INDEX ae_task_idx ON attempt_events (tenant_id, task_instance_id, created_at);
```

追加式（无 UPDATE/DELETE 路径）。reflection 的"失败+后续成功配对"= 同 task_instance_id 下 failure attempt 的 events × success attempt 的 events。`blamed` 的 evidence 必须引用该 attempt 内的 `event_id`（server 校验存在且归属，不是验证非空字符串）。

### 1.3 recall_requests（回执 + recall 幂等）

```sql
CREATE TABLE recall_requests (
  tenant_id    STRING NOT NULL,
  request_id   STRING NOT NULL,
  agent_id     STRING NOT NULL,
  episode_id   STRING,
  attempt_id   STRING NOT NULL,                            -- outcome 归属校验用（正常 recall 必填；无任务上下文走 peek_recall）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  query_hmac   BYTES NOT NULL,
  query_preview STRING,                                    -- 仅 demo tenant 显式开启
  pipeline_version STRING NOT NULL,
  outcome_state STRING NOT NULL DEFAULT 'unreported' CHECK (outcome_state IN ('unreported','reported','expired')),
  terminal_attempt_id STRING,                              -- 一张 receipt 至多归属一个 terminal attempt
  receipt_json JSONB NOT NULL,
  serialization_checksum BYTES NOT NULL,   -- canonical SHA-256 of receipt_json，只证明序列化一致性
  expires_at   TIMESTAMPTZ,                                -- receipt_retention 控制；demo 期不小于评审期
  PRIMARY KEY (tenant_id, request_id)
);
```

receipt item 字段：`{receipt_item_id, memory_id, layer, rank, raw_cosine_distance, similarity, effective_strength, utility, importance, final_score, reason[], injected(bool)}`。
**TTL 策略（回应 P0-7 + v1.2 修订）**：v1 首版全库不开 Row-Level TTL（见文件头总策略）；`receipt_retention`（默认 60 天，覆盖评审期至 9 月中）与 `outcome_window`（24h）为两个独立参数，retention 清理由 nightly 脚本按参数执行。

### 1.4 outcomes

```sql
CREATE TABLE outcomes (
  tenant_id         STRING NOT NULL,
  outcome_request_id STRING NOT NULL,       -- 本 tool 调用自身的幂等键（回应 P0-3，与 recall 的键分离）
  agent_id          STRING NOT NULL,
  episode_id        STRING NOT NULL,
  task_instance_id  STRING NOT NULL,
  attempt_id        STRING NOT NULL,
  status            STRING NOT NULL CHECK (status IN ('success','failure','cancelled')),
  attributions      JSONB NOT NULL,         -- [{recall_request_id, receipt_item_id, memory_id, role, evidence_event_id}]，最多 32 条
  plasticity_applied BOOL NOT NULL,
  payload_hmac      BYTES NOT NULL,         -- keyed 幂等指纹（v1.2.3：幂等归属本表，见 §1.5）
  response_json     JSONB NOT NULL,         -- 首次 response 精确重放体（INSERT 占位 '{}'，同事务回填）
  reported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, outcome_request_id),
  UNIQUE (tenant_id, agent_id, attempt_id)  -- 终态槽 per-agent：attempt 是 agent 私有概念（v1.2.3）
);
```

**归因约束（server 逐条校验，回应 P0-3）**：
- item 必须引用存在的 `(recall_request_id, receipt_item_id)`，且该 receipt 同 tenant/agent，且 receipt.attempt_id = 本 attempt（无条件相等）
- `success` 只允许 `role='credited'`，且 credited item 必须 `injected=true`、其 `evidence_event_id` 指向**同 attempt 内与本 item 三元组（recall_request_id+receipt_item_id+memory_id）完全匹配的 `memory_used` 事件**——generic `attempt_end` 不合法；`failure` 只允许 `role='blamed'` 且 `evidence_event_id` 存在于本 attempt 的 attempt_events；`cancelled` 不允许任何 attribution
- 同一 outcome 内按 `memory_id` 去重（同记忆多 item 只按一次计）
- 被归属的 receipt 置 `terminal_attempt_id = attempt_id`；已归属其他 terminal attempt 的 receipt 拒绝（`receipt_already_settled`）——utility 不重复记账
- `attributions` 数组上限 **32 条**（`max_attributions`，入口拒绝 `too_many_attributions`）——事务 B 必须保持短事务；MCP schema 以 `.max(32)` 显式公布
- 同 outcome_request_id 同 payload 重报幂等返回；同 `(agent_id, attempt_id)` 冲突 terminal status 报 `outcome_conflict`——终态唯一按 `(tenant, agent, attempt)` 隔离，同 tenant 其他 agent 报同名 attempt 落其自己的槽，占不走别人的（v1.2.3，migrations 018/019）
- attempt ledger 锚（本 agent 该 attempt 的确定性首行事件，`ORDER BY created_at, event_id`）只作 episode/task **一致性检测**（`attempt_scope_mismatch`），不承担授权——授权由上一条的 agent 隔离承担

### 1.5 tool_requests（remember/pin/log_event 的统一幂等台账，回应 P0-A）

```sql
CREATE TABLE tool_requests (
  tenant_id    STRING NOT NULL,
  agent_id     STRING NOT NULL,
  tool_name    STRING NOT NULL CHECK (tool_name IN ('remember','pin','log_event')),
  request_id   STRING NOT NULL,
  payload_hmac BYTES  NOT NULL,
  response_json JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, tool_name, request_id)
);
```

与业务写同一事务插入；重复请求：同 payload_hmac → 返回 response_json；不同 → `idempotency_key_reused`。recall/report_outcome 继续用各自专表。**唯一约束冲突的处理统一为：ROLLBACK 当前事务 → 新事务重读首次结果**（唯一约束错误已中止事务，不得在原事务内继续 SELECT）。
`pin` 的 `expires_at` 入参**删除**（无落点且引入定时 unpin 状态机，v1 不做）——pin 只是幂等 set/unset。

### 1.6 关系与证据

- `memory_derivations (tenant_id, derived_memory_id, source_memory_id, run_id)` — **仅 dream**（memory→memory）
- `memory_event_evidence (tenant_id, derived_memory_id, attempt_id, event_id, run_id)` — **仅 reflection**（memory→attempt_event，回应 P0-C；Auditor 链经此不断）
- credited_in/blamed_in 由 outcomes.attributions 表达
- `success_evidence` 完整 DDL（回应 P0-E）：

```sql
CREATE TABLE success_evidence (
  tenant_id        STRING NOT NULL,
  experience_id    UUID   NOT NULL,
  task_instance_id STRING NOT NULL,
  outcome_request_id STRING NOT NULL,   -- 证据来源 outcome
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, experience_id, task_instance_id)
);
```

### 1.7 nightly_runs

按结论 13/16/17（唯一键、lease/CAS、stale 状态机、单 batch）；选源 `ORDER BY next_transition_at, memory_id LIMIT batch_size`（列名勘误）。

## 2. 生命周期与公式

### 2.1 相似度定义（回应 P0-4）

余弦：索引 opclass `vector_cosine_ops`，查询算子 `<=>`；`similarity = clamp(1 - cosine_distance, 0, 1)`。receipt 同时记 `raw_cosine_distance` 与 `similarity`。

### 2.2 衰减

```
effective = strength_anchor * exp(-ln(2) * hours(now - strength_anchor_at) / half_life_hours)
```

pinned：effective 恒 = strength_anchor。

### 2.3 Outcome-gated plasticity

recall 不改 memory 行。事务 B（§4）内，逐条去重后的归因：

- **credited（仅 success）**：
  ```
  eff     = decay(...)                       -- 先 materialize
  spacing = 1 - exp(-hours(now - last_rewarded_at) / cooldown_hours)
  gain    = base_gain * spacing * (1 - eff)
  strength_anchor = min(1, eff + gain); strength_anchor_at = now; last_rewarded_at = now
  credited_success_count += 1
  ```
  pinned 记忆：计数照记，anchor/时间戳冻结不动（回应 P0-5）。
- **blamed（仅 failure，需 evidence_event_id）**：
  ```
  strength_anchor = decay(...) * blame_factor; strength_anchor_at = now
  -- last_rewarded_at 不变（惩罚不是奖励，不重置 spacing）
  evidenced_blame_count += 1
  ```
  pinned：计数照记，anchor 冻结。
- failure 无 blamed → 只留 trace 进 reflection；cancelled/late/unreported → 不动塑性
- late：超 `outcome_window`（24h）仍落 outcomes 审计记录，`plasticity_applied=false`
- faded 记忆收到 credited → 先 materialize 再 boost，state 回 fresh（唯一复活路径）

### 2.4 utility 与参数

`utility = (credited+1)/(credited+blamed+2)`。
**half_life 单一真相源（回应 P0-B）**：`half_life_hours` 列永远存**当前有效 policy 值**；decay 只读该列，绝不按 state 二次派生。
- 创建时写入 `base_half_life[layer] * (1 + importance)`
- consolidate 迁移：先 materialize/re-anchor，再把该列**乘一次** multiplier（默认 3.0）
- faded → fresh 复活：先 materialize，再把该列**重置回 fresh 基础值**（丢失 consolidation，重新挣）
合法域：`half_life>0, cooldown>0, 0<=base_gain<=1, 0<blame_factor<=1, multiplier>=1`。

**consolidation progress（v1.2.4）**：`progress = credited_success_count - consolidation_baseline`（lifetime count 只增不减，utility 公式不变）。baseline 更新点：创建=0；nightly/dream fade 时=当前 count（该轮进度清零，fade 胜 consolidate 同此）；事务 B revive 时=复活后 count（复活那次 credited 不计进度——严格"重新挣"，需 hits 次全新 credited）；consolidate 落袋时=当前 count。

**next_transition_at（v1.2.4，结论 39 收口）**：语义为"下次值得 nightly 检查本行的时刻"——调度提示非转换承诺，领取后一律 revalidate。canonical scheduler 三分支（全写点唯一口径，src/lib/scheduler.mjs）：`admission!='accepted' OR pinned OR faded -> NULL`；`fresh 且 progress>=hits -> 立即 due`；否则解析解 `strength_anchor_at + half_life * log2(anchor/fade_threshold)`（anchor<=threshold 时立即 due；解出的过去时刻保留原值）。写点矩阵：remember 初始化 / credited·blamed·revive 重排 / pin 置 NULL / unpin 重排（攒满 progress 则立即 due）/ nightly 各分支重排——nightly 仅重排也 `revision+1`（next 影响 eligibility）。首版常数：`fade_threshold=0.15, consolidate_hits=3, multiplier=3.0, batch=200, lease=10m, max_attempts=3`。

### 2.5 状态机

```
fresh --(effective <= fade_threshold 且非 pinned, nightly 通用 transition)--> faded
fresh --(credited_success_count - consolidation_baseline >= consolidate_hits, nightly)--> consolidated   -- 迁移时 materialize + 乘 multiplier；fade 优先于 consolidate（衰穿的行不配固化）
consolidated --(effective <= fade_threshold, nightly)--> faded
faded --(credited outcome, 事务 B)--> fresh
dream 专属：eligible fresh 低权重碎片 --(dream 事务)--> faded（见 §6）
其余迁移非法：拒绝 + 记错误
experience: candidate --(2 个不同 task_instance 的 success_evidence)--> verified --(被取代)--> superseded
-- "1 次显式正反馈"捷径已砍（回应 P0-E）：attempt_events 无正反馈类型，路径不可达；owner feedback 留待后续设计
-- success_evidence 写入 guard（结论 14 完整恢复）：本次 receipt 恰好注入 1 条 candidate experience + outcome=success + 本 attempt 无 user_correction event，三者同时成立才写一条
```

（v1.0 的 `effective 持续 > threshold` guard 已删——无历史字段，不可执行。）

## 3. Recall 流水线（回应 P0-2 的幂等语义）

1. **DB preflight（事务外）**：`SELECT ... WHERE (tenant_id, request_id)`；命中且 query_hmac 相同 → 直接返回原 receipt；命中但 hmac 不同 → `idempotency_key_reused`；miss → 继续
2. embedding（Bedrock，事务外）——接受极少数并发场景重复 embedding，不做 committed processing+lease 状态机
3. **事务 A（短 SERIALIZABLE）**：再次检查 `(tenant_id, request_id)`（存在则放弃本次计算、读首次结果返回）→ 两路候选 → rerank → packing → `INSERT recall_requests`（completed 形态一次写入，无中间态）→ COMMIT；unique 冲突 = 并发 loser，重读首次结果返回；40001 整体重试（≤5 次 + jitter）
4. 并发测试（验收）：同 request_id 并发 N 路，恰 1 行落库、所有调用方拿到同一 receipt

候选与打分：
- 第一路：向量 top-50，semantic gate `similarity >= 0.55`
- 第二路：`pinned OR importance >= 0.8`，**独立 relevance floor `similarity >= 0.35`**；mem_pin_idx 是否真支撑 OR 查询以 `EXPLAIN` spike 为准，不命中则拆两条 SQL UNION [pending spike]
- rerank：`final = 0.5*similarity + 0.2*effective + 0.2*utility + 0.1*importance`（`importance` 同时影响 half-life 与 rerank 为**有意双算**，作为 [A/B] 假设验证）
- **event 与 experience 预算分离**：event 注入 max 5 items / 1200 tokens；experience 注入 max 3 items / 600 tokens。token 估算（回应 correctness，中文按字计不做除法低估）：`tokens ≈ cjk_char_count + ceil(non_cjk_char_count / 4) + json_overhead(每 item 固定 24)`；receipt 记 `token_estimator_version='v1-cjk-aware'`，不称 tokenizer
- experience 排序：`(exp_status='verified' DESC, final_score DESC, memory_id ASC)` ——稳定排序键（回应 P1）
- 注入格式：固定 schema data role；event 带 `content+created_at+state`；experience 带 `trigger+correct_action+caution`（candidate 标"待验证建议"）

`peek_recall`：只读不落库；`as_of` 仅 demo/admin，向未来；早于行 anchor 报 `as_of_before_anchor`。

## 4. MCP 工具与事务 B

```
remember(content, kind, episode_id, request_id, importance?)        -- 幂等经 tool_requests；supersedes 已删
recall(query, purpose, episode_id, attempt_id, request_id, token_budget?)   -- attempt_id 必填（回应 P0-D）：无任务上下文只允许 peek_recall
pin(memory_id, pinned, reason, request_id)                           -- 幂等 set/unset，经 tool_requests；expires_at 已删
report_outcome(outcome_request_id, episode_id, task_instance_id, attempt_id, status, attributions[], ...)
log_event(episode_id, task_instance_id, attempt_id, event_type, tool_name?, payload?, request_id)   -- 幂等经 tool_requests
```

**硬删除与在途归因（回应 correctness）**：recall 与 report_outcome 之间某 memory 被 forget 时，事务 B 不整单失败——该 item 记 `memory_deleted / no_plasticity`，其余 item 正常结算，outcome 照常落库。

**事务 B（report_outcome，短 SERIALIZABLE）**：幂等读自 outcomes 本表（PK 即 claim；legacy 无证据行诚实拒 `legacy_outcome_unreplayable`）→ `(tenant, agent, attempt)` 终态唯一性检查 → ledger 锚一致性检测 → 逐条归因校验（§1.4 规则全跑，数组上限 32）→ memory_id 去重 → 塑性更新（§2.3）+ `revision+1` → outcome INSERT（response_json 占位）→ success_evidence 写入（若适用）→ scope 合法 receipt 结算 `outcome_state='reported', terminal_attempt_id` → response_json 回填 → COMMIT；40001 整体重试。

forget/export/unpin：owner/admin HTTP 面。`reflect` 无公共 tool。

## 5. 写入卫生

同步确定性 gate（无 LLM）：大小/类型/重复提示/敏感模式粗筛 → `accepted|quarantined|rejected`；quarantined 不 embedding 不注入，`quarantine_expires_at` 短 TTL；source 由 server 按调用路径分配；`derived` 必须带 evidence。

## 6. Nightly（回应 P0-6 的顺序修正）

执行顺序（每 job 独立 lease）：
1. **dream job**：冻结 eligible snapshot（fresh、低 effective、非 pinned、admission accepted，记 `(memory_id, revision)`）→ Bedrock 浓缩（事务外）→ 单事务：revision revalidate → insert summary（derived, layer=event）+ **恰好这些 sources 转 faded** + run completed。dream 拥有自己的 fade 迁移，通用 transition 不抢
2. **reflection job**：选源 `attempt_events JOIN outcomes`（attempt_events 自身无成败状态，必须联 outcomes 判定"失败 attempt + 同 task_instance 后续成功 attempt"）→ Bedrock 提炼 → 单事务插 experience(candidate) + `memory_event_evidence`（不是 memory_derivations）+ run completed
3. **通用 state transitions**：处理到期行（fade/consolidate），排除当晚 dream 已锁定的 sources

幂等/lease/stale/batch 全按结论 13/16/17。Lambda 连接池 handler 外复用 max=1；EventBridge retry+DLQ。

## 7. 评测（三档 A/B）

同 v1.0，附加假设：importance 双算是否改善 attribution 命中 [A/B]；固定 seed 公开 trace。

## 8. Auditor Mode

同 v1.0；spike 待办不变。[pending spike]

## 9. Property tests（验收增量）

v1.0 全部保留（移至 credited 路径），新增：
- recall 并发同 request_id：恰 1 行、同一 receipt
- blamed 无 evidence_event_id → 拒绝；evidence 不属于该 attempt → 拒绝
- 同 outcome 内同 memory_id 多 item → 只计一次
- receipt 已 settled 再归因 → `receipt_already_settled`
- consolidate 迁移前后 effective 连续（materialize 正确性）
- dream 运行期间 source 被事务 B 更新 → 整批 stale 不提交
- late outcome → `plasticity_applied=false` 且 anchor 不变
- remember/pin/log_event 重试 → tool_requests 命中，零重复副作用；同 key 不同 payload → `idempotency_key_reused`
- consolidate 后再 consolidate 不可达（状态机 guard）；half_life 列只被乘一次（P0-B 回归测试）
- faded 复活后 half_life = fresh 基础值
- 归因时目标 memory 已被 forget → 该 item `memory_deleted`，其余正常结算

## 10. Compliance 与配置

同 v1.0，增改：`receipt_retention=60d`（与 `outcome_window=24h` 分离）；`consolidated_half_life_multiplier=3.0`；`second_path_floor=0.35`；event 注入 `5 items/1200 tokens`。其余默认值表沿用 v1.0。

## 12. Freeze Addendum（v1.2.2，ChatGPT 终审产物）

1. **工具清单唯一化**：agent 面恰好 **5 个** tool——`remember / recall / pin / report_outcome / log_event`（此前摘要中"四个"为过期表述）；`peek_recall` 与 `forget/export/unpin/admin_replace_memory` 属 owner/admin HTTP 面，不是 agent tool。实现后导出 tools/list 快照存 `docs/TOOLS-SNAPSHOT.json`，README/SPEC/测试只认这一份。
2. **credited 也要 item 级证据（v1.2.2.1 修订）**：attempt_events 新增 server-validated 事件类型 `memory_used`，payload 必含 `recall_request_id + receipt_item_id + memory_id`；credited item 必须 `injected=true` 且其 `evidence_event_id` 指向**与该 item 绑定**的 `memory_used` 事件——`attempt_end(success)` 只证明 outcome，不得单独充当某条 memory 的 credited 证据；credited 与 blamed 互斥；`(attempt_id, memory_id, role)` 唯一；无 item-bound 证据时 outcome 照存、该 item `no_plasticity`。
3. **pin 是 capability**：principal 需带 `memory:pin` 能力位；仅 accepted 可 pin；superseded/quarantined/已删除不可 pin；pin 不改 source/utility；操作经 tool_requests 留审计；配额与告警 P1。
4. **主业务路径必须在 AWS**：Memory MCP 主服务部署于 AWS（Lambda+Function URL 优先，MCP transport 不兼容则 ECS Fargate）——**7/29 部署 spike 先行**（P0-01），spike 不绿不许写十天本地代码。spike 验收不止公网 200（v1.2.2.1 补）：必须验证 ①认证上下文→tenant/agent 映射 ②真实 MCP transport/session ③冷启动后重连 ④CRDB TLS 与连接上限行为。
5. **硬删除全副本传播（v1.2.2.1 修订，取 Codex 第一方案）**：receipt items 只存随机 memory_id+分数组件（不存正文，固化为不变量）；attempt_events payload 不得复制记忆正文；CloudWatch/Bedrock 日志不记 prompt 正文；依赖被删源的 derived memory **沿 provenance 递归 DELETE 整行**（现 schema 下 content NOT NULL、accepted 必有 embedding，不存在"清空两列"的合法路径——就是删行），只在无正文的 rebuild queue 保留随机 ID + 剩余 source IDs（P2 可重建）；不采用保留 content 的 quarantine；删除后 UI 显示 [deleted]。
6. **source 可达性表（v1.2.2.1 修订）**：`user_asserted`=owner/admin 路由写入；`agent_inferred`=agent tool 默认；`derived`=nightly 产物；`tool_verified`=**v1 reserved**；`external_untrusted`=**v1 同样 reserved**（P0 无认证 external-ingest 路由，agent 不得自报）。property test：agent 伪造任何 reserved source → server 忽略并按路径重新赋值。
7. **candidate 首验路径写死**：candidate 可注入（低于 verified 的 rank boost + "待验证建议"标注，§3 已有）→ 首次 credited 按 §2.5 guard 记 success_evidence → 2 个不同 task_instance 原子晋级 verified（晋级在事务 B 内完成）；中途 evidenced blame 不阻断晋级资格但计入 utility（评委可见"带伤转正"的诚实数据）。
8. **窄翻案（v1.2.2.1 修订，按 Codex 裁定整体延后）**：owner/admin `admin_replace_memory` 原子纠错通道**接受为 P1，schema 与实现一起放 P1**——P0-00 不预埋半成品表（CRDB 后加表无迁移障碍，"先占位否则要删除重加"的前提不成立）。P1 实现时一次性定：`agent_id` + 对 memories 的 composite FK + idempotency + single-successor 约束 + correction link 作为 recall suppression。不恢复 agent 可传的 supersedes。
9. **checksum 更名**：`integrity_checksum` → `serialization_checksum`（只证明序列化一致性）。

## 13. 文档同步义务（v1.1 起生效）

SPEC 变更时同一提交内同步：CODEX_CHANNEL.md 结论区（decision log）、ARCHITECTURE.md（外化简述）、RESEARCH.md（若涉及叙事）。本次已同步：ARCHITECTURE.md 去除 reinforce-on-recall 与陪伴 agent 表述；RESEARCH.md 去除 KMS 表述。
