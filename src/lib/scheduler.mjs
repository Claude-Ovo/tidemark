// canonical lifecycle scheduler（P0-06 方案 A，唯一口径）：next_transition_at 的
// 全部写点（remember/report_outcome credited/blamed/revive/pin/unpin/nightly 各分支）
// 都必须经由 scheduleNext 计算——语义是"下次值得 nightly 检查本行的时刻"，调度提示
// 而非转换承诺，领取后一律 revalidate。边界与状态机同口径：effective <= fade_threshold
// 触发 fade（含等号，消除 anchor==threshold 的 now 热循环）。
// 秒级以下用毫秒时间戳计算；返回 Date 或 null。
export const TRANSITION_CFG = {
  fade_threshold: 0.15,
  consolidate_hits: 3,
  consolidate_multiplier: 3.0,
  batch_size: 200,
  lease_minutes: 10,
  max_attempts: 3,
}

// progress = lifetime count - 本轮基线（复活/衰退后重新挣，SPEC v1.2.4 §2.4/§2.5）
export const consolidationProgress = (row) =>
  Number(row.credited_success_count) - Number(row.consolidation_baseline)

// row 需含：admission, pinned, state, strength_anchor, strength_anchor_at,
// half_life_hours, credited_success_count, consolidation_baseline
// evalTime: 毫秒时间戳（评估时钟由调用方注入——事务内单点取值或 scheduled_for）
export const scheduleNext = (row, evalTime) => {
  if (row.admission !== 'accepted' || row.pinned || row.state === 'faded') return null
  if (row.state === 'fresh' && consolidationProgress(row) >= TRANSITION_CFG.consolidate_hits) {
    return new Date(evalTime)   // 立即 due：转换本身仍只在 nightly 执行
  }
  const anchor = Number(row.strength_anchor)
  if (anchor <= TRANSITION_CFG.fade_threshold) return new Date(evalTime)
  // 解析解：effective 衰到阈值的时刻 = anchor_at + half_life * log2(anchor/threshold)
  const hours = Number(row.half_life_hours) * Math.log2(anchor / TRANSITION_CFG.fade_threshold)
  return new Date(new Date(row.strength_anchor_at).getTime() + hours * 3600e3)
  // 解出的过去时刻保留原值——due 语义已成立，不向 now 归一
}
