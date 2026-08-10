# 自然衰减 E2E 留证（2026-08-10，按 8/8 约定执行）

**命题**：真实 wall-clock 流逝 ~2.3 天后，服务面（`vizOcean` 单事务快照）的
`effective_strength` 与「存储锚点 + 唯一衰减公式（`src/lib/decay.mjs`）」独立重算
逐条一致——期间**零改写、零后台任务**（结论 1「衰减=读时计算」/ 结论 2「无每小时任务」
的时间维度实证）；outcome-gated 塑性留下的 anchor 差在衰减中兑现为真实的存活差。

**复现**：`node scripts/verify-decay-e2e.mjs --agent=<agent>`（tenant 默认 demo-tenant）

## Run 1: rehearsal-0808c（播种于 2026-08-08 11:16 CST，流逝 2.32 天）

- **PASS 12/12**：served === recomputed，全行 |Δ| = 0.0e+0
- 未 pinned 的 fresh 行（anchor 1.0）自然衰至 0.699–0.742（importance 分层可见：imp 0.8 → 0.742，imp 0.5 → 0.699）
- pinned 两行冻结在 ~0.99997（不衰减 ✓）
- **被 blamed×2 的行**（8/8 塑性 0.9999→0.6400）继续自然衰减至 **0.4668**——错误记忆被双通道压制（塑性罚 + 时间）

## Run 2: rehearsal-aged（播种于 2026-08-08 11:20 CST，流逝 2.29 天）

- **PASS 12/12**：全行 |Δ| = 0.0e+0
- **aged-credited 主证据**：8/8 被 credited 的老记忆（当时已自然衰至 0.322，塑性
  materialize+gain → anchor 0.5255）现保留 **0.385**；反事实（未 credited、anchor 0.322
  同半衰期）今天只剩 ≈0.236——**一次有证据的 credited 把这条记忆的存活曲线整体抬高**，
  在真实时间里可测量
- blamed×2 行：0.6400 → 0.4689（与 Run 1 同形态，跨 fixture 一致）
- 7.29 天龄的 pinned 老 seed 仍冻结 0.99997（长时距 pinned 不衰减 ✓）

## 边界（诚实声明）

- 两 fixture 各 12 行、单 tenant；证明的是**机制**（读时衰减的时间一致性 + 塑性→存活差），
  不是规模性能
- `tidemark-final` agent（8/8 播种）继续静置至 8/16 录制日，作为 demo 真实基线——
  录制前用同一脚本再验一次
- 对表精度 |Δ|<1e-9：served 与重算走同一实现（`decayEffective`）、同一 DB 时钟
  （snapshot_at），验证的是「快照后无改写、无第二套公式」
