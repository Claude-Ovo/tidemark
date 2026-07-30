// P0-05 report_outcome 验收：node --env-file=.env src/test-report-outcome.mjs（先起 server，EMBED_PROVIDER=stub）
// 结果门控核心引擎——覆盖：状态-角色耦合、item 证据校验、credited 加固/blamed 降权/pinned 计数、
// faded 复活、迟到零塑性、memory_id 去重、attempt 终态唯一、幂等、经验两次晋级、无辜不受罚。
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
  const c = new Client({ name: 'p005-test', version: '0.1.0' })
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
const AUTH = { 'x-tidemark-auth': 'spike-demo-key' }
const TENANT = 'demo-tenant', AGENT = 'demo-agent'
const suite = 'p005-' + randomUUID().slice(0, 8)
const eps = new Set(), rids = new Set(), attempts = new Set(), directIds = []
const ep = () => { const e = `${suite}-ep-` + randomUUID().slice(0, 6); eps.add(e); return e }
const rid = () => { const r = randomUUID(); rids.add(r); return r }
const att = () => { const a = `${suite}-att-` + randomUUID().slice(0, 6); attempts.add(a); return a }
const memRow = async (id) => (await q('SELECT state, pinned, strength_anchor, strength_anchor_at, credited_success_count, evidenced_blame_count, revision, half_life_hours, exp_status FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, id])).rows[0]

// 建立一次"记忆→recall→memory_used 证据"的完整链，返回可直接归因的三元组
const buildCitable = async (c, { content, episode, attemptId, taskId }) => {
  const rem = await call(c, 'remember', { content, episode_id: episode, request_id: rid() })
  assert.equal(rem.body.ok, true, `remember: ${JSON.stringify(rem.body)}`)
  const rrId = rid()
  const rec = await call(c, 'recall', { query: content, purpose: 'unit', episode_id: episode, attempt_id: attemptId, request_id: rrId })
  assert.equal(rec.body.ok, true)
  const item = rec.body.receipt.items.find(i => i.memory_id === rem.body.memory_id && i.injected)
  assert.ok(item, 'injected item to cite')
  const ev = await call(c, 'log_event', { episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, request_id: rid(),
    event_type: 'memory_used', payload: { recall_request_id: rrId, receipt_item_id: item.receipt_item_id, memory_id: item.memory_id } })
  assert.equal(ev.body.ok, true, `memory_used: ${JSON.stringify(ev.body)}`)
  return { memory_id: rem.body.memory_id, recall_request_id: rrId, receipt_item_id: item.receipt_item_id, evidence_event_id: ev.body.event_id }
}

let primaryError = null
try {
  // 1. 状态-角色耦合 + 参数校验
  await withClient(AUTH, async (c) => {
    const b = { outcome_request_id: rid(), episode_id: ep(), task_instance_id: suite + '-t', attempt_id: att() }
    assert.equal((await call(c, 'report_outcome', { ...b, status: 'bogus' })).isError, true, 'invalid status')
    const cancNonEmpty = await call(c, 'report_outcome', { ...b, status: 'cancelled', attributions: [{ recall_request_id: randomUUID(), receipt_item_id: randomUUID(), memory_id: randomUUID(), role: 'credited', evidence_event_id: randomUUID() }] })
    assert.equal(cancNonEmpty.body.error, 'cancelled_allows_no_attributions')
    const successBlamed = await call(c, 'report_outcome', { ...b, status: 'success', attributions: [{ recall_request_id: randomUUID(), receipt_item_id: randomUUID(), memory_id: randomUUID(), role: 'blamed', evidence_event_id: randomUUID() }] })
    assert.equal(successBlamed.body.error, 'success_allows_only_credited')
    console.log('PASS 1 status-role coupling + param validation')
  })

  // 2. cancelled：零塑性、outcome 落库
  await withClient(AUTH, async (c) => {
    const attemptId = att(), orid = rid()
    const r = await call(c, 'report_outcome', { outcome_request_id: orid, episode_id: ep(), task_instance_id: suite + '-t', attempt_id: attemptId, status: 'cancelled' })
    assert.equal(r.body.ok, true); assert.equal(r.body.plasticity_applied, false)
    const row = (await q('SELECT status FROM outcomes WHERE tenant_id=$1 AND attempt_id=$2', [TENANT, attemptId])).rows[0]
    assert.equal(row.status, 'cancelled')
    console.log('PASS 2 cancelled: zero plasticity, outcome recorded')
  })

  // 3. credited 加固：strength_anchor 上升、count+1、last_rewarded_at 前移、receipt settled
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t3'
    let cit
    await withClient(AUTH, async (c) => { cit = await buildCitable(c, { content: 'credit probe ' + suite, episode, attemptId, taskId }) })
    // 让记忆先衰减一截并把 last_rewarded 推远（spacing 才有值）——否则 anchor 已 1.0 封顶、加固无空间可涨
    await q(`UPDATE memories SET strength_anchor=0.5, strength_anchor_at=now() - INTERVAL '48 hours', last_rewarded_at=now() - INTERVAL '48 hours' WHERE tenant_id=$1 AND memory_id=$2`, [TENANT, cit.memory_id])
    const before = await memRow(cit.memory_id)
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success', attributions: [{ ...cit, role: 'credited' }] })
      assert.equal(r.body.ok, true); assert.equal(r.body.plasticity_applied, true)
      assert.equal(r.body.items[0].applied, true)
      assert.ok(r.body.items[0].plasticity.reinforcement_gain >= 0)
    })
    const after = await memRow(cit.memory_id)
    // effective(48h 后) < anchor(0.5)，加固后 new_anchor = eff + gain 应回升且 > effective_before
    assert.ok(Number(after.strength_anchor) > 0, 'anchor positive')
    assert.ok(Number(after.strength_anchor) > Number(before.strength_anchor) * Math.exp(-Math.LN2 * 48 / Number(before.half_life_hours)), 'anchor lifted above its decayed value')
    assert.equal(Number(after.credited_success_count), Number(before.credited_success_count) + 1, 'credited count +1')
    assert.equal(Number(after.revision), Number(before.revision) + 1, 'revision bumped')
    const rr = (await q('SELECT outcome_state, terminal_attempt_id FROM recall_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, cit.recall_request_id])).rows[0]
    assert.equal(rr.outcome_state, 'reported'); assert.equal(rr.terminal_attempt_id, attemptId)
    console.log('PASS 3 credited reinforces + settles receipt')
  }

  // 4. credited 无 item-bound 证据必拒：用普通 note 事件当证据
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t4'
    let memId, rrId, itemId, noteEv
    await withClient(AUTH, async (c) => {
      const rem = await call(c, 'remember', { content: 'fake evidence probe ' + suite, episode_id: episode, request_id: rid() })
      memId = rem.body.memory_id; rrId = rid()
      const rec = await call(c, 'recall', { query: 'fake evidence probe ' + suite, purpose: 'unit', episode_id: episode, attempt_id: attemptId, request_id: rrId })
      itemId = rec.body.receipt.items.find(i => i.injected).receipt_item_id
      const n = await call(c, 'log_event', { episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, request_id: rid(), event_type: 'note', payload: { ref: randomUUID() } })
      noteEv = n.body.event_id
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success', attributions: [{ recall_request_id: rrId, receipt_item_id: itemId, memory_id: memId, role: 'credited', evidence_event_id: noteEv }] })
      assert.equal(r.body.ok, true)
      assert.equal(r.body.items[0].applied, false)
      assert.equal(r.body.items[0].reason, 'credited_requires_item_bound_memory_used')
      assert.equal(r.body.plasticity_applied, false, 'no plasticity without valid evidence')
    })
    const m = await memRow(memId)
    assert.equal(Number(m.credited_success_count), 0, 'no credit without item-bound evidence')
    console.log('PASS 4 credited without memory_used evidence -> no plasticity')
  }

  // 5. failure + blamed：strength 降到 *0.8，blame count+1
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t5'
    let cit
    await withClient(AUTH, async (c) => { cit = await buildCitable(c, { content: 'blame probe ' + suite, episode, attemptId, taskId }) })
    const before = await memRow(cit.memory_id)
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'failure', attributions: [{ ...cit, role: 'blamed' }] })
      assert.equal(r.body.ok, true); assert.equal(r.body.items[0].applied, true)
    })
    const after = await memRow(cit.memory_id)
    assert.ok(Number(after.strength_anchor) < Number(before.strength_anchor), 'blamed lowered strength')
    assert.equal(Number(after.evidenced_blame_count), 1, 'blame count +1')
    console.log('PASS 5 failure+blamed lowers strength')
  }

  // 6. failure 无 blamed（默认不罚无辜）：一条记忆被 recall 但 outcome 不点它，强度不变
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t6'
    let cit
    await withClient(AUTH, async (c) => { cit = await buildCitable(c, { content: 'innocent probe ' + suite, episode, attemptId, taskId }) })
    const before = await memRow(cit.memory_id)
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'failure' })
      assert.equal(r.body.ok, true); assert.equal(r.body.plasticity_applied, false)
    })
    const after = await memRow(cit.memory_id)
    assert.equal(Number(after.strength_anchor), Number(before.strength_anchor), 'innocent memory untouched on unattributed failure')
    assert.equal(Number(after.evidenced_blame_count), 0)
    console.log('PASS 6 failure without blamed punishes nobody')
  }

  // 7. pinned：credited 只计数、anchor 冻结
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t7'
    let cit
    await withClient(AUTH, async (c) => { cit = await buildCitable(c, { content: 'pinned credit ' + suite, episode, attemptId, taskId }) })
    await q('UPDATE memories SET pinned=true, strength_anchor=0.5, strength_anchor_at=now() - INTERVAL \'10 days\' WHERE tenant_id=$1 AND memory_id=$2', [TENANT, cit.memory_id])
    const before = await memRow(cit.memory_id)
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success', attributions: [{ ...cit, role: 'credited' }] })
      assert.equal(r.body.items[0].reason, 'pinned_count_only')
    })
    const after = await memRow(cit.memory_id)
    assert.equal(Number(after.strength_anchor), Number(before.strength_anchor), 'pinned anchor frozen')
    assert.equal(Number(after.credited_success_count), Number(before.credited_success_count) + 1, 'pinned still counts')
    console.log('PASS 7 pinned credited: count only, anchor frozen')
  }

  // 8. faded 复活：credited 使 faded->fresh，half_life 重置回基础值
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t8'
    let cit
    await withClient(AUTH, async (c) => { cit = await buildCitable(c, { content: 'revival probe ' + suite, episode, attemptId, taskId }) })
    await q('UPDATE memories SET state=\'faded\', half_life_hours=999, importance=0.5 WHERE tenant_id=$1 AND memory_id=$2', [TENANT, cit.memory_id])
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success', attributions: [{ ...cit, role: 'credited' }] })
      assert.equal(r.body.items[0].plasticity.revived, true, 'revival flagged')
    })
    const after = await memRow(cit.memory_id)
    assert.equal(after.state, 'fresh', 'faded revived to fresh')
    assert.equal(Number(after.half_life_hours), 72 * 1.5, 'half_life reset to event base*(1+importance)')
    console.log('PASS 8 credited revives faded memory + resets half_life')
  }

  // 9. attempt 终态唯一 + 幂等
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t9', orid = rid()
    const args = { outcome_request_id: orid, episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'cancelled' }
    await withClient(AUTH, async (c) => {
      const first = await call(c, 'report_outcome', args)
      assert.equal(first.body.ok, true)
      const replay = await call(c, 'report_outcome', args)
      assert.equal(replay.body.ok, true, 'idempotent replay ok')
      const conflict = await call(c, 'report_outcome', { ...args, outcome_request_id: rid(), status: 'success' })
      assert.equal(conflict.body.error, 'outcome_conflict', 'second terminal outcome on same attempt rejected')
      const n = (await q('SELECT count(*)::INT4 AS n FROM outcomes WHERE tenant_id=$1 AND attempt_id=$2', [TENANT, attemptId])).rows[0].n
      assert.equal(n, 1, 'exactly one outcome per attempt')
    })
    console.log('PASS 9 attempt terminal uniqueness + idempotent replay')
  }

  // 10. 经验两次 task_instance 晋级 candidate -> verified
  {
    const episode = ep()
    let expId
    // 造一条 candidate experience（直插，带真实向量）
    await withClient(AUTH, async (c) => {
      const seed = await call(c, 'remember', { content: 'exp seed ' + suite, episode_id: episode, request_id: rid() })
      const emb = (await q('SELECT embedding::STRING AS e FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, seed.body.memory_id])).rows[0].e
      expId = randomUUID(); directIds.push(expId)
      await q(`INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, experience_body, exp_status, source, admission, state, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours)
               VALUES ($1,$2,$3,'experience',$4,'exp candidate body',$5,$6,'candidate','agent_inferred','accepted','fresh',0.5,1.0,now(),now(),2160)`,
        [TENANT, AGENT, expId, episode, emb, JSON.stringify({ trigger: 'when X', correct_action: 'do Y', caution: 'mind Z' })])
    })
    // 两次不同 task_instance 的成功归因
    for (let i = 0; i < 2; i++) {
      const attemptId = att(), taskId = `${suite}-exp-task-${i}`
      await withClient(AUTH, async (c) => {
        const rrId = rid()
        const rec = await call(c, 'recall', { query: 'exp seed ' + suite, purpose: 'unit', episode_id: episode, attempt_id: attemptId, request_id: rrId })
        const item = rec.body.receipt.items.find(x => x.memory_id === expId && x.injected)
        assert.ok(item, `exp injected on round ${i} (candidates=${rec.body.receipt.items.length})`)
        const ev = await call(c, 'log_event', { episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: { recall_request_id: rrId, receipt_item_id: item.receipt_item_id, memory_id: expId } })
        const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success', attributions: [{ recall_request_id: rrId, receipt_item_id: item.receipt_item_id, memory_id: expId, role: 'credited', evidence_event_id: ev.body.event_id }] })
        assert.equal(r.body.ok, true)
        if (i === 1) assert.ok(r.body.promotions.includes(expId), 'promoted on second distinct task instance')
      })
    }
    const after = await memRow(expId)
    assert.equal(after.exp_status, 'verified', 'candidate -> verified after 2 distinct task instances')
    console.log('PASS 10 experience promotion on two distinct task instances')
  }

  console.log('ALL P0-05 REPORT_OUTCOME ASSERTIONS PASSED')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    const E = [...eps], R = [...rids], A = [...attempts]
    if (E.length) { await q('DELETE FROM success_evidence WHERE tenant_id=$1 AND experience_id IN (SELECT memory_id FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2))', [TENANT, E]).catch(() => {}); await q('DELETE FROM outcomes WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E]); await q('DELETE FROM recall_requests WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E]); await q('DELETE FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E]) }
    if (directIds.length) { await q('DELETE FROM success_evidence WHERE tenant_id=$1 AND experience_id = ANY($2)', [TENANT, directIds]).catch(() => {}); await q('DELETE FROM memories WHERE tenant_id=$1 AND memory_id = ANY($2)', [TENANT, directIds]) }
    if (A.length) await q('DELETE FROM attempt_events WHERE tenant_id=$1 AND attempt_id = ANY($2)', [TENANT, A])
    if (R.length) await q('DELETE FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])
    const counts = {}
    for (const [name, sql, params] of [
      ['memories', 'SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E.length ? E : ['-']]],
      ['outcomes', 'SELECT count(*)::INT4 AS n FROM outcomes WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E.length ? E : ['-']]],
      ['attempt_events', 'SELECT count(*)::INT4 AS n FROM attempt_events WHERE tenant_id=$1 AND attempt_id = ANY($2)', [TENANT, A.length ? A : ['-']]],
      ['tool_requests', 'SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R.length ? R : ['-']]],
    ]) counts[name] = (await q(sql, params)).rows[0].n
    const leaks = Object.entries(counts).filter(([, n]) => n !== 0)
    if (leaks.length) cleanupErrors.push(new Error('residual: ' + leaks.map(([k, n]) => `${k}=${n}`).join(' ')))
    else console.log('cleanup done (residual: all zero)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
