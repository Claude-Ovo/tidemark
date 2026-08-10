// P0-12 v4 分组报表 + fixture 前置验证（纯函数，零 DB——预审裁定的报表口径）。
// headline 不出单一均分：main effectiveness 聚合 / negative controls 逐场景 pass-fail /
// diagnostics raw 值单列；全 probes 混合均分仅作 reference 行。
// 坑位型场景（precondition:'contention'）验 receipt 前置：vector 臂（零塑性）目标必须在
// 注入席外——否则坑位竞争不存在，标 invalid_fixture 不计入分组统计（embedding 漂移
// 不得误算成产品成败）。matched control 的服务面断言（cancelled 目标 utility 恒 0.5）
// 违反时记 violation——那是产品失败，不是 fixture 失效，两者分开。

export const groupReport = (armResult, invalidSet = new Set()) => {
  const buckets = { main: [], control: [], diagnostic: [] }
  for (const sc of armResult.scenarios) (buckets[sc.group] ?? buckets.main).push(sc)
  const agg = (list) => {
    const probes = list.filter(sc => !invalidSet.has(sc.scenario)).flatMap(sc => sc.probes)
    if (!probes.length) return { n: 0, score: null, success: null }
    return {
      n: probes.length,
      score: +(probes.reduce((a, p) => a + p.score, 0) / probes.length).toFixed(4),
      success: +(probes.filter(p => p.task_success).length / probes.length).toFixed(4),
    }
  }
  return {
    main: agg(buckets.main),
    // control 的 pass-fail 只看断言 probe（标了 control_probe 的）；没有标记的场景退回全 probes。
    // 治疗前/设置期 probes 不参与判定（v4 ack 后修正：no-memory 在配对场景的设置期 miss
    // 不是 control 失效；nc-stale 的前两击是设计态）
    controls: buckets.control.map(sc => {
      const asserted = sc.probes.filter(p => p.control_probe)
      const judged = asserted.length ? asserted : sc.probes
      return {
        scenario: sc.scenario,
        invalid: invalidSet.has(sc.scenario) || undefined,
        pass: !invalidSet.has(sc.scenario) && judged.every(p => p.task_success),
      }
    }),
    diagnostics: buckets.diagnostic.map(sc => ({
      scenario: sc.scenario,
      scores: sc.probes.map(p => p.score),
      budget_normalized: sc.probes.map(p => p.budget_normalized).filter(v => v !== undefined),
    })),
    reference_overall: agg([...buckets.main, ...buckets.control, ...buckets.diagnostic]),
  }
}

// 从 suite 冻结期望的 contention 场景集合（fail-closed 的依据——不是"看 trace 里有什么"）
export const expectedContentionScenarios = (scenarios) =>
  scenarios.filter(sc => (sc.steps ?? []).some(st => st.precondition === 'contention')).map(sc => sc.id)

// v4 三审 P1-3：fail-closed——期望集合来自 suite；每个期望场景必须在 vector 与 full 各有
// contention trace，vector 目标必须【存在于候选、injected===false、numeric rank>=6】，
// 任一不满足（缺 trace/空 receipt/absent/rank null/rank<6/已注入）即 invalid_fixture。
// "目标根本没进候选"不再能冒充"坑位竞争成立"。
export const verifyFixtures = ({ vector = [], full = [], expected = [] }) => {
  const invalid = new Set()
  const violations = []
  const flips = {}
  const contention = (tr) => tr.filter(l => l.t === 'receipt_probe' && l.precondition === 'contention')
  const targetOf = (line) => (line.targets ?? []).find(t => String(t.fact).endsWith('-target'))
  const vecBySc = new Map(contention(vector).map(l => [l.sc, l]))
  const fullBySc = new Map(contention(full).map(l => [l.sc, l]))
  for (const sc of expected) {
    const vLine = vecBySc.get(sc), fLine = fullBySc.get(sc)
    const vTarget = vLine ? targetOf(vLine) : null
    const fTarget = fLine ? targetOf(fLine) : null
    if (vTarget) flips[sc] = { vector: { injected: vTarget.injected === true, rank: vTarget.rank ?? null } }
    if (fTarget) flips[sc] = { ...(flips[sc] ?? {}), full: { injected: fTarget.injected === true, rank: fTarget.rank ?? null } }
    // 前置全条件（缺一即 invalid）：双臂 trace 在、vector 目标在候选中且未注入、数值 rank>=6
    const preconditionOk = !!vLine && !!fLine && !!vTarget && !vTarget.absent
      && vTarget.injected === false && typeof vTarget.rank === 'number' && vTarget.rank >= 6
    if (!preconditionOk) { invalid.add(sc); continue }
    // matched control 服务面断言（round 2 复审 P1 收紧：full 侧同样 fail-closed）——
    // full cancelled 目标消失=证据失败（不是 fixture 漂移）；utility 必须为 numeric 且
    // |util-0.5|<=1e-9 才通过；absent/null/非数值分别记 violation
    if (sc === 'sc-cancelled-null') {
      if (!fTarget || fTarget.absent) {
        violations.push({ sc, kind: 'cancelled-target-missing' })
      } else if (typeof fTarget.util !== 'number' || Number.isNaN(fTarget.util)) {
        violations.push({ sc, kind: 'cancelled-target-utility-missing', util: fTarget.util ?? null })
      } else if (Math.abs(fTarget.util - 0.5) > 1e-9) {
        violations.push({ sc, kind: 'cancelled-target-utility-changed', util: fTarget.util })
      }
    }
  }
  return { invalid: [...invalid], violations, flips }
}
