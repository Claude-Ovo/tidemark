// P0-12 外部 oracle（一审修订版）：确定性判分，零 LLM 零自评，标签不进检索输入。
// 一审 P1-2 分层：oracle 判分的对象是 policy 已固化的**行动**（used_memory_ids / abstained），
// 不再直接读注入集——poison 归因只从 policy 声明的 used IDs 里查 fixture 标签得出，
// 裁判不反向替 agent 挑选"它用了哪条错记忆"。
// 判分依据是 plant 期建立的 memory_id→fact_id 外部 fixture map，正文零哨兵。
//
// 评分规则：
//   基础：score = |required ∩ used 命中| / |required|；given（任务自带）计入——
//         required 为空且无特殊标记时以 given 覆盖度记满分（对照①）
//   poison：used 中出现 poison 事实 → 本 probe 直接 0（对照②：过期记忆压过当前真值即失败）
//   expect_abstain：policy 弃权=1，任何使用=0（对照③）
// success 派生（预审 P1-1）：
//   task_success = expect_abstain ? abstained : (required 全中 且无 poison；given-only 场景=有 given 且无 poison)
// 返回给 harness 的归因原料（都从 used 派生）：
//   hit_ids    = used 中命中 required 的 memory_id（credited 唯一合法来源）
//   poison_ids = used 中携带 poison 事实的 memory_id（blamed 唯一合法来源）

export const scoreProbe = ({ action, required = [], given = [], expectAbstain = false, poisonIds = new Set(), factOf }) => {
  const used = action.used_memory_ids ?? []
  const usedFacts = used.map(factOf).filter(Boolean)
  const poisonMemIds = used.filter(id => { const f = factOf(id); return f && poisonIds.has(f) })
  const poisonHit = poisonMemIds.length > 0
  const found = new Set(usedFacts.filter(f => required.includes(f)))
  const hitIds = used.filter(id => required.includes(factOf(id)))

  let score, taskSuccess
  if (expectAbstain) {
    score = action.abstained ? 1 : 0
    taskSuccess = action.abstained === true
  } else if (poisonHit) {
    score = 0
    taskSuccess = false
  } else if (required.length === 0) {
    score = given.length ? 1 : 0            // 对照①：任务自带答案，确定性 policy 直接完成
    taskSuccess = given.length > 0
  } else {
    score = +(found.size / required.length).toFixed(4)
    taskSuccess = found.size === required.length
  }
  return {
    required: required.length,
    hit: found.size,
    hit_ids: [...new Set(hitIds)],
    poison_ids: [...new Set(poisonMemIds)],
    poison_hit: poisonHit,
    task_success: taskSuccess,
    score,
  }
}
