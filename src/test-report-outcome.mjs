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

  // 11. attribution 走私全链（Codex 初审#1 回归）：正文永远进不了 outcomes
  {
    const SENTINEL = `p005-smuggle-${suite}-${randomUUID().slice(0, 8)}`
    const episode = ep(), attemptId = att(), taskId = suite + '-t11'
    let smugMemId
    await withClient(AUTH, async (c) => {
      // 真实 remember 一条含 sentinel 的记忆（存在性前提，防挡板测试）
      const rem = await call(c, 'remember', { content: `note ${SENTINEL} plaintext`, episode_id: episode, request_id: rid() })
      assert.equal(rem.body.ok, true, JSON.stringify(rem.body)); smugMemId = rem.body.memory_id
      // a) 非 UUID 字段直塞正文 -> 整体拒绝，零落库
      const evil = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'failure',
        attributions: [{ recall_request_id: SENTINEL, receipt_item_id: randomUUID(), memory_id: randomUUID(), role: 'blamed', evidence_event_id: randomUUID() }] })
      assert.equal(evil.body.error, 'attribution_recall_request_id_not_uuid', JSON.stringify(evil.body))
      // b) 未知键走私（直调工具函数，绕过 zod strip 的纵深校验）
      process.env.TIDEMARK_DEV_INSECURE ??= '1'
      const { reportOutcomeTool } = await import('./tools/report-outcome.mjs')
      const evil2 = await reportOutcomeTool({ principal: { tenant_id: TENANT, agent_id: AGENT }, outcome_request_id: randomUUID(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'failure',
        attributions: [{ recall_request_id: randomUUID(), receipt_item_id: randomUUID(), memory_id: randomUUID(), role: 'blamed', evidence_event_id: randomUUID(), smuggled_note: SENTINEL }] })
      assert.equal(evil2.error, 'attribution_unknown_key', JSON.stringify(evil2))
      // c) 格式合法但归因无效 -> 照单存档（存的全是 UUID，无正文通道）
      const stored = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'failure',
        attributions: [{ recall_request_id: randomUUID(), receipt_item_id: randomUUID(), memory_id: randomUUID(), role: 'blamed', evidence_event_id: randomUUID() }] })
      assert.equal(stored.body.ok, true, JSON.stringify(stored.body))
      assert.equal(stored.body.items[0].reason, 'receipt_not_found_in_scope')
    })
    // d) 硬删 sentinel memory 后全表零正文命中（outcomes/attempt_events/memories/tool_requests）
    await q('DELETE FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, smugMemId])
    for (const [table, col] of [['outcomes', 'attributions::STRING'], ['outcomes', 'COALESCE(response_json::STRING, \'\')'],
                                ['attempt_events', 'payload::STRING'], ['memories', 'content'], ['tool_requests', 'COALESCE(response_json::STRING, \'\')']]) {
      const n = (await q(`SELECT count(*)::INT4 AS n FROM ${table} WHERE tenant_id=$1 AND ${col} LIKE '%' || $2 || '%'`, [TENANT, SENTINEL])).rows[0].n
      assert.equal(n, 0, `sentinel residue in ${table}.${col}`)
    }
    console.log('PASS 11 attribution smuggling rejected end to end, zero residue after delete')
  }

  // 12. 未来锚点拒绝不 clamp（Codex 初审#2 回归，结论 10）
  {
    const epA = ep(), attA = att(), taskA = suite + '-t12a'
    let citA
    await withClient(AUTH, async (c) => { citA = await buildCitable(c, { content: 'future credit ' + suite, episode: epA, attemptId: attA, taskId: taskA }) })
    await q(`UPDATE memories SET strength_anchor_at=now() + INTERVAL '48 hours', last_rewarded_at=now() + INTERVAL '48 hours' WHERE tenant_id=$1 AND memory_id=$2`, [TENANT, citA.memory_id])
    const beforeA = await memRow(citA.memory_id)
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: epA, task_instance_id: taskA, attempt_id: attA, status: 'success', attributions: [{ ...citA, role: 'credited' }] })
      assert.equal(r.body.ok, true, JSON.stringify(r.body))
      assert.equal(r.body.items[0].applied, false)
      assert.equal(r.body.items[0].reason, 'future_timestamp_rejected', JSON.stringify(r.body.items))
      assert.equal(r.body.plasticity_applied, false)
    })
    const afterA = await memRow(citA.memory_id)
    assert.equal(Number(afterA.credited_success_count), Number(beforeA.credited_success_count), 'future credited: count untouched')
    assert.equal(afterA.strength_anchor_at.getTime(), beforeA.strength_anchor_at.getTime(), 'future anchor NOT rewritten to now')
    assert.equal(Number(afterA.revision), Number(beforeA.revision), 'future credited: row untouched')
    // blamed 同守 anchor
    const epB = ep(), attB = att(), taskB = suite + '-t12b'
    let citB
    await withClient(AUTH, async (c) => { citB = await buildCitable(c, { content: 'future blame ' + suite, episode: epB, attemptId: attB, taskId: taskB }) })
    await q(`UPDATE memories SET strength_anchor_at=now() + INTERVAL '48 hours' WHERE tenant_id=$1 AND memory_id=$2`, [TENANT, citB.memory_id])
    const beforeB = await memRow(citB.memory_id)
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: epB, task_instance_id: taskB, attempt_id: attB, status: 'failure', attributions: [{ ...citB, role: 'blamed' }] })
      assert.equal(r.body.items[0].reason, 'future_timestamp_rejected', JSON.stringify(r.body.items))
    })
    const afterB = await memRow(citB.memory_id)
    assert.equal(Number(afterB.strength_anchor), Number(beforeB.strength_anchor), 'future blamed: anchor untouched')
    console.log('PASS 12 future timestamps rejected, rows untouched (no clamp)')
  }

  // 13. scope 不合法的 receipt 绝不结算（Codex 初审#3 回归）+ attempt 归属整体拒
  {
    // a) 空 attempt + 错 episode：receipt 校验拒 item，receipt 不得被结算
    const epReal = ep(), epWrong = ep(), attemptId = att(), taskId = suite + '-t13'
    let rrId
    await withClient(AUTH, async (c) => {
      const rem = await call(c, 'remember', { content: 'settle guard ' + suite, episode_id: epReal, request_id: rid() })
      rrId = rid()
      const rec = await call(c, 'recall', { query: 'settle guard ' + suite, purpose: 'unit', episode_id: epReal, attempt_id: attemptId, request_id: rrId })
      const item = rec.body.receipt.items.find(i => i.injected)
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: epWrong, task_instance_id: taskId, attempt_id: attemptId, status: 'failure',
        attributions: [{ recall_request_id: rrId, receipt_item_id: item.receipt_item_id, memory_id: item.memory_id, role: 'blamed', evidence_event_id: randomUUID() }] })
      assert.equal(r.body.ok, true, JSON.stringify(r.body))
      assert.equal(r.body.items[0].reason, 'receipt_episode_mismatch', JSON.stringify(r.body.items))
    })
    const rr = (await q('SELECT outcome_state, terminal_attempt_id FROM recall_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, rrId])).rows[0]
    assert.notEqual(rr.outcome_state, 'reported', 'out-of-scope receipt must NOT be settled')
    assert.equal(rr.terminal_attempt_id, null, 'terminal_attempt_id stays NULL')
    // b) attempt 已有事件时，错 episode 的 outcome 整体拒（attempt 归属防线）
    const ep2 = ep(), att2 = att(), task2 = suite + '-t13b'
    await withClient(AUTH, async (c) => {
      await buildCitable(c, { content: 'attempt anchor ' + suite, episode: ep2, attemptId: att2, taskId: task2 })
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: ep(), task_instance_id: task2, attempt_id: att2, status: 'cancelled' })
      assert.equal(r.body.error, 'attempt_scope_mismatch', JSON.stringify(r.body))
    })
    console.log('PASS 13 out-of-scope receipt never settled + attempt scope enforced')
  }

  // 14. 迟到窗口（>24h）：照单存档零塑性，合法 receipt 正常关闭
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t14'
    let cit
    await withClient(AUTH, async (c) => { cit = await buildCitable(c, { content: 'late probe ' + suite, episode, attemptId, taskId }) })
    await q(`UPDATE recall_requests SET created_at=now() - INTERVAL '25 hours' WHERE tenant_id=$1 AND request_id=$2`, [TENANT, cit.recall_request_id])
    const before = await memRow(cit.memory_id)
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success', attributions: [{ ...cit, role: 'credited' }] })
      assert.equal(r.body.ok, true, JSON.stringify(r.body))
      assert.equal(r.body.items[0].reason, 'late_no_plasticity', JSON.stringify(r.body.items))
      assert.equal(r.body.plasticity_applied, false)
    })
    const after = await memRow(cit.memory_id)
    assert.equal(Number(after.credited_success_count), Number(before.credited_success_count), 'late outcome: zero plasticity')
    const n = (await q('SELECT count(*)::INT4 AS n FROM outcomes WHERE tenant_id=$1 AND attempt_id=$2', [TENANT, attemptId])).rows[0].n
    assert.equal(n, 1, 'late outcome still archived')
    console.log('PASS 14 late outcome archived with zero plasticity')
  }

  // 15. memory 已删除：照单存档零塑性
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t15'
    let cit
    await withClient(AUTH, async (c) => { cit = await buildCitable(c, { content: 'deleted probe ' + suite, episode, attemptId, taskId }) })
    await q('DELETE FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, cit.memory_id])
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success', attributions: [{ ...cit, role: 'credited' }] })
      assert.equal(r.body.ok, true, JSON.stringify(r.body))
      assert.equal(r.body.items[0].reason, 'memory_deleted', JSON.stringify(r.body.items))
    })
    console.log('PASS 15 deleted memory: archived, zero plasticity')
  }

  // 16. 同 outcome 内 memory_id 去重：只加固一次
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t16'
    let cit
    await withClient(AUTH, async (c) => { cit = await buildCitable(c, { content: 'dedupe probe ' + suite, episode, attemptId, taskId }) })
    await q(`UPDATE memories SET strength_anchor=0.5, strength_anchor_at=now() - INTERVAL '48 hours', last_rewarded_at=now() - INTERVAL '48 hours' WHERE tenant_id=$1 AND memory_id=$2`, [TENANT, cit.memory_id])
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success',
        attributions: [{ ...cit, role: 'credited' }, { ...cit, role: 'credited' }] })
      assert.equal(r.body.ok, true, JSON.stringify(r.body))
      assert.equal(r.body.items[0].applied, true)
      assert.equal(r.body.items[1].reason, 'duplicate_memory_skipped', JSON.stringify(r.body.items))
    })
    const after = await memRow(cit.memory_id)
    assert.equal(Number(after.credited_success_count), 1, 'dedupe: credited exactly once')
    console.log('PASS 16 duplicate memory_id in one outcome credited once')
  }

  // 17. 同 key 异 payload 拒（keyed idempotency on outcomes table）
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t17', orid = rid()
    await withClient(AUTH, async (c) => {
      const first = await call(c, 'report_outcome', { outcome_request_id: orid, episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'cancelled' })
      assert.equal(first.body.ok, true, JSON.stringify(first.body))
      const diff = await call(c, 'report_outcome', { outcome_request_id: orid, episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'failure' })
      assert.equal(diff.body.error, 'idempotency_key_reused', JSON.stringify(diff.body))
    })
    console.log('PASS 17 same key different payload rejected')
  }

  // 18. 真并发双终态：同 attempt 两个 key 同时报 success/failure，恰一个赢
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t18'
    const mk = (status) => ({ outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status })
    const [r1, r2] = await Promise.all([
      withClient(AUTH, (c) => call(c, 'report_outcome', mk('success'))),
      withClient(AUTH, (c) => call(c, 'report_outcome', mk('failure'))),
    ])
    const oks = [r1, r2].filter(r => r.body.ok === true)
    const conflicts = [r1, r2].filter(r => r.body.error === 'outcome_conflict')
    assert.equal(oks.length, 1, `exactly one winner: ${JSON.stringify([r1.body, r2.body])}`)
    assert.equal(conflicts.length, 1, `exactly one conflict: ${JSON.stringify([r1.body, r2.body])}`)
    const n = (await q('SELECT count(*)::INT4 AS n FROM outcomes WHERE tenant_id=$1 AND attempt_id=$2', [TENANT, attemptId])).rows[0].n
    assert.equal(n, 1, 'exactly one terminal outcome row')
    console.log('PASS 18 concurrent double-terminal: single winner')
  }

  // 19. cross-agent（二审#2 所有权模型）：终态槽按 (tenant, agent, attempt) 隔离——
  // second-agent 用 demo 的 attempt_id 报 outcome 落的是它自己的槽，占不走 demo 的；
  // demo 的 receipt/memory 对它全程不可见不可动；demo 随后报自己的终态照常成功
  {
    const episode = ep(), attemptId = att(), taskId = suite + '-t19'
    let cit
    await withClient(AUTH, async (c) => { cit = await buildCitable(c, { content: 'xagent probe ' + suite, episode, attemptId, taskId }) })
    const before = await memRow(cit.memory_id)
    await withClient({ 'x-tidemark-auth': 'spike-second-key' }, async (c) => {
      const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success', attributions: [{ ...cit, role: 'credited' }] })
      assert.equal(r.body.ok, true, JSON.stringify(r.body))                       // 落它自己的槽
      assert.equal(r.body.items[0].reason, 'receipt_not_found_in_scope', JSON.stringify(r.body.items))
      assert.equal(r.body.plasticity_applied, false, 'foreign receipt invisible -> zero plasticity')
    })
    const after = await memRow(cit.memory_id)
    assert.equal(Number(after.credited_success_count), Number(before.credited_success_count), 'cross-agent: memory untouched')
    const rr = (await q('SELECT terminal_attempt_id FROM recall_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, cit.recall_request_id])).rows[0]
    assert.equal(rr.terminal_attempt_id, null, 'cross-agent: receipt not settled')
    // 关键断言：demo 自己的终态槽没有被占走（squatting 攻击的修复验证）
    await withClient(AUTH, async (c) => {
      const own = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success', attributions: [{ ...cit, role: 'credited' }] })
      assert.equal(own.body.ok, true, `demo's own terminal slot must survive: ${JSON.stringify(own.body)}`)
      assert.equal(own.body.items[0].applied, true, 'demo credits its own memory normally')
    })
    const rows = (await q('SELECT agent_id FROM outcomes WHERE tenant_id=$1 AND attempt_id=$2 ORDER BY agent_id', [TENANT, attemptId])).rows
    assert.deepEqual(rows.map(r => r.agent_id), ['demo-agent', 'second-agent'], 'two isolated terminal slots, one per agent')
    console.log('PASS 19 per-agent terminal slots: squatting impossible, demo unharmed')
  }

  // 20/21. 晋级判定数【召回时点 candidate】而非全部 experience（Codex 初审#4 回归）
  {
    // 每组用独立 seed 文本（stub embedding 由内容决定）：组间向量不同，20 的经验不会污染 21 的召回
    const mkExp = async (c, episode, status, tag, seedText) => {
      const seed = await call(c, 'remember', { content: seedText, episode_id: episode, request_id: rid() })
      const emb = (await q('SELECT embedding::STRING AS e FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, seed.body.memory_id])).rows[0].e
      const id = randomUUID(); directIds.push(id)
      await q(`INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, experience_body, exp_status, source, admission, state, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours)
               VALUES ($1,$2,$3,'experience',$4,$5,$6,$7,$8,'agent_inferred','accepted','fresh',0.5,1.0,now(),now(),2160)`,
        [TENANT, AGENT, id, episode, `exp ${tag} body`, emb, JSON.stringify({ trigger: `when ${tag}`, correct_action: 'do it', caution: 'careful' }), status])
      return id
    }
    // 20: candidate + verified 同注入 -> candidate 仍可记首验
    {
      const episode = ep(), attemptId = att(), taskId = suite + '-t20'
      let candId
      await withClient(AUTH, async (c) => {
        const seed20 = `exp pair20 seed ${suite}`
        candId = await mkExp(c, episode, 'candidate', 'cand20', seed20)
        await mkExp(c, episode, 'verified', 'veri20', seed20)
        const rrId = rid()
        const rec = await call(c, 'recall', { query: seed20, purpose: 'unit', episode_id: episode, attempt_id: attemptId, request_id: rrId })
        const items = rec.body.receipt.items
        const candItem = items.find(i => i.memory_id === candId && i.injected)
        assert.ok(candItem, `candidate injected: ${JSON.stringify(items.map(i => ({ m: i.memory_id, l: i.layer, inj: i.injected })))}`)
        assert.equal(candItem.experience_status_at_recall, 'candidate', 'receipt snapshots exp status at recall')
        const injectedExp = items.filter(i => i.layer === 'experience' && i.injected)
        assert.ok(injectedExp.length >= 2, 'both experiences injected')
        const ev = await call(c, 'log_event', { episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: { recall_request_id: rrId, receipt_item_id: candItem.receipt_item_id, memory_id: candId } })
        const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success',
          attributions: [{ recall_request_id: rrId, receipt_item_id: candItem.receipt_item_id, memory_id: candId, role: 'credited', evidence_event_id: ev.body.event_id }] })
        assert.equal(r.body.ok, true, JSON.stringify(r.body))
        assert.equal(r.body.items[0].promotion_guard, undefined, `verified must not block sole-candidate: ${JSON.stringify(r.body.items)}`)
      })
      const evd = (await q('SELECT count(*)::INT4 AS n FROM success_evidence WHERE tenant_id=$1 AND experience_id=$2', [TENANT, candId])).rows[0].n
      assert.equal(evd, 1, 'first success_evidence recorded despite verified co-injection')
      console.log('PASS 20 candidate+verified co-injection: candidate earns evidence')
    }
    // 21: candidate + candidate 同注入 -> not_sole_candidate，不记证据
    {
      const episode = ep(), attemptId = att(), taskId = suite + '-t21'
      let candA
      await withClient(AUTH, async (c) => {
        const seed21 = `exp pair21 seed ${suite}`
        candA = await mkExp(c, episode, 'candidate', 'candA21', seed21)
        await mkExp(c, episode, 'candidate', 'candB21', seed21)
        const rrId = rid()
        const rec = await call(c, 'recall', { query: seed21, purpose: 'unit', episode_id: episode, attempt_id: attemptId, request_id: rrId })
        const itemA = rec.body.receipt.items.find(i => i.memory_id === candA && i.injected)
        assert.ok(itemA, 'candidate A injected')
        const ev = await call(c, 'log_event', { episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, request_id: rid(), event_type: 'memory_used', payload: { recall_request_id: rrId, receipt_item_id: itemA.receipt_item_id, memory_id: candA } })
        const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: episode, task_instance_id: taskId, attempt_id: attemptId, status: 'success',
          attributions: [{ recall_request_id: rrId, receipt_item_id: itemA.receipt_item_id, memory_id: candA, role: 'credited', evidence_event_id: ev.body.event_id }] })
        assert.equal(r.body.ok, true, JSON.stringify(r.body))
        assert.equal(r.body.items[0].promotion_guard, 'not_sole_candidate', JSON.stringify(r.body.items))
      })
      const evd = (await q('SELECT count(*)::INT4 AS n FROM success_evidence WHERE tenant_id=$1 AND experience_id=$2', [TENANT, candA])).rows[0].n
      assert.equal(evd, 0, 'two candidates: no evidence recorded')
      console.log('PASS 21 candidate+candidate co-injection: not_sole_candidate')
    }
  }

  // 22. attributions 数量上限（二审#7）：事务 B 保持短事务
  await withClient(AUTH, async (c) => {
    const mk = () => ({ recall_request_id: randomUUID(), receipt_item_id: randomUUID(), memory_id: randomUUID(), role: 'credited', evidence_event_id: randomUUID() })
    const r = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: ep(), task_instance_id: suite + '-t22', attempt_id: att(), status: 'success',
      attributions: Array.from({ length: 33 }, mk) })
    assert.equal(r.body.ok, false, `33 attributions rejected (MCP .max(32) or tool-level cap): ${JSON.stringify(r.body).slice(0, 200)}`)
    // exact-32 接受边界：冻结值本身必须可用（全部无效归因也照单存档，存的全是 UUID）
    const at32 = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: ep(), task_instance_id: suite + '-t22c', attempt_id: att(), status: 'success',
      attributions: Array.from({ length: 32 }, mk) })
    assert.equal(at32.body.ok, true, `exactly 32 accepted: ${JSON.stringify(at32.body).slice(0, 200)}`)
    assert.equal(at32.body.items.length, 32)
    const ok = await call(c, 'report_outcome', { outcome_request_id: rid(), episode_id: ep(), task_instance_id: suite + '-t22b', attempt_id: att(), status: 'cancelled' })
    assert.equal(ok.body.ok, true, 'cap does not break normal calls')
    console.log('PASS 22 attributions cap: 33 rejected, exact-32 accepted')
  })

  console.log('ALL P0-05 REPORT_OUTCOME ASSERTIONS PASSED (22 scenarios)')
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
