// migration preflight 单测（mock client，无 DB）：014/016 的 fail-closed 行为两向断言。
// 时序正确性（检查发生在破坏性语句之前、真实 applyOne 路径）由
// migrations/test-migrate-integration.mjs 在真实库上证明——本文件只锁指引文本与开关逻辑。
import assert from 'node:assert/strict'
import { PREFLIGHTS } from '../migrations/preflights.mjs'

const mockClient = (n) => ({ query: async () => ({ rows: [{ n }] }) })

// 014：最早破坏点。证据仍在 -> 拒绝并指引 BACKFILL（不许删任何一侧）
await assert.rejects(
  () => PREFLIGHTS[14](mockClient(2)),
  (e) => e.message.includes('PREFLIGHT 014 REFUSED') && e.message.includes('BACKFILL')
    && e.message.includes('Never delete outcome rows'),
  '014 must refuse with backfill instructions while evidence exists')
console.log('PASS preflight 014 refuses with backfill guidance')
await PREFLIGHTS[14](mockClient(0))
console.log('PASS preflight 014 passes on zero legacy rows')

// 016：纵深防御。走到这里证据已丢 -> 指引打 unreplayable marker，绝不删行
await assert.rejects(
  () => PREFLIGHTS[16](mockClient(3)),
  (e) => e.message.includes('PREFLIGHT 016 REFUSED') && e.message.includes('legacy_outcome_unreplayable')
    && e.message.includes('Do NOT delete') && !e.message.includes('delete the originals'),
  '016 must instruct marking, never deletion')
console.log('PASS preflight 016 refuses with marker guidance (no deletion path)')
await PREFLIGHTS[16](mockClient(0))
console.log('PASS preflight 016 passes on zero legacy rows')

console.log('ALL PREFLIGHT TESTS PASSED')
