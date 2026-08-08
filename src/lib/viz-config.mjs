// activity 流共享配置（SPEC §14 / 结论 66）：db.mjs（写事务上限）与 viz/activity.mjs
// （watermark）都从这里取值——单一真相源，无互相 import 的环。
// 冻结不变量：WRITE_TX_TIMEOUT_MS **严格小于** SAFETY_GRACE_MS，closed watermark 的
// 水位证明才成立（任何带 now() 时间戳的行必须在 grace 关闭前提交或 abort）。
export const SAFETY_GRACE_MS = 30000

export const WRITE_TX_TIMEOUT_MS = (() => {
  const v = Number(process.env.TIDEMARK_WRITE_TX_TIMEOUT_MS || 15000)
  if (!Number.isInteger(v) || v < 100) throw new Error(`invalid TIDEMARK_WRITE_TX_TIMEOUT_MS "${process.env.TIDEMARK_WRITE_TX_TIMEOUT_MS}"`)
  // Codex activity 一审 P1-2：严格不等式必须被配置守住——30000 等值同样拒绝
  if (v >= SAFETY_GRACE_MS) throw new Error(`TIDEMARK_WRITE_TX_TIMEOUT_MS (${v}) must be strictly less than SAFETY_GRACE_MS (${SAFETY_GRACE_MS})`)
  return v
})()
