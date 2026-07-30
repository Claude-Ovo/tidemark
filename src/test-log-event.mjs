// P0-05 前置：log_event 验收。node --env-file=.env src/test-log-event.mjs（先起 server，EMBED_PROVIDER=stub）
// 场景：无auth/必填与枚举/happy path落台账/幂等重放+异payload拒/payload超限拒/
//       memory_used 全套 server 校验（缺字段/receipt越权/attempt不匹配/item不存在/未注入/合法通过）
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { connectWithRetry, withDatabase, isRetryableDatabaseError, sleep } from '../migrations/db.mjs'

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
  const c = new Client({ name: 'p005a-test', version: '0.1.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }))
  try { return await fn(c) } finally { await c.close().catch(() => {}) }
}
const call = async (c, name, args) => {
  try {
    const r = await c.callTool({ name, arguments: args })
    try { return { isError: r.isError === true, body: JSON.parse(r.content[0].text) } }
    catch { return { isError: true, body: { ok: false, error: 'non_json' } } }
  } catch (e) { return { isError: true, body: { ok: false, error: 'protocol_validation', raw: e.message?.slice(0, 120) } } }
}
const AUTH1 = { 'x-tidemark-auth': 'spike-demo-key' }
const AUTH2 = { 'x-tidemark-auth': 'spike-second-key' }
const TENANT = 'demo-tenant'
const suite = 'p005a-' + randomUUID().slice(0, 8)
const eps = new Set(), rids = new Set(), attempts = new Set()
const ep = () => { const e = `${suite}-ep-` + randomUUID().slice(0, 6); eps.add(e); return e }
const rid = () => { const r = randomUUID(); rids.add(r); return r }
const att = () => { const a = `${suite}-att-` + randomUUID().slice(0, 6); attempts.add(a); return a }
const base = () => ({ episode_id: ep(), task_instance_id: suite + '-task', attempt_id: att(), request_id: rid() })

let primaryError = null
try {
  // 1. 无 auth
  await withClient({}, async (c) => {
    const { isError, body } = await call(c, 'log_event', { ...base(), event_type: 'note' })
    assert.equal(isError, true); assert.equal(body.error, 'unauthorized')
    console.log('PASS 1 unauthorized')
  })

  // 2. 枚举校验（协议层拦非法 event_type）
  await withClient(AUTH1, async (c) => {
    const bad = await call(c, 'log_event', { ...base(), event_type: 'made_up_type' })
    assert.equal(bad.isError, true, 'invalid event_type rejected')
    console.log('PASS 2 event_type enum enforced')
  })

  // 3. happy path：note 落台账，行字段核验
  let noteArgs
  await withClient(AUTH1, async (c) => {
    noteArgs = { ...base(), event_type: 'note', tool_name: 'unit', payload: { detail: 'hello ledger' } }
    const { body } = await call(c, 'log_event', noteArgs)
    assert.equal(body.ok, true); assert.ok(body.event_id)
    const row = (await q('SELECT event_type, tool_name, payload, agent_id FROM attempt_events WHERE tenant_id=$1 AND attempt_id=$2 AND event_id=$3',
      [TENANT, noteArgs.attempt_id, body.event_id])).rows[0]
    assert.ok(row && row.event_type === 'note' && row.tool_name === 'unit' && row.payload.detail === 'hello ledger' && row.agent_id === 'demo-agent')
    console.log('PASS 3 note event lands in ledger')
  })

  // 4. 幂等重放 + 同 key 异 payload 拒
  await withClient(AUTH1, async (c) => {
    const first = await call(c, 'log_event', noteArgs)
    const again = await call(c, 'log_event', noteArgs)
    assert.equal(again.body.event_id, first.body.event_id, 'replay returns same event_id')
    const n = (await q('SELECT count(*)::INT4 AS n FROM attempt_events WHERE tenant_id=$1 AND attempt_id=$2', [TENANT, noteArgs.attempt_id])).rows[0].n
    assert.equal(n, 1, 'exactly one ledger row')
    const diff = await call(c, 'log_event', { ...noteArgs, payload: { detail: 'MUTATED' } })
    assert.equal(diff.body.error, 'idempotency_key_reused')
    console.log('PASS 4 idempotent replay + key reuse rejected')
  })

  // 5. payload 超限拒
  await withClient(AUTH1, async (c) => {
    const { isError, body } = await call(c, 'log_event', { ...base(), event_type: 'note', payload: { blob: 'x'.repeat(5000) } })
    assert.equal(isError, true); assert.equal(body.error, 'payload_too_large')
    console.log('PASS 5 payload size gate')
  })

  // 6. memory_used 全套校验：先造一张真 receipt
  {
    const attemptId = att(), episode = ep()
    let receiptItem, recallRequestId
    await withClient(AUTH1, async (c) => {
      const CONTENT = 'ledger probe ' + suite
      const rem = await call(c, 'remember', { content: CONTENT, episode_id: episode, request_id: rid() })
      assert.equal(rem.body.ok, true)
      recallRequestId = rid()
      const rec = await call(c, 'recall', { query: CONTENT, purpose: 'unit', episode_id: episode, attempt_id: attemptId, request_id: recallRequestId })
      assert.equal(rec.body.ok, true)
      receiptItem = rec.body.receipt.items.find(i => i.injected)
      assert.ok(receiptItem, 'have an injected item to cite')
    })
    const goodPayload = { recall_request_id: recallRequestId, receipt_item_id: receiptItem.receipt_item_id, memory_id: receiptItem.memory_id }

    await withClient(AUTH1, async (c) => {
      // 6a 缺字段
      const missing = await call(c, 'log_event', { episode_id: episode, task_instance_id: suite + '-task', attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: { recall_request_id: recallRequestId } })
      assert.ok(missing.body.error.startsWith('memory_used_payload_missing'), 'missing triple rejected')
      // 6b attempt 不匹配
      const wrongAttempt = await call(c, 'log_event', { episode_id: episode, task_instance_id: suite + '-task', attempt_id: att(), request_id: rid(), event_type: 'memory_used', payload: goodPayload })
      assert.equal(wrongAttempt.body.error, 'memory_used_attempt_mismatch')
      // 6c item 不存在
      const wrongItem = await call(c, 'log_event', { episode_id: episode, task_instance_id: suite + '-task', attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: { ...goodPayload, receipt_item_id: randomUUID() } })
      assert.equal(wrongItem.body.error, 'memory_used_item_mismatch')
      // 6d 合法通过
      const good = await call(c, 'log_event', { episode_id: episode, task_instance_id: suite + '-task', attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: goodPayload })
      assert.equal(good.body.ok, true, `valid memory_used accepted: ${JSON.stringify(good.body)}`)
      console.log('PASS 6 memory_used server validation (missing/attempt/item/valid)')
    })
    // 6e 越权：second-agent 引用 demo-agent 的 receipt
    await withClient(AUTH2, async (c) => {
      const stolen = await call(c, 'log_event', { episode_id: episode, task_instance_id: suite + '-task', attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: goodPayload })
      assert.equal(stolen.body.error, 'memory_used_receipt_not_found_in_scope', 'cross-agent receipt citation rejected')
      console.log('PASS 6e cross-agent memory_used rejected')
    })
  }

  console.log('ALL P0-05A LOG_EVENT ASSERTIONS PASSED')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    const E = [...eps], R = [...rids], A = [...attempts]
    if (E.length) { await q('DELETE FROM recall_requests WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E]); await q('DELETE FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E]) }
    if (A.length) await q('DELETE FROM attempt_events WHERE tenant_id=$1 AND attempt_id = ANY($2)', [TENANT, A])
    if (R.length) await q('DELETE FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])
    const ae = A.length ? (await q('SELECT count(*)::INT4 AS n FROM attempt_events WHERE tenant_id=$1 AND attempt_id = ANY($2)', [TENANT, A])).rows[0].n : 0
    const tr = R.length ? (await q('SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])).rows[0].n : 0
    const mm = E.length ? (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E])).rows[0].n : 0
    if (ae || tr || mm) cleanupErrors.push(new Error(`residual: attempt_events=${ae} tool_requests=${tr} memories=${mm}`))
    else console.log('cleanup done (residual: attempt_events=0, tool_requests=0, memories=0)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
