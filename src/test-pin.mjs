// P0-05b pin 验收：node --env-file=.env src/test-pin.mjs（先起 server，EMBED_PROVIDER=stub）
// 场景：无auth/无能力位/scope外/未accepted不可pin/pin冻结当下effective/重复set零副作用/
//       unpin恢复衰减/幂等重放+异payload拒/reason必须slug/不动utility与last_rewarded
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
  const c = new Client({ name: 'p005b-test', version: '0.1.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }))
  try { return await fn(c) } finally { await c.close().catch(() => {}) }
}
const call = async (c, name, args) => {
  try {
    const r = await c.callTool({ name, arguments: args })
    try { return { isError: r.isError === true, body: JSON.parse(r.content[0].text) } }
    catch { return { isError: true, body: { ok: false, error: 'non_json' } } }
  } catch (e) { return { isError: true, body: { ok: false, error: 'protocol_validation' } } }
}
const AUTH = { 'x-tidemark-auth': 'spike-demo-key' }
const AUTH2 = { 'x-tidemark-auth': 'spike-second-key' }
const AUTH3 = { 'x-tidemark-auth': 'spike-third-key' }   // 有 memory:pin 能力、不同 agent——测两道门独立
const TENANT = 'demo-tenant', AGENT = 'demo-agent'
const suite = 'p005b-' + randomUUID().slice(0, 8)
const eps = new Set(), rids = new Set(), directIds = []
const ep = () => { const e = `${suite}-` + randomUUID().slice(0, 6); eps.add(e); return e }
const rid = () => { const r = randomUUID(); rids.add(r); return r }
const row = async (id) => (await q('SELECT pinned, strength_anchor, strength_anchor_at, last_rewarded_at, credited_success_count, revision, source FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, id])).rows[0]

let primaryError = null
try {
  // 种子
  const episode = ep()
  let memId
  await withClient(AUTH, async (c) => {
    const r = await call(c, 'remember', { content: 'pin target ' + suite, episode_id: episode, request_id: rid() })
    assert.equal(r.body.ok, true); memId = r.body.memory_id
  })
  // 让它衰减出空间：anchor=1.0，48h 前锚点，半衰期 108h -> effective ≈ 0.735
  await q(`UPDATE memories SET strength_anchor=1.0, strength_anchor_at=now() - INTERVAL '48 hours' WHERE tenant_id=$1 AND memory_id=$2`, [TENANT, memId])

  // 1. 无 auth / 无能力位
  await withClient({}, async (c) => {
    const r = await call(c, 'pin', { memory_id: memId, pinned: true, reason: 'unit', request_id: rid() })
    assert.equal(r.body.error, 'unauthorized')
  })
  await withClient(AUTH2, async (c) => {
    const r = await call(c, 'pin', { memory_id: memId, pinned: true, reason: 'unit', request_id: rid() })
    assert.equal(r.body.error, 'pin_capability_required', 'second-agent lacks memory:pin')
  })
  console.log('PASS 1 auth + capability gate')

  // 2. reason 必须 slug；scope 外记忆拒
  await withClient(AUTH, async (c) => {
    const bad = await call(c, 'pin', { memory_id: memId, pinned: true, reason: 'this is prose not a slug!', request_id: rid() })
    assert.equal(bad.body.error, 'reason_must_be_slug')
    const ghost = await call(c, 'pin', { memory_id: randomUUID(), pinned: true, reason: 'unit', request_id: rid() })
    assert.equal(ghost.body.error, 'memory_not_found_in_scope')
    console.log('PASS 2 reason slug + scope check')
  })

  // 3. 未 accepted 不可 pin（quarantined fixture）
  {
    let qid
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'remember', { content: `key AKIAABCDEFGHIJKLMNOP ${suite}`, episode_id: episode, request_id: rid() })
      assert.equal(r.body.admission, 'quarantined'); qid = r.body.memory_id
      const pin = await call(c, 'pin', { memory_id: qid, pinned: true, reason: 'unit', request_id: rid() })
      assert.equal(pin.body.error, 'only_accepted_memories_pinnable')
      console.log('PASS 3 quarantined not pinnable')
    })
  }

  // 4. pin = materialize 冻结当下（非升满）；断言 frozen ≈ decay 预期且 < 原 anchor
  let frozen
  await withClient(AUTH, async (c) => {
    const before = await row(memId)
    const r = await call(c, 'pin', { memory_id: memId, pinned: true, reason: 'freeze_test', request_id: rid() })
    assert.equal(r.body.ok, true); assert.equal(r.body.transition, true)
    frozen = r.body.frozen_at_strength
    const expected = 1.0 * Math.exp(-Math.LN2 * 48 / Number(before.strength_anchor ? (await q('SELECT half_life_hours FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, memId])).rows[0].half_life_hours : 108))
    assert.ok(frozen < 1.0, 'pin must NOT boost to full')
    assert.ok(Math.abs(frozen - expected) < 0.01, `frozen(${frozen}) ~= decayed expectation(${expected.toFixed(4)})`)
    const after = await row(memId)
    assert.equal(after.pinned, true)
    assert.ok(Math.abs(Number(after.strength_anchor) - frozen) < 1e-6, 'anchor materialized to frozen value')
    assert.equal(Number(after.revision), Number(before.revision) + 1)
    assert.equal(after.last_rewarded_at.getTime(), before.last_rewarded_at.getTime(), 'last_rewarded untouched')
    assert.equal(after.source, before.source, 'source untouched')
    console.log('PASS 4 pin freezes current effective (materialize, not boost)')
  })

  // 5. 重复 set 零副作用（no-op，不再 materialize）
  await withClient(AUTH, async (c) => {
    const before = await row(memId)
    const r = await call(c, 'pin', { memory_id: memId, pinned: true, reason: 'again', request_id: rid() })
    assert.equal(r.body.transition, false, 'idempotent set is a no-op')
    const after = await row(memId)
    assert.equal(Number(after.strength_anchor), Number(before.strength_anchor), 'no double materialize')
    assert.equal(Number(after.revision), Number(before.revision), 'no-op does not bump revision')
    console.log('PASS 5 repeated set is no-op')
  })

  // 6. 幂等重放 + 异 payload 拒
  await withClient(AUTH, async (c) => {
    const args = { memory_id: memId, pinned: true, reason: 'replay_probe', request_id: rid() }
    const a = await call(c, 'pin', args)
    const b = await call(c, 'pin', args)
    assert.deepEqual(b.body, a.body, 'replay returns first response')
    const diff = await call(c, 'pin', { ...args, reason: 'different_reason' })
    assert.equal(diff.body.error, 'idempotency_key_reused')
    console.log('PASS 6 idempotent replay + key reuse rejected')
  })

  // 7. unpin：保 anchor、anchor_at 重置为 now、恢复衰减
  await withClient(AUTH, async (c) => {
    const before = await row(memId)
    const r = await call(c, 'pin', { memory_id: memId, pinned: false, reason: 'release', request_id: rid() })
    assert.equal(r.body.transition, true)
    const after = await row(memId)
    assert.equal(after.pinned, false)
    assert.equal(Number(after.strength_anchor), Number(before.strength_anchor), 'unpin keeps anchor value')
    assert.ok(after.strength_anchor_at.getTime() > before.strength_anchor_at.getTime(), 'anchor_at reset to now (decay resumes fresh)')
    console.log('PASS 7 unpin keeps anchor, resets clock')
  })

  // 8. faded+pin 召回闭环（二审#5）：faded 排除 -> pin 后命中注入 -> unpin 恢复沉底
  {
    const episode = ep()
    const QF = 'pin faded closure ' + suite
    let fid
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'remember', { content: QF, episode_id: episode, request_id: rid() })
      fid = r.body.memory_id
    })
    await q(`UPDATE memories SET state='faded' WHERE tenant_id=$1 AND memory_id=$2`, [TENANT, fid])
    const recallIds = async (c) => {
      const r = await call(c, 'recall', { query: QF, purpose: 'unit', episode_id: episode, attempt_id: `${suite}-att-` + randomUUID().slice(0, 6), request_id: rid() })
      assert.equal(r.body.ok, true, JSON.stringify(r.body))
      return r.body.receipt.items
    }
    await withClient(AUTH, async (c) => {
      assert.ok(!(await recallIds(c)).some(i => i.memory_id === fid), 'faded unpinned: excluded from recall')
      const p = await call(c, 'pin', { memory_id: fid, pinned: true, reason: 'rescue', request_id: rid() })
      assert.equal(p.body.ok, true, JSON.stringify(p.body))
      const hit = (await recallIds(c)).find(i => i.memory_id === fid)
      assert.ok(hit, 'faded+pinned: recallable again')
      assert.equal(hit.injected, true, 'faded+pinned: injected, not just listed')
      const u = await call(c, 'pin', { memory_id: fid, pinned: false, reason: 'release', request_id: rid() })
      assert.equal(u.body.ok, true)
      assert.ok(!(await recallIds(c)).some(i => i.memory_id === fid), 'unpinned again: sinks back immediately')
    })
    console.log('PASS 8 faded -> pin -> recall hit/injected -> unpin -> sinks back')
  }

  // 9. 未来锚点拒绝（二审#4，结论 10）：pin 与 unpin 都不许回拨清洗
  {
    const episode = ep()
    let mid
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'remember', { content: 'pin future probe ' + suite, episode_id: episode, request_id: rid() })
      mid = r.body.memory_id
    })
    await q(`UPDATE memories SET strength_anchor_at=now() + INTERVAL '48 hours' WHERE tenant_id=$1 AND memory_id=$2`, [TENANT, mid])
    const before = await row(mid)
    await withClient(AUTH, async (c) => {
      const p = await call(c, 'pin', { memory_id: mid, pinned: true, reason: 'unit', request_id: rid() })
      assert.equal(p.body.error, 'future_timestamp_rejected', JSON.stringify(p.body))
    })
    let after = await row(mid)
    assert.equal(after.pinned, false, 'future pin: no transition')
    assert.equal(after.strength_anchor_at.getTime(), before.strength_anchor_at.getTime(), 'future anchor NOT rewritten')
    assert.equal(Number(after.revision), Number(before.revision), 'future pin: row untouched')
    // 置回过去 -> pin 成功 -> 再置未来 -> unpin 必须拒（unpin 的 anchor_at=now 同样是回拨）
    await q(`UPDATE memories SET strength_anchor_at=now() - INTERVAL '1 hour' WHERE tenant_id=$1 AND memory_id=$2`, [TENANT, mid])
    await withClient(AUTH, async (c) => {
      const p = await call(c, 'pin', { memory_id: mid, pinned: true, reason: 'unit', request_id: rid() })
      assert.equal(p.body.ok, true, JSON.stringify(p.body))
    })
    await q(`UPDATE memories SET strength_anchor_at=now() + INTERVAL '48 hours' WHERE tenant_id=$1 AND memory_id=$2`, [TENANT, mid])
    await withClient(AUTH, async (c) => {
      const u = await call(c, 'pin', { memory_id: mid, pinned: false, reason: 'unit', request_id: rid() })
      assert.equal(u.body.error, 'future_timestamp_rejected', JSON.stringify(u.body))
    })
    after = await row(mid)
    assert.equal(after.pinned, true, 'future unpin: stays pinned, no rewrite')
    console.log('PASS 9 future anchor rejects both pin and unpin, zero writes')
  }

  // 10. capability 过了、agent scope 也必须过：third-agent 有 memory:pin，pin 不到 demo-agent 的记忆
  await withClient(AUTH3, async (c) => {
    const r = await call(c, 'pin', { memory_id: memId, pinned: true, reason: 'unit', request_id: rid() })
    assert.equal(r.body.error, 'memory_not_found_in_scope', JSON.stringify(r.body))
    console.log('PASS 10 capability-holding foreign agent still scope-blocked')
  })

  // 11. superseded experience 不可 pin
  {
    const sid = randomUUID(); directIds.push(sid)
    // accepted 行必须带 embedding（001 的 CHECK）——复用开头种子的向量
    const emb = (await q('SELECT embedding::STRING AS e FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, memId])).rows[0].e
    await q(`INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, embedding_model_id, experience_body, exp_status, source, admission, state, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours)
             VALUES ($1,$2,$3,'experience',$4,'superseded exp body',$5,'stub-sha256-512',$6,'superseded','agent_inferred','accepted','fresh',0.5,1.0,now(),now(),2160)`,
      [TENANT, AGENT, sid, `${suite}-direct`, emb, JSON.stringify({ trigger: 't', correct_action: 'a', caution: 'c' })])
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'pin', { memory_id: sid, pinned: true, reason: 'unit', request_id: rid() })
      assert.equal(r.body.error, 'superseded_not_pinnable', JSON.stringify(r.body))
    })
    console.log('PASS 11 superseded experience not pinnable')
  }

  // 12. 同 request 并发 first-writer：两个并发同 key 同 payload，恰一次转换、响应一致
  {
    const episode = ep()
    let mid
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'remember', { content: 'pin race probe ' + suite, episode_id: episode, request_id: rid() })
      mid = r.body.memory_id
    })
    const before = await row(mid)
    const raceReq = rid()
    const args = { memory_id: mid, pinned: true, reason: 'race_probe', request_id: raceReq }
    const [r1, r2] = await Promise.all([
      withClient(AUTH, (c) => call(c, 'pin', args)),
      withClient(AUTH, (c) => call(c, 'pin', args)),
    ])
    assert.equal(r1.body.ok, true, JSON.stringify(r1.body))
    assert.deepEqual(r1.body, r2.body, `concurrent same-key responses identical: ${JSON.stringify([r1.body, r2.body])}`)
    const after = await row(mid)
    assert.equal(after.pinned, true)
    assert.equal(Number(after.revision), Number(before.revision) + 1, 'exactly one transition applied')
    console.log('PASS 12 concurrent same-request first-writer: one transition, identical responses')
  }

  // 13. reason 不落日志/持久层（二审#6）：sentinel slug 在 stdout 与 tool_requests 双零命中
  {
    const SENT = `sentinel-reason-${suite}`
    const episode = ep()
    let mid
    await withClient(AUTH, async (c) => {
      const r = await call(c, 'remember', { content: 'pin log probe ' + suite, episode_id: episode, request_id: rid() })
      mid = r.body.memory_id
    })
    process.env.TIDEMARK_DEV_INSECURE ??= '1'
    const { pinTool } = await import('./tools/pin.mjs')
    const logs = []
    const orig = console.log
    console.log = (...a) => logs.push(a.map(String).join(' '))
    let direct
    try {
      direct = await pinTool({ principal: { tenant_id: TENANT, agent_id: AGENT, capabilities: ['memory:pin'] }, memory_id: mid, pinned: true, reason: SENT, request_id: rid() })
    } finally { console.log = orig }
    assert.equal(direct.ok, true, JSON.stringify(direct))
    assert.ok(!logs.some(l => l.includes(SENT)), `reason leaked to logs: ${JSON.stringify(logs)}`)
    const n = (await q(`SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND COALESCE(response_json::STRING,'') LIKE '%' || $2 || '%'`, [TENANT, SENT])).rows[0].n
    assert.equal(n, 0, 'reason absent from persisted response')
    console.log('PASS 13 pin reason never reaches logs or persisted response')
  }

  console.log('ALL P0-05B PIN ASSERTIONS PASSED (13 scenarios)')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    const E = [...eps], R = [...rids]
    if (E.length) { await q('DELETE FROM recall_requests WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E]); await q('DELETE FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E]) }
    if (directIds.length) await q('DELETE FROM memories WHERE tenant_id=$1 AND memory_id = ANY($2)', [TENANT, directIds])
    if (R.length) await q('DELETE FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])
    const mm = E.length ? (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND (episode_id = ANY($2) OR memory_id = ANY($3))', [TENANT, E, directIds.length ? directIds : ['00000000-0000-0000-0000-000000000000']])).rows[0].n : 0
    const rr = E.length ? (await q('SELECT count(*)::INT4 AS n FROM recall_requests WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E])).rows[0].n : 0
    const tr = R.length ? (await q('SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])).rows[0].n : 0
    if (mm || rr || tr) cleanupErrors.push(new Error(`residual: memories=${mm} recall_requests=${rr} tool_requests=${tr}`))
    else console.log('cleanup done (residual: memories=0, recall_requests=0, tool_requests=0)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
