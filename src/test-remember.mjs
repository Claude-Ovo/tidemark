// P0-03 验收断言：node --env-file=.env src/test-remember.mjs（先起 server）
// 场景：无auth拒/正常写入/幂等重放/同key异payload拒/语义重复≠网络重试/100并发同key仅1行/quarantine无embedding/rejected零落行
// 全部产物在 finally 中按精确 ID 清理，脚本不留残留。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { isRetryableDatabaseError, sleep } from '../migrations/db.mjs'

// 取证查询走仓库已验证的 cold-wake 策略：专用 client + connectWithRetry(5)，断连即重建
import { connectWithRetry, withDatabase } from '../migrations/db.mjs'
let forensic = null
const q = async (text, params) => {
  const cs = withDatabase(process.env.COCKROACH_DATABASE_URL, process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  for (let attempt = 1; ; attempt++) {
    try {
      forensic ??= await connectWithRetry(cs, { label: 'forensic' })
      return await forensic.query(text, params)
    } catch (e) {
      await forensic?.end().catch(() => {}); forensic = null
      if (!isRetryableDatabaseError(e) || attempt >= 5) throw e
      await sleep(800 * attempt)
    }
  }
}

const url = process.env.TIDEMARK_URL || 'http://localhost:3901'
const withClient = async (headers, fn) => {
  const c = new Client({ name: 'p003-test', version: '0.1.1' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }))
  try { return await fn(c) } finally { await c.close().catch(() => {}) }
}
const call = async (c, args) => {
  const r = await c.callTool({ name: 'remember', arguments: args })
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) }
}
const AUTH = { 'x-tidemark-auth': 'spike-demo-key' }
const TENANT = 'demo-tenant'

// 清理登记簿：精确 ID 回收
const createdEpisodes = new Set()
const createdRequestIds = new Set()
const ep = () => { const e = 'p003-' + randomUUID().slice(0, 8); createdEpisodes.add(e); return e }
const rid = () => { const r = randomUUID(); createdRequestIds.add(r); return r }

let primaryError = null
try {
  // 1. 无 auth -> isError
  await withClient({}, async (c) => {
    const { isError, body } = await call(c, { content: 'x', episode_id: ep(), request_id: rid() })
    assert.equal(isError, true); assert.equal(body.error, 'unauthorized')
    console.log('PASS 1 unauthorized isError')
  })

  // 2. 正常写入：accepted + DB 行核验（含 canonical 存储）
  const ep2 = ep(), rid2 = rid()
  let mem2
  await withClient(AUTH, async (c) => {
    const { body } = await call(c, { content: '  tidemark remembers the tide  ', episode_id: ep2, request_id: rid2, kind: 'fact', importance: 0.7 })
    assert.equal(body.ok, true); assert.equal(body.admission, 'accepted')
    assert.equal(body.source, 'agent_inferred'); assert.ok(body.embedding_sha256)
    mem2 = body.memory_id
    const row = (await q('SELECT content, embedding IS NOT NULL AS has_emb, half_life_hours, importance FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3', [TENANT, 'demo-agent', mem2])).rows[0]
    assert.equal(row.has_emb, true); assert.equal(Number(row.importance), 0.7)
    assert.equal(row.content, 'tidemark remembers the tide', 'stored content is canonical (trimmed)')
    assert.equal(Number(row.half_life_hours), 72 * 1.7, 'half_life = base*(1+importance)')
    console.log('PASS 2 accepted write + canonical stored + DB row verified')
  })

  // 3. 幂等重放：同 key 同 payload -> 原响应，无第二行
  await withClient(AUTH, async (c) => {
    const { body } = await call(c, { content: '  tidemark remembers the tide  ', episode_id: ep2, request_id: rid2, kind: 'fact', importance: 0.7 })
    assert.equal(body.memory_id, mem2, 'replay returns first memory_id')
    const n = (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id=$2', [TENANT, ep2])).rows[0].n
    assert.equal(n, 1, 'still exactly one row')
    console.log('PASS 3 idempotent replay')
  })

  // 4. 同 key 异 payload -> idempotency_key_reused
  await withClient(AUTH, async (c) => {
    const { isError, body } = await call(c, { content: 'DIFFERENT', episode_id: ep2, request_id: rid2 })
    assert.equal(isError, true); assert.equal(body.error, 'idempotency_key_reused')
    console.log('PASS 4 key reuse rejected')
  })

  // 5. 语义重复 ≠ 网络重试：同内容 + 不同 request_id -> 第二行（PLAN P0-03 验收原文）
  await withClient(AUTH, async (c) => {
    const ep5 = ep()
    const a = await call(c, { content: 'same words twice', episode_id: ep5, request_id: rid() })
    const b = await call(c, { content: 'same words twice', episode_id: ep5, request_id: rid() })
    assert.equal(a.body.ok, true); assert.equal(b.body.ok, true)
    assert.notEqual(a.body.memory_id, b.body.memory_id, 'different request_id -> distinct memories')
    const n = (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id=$2', [TENANT, ep5])).rows[0].n
    assert.equal(n, 2, 'semantic duplicate is NOT treated as retry')
    console.log('PASS 5 semantic duplicate != network retry')
  })

  // 6. 100 并发同 request_id -> 全部 ok、同一 memory_id、恰 1 行
  {
    const r = rid(), content = 'concurrent-storm', ep6 = ep()
    const results = await Promise.all(Array.from({ length: 100 }, () =>
      withClient(AUTH, (c) => call(c, { content, episode_id: ep6, request_id: r }))))
    results.forEach((res, i) => {
      assert.equal(res.isError, false, `concurrent ${i} unexpected isError: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.ok, true, `concurrent ${i} not ok`)
      assert.ok(res.body.memory_id, `concurrent ${i} missing memory_id`)
    })
    const ids = new Set(results.map(r2 => r2.body.memory_id))
    assert.equal(ids.size, 1, `all 100 share one memory_id (got ${ids.size})`)
    const n = (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id=$2', [TENANT, ep6])).rows[0].n
    assert.equal(n, 1, 'exactly one row after 100 concurrent')
    console.log('PASS 6 100 concurrent same request_id -> all ok, 1 row')
  }

  // 7. quarantine：敏感内容 -> quarantined、无 embedding、有过期时间
  await withClient(AUTH, async (c) => {
    const { body } = await call(c, { content: 'my key is AKIAABCDEFGHIJKLMNOP ok', episode_id: ep(), request_id: rid() })
    assert.equal(body.admission, 'quarantined'); assert.ok(body.reasons[0].startsWith('sensitive:'))
    const row = (await q('SELECT embedding IS NULL AS no_emb, quarantine_expires_at IS NOT NULL AS has_exp FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, body.memory_id])).rows[0]
    assert.equal(row.no_emb, true); assert.equal(row.has_exp, true)
    console.log('PASS 7 quarantined: no embedding, expiry set')
  })

  // 8. rejected：原始超长（含空白填充绕过复现）-> isError、memories 零落行、claim 留档
  await withClient(AUTH, async (c) => {
    const ep8 = ep(), r8 = rid()
    const { isError, body } = await call(c, { content: ' '.repeat(9000) + 'x', episode_id: ep8, request_id: r8 })
    assert.equal(isError, true); assert.equal(body.admission, 'rejected')
    assert.equal(body.reasons[0], 'content_too_large_raw', 'whitespace padding cannot bypass raw size gate')
    const mems = (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id=$2', [TENANT, ep8])).rows[0].n
    assert.equal(mems, 0, 'rejected: zero memory rows')
    const claim = (await q('SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, r8])).rows[0].n
    assert.equal(claim, 1, 'rejected still claims idempotency (replay-safe)')
    console.log('PASS 8 rejected: zero memory rows, claim recorded, padding bypass dead')
  })

  console.log('ALL P0-03 REMEMBER ASSERTIONS PASSED')
} catch (e) {
  primaryError = e
} finally {
  // 精确清理：DELETE 失败或任一表残留非零都必须令测试失败（保留原始失败为 primary）
  const cleanupErrors = []
  const eps = [...createdEpisodes], rids = [...createdRequestIds]
  try {
    if (eps.length) await q(`DELETE FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)`, [TENANT, eps])
    if (rids.length) await q(`DELETE FROM tool_requests WHERE tenant_id=$1 AND tool_name='remember' AND request_id = ANY($2)`, [TENANT, rids])
    const memLeft = eps.length ? (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, eps])).rows[0].n : 0
    const reqLeft = rids.length ? (await q('SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, rids])).rows[0].n : 0
    if (memLeft !== 0 || reqLeft !== 0) cleanupErrors.push(new Error(`residual rows: memories=${memLeft} tool_requests=${reqLeft}`))
    else console.log('cleanup done (residual: memories=0, tool_requests=0)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) {
    if (primaryError) throw new AggregateError([primaryError, ...cleanupErrors], 'test failed AND cleanup failed')
    throw new AggregateError(cleanupErrors, 'cleanup failed')
  }
  if (primaryError) throw primaryError
}
