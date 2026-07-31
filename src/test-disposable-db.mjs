// disposable-db 生命周期单测（fake connect，无真实 DB）：
// Codex round-6 反例回归——CREATE 成功后首次业务连接失败，cleanup 必须仍然执行。
import assert from 'node:assert/strict'
import { withDisposableDb } from '../migrations/disposable-db.mjs'

const silent = { log: () => {}, error: () => {} }

const harness = ({ businessConnectFails = false, createFails = false } = {}) => {
  const calls = []
  const connect = async (_cs, { label }) => {
    if (label === 'admin' || label === 'admin-cleanup') {
      return {
        query: async (sql) => {
          calls.push(sql)
          if (createFails && sql.startsWith('CREATE DATABASE')) throw new Error('duplicate database')
        },
        end: async () => {},
      }
    }
    if (businessConnectFails) throw new Error('ECONNRESET storm')
    return { query: async (sql) => { calls.push('biz:' + sql) }, end: async () => {} }
  }
  return { calls, connect }
}
const creates = (calls) => calls.filter(s => s.startsWith('CREATE DATABASE'))
const drops = (calls) => calls.filter(s => s.startsWith('DROP DATABASE'))

// 1. Codex 实库反例：CREATE 成功、首次 connect 抛错 -> 仍恰好一次 DROP，且只 DROP 本次库
{
  const { calls, connect } = harness({ businessConnectFails: true })
  await assert.rejects(
    () => withDisposableDb({ base: 'postgres://fake', mkName: () => 'tidemark_mig_fake_a', connect, log: silent,
      fn: async () => { throw new Error('never reached') } }),
    /ECONNRESET storm/, 'primary error must surface')
  assert.equal(creates(calls).length, 1)
  assert.equal(drops(calls).length, 1, 'connect failure after CREATE still triggers cleanup')
  assert.ok(drops(calls)[0].includes('tidemark_mig_fake_a'), 'drops exactly the db it created')
  console.log('PASS connect-failure-after-CREATE still cleans up exactly once')
}

// 2. CREATE 本身失败（撞名 fail-closed）-> 零 DROP（绝不碰预先存在的库）
{
  const { calls, connect } = harness({ createFails: true })
  await assert.rejects(
    () => withDisposableDb({ base: 'postgres://fake', mkName: () => 'tidemark_mig_fake_b', connect, log: silent, fn: async () => {} }),
    /duplicate database/)
  assert.equal(drops(calls).length, 0, 'collision must not drop the pre-existing db')
  console.log('PASS CREATE collision fails closed with zero drops')
}

// 3. 正常路径：fn 跑完 -> 恰好一次 DROP；fn 抛错 -> 主错误上抛且仍恰好一次 DROP
{
  const ok = harness()
  await withDisposableDb({ base: 'postgres://fake', mkName: () => 'tidemark_mig_fake_c', connect: ok.connect, log: silent, fn: async (c) => c.query('SELECT 1') })
  assert.equal(drops(ok.calls).length, 1)
  const bad = harness()
  await assert.rejects(
    () => withDisposableDb({ base: 'postgres://fake', mkName: () => 'tidemark_mig_fake_d', connect: bad.connect, log: silent,
      fn: async () => { throw new Error('act failed') } }),
    /act failed/)
  assert.equal(drops(bad.calls).length, 1, 'fn failure still cleans up')
  console.log('PASS normal and fn-failure paths both clean up exactly once')
}

console.log('ALL DISPOSABLE-DB TESTS PASSED')
