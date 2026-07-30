// migration preflight 单测（mock client，无 DB）：016 的 fail-closed 行为两向断言
import assert from 'node:assert/strict'
import { PREFLIGHTS } from '../migrations/preflights.mjs'

const mockClient = (n) => ({ query: async () => ({ rows: [{ n }] }) })

// legacy 行存在 -> 必须 throw，且指引包含 archive 步骤与诚实失败语义
await assert.rejects(
  () => PREFLIGHTS[16](mockClient(3)),
  (e) => e.message.includes('PREFLIGHT 016 REFUSED') && e.message.includes('3 legacy outcome row')
    && e.message.includes('outcomes_legacy_archive') && e.message.includes('legacy_outcome_unreplayable'),
  'preflight must refuse with manual instructions')
console.log('PASS preflight 016 refuses when legacy rows exist')

// 零行 -> 放行
await PREFLIGHTS[16](mockClient(0))
console.log('PASS preflight 016 passes on zero legacy rows')

console.log('ALL PREFLIGHT TESTS PASSED')
