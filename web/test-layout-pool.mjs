// 潮池布局回归（DESIGN-OCEAN.md v2「布局回归断言」全项 + Codex v2 一审 P1-3/P1-4/P2-7）
// node web/test-layout-pool.mjs；真实 74-memory 快照验收在原型阶段接真实 API 入测。
import assert from 'node:assert/strict'
import { layoutPool, radiusOf, layerOf, strengthOf, fadeLineRadius, POOL_CFG, stableHash } from './src/pool/layout-pool.mjs'

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const mem = (n, s, { pinned = false, at = null } = {}) => ({
  memory_id: uuid(n), pinned, effective_strength: s,
  created_at: at ?? new Date(Date.UTC(2026, 7, 1, 0, 0, n % 3600, Math.floor(n / 3600))).toISOString(),
})
let passed = 0
const t = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`) }

// 拟真分布（74 条，接近真实快照形态：少数高、多数中、一簇将忘、少量 pinned）
const realistic = [
  ...Array.from({ length: 4 }, (_, i) => mem(i, 0, { pinned: true })),
  ...Array.from({ length: 8 }, (_, i) => mem(10 + i, 0.72 + 0.03 * (i % 8))),
  ...Array.from({ length: 40 }, (_, i) => mem(30 + i, 0.36 + (i * 0.008))),
  ...Array.from({ length: 16 }, (_, i) => mem(80 + i, 0.05 + i * 0.017)),
  ...Array.from({ length: 6 }, (_, i) => mem(100 + i, 0.14 - i * 0.02)),
]

t('层判定：绝对阈值，pinned 恒 anchor', () => {
  assert.equal(layerOf(mem(1, 0.70)), 'anchor')
  assert.equal(layerOf(mem(1, 0.699)), 'active_tide')
  assert.equal(layerOf(mem(1, 0.36)), 'active_tide')
  assert.equal(layerOf(mem(1, 0.35)), 'receding_edge')
  assert.equal(layerOf(mem(1, 0.01, { pinned: true })), 'anchor')
})

t('半径：r 随 s 严格单调、pinned 恒在小环、零径向妥协', () => {
  for (let s = 0; s < 1; s += 0.05) {
    assert.ok(radiusOf(mem(1, s)) > radiusOf(mem(1, s + 0.05)))
  }
  assert.equal(radiusOf(mem(1, 0.2, { pinned: true })), POOL_CFG.PIN_RING)
  const { placed } = layoutPool(realistic)
  for (const p of placed) {
    const src = realistic.find(m => m.memory_id === p.memory_id)
    assert.equal(p.r, radiusOf(src), 'painted r 必须恒等 radiusOf——布局不得二次改 r')
  }
})

t('池内完整可见（P1-3）：s=0 粒子 r+mark+halo <= 1，OUTER_INSET 覆盖足量', () => {
  assert.ok(POOL_CFG.OUTER_INSET >= POOL_CFG.MARK_R + POOL_CFG.HALO_R)
  const worst = radiusOf(mem(1, 0)) + POOL_CFG.MARK_R + POOL_CFG.HALO_R
  assert.ok(worst <= 1, `s=0 可见外缘 ${worst} 超出池`)
  const edge = Array.from({ length: 30 }, (_, i) => mem(700 + i, 0))
  const { placed } = layoutPool(edge)   // 内部不变量断言同时守 r+visible<=1
  for (const p of placed) assert.ok(p.r + p.markR + POOL_CFG.HALO_R <= 1)
})

t('强弱不反序（placed 全序）', () => {
  const { placed } = layoutPool(realistic)
  const nonPin = placed.filter(p => !realistic.find(m => m.memory_id === p.memory_id).pinned)
  for (const a of nonPin) for (const b of nonPin) {
    if (a.s > b.s) assert.ok(a.r < b.r || a.s === b.s)
  }
})

t('同强度 ties：同半径且不跨层', () => {
  const ties = Array.from({ length: 12 }, (_, i) => mem(200 + i, 0.5))
  const { placed, overflow } = layoutPool(ties)
  assert.equal(overflow.length, 0)
  assert.equal(new Set(placed.map(p => p.r)).size, 1, '同 strength 恒同半径')
  assert.equal(new Set(placed.map(p => p.layer)).size, 1)
})

t('fade line：与 radiusOf 同一映射，s<=fade_threshold 恒在线外侧', () => {
  const fade = 0.15
  const line = fadeLineRadius(fade)
  assert.equal(line, radiusOf(mem(1, fade)), 'fade line 必须走同一映射函数')
  const { placed } = layoutPool(realistic)
  for (const p of placed) {
    const src = realistic.find(m => m.memory_id === p.memory_id)
    if (!src.pinned && strengthOf(src) <= fade) assert.ok(p.r >= line)
  }
})

t('密集布点：零重叠或诚实 overflow（60 同强度复现集，P1-2）', () => {
  const dense = Array.from({ length: 60 }, (_, i) => mem(300 + i, 0.5))
  const { placed, overflow } = layoutPool(dense)   // pairwise 不变量在 layoutPool 内部，越线即 throw
  assert.equal(placed.length + overflow.length, 60, '每条要么落位要么显式 overflow，无静默丢失')
  for (const o of overflow) assert.equal(o.reason, 'placement_overflow')
})

t('密集 pinned：小环轨道排布不塞零点', () => {
  const pins = Array.from({ length: 10 }, (_, i) => mem(400 + i, 0, { pinned: true }))
  const { placed, overflow } = layoutPool(pins)
  for (const p of placed) assert.equal(p.r, POOL_CFG.PIN_RING)
  assert.ok(placed.length >= 8, `pinned 环至少容 8（实测 ${placed.length}，溢出 ${overflow.length} 显式）`)
})

t('刷新确定性：同输入两次布局逐字节相同（含乱序输入）', () => {
  const a = layoutPool(realistic)
  const b = layoutPool([...realistic].reverse())
  assert.deepEqual(a, b)
})

// P2-7：12 桶最大占比 + circular gap 双指标；placed 覆盖率单独断言，
// 防止靠丢 overflow 让剩余点"看起来均匀"
const angularAudit = (memories, { maxBinShare, maxGapRad, minPlacedShare }) => {
  const { placed, overflow } = layoutPool(memories)
  assert.ok(placed.length >= memories.length * minPlacedShare,
    `placed 覆盖率不足: ${placed.length}/${memories.length}（overflow ${overflow.length}）`)
  const thetas = placed.map(p => ((p.theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b)
  const bins = new Array(12).fill(0)
  for (const th of thetas) bins[Math.floor(th / (Math.PI / 6)) % 12]++
  const maxBin = Math.max(...bins)
  assert.ok(maxBin <= placed.length * maxBinShare, `单 30° 扇区占比过高: ${bins}`)
  let maxGap = 2 * Math.PI - thetas[thetas.length - 1] + thetas[0]
  for (let i = 1; i < thetas.length; i++) maxGap = Math.max(maxGap, thetas[i] - thetas[i - 1])
  assert.ok(maxGap <= maxGapRad, `最大角向空窗 ${(maxGap * 180 / Math.PI).toFixed(1)}° 超限`)
}

t('角向无聚簇退化（P1-3 转移到 angle，P2-7 加严）：拟真 74', () => {
  angularAudit(realistic, { maxBinShare: 0.25, maxGapRad: Math.PI / 3, minPlacedShare: 0.95 })
})

t('角向无聚簇退化：突发同刻批量写入（同 created_at 秒级 tie）', () => {
  const burst = Array.from({ length: 48 }, (_, i) => mem(800 + i, 0.3 + i * 0.01, { at: '2026-08-01T00:00:00.000Z' }))
  angularAudit(burst, { maxBinShare: 0.25, maxGapRad: Math.PI / 2, minPlacedShare: 0.9 })
})

t('全高 / 全低 边界集不越层', () => {
  const hi = Array.from({ length: 20 }, (_, i) => mem(500 + i, 0.9 + i * 0.005))
  const lo = Array.from({ length: 20 }, (_, i) => mem(600 + i, 0.01 + i * 0.005))
  for (const p of layoutPool(hi).placed) assert.equal(p.layer, 'anchor')
  for (const p of layoutPool(lo).placed) assert.equal(p.layer, 'receding_edge')
})

t('性能预算（P1-4）：74/500/2000 三档，空间哈希后须全部可交互', () => {
  const spread = (n, base) => Array.from({ length: n }, (_, i) => mem(base + i, (i % 97) / 100))
  const budget = [[74, 30], [500, 150], [2000, 1200]]
  for (const [n, ms] of budget) {
    const data = spread(n, 10000 + n)
    layoutPool(data)                          // 预热（JIT）
    const t0 = performance.now()
    const { placed, overflow } = layoutPool(data)
    const dt = performance.now() - t0
    console.log(`  # n=${n}: ${dt.toFixed(1)}ms (placed ${placed.length} / overflow ${overflow.length})`)
    assert.ok(dt < ms, `n=${n} 布局 ${dt.toFixed(1)}ms 超预算 ${ms}ms`)
  }
})

t('stableHash 确定性', () => {
  assert.equal(stableHash('tidemark'), stableHash('tidemark'))
  assert.notEqual(stableHash('a'), stableHash('b'))
})

console.log(`\n${passed} 项全过`)
