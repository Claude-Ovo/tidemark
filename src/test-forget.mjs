// P0-08 验收：node --env-file=.env src/test-forget.mjs（先起 server，EMBED_PROVIDER=stub）
// 覆盖：admin 鉴权 fail-closed、参数校验、not_found、直接删+content-free 墓碑、幂等重删、
// 血统级联（幸存源登记 rebuild）、两层深链逆拓扑、跨 tenant 不可达。
import { assertStubLocked } from './lib/test-env.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { connectWithRetry, withDatabase, isRetryableDatabaseError, sleep } from '../migrations/db.mjs'
import { embed } from './lib/embed.mjs'
import { toVectorLiteral } from './lib/vector-canonical.mjs'

let forensic = null
const q = async (text, params) => {
  const cs = withDatabase(process.env.COCKROACH_DATABASE_URL, process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  for (let attempt = 1; ; attempt++) {
    try { forensic ??= await connectWithRetry(cs, { label: 'forensic' }); return await forensic.query(text, params) }
    catch (e) { await forensic?.end().catch(() => {}); forensic = null; if (!isRetryableDatabaseError(e) || attempt >= 5) throw e; await sleep(800 * attempt) }
  }
}
const url = process.env.TIDEMARK_URL || 'http://localhost:3901'
const forget = async (body, admin = 'dev-admin') => {
  const res = await fetch(url + '/admin/forget', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-tidemark-admin': admin } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const suite = 'p008-' + randomUUID().slice(0, 8)
const T = suite + '-tenant', A = T + '-agent'
const insMem = async (content, over = {}) => {
  const o = { source: 'agent_inferred', tenant: T, ...over }
  const id = randomUUID()
  const e = await embed(content)
  await q(
    `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, embedding_model_id, source, admission,
       state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
       credited_success_count, consolidation_baseline)
     VALUES ($1,$2,$3,'event',$4,$5,$6,'stub-sha256-512',$7,'accepted','fresh',false,0.5,1.0, now(), now(), 108, 0, 0)`,
    [o.tenant, A, id, `${suite}-ep`, content, toVectorLiteral(e.f32), o.source])
  return id
}
const edge = (derived, source, runId) => q(
  `INSERT INTO memory_derivations (tenant_id, derived_memory_id, source_memory_id, run_id) VALUES ($1,$2,$3,$4)`,
  [T, derived, source, runId])
const mkRun = async () => {
  const id = randomUUID()
  await q(
    `INSERT INTO nightly_runs (tenant_id, run_id, job_kind, scheduled_for, pipeline_version, status, attempt_count, batch_size, source_snapshot, source_fingerprint, control_config)
     VALUES ($1,$2,'dream', now(), 'p008-fx', 'completed', 1, 1, '[]', $3, '{}')`,
    [T, id, Buffer.from('fx-' + randomUUID())])
  return id
}
const alive = async (id) => (await q('SELECT 1 FROM memories WHERE tenant_id=$1 AND memory_id=$2', [T, id])).rows.length
const tomb = async (id) => (await q('SELECT reason FROM memory_tombstones WHERE tenant_id=$1 AND memory_id=$2', [T, id])).rows[0]

let primaryError = null
try {
  await assertStubLocked()

  // F1 鉴权 fail-closed
  {
    const noAuth = await forget({ tenant_id: T, memory_id: randomUUID(), reason: 'unit' }, null)
    assert.equal(noAuth.status, 403)
    const badAuth = await forget({ tenant_id: T, memory_id: randomUUID(), reason: 'unit' }, 'wrong-key')
    assert.equal(badAuth.status, 403)
    console.log('PASS F1 admin auth fail-closed')
  }

  // F2 参数校验
  {
    const badId = await forget({ tenant_id: T, memory_id: 'not-a-uuid', reason: 'unit' })
    assert.equal(badId.body.error, 'memory_id_invalid')
    const badReason = await forget({ tenant_id: T, memory_id: randomUUID(), reason: 'this is prose!' })
    assert.equal(badReason.body.error, 'reason_must_be_slug')
    console.log('PASS F2 validation (uuid + slug reason)')
  }

  // F3 not_found
  {
    const r = await forget({ tenant_id: T, memory_id: randomUUID(), reason: 'unit' })
    assert.equal(r.body.error, 'memory_not_found')
    console.log('PASS F3 unknown memory refused')
  }

  // F4 直接删 + content-free 墓碑
  {
    const id = await insMem('f4 secret content ' + suite)
    const r = await forget({ tenant_id: T, memory_id: id, reason: 'user_requested' })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.deepEqual(r.body.deleted, [id])
    assert.equal(await alive(id), 0, 'row physically gone')
    const t4 = await tomb(id)
    assert.equal(t4.reason, 'user_requested')
    assert.ok(!JSON.stringify(t4).includes('secret'), 'tombstone is content-free')
    console.log('PASS F4 hard delete + content-free tombstone')
  }

  // F5 幂等重删
  {
    const id = await insMem('f5 target ' + suite)
    await forget({ tenant_id: T, memory_id: id, reason: 'unit' })
    const again = await forget({ tenant_id: T, memory_id: id, reason: 'unit' })
    assert.equal(again.body.already_forgotten, true, JSON.stringify(again.body))
    console.log('PASS F5 idempotent re-forget')
  }

  // F6 血统级联 + 幸存源 rebuild 登记：S1,S2 -> D；删 S1 => D 级联删、S2 幸存 => rebuild
  {
    const s1 = await insMem('f6 source one ' + suite)
    const s2 = await insMem('f6 source two ' + suite)
    const d = await insMem('f6 derived ' + suite, { source: 'derived' })
    const run = await mkRun()
    await edge(d, s1, run); await edge(d, s2, run)
    const r = await forget({ tenant_id: T, memory_id: s1, reason: 'privacy_request' })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.deepEqual([...r.body.deleted].sort(), [s1, d].sort(), 'source and its derived both deleted')
    assert.equal(r.body.rebuilds, 1)
    assert.equal(await alive(s2), 1, 'sibling source survives')
    assert.equal((await tomb(d)).reason, 'cascade.privacy_request')
    const rb = (await q('SELECT remaining_source_memory_ids FROM memory_rebuild_queue WHERE tenant_id=$1 AND deleted_derived_memory_id=$2', [T, d])).rows[0]
    assert.deepEqual(rb.remaining_source_memory_ids, [s2], 'rebuild queue holds the surviving source only')
    console.log('PASS F6 lineage cascade + rebuild registration')
  }

  // F7 两层深链逆拓扑：S -> D1 -> D2（D1 又是 D2 的源）；删 S 全链没、顺序不炸 FK
  {
    const s = await insMem('f7 root ' + suite)
    const d1 = await insMem('f7 mid ' + suite, { source: 'derived' })
    const d2 = await insMem('f7 leaf ' + suite, { source: 'derived' })
    const run = await mkRun()
    await edge(d1, s, run); await edge(d2, d1, run)
    const r = await forget({ tenant_id: T, memory_id: s, reason: 'unit' })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    assert.equal(r.body.deleted.length, 3, 'whole two-level lineage deleted')
    for (const id of [s, d1, d2]) assert.equal(await alive(id), 0)
    console.log('PASS F7 two-level lineage deleted in reverse topological order')
  }

  // F8 跨 tenant 不可达
  {
    const other = suite + '-other'
    const id = await insMem('f8 foreign ' + suite, { tenant: other })
    const r = await forget({ tenant_id: T, memory_id: id, reason: 'unit' })
    assert.equal(r.body.error, 'memory_not_found', 'other tenant memory invisible')
    assert.equal((await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1', [other])).rows[0].n, 1)
    console.log('PASS F8 cross-tenant unreachable')
  }

  // F9 显式 forget 撤销既有重建授权（round-1 P0 复现①）
  {
    const s1 = await insMem('f9 s1 ' + suite)
    const s2 = await insMem('f9 s2 ' + suite)
    const d = await insMem('f9 d ' + suite, { source: 'derived' })
    const run = await mkRun()
    await edge(d, s1, run); await edge(d, s2, run)
    await forget({ tenant_id: T, memory_id: s1, reason: 'unit' })   // cascade 删 D，queue(D)=[s2] pending
    const q1 = (await q('SELECT status FROM memory_rebuild_queue WHERE tenant_id=$1 AND deleted_derived_memory_id=$2', [T, d])).rows[0]
    assert.equal(q1.status, 'pending')
    const r = await forget({ tenant_id: T, memory_id: d, reason: 'privacy_request' })   // 显式点名删 D
    assert.equal(r.body.already_forgotten, true)
    assert.ok(r.body.rebuilds_revoked >= 1, JSON.stringify(r.body))
    const q2 = (await q('SELECT status, last_error FROM memory_rebuild_queue WHERE tenant_id=$1 AND deleted_derived_memory_id=$2', [T, d])).rows[0]
    assert.equal(q2.status, 'abandoned', 'explicit forget revokes the resurrection authorization')
    assert.equal(q2.last_error, 'explicitly_forgotten')
    console.log('PASS F9 explicit forget of a cascaded derived revokes its rebuild authorization')
  }

  // F10 删最后幸存源：queue 剪空即 abandoned，不再引用死者（round-1 P0 复现②）
  {
    const s1 = await insMem('f10 s1 ' + suite)
    const s2 = await insMem('f10 s2 ' + suite)
    const d = await insMem('f10 d ' + suite, { source: 'derived' })
    const run = await mkRun()
    await edge(d, s1, run); await edge(d, s2, run)
    await forget({ tenant_id: T, memory_id: s1, reason: 'unit' })   // queue(D)=[s2]
    const r = await forget({ tenant_id: T, memory_id: s2, reason: 'unit' })   // 最后幸存源也删
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    const q3 = (await q('SELECT status, remaining_source_memory_ids, last_error FROM memory_rebuild_queue WHERE tenant_id=$1 AND deleted_derived_memory_id=$2', [T, d])).rows[0]
    assert.equal(q3.status, 'abandoned', 'queue with zero surviving sources abandoned')
    assert.deepEqual(q3.remaining_source_memory_ids, [], 'no reference to any forgotten source remains')
    assert.equal(q3.last_error, 'all_sources_forgotten')
    console.log('PASS F10 forgetting the last surviving source empties and abandons the queue')
  }

  // F11 processing 的 ABA 封口（round-3 P0）：三源 queue 被 worker 领取后遭部分剪枝——
  // 旧 generation 的提交必须 CAS=0，行回 pending 且幸存源保留
  {
    const s2 = await insMem('f11 s2 ' + suite)
    const s3 = await insMem('f11 s3 ' + suite)
    const dDead = randomUUID()   // 已死 derived（只需 queue 行，无需真实 memory）
    await q(
      `INSERT INTO memory_rebuild_queue (tenant_id, agent_id, deleted_derived_memory_id, remaining_source_memory_ids, status, attempt_count, lease_expires_at)
       VALUES ($1,$2,$3,$4,'processing',1, now() + INTERVAL '10 minutes')`,
      [T, A, dDead, [s2, s3]])   // 模拟 worker claim：status=processing, generation=1, 冻结输入含 s2
    const r = await forget({ tenant_id: T, memory_id: s2, reason: 'unit' })
    assert.equal(r.body.ok, true, JSON.stringify(r.body))
    const row = (await q('SELECT status, attempt_count, remaining_source_memory_ids, lease_expires_at FROM memory_rebuild_queue WHERE tenant_id=$1 AND deleted_derived_memory_id=$2', [T, dDead])).rows[0]
    assert.equal(row.status, 'pending', 'partially pruned processing row returns to pending')
    assert.equal(Number(row.attempt_count), 2, 'generation bumped -- old claim disqualified')
    assert.deepEqual(row.remaining_source_memory_ids, [s3], 'survivor kept for the NEXT claim')
    assert.equal(row.lease_expires_at, null)
    // 旧 worker 按冻结契约提交：CAS status=processing AND attempt_count=1 -> 必须 0 行
    const staleCommit = await q(
      `UPDATE memory_rebuild_queue SET status='completed', completed_at=now()
       WHERE tenant_id=$1 AND deleted_derived_memory_id=$2 AND status='processing' AND attempt_count=1`,
      [T, dDead])
    assert.equal(staleCommit.rowCount, 0, 'stale generation commit fenced out')
    console.log('PASS F11 partially pruned processing claim loses commit rights (ABA sealed)')
  }

  console.log('ALL P0-08 FORGET ASSERTIONS PASSED (F1-F11)')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    for (const tbl of ['memory_rebuild_queue', 'memory_tombstones', 'memory_derivations', 'nightly_runs', 'memories']) {
      await q(`DELETE FROM ${tbl} WHERE tenant_id LIKE $1 || '%'`, [suite])
    }
    const n = (await q(`SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id LIKE $1 || '%'`, [suite])).rows[0].n
    const tn = (await q(`SELECT count(*)::INT4 AS n FROM memory_tombstones WHERE tenant_id LIKE $1 || '%'`, [suite])).rows[0].n
    if (n || tn) cleanupErrors.push(new Error(`residual: memories=${n} tombstones=${tn}`))
    else console.log('cleanup done (residual: all zero)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
