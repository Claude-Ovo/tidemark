// P0-12 外部 oracle（预审修订版）：确定性判分，零 LLM 零自评，标签不进检索输入——
// 判分依据是 plant 期建立的 memory_id→fact_id 外部 fixture map（预审方法学裁定），
// 不再读正文哨兵。绝不读 viz、绝不让被测系统自评。
//
// 评分规则：
//   基础：score = |required ∩ 注入命中| / |required|；given（任务自带）计入 found——
//         required 为空且无特殊标记时以 given 覆盖度记满分（对照①）
//   poison：注入集中出现 poison 事实 → 本 probe 直接 0（对照②：过期记忆压过当前真值即失败）
//   expect_abstain：零注入=1，任何注入=0（对照③）
// success 派生（预审 P1-1：outcome 必须由 oracle 结果派生，不许脱钩）：
//   task_success = expect_abstain ? (injected==0) : (hit === required 全中 且无 poison)

export const scoreProbe = ({ injected, required = [], given = [], expectAbstain = false, poisonIds = new Set(), factOf }) => {
  const injectedFacts = injected.map(i => factOf(i.memory_id)).filter(Boolean)
  const poisonHit = injectedFacts.some(f => poisonIds.has(f))
  const found = new Set(injectedFacts.filter(f => required.includes(f)))
  const hitIds = injected.filter(i => required.includes(factOf(i.memory_id))).map(i => i.memory_id)

  let score, taskSuccess
  if (expectAbstain) {
    score = injected.length === 0 ? 1 : 0
    taskSuccess = injected.length === 0
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
    poison_hit: poisonHit,
    task_success: taskSuccess,
    score,
  }
}
