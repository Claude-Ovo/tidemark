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

  // 3. 枚举化白名单：slug 马甲哨兵在每个语义字符串字段都必须被拒；合法失败轨迹完整可表达
  const SENTINEL = 'sentinel-pw-' + randomUUID().slice(0, 8)   // slug 合法形态的短正文（Codex 二审复现形态）
  let evArgs
  await withClient(AUTH1, async (c) => {
    // 3a 未知键仍拒
    const unknown = await call(c, 'log_event', { ...base(), event_type: 'note', payload: { detail: SENTINEL } })
    assert.ok(unknown.body.error.startsWith('payload_key_not_allowed'))
    // 3b slug 马甲哨兵逐字段轰炸：每个语义字符串字段都必须拒收
    const smuggle = [
      ['note', { ref: SENTINEL }, 'payload_value_invalid:ref'],                          // ref 必须 uuid
      ['tool_error', { error_type: SENTINEL, trace_id: randomUUID() }, 'payload_value_invalid:error_type'],
      ['user_correction', { correction_type: SENTINEL }, 'payload_value_invalid:correction_type'],
      ['attempt_end', { status: SENTINEL }, 'payload_value_invalid:status'],
      ['tool_call', { args_digest: SENTINEL }, 'payload_value_invalid:args_digest'],
    ]
    for (const [type, payload, want] of smuggle) {
      const r = await call(c, 'log_event', { ...base(), event_type: type, tool_name: type === 'tool_error' ? 'unit-tool' : undefined, payload })
      assert.equal(r.body.error, want, `${type} semantic field must reject slug-shaped sentinel (got ${r.body.error})`)
    }
    // 3c 冻结结论 4 的完整失败轨迹：start(空) -> tool_error(全字段) -> attempt_end(status)
    const traj = base()
    const s1 = await call(c, 'log_event', { ...traj, request_id: rid(), event_type: 'attempt_start' })
    assert.equal(s1.body.ok, true)
    evArgs = { ...traj, request_id: rid(), event_type: 'tool_error', tool_name: 'unit-tool',
      payload: { error_type: 'timeout', trace_id: randomUUID(), duration_ms: 1200, exit_code: 1 } }
    const s2 = await call(c, 'log_event', evArgs)
    assert.equal(s2.body.ok, true)
    const s3 = await call(c, 'log_event', { ...traj, request_id: rid(), event_type: 'attempt_end', payload: { status: 'failure' } })
    assert.equal(s3.body.ok, true)
    const row = (await q('SELECT event_type, tool_name, payload FROM attempt_events WHERE tenant_id=$1 AND attempt_id=$2 AND event_id=$3',
      [TENANT, evArgs.attempt_id, s2.body.event_id])).rows[0]
    assert.ok(row.payload.error_type === 'timeout' && row.payload.trace_id && row.tool_name === 'unit-tool')
    // 3d 冻结字段逐项缺失负例
    const missing = [
      [{ ...traj, request_id: rid(), event_type: 'tool_error', payload: { error_type: 'timeout', trace_id: randomUUID() } }, 'tool_error_tool_name_required'],
      [{ ...traj, request_id: rid(), event_type: 'tool_error', tool_name: 'unit-tool', payload: { trace_id: randomUUID() } }, 'tool_error_payload_missing_error_type'],
      [{ ...traj, request_id: rid(), event_type: 'tool_error', tool_name: 'unit-tool', payload: { error_type: 'timeout' } }, 'tool_error_payload_missing_trace_id'],
      [{ ...traj, request_id: rid(), event_type: 'attempt_end' }, 'attempt_end_payload_required'],
      [{ ...traj, request_id: rid(), event_type: 'attempt_end', payload: {} }, 'attempt_end_payload_missing_status'],
    ]
    for (const [args, want] of missing) {
      const r = await call(c, 'log_event', args)
      assert.equal(r.body.error, want, `expected ${want}, got ${r.body.error}`)
    }
    console.log('PASS 3 enum allowlist: slug sentinel dead in every semantic field + frozen failure fields enforced')
  })

  // 4. 幂等重放 + 同 key 异 payload 拒
  await withClient(AUTH1, async (c) => {
    const before = (await q('SELECT count(*)::INT4 AS n FROM attempt_events WHERE tenant_id=$1 AND attempt_id=$2', [TENANT, evArgs.attempt_id])).rows[0].n
    const first = await call(c, 'log_event', evArgs)
    const again = await call(c, 'log_event', evArgs)
    assert.equal(again.body.event_id, first.body.event_id, 'replay returns same event_id')
    const after = (await q('SELECT count(*)::INT4 AS n FROM attempt_events WHERE tenant_id=$1 AND attempt_id=$2', [TENANT, evArgs.attempt_id])).rows[0].n
    assert.equal(after, before, 'replay adds zero rows')
    const own = (await q('SELECT count(*)::INT4 AS n FROM attempt_events WHERE tenant_id=$1 AND attempt_id=$2 AND event_id=$3', [TENANT, evArgs.attempt_id, first.body.event_id])).rows[0].n
    assert.equal(own, 1, 'the event itself is exactly one row')
    const diff = await call(c, 'log_event', { ...evArgs, payload: { ...evArgs.payload, error_type: 'crash' } })
    assert.equal(diff.body.error, 'idempotency_key_reused', `schema-valid but different payload must hit idempotency guard (got ${diff.body.error})`)
    console.log('PASS 4 idempotent replay + key reuse rejected')
  })

  // 5. 20 并发同 request_id：同一 event_id、两表各恰一行（SPEC §9）
  {
    const args = { ...base(), event_type: 'note', payload: { ref: randomUUID() } }
    const results = await Promise.all(Array.from({ length: 20 }, () => withClient(AUTH1, (c) => call(c, 'log_event', args))))
    results.forEach((r, i) => assert.equal(r.body.ok, true, `concurrent ${i}: ${JSON.stringify(r.body).slice(0, 120)}`))
    assert.equal(new Set(results.map(r => r.body.event_id)).size, 1, 'all share one event_id')
    const ae = (await q('SELECT count(*)::INT4 AS n FROM attempt_events WHERE tenant_id=$1 AND attempt_id=$2', [TENANT, args.attempt_id])).rows[0].n
    const tr = (await q('SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, args.request_id])).rows[0].n
    assert.equal(ae, 1, 'one ledger row'); assert.equal(tr, 1, 'one claim row')
    console.log('PASS 5 20 concurrent same request_id -> one event, one claim')
  }

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
      const mk = (over) => ({ episode_id: episode, task_instance_id: suite + '-task', attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: goodPayload, ...over })
      // 6a 缺字段
      const missing = await call(c, 'log_event', mk({ payload: { recall_request_id: recallRequestId } }))
      assert.ok(missing.body.error.startsWith('memory_used_payload_missing'), 'missing triple rejected')
      // 6b 额外字段（P0：memory_used 精确三元组，extra key 必拒）
      const extra = await call(c, 'log_event', mk({ payload: { ...goodPayload, smuggled: SENTINEL } }))
      assert.ok(extra.body.error.startsWith('payload_key_not_allowed'), 'extra key on memory_used rejected')
      // 6c attempt 不匹配
      const wrongAttempt = await call(c, 'log_event', mk({ attempt_id: att() }))
      assert.equal(wrongAttempt.body.error, 'memory_used_attempt_mismatch')
      // 6d episode 不匹配（P1：episode 有真值必须核对）
      const wrongEpisode = await call(c, 'log_event', mk({ episode_id: ep() }))
      assert.equal(wrongEpisode.body.error, 'memory_used_episode_mismatch')
      // 6e item 不存在
      const wrongItem = await call(c, 'log_event', mk({ payload: { ...goodPayload, receipt_item_id: randomUUID() } }))
      assert.equal(wrongItem.body.error, 'memory_used_item_mismatch')
      // 6f 三元组内 memory_id 与 item 不符
      const wrongMemory = await call(c, 'log_event', mk({ payload: { ...goodPayload, memory_id: randomUUID() } }))
      assert.equal(wrongMemory.body.error, 'memory_used_item_mismatch', 'memory_id mismatch rejected independently')
      // 6g 合法通过
      const good = await call(c, 'log_event', mk({}))
      assert.equal(good.body.ok, true, `valid memory_used accepted: ${JSON.stringify(good.body)}`)
      console.log('PASS 6 memory_used validation (missing/extra/attempt/episode/item/memory_id/valid)')
    })
    // 6h 越权：second-agent 引用 demo-agent 的 receipt
    await withClient(AUTH2, async (c) => {
      const stolen = await call(c, 'log_event', { episode_id: episode, task_instance_id: suite + '-task', attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: goodPayload })
      assert.equal(stolen.body.error, 'memory_used_receipt_not_found_in_scope', 'cross-agent receipt citation rejected')
      console.log('PASS 6h cross-agent memory_used rejected')
    })
  }

  // 7. injected=false 拒绝：token_budget=1 产出零注入 receipt，引用其 item 必拒
  {
    const attemptId = att(), episode = ep()
    await withClient(AUTH1, async (c) => {
      const CONTENT = 'uninjected probe ' + suite
      const rem = await call(c, 'remember', { content: CONTENT, episode_id: episode, request_id: rid() })
      assert.equal(rem.body.ok, true)
      const rrId = rid()
      const rec = await call(c, 'recall', { query: CONTENT, purpose: 'unit', episode_id: episode, attempt_id: attemptId, request_id: rrId, token_budget: 1 })
      assert.equal(rec.body.ok, true)
      const item = rec.body.receipt.items.find(i => i.memory_id === rem.body.memory_id)
      assert.ok(item && item.injected === false, 'token_budget=1 yields candidate without injection')
      const cite = await call(c, 'log_event', { episode_id: episode, task_instance_id: suite + '-task', attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: { recall_request_id: rrId, receipt_item_id: item.receipt_item_id, memory_id: item.memory_id } })
      assert.equal(cite.body.error, 'memory_used_item_not_injected', 'citing uninjected item rejected')
      console.log('PASS 7 uninjected item cannot be cited as evidence')
    })
  }

  // 8. 哨兵全库回归（P0）：删除记忆后，attempt_events 任何 payload 不得含哨兵
  {
    await q('DELETE FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, [...eps]])
    const hit = (await q(`SELECT count(*)::INT4 AS n FROM attempt_events WHERE tenant_id=$1 AND payload::STRING LIKE '%' || $2 || '%'`, [TENANT, SENTINEL])).rows[0].n
    assert.equal(hit, 0, 'no sentinel content survives anywhere in the ledger after memory deletion')
    console.log('PASS 8 sentinel regression: ledger holds zero memory content post-delete')
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
    const rr2 = E.length ? (await q('SELECT count(*)::INT4 AS n FROM recall_requests WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E])).rows[0].n : 0
    if (ae || tr || mm || rr2) cleanupErrors.push(new Error(`residual: attempt_events=${ae} tool_requests=${tr} memories=${mm} recall_requests=${rr2}`))
    else console.log('cleanup done (residual: attempt_events=0, tool_requests=0, memories=0, recall_requests=0)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
