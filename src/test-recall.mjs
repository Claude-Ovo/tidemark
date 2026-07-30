// P0-04 recall 验收：node --env-file=.env src/test-recall.mjs（先起 server，EMBED_PROVIDER=stub）
// stub embedding 由内容哈希驱动：同文本=同向量（similarity=1），异文本=互不相关——检索语义可确定性断言
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { connectWithRetry, withDatabase, isRetryableDatabaseError, sleep } from '../migrations/db.mjs'
import { canonicalJson } from './lib/canonical-json.mjs'

let forensic = null
const q = async (text, params) => {
  const cs = withDatabase(process.env.COCKROACH_DATABASE_URL, process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  for (let attempt = 1; ; attempt++) {
    try { forensic ??= await connectWithRetry(cs, { label: 'forensic' }); return await forensic.query(text, params) }
    catch (e) { await forensic?.end().catch(() => {}); forensic = null; if (!isRetryableDatabaseError(e) || attempt >= 5) throw e; await sleep(800 * attempt) }
  }
}
const url = process.env.TIDEMARK_URL || 'http://localhost:3901'
const withClient = async (headers, fn) => {
  const c = new Client({ name: 'p004-test', version: '0.1.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }))
  try { return await fn(c) } finally { await c.close().catch(() => {}) }
}
const call = async (c, name, args) => {
  try {
    const r = await c.callTool({ name, arguments: args })
    const text = r.content[0].text
    try { return { isError: r.isError === true, body: JSON.parse(text) } }
    catch { return { isError: true, body: { ok: false, error: 'non_json', raw: text.slice(0, 120) } } }
  } catch (e) {
    // zod/协议层校验拒绝（如缺 attempt_id）也是合法的错误路径
    return { isError: true, body: { ok: false, error: 'protocol_validation', raw: e.message?.slice(0, 120) } }
  }
}
const AUTH = { 'x-tidemark-auth': 'spike-demo-key' }
const TENANT = 'demo-tenant', AGENT = 'demo-agent'
const suite = 'p004-' + randomUUID().slice(0, 8)
const createdEpisodes = new Set(), createdRequestIds = new Set(), directMemoryIds = []
const ep = () => { const e = `${suite}-ep-` + randomUUID().slice(0, 6); createdEpisodes.add(e); return e }
const rid = () => { const r = randomUUID(); createdRequestIds.add(r); return r }

let primaryError = null
try {
  // 种子：三条事件记忆（经真实 remember 落库，stub embedding 确定性）
  const seedEp = ep()
  const seeds = {}
  await withClient(AUTH, async (c) => {
    for (const [key, content, importance] of [
      ['tide', 'the tide leaves a mark on the shore', 0.5],
      ['coffee', 'she prefers oat milk in her coffee', 0.5],
      ['anchor', 'the anchor holds the ship in the storm', 0.9],   // 高重要度（第二路候选资格）
    ]) {
      // 冷唤醒风暴偶发耗尽服务端重试——种子期容错一次（同 request_id 重放，幂等保证不双写）
      let res = await call(c, 'remember', { content, episode_id: seedEp, request_id: (seeds[key + '_rid'] = rid()), importance })
      if (!res.body.ok) { await sleep(3000); res = await call(c, 'remember', { content, episode_id: seedEp, request_id: seeds[key + '_rid'], importance }) }
      assert.equal(res.body.ok, true, `seed ${key}: ${JSON.stringify(res.body)}`)
      seeds[key] = res.body.memory_id
    }
  })

  // 1. 无 auth -> isError
  await withClient({}, async (c) => {
    const { isError, body } = await call(c, 'recall', { query: 'x', episode_id: ep(), attempt_id: 'a1', request_id: rid() })
    assert.equal(isError, true); assert.equal(body.error, 'unauthorized')
    console.log('PASS 1 unauthorized isError')
  })

  // 2. attempt_id 必填（冻结 P0-D）
  await withClient(AUTH, async (c) => {
    const { isError, body } = await call(c, 'recall', { query: 'x', episode_id: ep(), request_id: rid() })
    assert.equal(isError, true, 'missing attempt_id must be error')
    console.log('PASS 2 attempt_id required')
  })

  // 3. 语义命中：同文本查询 -> top1 即目标记忆，similarity=1，receipt 字段完备且落库带 checksum
  let receiptRequestId
  await withClient(AUTH, async (c) => {
    receiptRequestId = rid()
    const { body } = await call(c, 'recall', { query: 'the tide leaves a mark on the shore', episode_id: ep(), attempt_id: 'a3', request_id: receiptRequestId })
    assert.equal(body.ok, true)
    const items = body.receipt.items
    assert.ok(items.length >= 1, 'has candidates')
    assert.equal(items[0].memory_id, seeds.tide, 'top1 is the semantically identical memory')
    assert.ok(items[0].similarity > 0.999, 'identical stub embedding -> similarity ~1')
    assert.ok(items[0].injected, 'top1 injected')
    for (const f of ['receipt_item_id', 'raw_cosine_distance', 'effective_strength', 'utility', 'importance', 'final_score', 'reason', 'rank']) {
      assert.ok(items[0][f] !== undefined, `receipt item has ${f}`)
    }
    assert.ok(body.injected.events.some(e2 => e2.memory_id === seeds.tide), 'injected payload contains content')
    const row = (await q('SELECT receipt_json, serialization_checksum, outcome_state FROM recall_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, receiptRequestId])).rows[0]
    assert.ok(row, 'receipt persisted')
    assert.equal(row.outcome_state, 'unreported')
    const recomputed = createHash('sha256').update(canonicalJson(row.receipt_json.receipt)).digest()
    assert.ok(recomputed.equals(row.serialization_checksum), 'stored checksum matches recomputed over stored receipt')
    console.log('PASS 3 semantic hit + full receipt persisted + checksum verified')
  })

  // 4. 幂等重放：同 request_id 同 query -> replay 返回同一 receipt；异 query -> idempotency_key_reused
  await withClient(AUTH, async (c) => {
    const { body } = await call(c, 'recall', { query: 'the tide leaves a mark on the shore', episode_id: ep(), attempt_id: 'a4', request_id: receiptRequestId })
    assert.equal(body.replay, true, 'replay flag')
    const n = (await q('SELECT count(*)::INT4 AS n FROM recall_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, receiptRequestId])).rows[0].n
    assert.equal(n, 1, 'still one receipt row')
    const { isError, body: b2 } = await call(c, 'recall', { query: 'DIFFERENT QUERY', episode_id: ep(), attempt_id: 'a4', request_id: receiptRequestId })
    assert.equal(isError, true); assert.equal(b2.error, 'idempotency_key_reused')
    console.log('PASS 4 idempotent replay + key reuse rejected')
  })

  // 5. 无关查询：低相似候选被 gate 拦截，但高重要度记忆可走第二路（floor 0.35）——只断言"tide/coffee 不得出现"
  await withClient(AUTH, async (c) => {
    const { body } = await call(c, 'recall', { query: 'completely unrelated topic zebra quantum', episode_id: ep(), attempt_id: 'a5', request_id: rid() })
    assert.equal(body.ok, true)
    const ids = body.receipt.items.map(i => i.memory_id)
    assert.ok(!ids.includes(seeds.tide) && !ids.includes(seeds.coffee), 'ordinary memories blocked by semantic gate (0.55)')
    for (const it of body.receipt.items) {
      assert.ok(it.reason.includes('pinned_path') || it.reason.includes('high_importance_path'), 'survivors only via second path')
      assert.ok(it.similarity >= 0.35, 'second path floor enforced')
    }
    console.log(`PASS 5 semantic gate blocks unrelated (second-path survivors: ${ids.length})`)
  })

  // 6. faded/quarantined 排除：直插一条 faded 同文本记忆，recall 不得返回它
  {
    const fadedId = randomUUID()
    directMemoryIds.push(fadedId)
    const emb = (await q('SELECT embedding::STRING AS e FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, seeds.tide])).rows[0].e
    await q(`INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, source, admission, state, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours)
             VALUES ($1,$2,$3,'event',$4,'the tide leaves a mark on the shore',$5,'agent_inferred','accepted','faded',0.5,1.0,now(),now(),72)`,
      [TENANT, AGENT, fadedId, seedEp, emb])
    await withClient(AUTH, async (c) => {
      const { body } = await call(c, 'recall', { query: 'the tide leaves a mark on the shore', episode_id: ep(), attempt_id: 'a6', request_id: rid() })
      assert.ok(!body.receipt.items.some(i => i.memory_id === fadedId), 'faded memory excluded from candidates')
      console.log('PASS 6 faded excluded')
    })
  }

  // 7. recall 不改 memory 行（outcome-gated：无 reinforce）
  {
    const before = (await q('SELECT strength_anchor, strength_anchor_at, last_rewarded_at, revision FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, seeds.tide])).rows[0]
    await withClient(AUTH, async (c) => {
      await call(c, 'recall', { query: 'the tide leaves a mark on the shore', episode_id: ep(), attempt_id: 'a7', request_id: rid() })
    })
    const after = (await q('SELECT strength_anchor, strength_anchor_at, last_rewarded_at, revision FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, seeds.tide])).rows[0]
    assert.deepEqual(after, before, 'recall must not mutate memory rows')
    console.log('PASS 7 recall leaves memory rows untouched (outcome-gated)')
  }

  console.log('ALL P0-04 RECALL ASSERTIONS PASSED')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    const eps = [...createdEpisodes], rids = [...createdRequestIds]
    if (eps.length) await q('DELETE FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND episode_id = ANY($3)', [TENANT, AGENT, eps])
    if (directMemoryIds.length) await q('DELETE FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND memory_id = ANY($3)', [TENANT, AGENT, directMemoryIds])
    if (rids.length) {
      await q(`DELETE FROM tool_requests WHERE tenant_id=$1 AND agent_id=$2 AND request_id = ANY($3)`, [TENANT, AGENT, rids])
      await q(`DELETE FROM recall_requests WHERE tenant_id=$1 AND agent_id=$2 AND request_id = ANY($3)`, [TENANT, AGENT, rids])
    }
    const mem = eps.length ? (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, eps])).rows[0].n : 0
    const tr = rids.length ? (await q('SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, rids])).rows[0].n : 0
    const rr = rids.length ? (await q('SELECT count(*)::INT4 AS n FROM recall_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, rids])).rows[0].n : 0
    if (mem !== 0 || tr !== 0 || rr !== 0) cleanupErrors.push(new Error(`residual: memories=${mem} tool_requests=${tr} recall_requests=${rr}`))
    else console.log('cleanup done (residual: memories=0, tool_requests=0, recall_requests=0)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
