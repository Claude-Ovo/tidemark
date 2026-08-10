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

export const verifyFixtures = ({ vector = [], full = [] }) => {
  const invalid = new Set()
  const violations = []
  const flips = {}
  const contention = (tr) => tr.filter(l => l.t === 'receipt_probe' && l.precondition === 'contention')
  const targetOf = (line) => (line.targets ?? []).find(t => String(t.fact).endsWith('-target'))
  for (const line of contention(vector)) {
    const target = targetOf(line)
    // 前置：vector 臂目标在注入席外（absent=完全出候选，同样成立）；缺 trace 保守判 invalid
    if (!target || target.injected === true) invalid.add(line.sc)
    if (target) flips[line.sc] = { vector: { injected: target.injected === true, rank: target.rank ?? null } }
  }
  for (const line of contention(full)) {
    const target = targetOf(line)
    if (!target) continue
    // v4 ack 解释①：坑位证明必须是 injected 翻转（false→true）配合 rank，不是只看 rank
    flips[line.sc] = { ...(flips[line.sc] ?? {}),
      full: { injected: target.injected === true, rank: target.rank ?? null } }
    if (target.absent) continue
    if (line.sc === 'sc-cancelled-null' && target.util != null && Math.abs(target.util - 0.5) > 1e-9) {
      violations.push({ sc: line.sc, kind: 'cancelled-target-utility-changed', util: target.util })
    }
  }
  return { invalid: [...invalid], violations, flips }
}
