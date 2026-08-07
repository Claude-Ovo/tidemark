// 潮池布局回归（DESIGN-OCEAN.md v2「布局回归断言」全项，node web/test-layout-pool.mjs）
// 真实 74-memory 快照验收在原型阶段接真实 API 跑；本文件先覆盖构造集 + 分布形态。
import assert from 'node:assert/strict'
import { layoutPool, radiusOf, layerOf, strengthOf, fadeLineRadius, POOL_CFG, stableHash } from './src/pool/layout-pool.mjs'

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const mem = (n, s, { pinned = false, at = null } = {}) => ({
  memory_id: uuid(n), pinned, effective_strength: s,
  created_at: at ?? new Date(Date.UTC(2026, 7, 1, 0, n)).toISOString(),
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
  const rs = new Set(placed.map(p => p.r))
  assert.equal(rs.size, 1, '同 strength 恒同半径')
  assert.equal(new Set(placed.map(p => p.layer)).size, 1)
})

t('fade line：s<=fade_threshold 的粒子恒在警戒线外侧', () => {
  const fade = 0.15
  const line = fadeLineRadius(fade)
  const { placed } = layoutPool(realistic)
  for (const p of placed) {
    const src = realistic.find(m => m.memory_id === p.memory_id)
    if (!src.pinned && strengthOf(src) <= fade) assert.ok(p.r >= line)
  }
})

t('密集布点：零重叠或诚实 overflow（60 同强度复现集，P1-2）', () => {
  const dense = Array.from({ length: 60 }, (_, i) => mem(300 + i, 0.5))
  const { placed, overflow } = layoutPool(dense)   // pairwise 断言在 layoutPool 内部，越线即 throw
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

t('角向无聚簇退化（P1-3 转移到 angle）：半圆分箱无 >60% 挤压', () => {
  const { placed } = layoutPool(realistic)
  const bins = [0, 0, 0, 0, 0, 0]
  for (const p of placed) {
    const norm = ((p.theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    bins[Math.floor(norm / (Math.PI / 3))]++
  }
  for (const n of bins) assert.ok(n <= placed.length * 0.6, `单 60° 扇区占比过高: ${bins}`)
})

t('全高 / 全低 边界集不越层', () => {
  const hi = Array.from({ length: 20 }, (_, i) => mem(500 + i, 0.9 + i * 0.005))
  const lo = Array.from({ length: 20 }, (_, i) => mem(600 + i, 0.01 + i * 0.005))
  for (const p of layoutPool(hi).placed) assert.equal(p.layer, 'anchor')
  for (const p of layoutPool(lo).placed) assert.equal(p.layer, 'receding_edge')
})

t('stableHash 确定性', () => {
  assert.equal(stableHash('tidemark'), stableHash('tidemark'))
  assert.notEqual(stableHash('a'), stableHash('b'))
})

console.log(`\n${passed} 项全过`)
