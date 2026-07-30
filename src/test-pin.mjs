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
const TENANT = 'demo-tenant'
const suite = 'p005b-' + randomUUID().slice(0, 8)
const eps = new Set(), rids = new Set()
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

  console.log('ALL P0-05B PIN ASSERTIONS PASSED')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    const E = [...eps], R = [...rids]
    if (E.length) await q('DELETE FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E])
    if (R.length) await q('DELETE FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])
    const mm = E.length ? (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E])).rows[0].n : 0
    const tr = R.length ? (await q('SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])).rows[0].n : 0
    if (mm || tr) cleanupErrors.push(new Error(`residual: memories=${mm} tool_requests=${tr}`))
    else console.log('cleanup done (residual: memories=0, tool_requests=0)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
