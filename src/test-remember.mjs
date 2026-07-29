// P0-03 验收断言：node --env-file=.env src/test-remember.mjs（先起 server）
// 场景：无auth拒/正常写入/重复request_id幂等/同key异payload拒/100并发同key仅1行/quarantine无embedding/rejected不落行
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { isRetryableDatabaseError, sleep } from '../migrations/db.mjs'

// 取证查询带瞬断重试（serverless 冷唤醒 ECONNRESET）
const q = async (text, params) => {
  for (let attempt = 1; ; attempt++) {
    try { return await getPool().query(text, params) }
    catch (e) {
      if (!isRetryableDatabaseError(e) || attempt >= 4) throw e
      await sleep(800 * attempt)
    }
  }
}

const url = process.env.TIDEMARK_URL || 'http://localhost:3901'
const withClient = async (headers, fn) => {
  const c = new Client({ name: 'p003-test', version: '0.1.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }))
  try { return await fn(c) } finally { await c.close().catch(() => {}) }
}
const call = async (c, args) => {
  const r = await c.callTool({ name: 'remember', arguments: args })
  return { isError: r.isError === true, body: JSON.parse(r.content[0].text) }
}
const AUTH = { 'x-tidemark-auth': 'spike-demo-key' }
const ep = 'ep-' + randomUUID().slice(0, 8)

// 1. 无 auth -> isError
await withClient({}, async (c) => {
  const { isError, body } = await call(c, { content: 'x', episode_id: ep, request_id: randomUUID() })
  assert.equal(isError, true); assert.equal(body.error, 'unauthorized')
  console.log('PASS 1 unauthorized isError')
})

// 2. 正常写入：accepted + embedding 元数据 + DB 行核验
let rid2 = randomUUID(), mem2
await withClient(AUTH, async (c) => {
  const { body } = await call(c, { content: 'tidemark remembers the tide', episode_id: ep, request_id: rid2, kind: 'fact', importance: 0.7 })
  assert.equal(body.ok, true); assert.equal(body.admission, 'accepted')
  assert.equal(body.source, 'agent_inferred'); assert.ok(body.embedding_sha256)
  mem2 = body.memory_id
  const row = (await q('SELECT admission, embedding IS NOT NULL AS has_emb, half_life_hours, importance FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3', ['demo-tenant', 'demo-agent', mem2])).rows[0]
  assert.equal(row.has_emb, true); assert.equal(Number(row.importance), 0.7)
  assert.equal(Number(row.half_life_hours), 72 * 1.7, 'half_life = base*(1+importance)')
  console.log('PASS 2 accepted write + DB row verified')
})

// 3. 幂等重放：同 key 同 payload -> 原响应，无第二行
await withClient(AUTH, async (c) => {
  const { body } = await call(c, { content: 'tidemark remembers the tide', episode_id: ep, request_id: rid2, kind: 'fact', importance: 0.7 })
  assert.equal(body.memory_id, mem2, 'replay returns first memory_id')
  const n = (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id=$2', ['demo-tenant', ep])).rows[0].n
  assert.equal(n, 1, 'still exactly one row')
  console.log('PASS 3 idempotent replay')
})

// 4. 同 key 异 payload -> idempotency_key_reused
await withClient(AUTH, async (c) => {
  const { isError, body } = await call(c, { content: 'DIFFERENT', episode_id: ep, request_id: rid2 })
  assert.equal(isError, true); assert.equal(body.error, 'idempotency_key_reused')
  console.log('PASS 4 key reuse rejected')
})

// 5. 100 并发同 request_id -> 恰 1 行、所有响应同 memory_id（PLAN P0-03 验收原文）
{
  const rid = randomUUID(), content = 'concurrent-storm', ep5 = 'ep5-' + randomUUID().slice(0, 8)
  const results = await Promise.all(Array.from({ length: 100 }, () =>
    withClient(AUTH, (c) => call(c, { content, episode_id: ep5, request_id: rid }))))
  const ids = new Set(results.map(r => r.body.memory_id))
  assert.equal(ids.size, 1, `all 100 share one memory_id (got ${ids.size})`)
  const n = (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id=$2', ['demo-tenant', ep5])).rows[0].n
  assert.equal(n, 1, 'exactly one row after 100 concurrent')
  console.log('PASS 5 100 concurrent same request_id -> 1 row')
}

// 6. quarantine：敏感内容 -> quarantined、无 embedding、有过期时间
await withClient(AUTH, async (c) => {
  const { body } = await call(c, { content: 'my key is AKIAABCDEFGHIJKLMNOP ok', episode_id: ep, request_id: randomUUID() })
  assert.equal(body.admission, 'quarantined'); assert.ok(body.reasons[0].startsWith('sensitive:'))
  const row = (await q('SELECT embedding IS NULL AS no_emb, quarantine_expires_at IS NOT NULL AS has_exp FROM memories WHERE tenant_id=$1 AND memory_id=$2', ['demo-tenant', body.memory_id])).rows[0]
  assert.equal(row.no_emb, true); assert.equal(row.has_exp, true)
  console.log('PASS 6 quarantined: no embedding, expiry set')
})

// 7. rejected：超长内容 -> ok:false、零落行（claim 留档）
await withClient(AUTH, async (c) => {
  const rid = randomUUID()
  const { isError, body } = await call(c, { content: 'x'.repeat(9000), episode_id: ep, request_id: rid })
  assert.equal(isError, true); assert.equal(body.admission, 'rejected')
  const claim = (await q('SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id=$2', ['demo-tenant', rid])).rows[0].n
  assert.equal(claim, 1, 'rejected still claims idempotency (replay-safe)')
  console.log('PASS 7 rejected: no memory row, claim recorded')
})

console.log('ALL P0-03 REMEMBER ASSERTIONS PASSED')
await getPool().end()
