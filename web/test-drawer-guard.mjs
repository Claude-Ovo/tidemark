// drawer 请求守卫回归（交互层一审 P1-4 的机器可测半：竞态与迟到响应；
// 焦点/inert 的 DOM 半在真实浏览器验收——见频道实录）
import assert from 'node:assert/strict'
import { makeDrawerGuard } from './src/pool/drawer-guard.mjs'

let passed = 0
const t = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`) }

t('A→B 竞态：迟到的 A 响应失效，B 有效', () => {
  const g = makeDrawerGuard()
  const a = g.begin()
  const b = g.begin()               // 快速点开 B：A 被 abort
  assert.equal(a.signal?.aborted, true, 'begin(B) 必须 abort A 的在途请求')
  assert.equal(g.isCurrent(a), false, '迟到的 A 不得覆盖')
  assert.equal(g.isCurrent(b), true)
})

t('close 后迟到响应失效，且在途请求被 abort', () => {
  const g = makeDrawerGuard()
  const a = g.begin()
  g.close()
  assert.equal(a.signal?.aborted, true)
  assert.equal(g.isCurrent(a), false, 'close 后迟到响应不得重写抽屉')
  assert.equal(g.isOpen(), false)
})

t('close 后重开：旧 token 仍失效，新 token 有效', () => {
  const g = makeDrawerGuard()
  const a = g.begin()
  g.close()
  const b = g.begin()
  assert.equal(g.isCurrent(a), false)
  assert.equal(g.isCurrent(b), true)
})

console.log(`\n${passed} 项全过`)
