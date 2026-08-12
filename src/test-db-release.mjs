// runTxWithPool 的连接归还语义单测（fake pool 注入）：node src/test-db-release.mjs
// 断言：业务错误(23505/CONCURRENT_WINNER)+rollback成功 -> 健康归还(reuse)；
//       链路错误(ECONNRESET) -> 销毁(destroy)；ROLLBACK 失败 -> 销毁；40001 重试后成功且首连归还健康
import assert from 'node:assert/strict'
import { runTxWithPool } from './lib/db.mjs'

const makeFake = () => {
  const releases = []
  const clients = []
  const makeClient = (behavior) => {
    const c = makeClientInner(behavior)
    clients.push(c)
    return c
  }
  const makeClientInner = (behavior) => ({
    calls: [],
    async query(sql) {
      this.calls.push(sql)
      if (sql === 'ROLLBACK' && behavior.rollbackFails) throw Object.assign(new Error('conn gone'), { code: 'ECONNRESET' })
      return { rows: [] }
    },
    release(err) { releases.push(err === undefined ? 'healthy' : 'destroy') },
  })
  return { releases, clients, makeClient }
}

// 1. 业务错误（23505 映射的 CONCURRENT_WINNER）+ rollback 成功 -> 健康归还
{
  const { releases, makeClient } = makeFake()
  const pool = { connect: async () => makeClient({}) }
  await assert.rejects(
    runTxWithPool(pool, async () => { throw Object.assign(new Error('winner'), { code: 'CONCURRENT_WINNER' }) }, 't1'))
  assert.deepEqual(releases, ['healthy'], 'business error must return connection healthy')
  console.log('PASS 1 business error -> healthy return')
}

// 2. 链路错误 ECONNRESET -> 销毁（并重试至上限）
{
  const { releases, makeClient } = makeFake()
  const pool = { connect: async () => makeClient({}) }
  await assert.rejects(
    runTxWithPool(pool, async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }, 't2'))
  assert.equal(releases.length, 5, 'retried 5 times')
  assert.ok(releases.every(r => r === 'destroy'), 'broken connections must be destroyed')
  console.log('PASS 2 connection error -> destroy (x5 retries)')
}

// 3. ROLLBACK 自身失败 -> 销毁
{
  const { releases, makeClient } = makeFake()
  const pool = { connect: async () => makeClient({ rollbackFails: true }) }
  await assert.rejects(
    runTxWithPool(pool, async () => { throw Object.assign(new Error('app boom'), { code: 'APP_ERR' }) }, 't3'))
  assert.deepEqual(releases, ['destroy'], 'failed rollback must destroy')
  console.log('PASS 3 rollback failure -> destroy')
}

// 4. 40001 一次后成功：首连健康归还（序列化冲突不毁连接），第二连正常提交
{
  const { releases, makeClient } = makeFake()
  let first = true
  const pool = { connect: async () => makeClient({}) }
  const result = await runTxWithPool(pool, async () => {
    if (first) { first = false; throw Object.assign(new Error('serialization'), { code: '40001' }) }
    return 'done'
  }, 't4')
  assert.equal(result, 'done')
  assert.deepEqual(releases, ['healthy', 'healthy'], '40001 must not destroy the connection')
  console.log('PASS 4 40001 retry -> both connections returned healthy')
}

// 5. 链路已死时不许再往这条连接上补发 ROLLBACK（它到不了服务端，只会白等一个往返）
{
  const { clients, makeClient } = makeFake()
  const pool = { connect: async () => makeClient({}) }
  await assert.rejects(
    runTxWithPool(pool, async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }, 't5'))
  for (const c of clients) assert.ok(!c.calls.includes('ROLLBACK'), 'dead link must not be issued a ROLLBACK')
  console.log('PASS 5 broken link -> no ROLLBACK on the corpse')
}

// 6. 25001 脏连接（BEGIN 往返被掐后服务端残留事务）：销毁换一条重试，不在同一条上死磕
{
  const { releases, clients, makeClient } = makeFake()
  const pool = { connect: async () => makeClient({}) }
  let first = true
  const result = await runTxWithPool(pool, async () => {
    if (first) { first = false; throw Object.assign(new Error('there is already a transaction in progress'), { code: '25001' }) }
    return 'done'
  }, 't6')
  assert.equal(result, 'done', '25001 must be retried, not thrown at the caller')
  assert.deepEqual(releases, ['destroy', 'healthy'], 'dirty connection destroyed, replacement returned healthy')
  assert.ok(!clients[0].calls.includes('ROLLBACK'), 'dirty connection is evicted, not nursed with ROLLBACK')
  console.log('PASS 6 25001 dirty connection -> destroy + retry on a fresh one')
}

console.log('ALL DB RELEASE SEMANTICS TESTS PASSED')
