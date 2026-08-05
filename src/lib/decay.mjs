// 衰减公式唯一实现（P0-11 起从 recall.mjs 提为共享模块）：
// recall rerank 与 viz 海景快照必须用同一双眼睛看强度——公式分叉=画面撒谎。
// now 由调用方传入：recall 用请求时刻，viz 用【DB 快照时刻】（契约#2：客户端永不用浏览器钟）。
export const decayEffective = (row, now) => {
  if (row.pinned) return Number(row.strength_anchor)     // pinned 冻结，不衰减
  const ageH = (now - new Date(row.strength_anchor_at).getTime()) / 3600e3
  return Number(row.strength_anchor) * Math.exp(-Math.LN2 * Math.max(0, ageH) / Number(row.half_life_hours))
}
