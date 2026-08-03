// nightly dream job（P0-07 方案 B + 二审收口）：低权重碎片 -> 浓缩 derived memory -> 源沉底。
// 契约：
//   - 选源对齐 due queue（低水位=fade_threshold，二审#1）：due 且 fresh/event/非 derived/
//     importance<0.5/credited=0/episode 非 NULL 的行有界扫（dream_scan_rows），
//     (agent, episode) 分组、>=min_cluster 成簇、簇内 created_at 升序取 max_sources_per_cluster，
//     簇间按 (agent_id, episode_id) 排序取 max_clusters——dream 挑簇、transition 处理余行
//   - derived 硬排除（source<>'derived'，一审#3——防梦中梦回流）
//   - 每簇独立 identity（一审#4）：cluster_fingerprint -> 确定性 derived_memory_id；
//     逐簇 idempotent insert（已存在核对 checksum 一致，不同=invariant abort）；
//     任一簇失败整批零产物零 fade
//   - server 封口（二审#6）：结构校验 -> deterministic admission -> 才 embedding；
//     time_range 由 server 从源 created_at 计算；模型只产 summary/salient_points
//   - Dream Receipt：输入侧=source_snapshot（immutable），输出侧=result_receipt（028）
//   - 失败分类（二审#5）：provider/embedding transient -> markRetryable（lease 立即过期，
//     同 snapshot 可 takeover）；schema/admission/invariant -> terminal failed
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inSerializableTx } from '../lib/db.mjs'
import { canonicalJson } from '../lib/canonical-json.mjs'
import { scheduleNext } from '../lib/scheduler.mjs'
import { embed, embedModelId } from '../lib/embed.mjs'
import { toVectorLiteral, canonicalDigest } from '../lib/vector-canonical.mjs'
import { runAdmissionGate } from '../lib/admission.mjs'
import { dreamSummarize, NIGHTLY_PROVIDER, NIGHTLY_MODEL_ID, PROMPT_VERSION } from '../lib/nightly-provider.mjs'
import { claimNightlyRun, fenceUpdate, markRetryable } from './run-harness.mjs'

export const DREAM_CFG = {
  min_cluster: 3,
  max_clusters: 5,
  max_sources_per_cluster: 8,
  batch_size: 200,          // dream_scan_rows：due 队列扫描的 source 行数上限
  lease_minutes: 10,
  max_attempts: 3,
}

export const dreamPipelineVersionOf = (cfg) => [
  // v2: 加入精确 embedding 身份（derived payload 的向量随 embed 空间变化，结论 55）
  'dream-v2', `embed=${embedModelId()}`, `prov=${NIGHTLY_PROVIDER}`, `model=${NIGHTLY_MODEL_ID}`, `prompt=${PROMPT_VERSION}`,
  `minc=${DREAM_CFG.min_cluster}`, `maxc=${DREAM_CFG.max_clusters}`, `maxsrc=${DREAM_CFG.max_sources_per_cluster}`,
  `scan=${cfg.batch_size}`,
].join('|')

export const assertDreamPolicyFrozen = (cfg) => {
  for (const k of ['min_cluster', 'max_clusters', 'max_sources_per_cluster']) {
    if (k in cfg && cfg[k] !== DREAM_CFG[k]) throw new Error(`semantic_policy_override_forbidden:${k}`)
  }
}

// 确定性 derived id：cluster_fingerprint 前 16 字节整形为合法 UUID（v8 风格自定位）
const derivedIdOf = (clusterFingerprint) => {
  const b = Buffer.from(clusterFingerprint)
  b[6] = (b[6] & 0x0f) | 0x80   // version nibble 置 8（custom）
  b[8] = (b[8] & 0x3f) | 0x80   // variant 10xx
  const h = b.subarray(0, 16).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

const SRC_COLS = `memory_id, revision, agent_id, episode_id, content, importance, created_at`

const mkSelectAndSnapshot = (tenantId, cfg, pipelineVersion) => async (c, evalIso) => {
  const rows = (await c.query(
    `SELECT ${SRC_COLS} FROM memories
     WHERE tenant_id=$1 AND next_transition_at IS NOT NULL AND next_transition_at <= $2
       AND layer='event' AND source <> 'derived' AND admission='accepted' AND NOT pinned AND state='fresh'
       AND importance < 0.5 AND credited_success_count = 0 AND episode_id IS NOT NULL
     ORDER BY next_transition_at, memory_id LIMIT ${cfg.batch_size}`,
    [tenantId, evalIso])).rows
  if (rows.length === 0) return null
  // (agent, episode) 分组 -> 成簇 -> 截取 -> 簇间稳定排序
  const groups = new Map()
  for (const r of rows) {
    const k = JSON.stringify([r.agent_id, r.episode_id])   // tuple key：无分隔符碰撞
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const clusters = []
  for (const members of groups.values()) {
    if (members.length < DREAM_CFG.min_cluster) continue
    members.sort((a, b) => a.created_at - b.created_at || (a.memory_id < b.memory_id ? -1 : 1))
    clusters.push(members.slice(0, DREAM_CFG.max_sources_per_cluster))
  }
  if (clusters.length === 0) return null   // 有 due 行但不成簇：dream no-work，行留给 transition
  clusters.sort((a, b) => a[0].agent_id < b[0].agent_id ? -1 : a[0].agent_id > b[0].agent_id ? 1
    : a[0].episode_id < b[0].episode_id ? -1 : a[0].episode_id > b[0].episode_id ? 1 : 0)
  const picked = clusters.slice(0, DREAM_CFG.max_clusters)
  const withIds = picked.map(members => {
    const fp = createHash('sha256').update(canonicalJson({
      members: members.map(m => [m.memory_id, String(m.revision)]),
      evaluation_at: evalIso, pipeline_version: pipelineVersion,
    })).digest()
    return { members, cluster_fingerprint: fp, derived_memory_id: derivedIdOf(fp) }
  })
  return {
    sources: withIds,
    snapshot: { clusters: withIds.map(cl => ({
      agent_id: cl.members[0].agent_id, episode_id: cl.members[0].episode_id,
      members: cl.members.map(m => [m.memory_id, String(m.revision)]),
      cluster_fingerprint: cl.cluster_fingerprint.toString('hex'),
      derived_memory_id: cl.derived_memory_id,
    })) },
    fingerprint: createHash('sha256').update(canonicalJson({
      job_kind: 'dream', cluster_fingerprints: withIds.map(cl => cl.cluster_fingerprint.toString('hex')),
      evaluation_at: evalIso, pipeline_version: pipelineVersion,
    })).digest(),
  }
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', '57P01', '08006', '08001'])
const isTransient = (e) => TRANSIENT_CODES.has(e?.code) || /timeout|throttl|5\d\d|reset/i.test(e?.message ?? '')

export const claimDream = async (tenantId, evaluationAtIso, cfg = DREAM_CFG) => {
  const pipelineVersion = dreamPipelineVersionOf(cfg)
  return claimNightlyRun({
    tenantId, evaluationAtIso, jobKind: 'dream', pipelineVersion, cfg,
    selectAndSnapshot: mkSelectAndSnapshot(tenantId, cfg, pipelineVersion),
  })
}

// execute 阶段独立导出（二审#5：真实 stale/race 测试需要 claim 与 execute 之间的注入点）
export const executeDream = async (tenantId, evaluationAtIso, claim) => {
  const evalMs = new Date(evaluationAtIso).getTime()
  const fence = { tenantId, runId: claim.run_id, expectedAttempt: claim.expected_attempt }

  // 模型段 + embedding：全部事务外（结论 13/16）。任一簇失败 -> 整批零产物。
  let products
  try {
    products = []
    for (const cl of claim.sources) {
      const narrative = await dreamSummarize(cl.members)
      // server 封口：结构校验 -> deterministic admission -> 才 embedding
      if (typeof narrative?.summary !== 'string' || narrative.summary.length < 1 || narrative.summary.length > 1000
          || !Array.isArray(narrative.salient_points) || narrative.salient_points.length > 8) {
        throw Object.assign(new Error('dream_output_schema_rejected'), { terminal: true })
      }
      // salient_points 固定 canonical rendering 纳入正文与 checksum（一审#10：不静默丢弃）
      const rendered = narrative.salient_points.length
        ? `${narrative.summary}
[salient] ${narrative.salient_points.join(' | ')}`
        : narrative.summary
      const gate = runAdmissionGate({ content: rendered })
      if (gate.admission !== 'accepted') {
        throw Object.assign(new Error('dream_output_admission_rejected'), { terminal: true })
      }
      const e = await embed(gate.canonical)
      const importance = Math.max(...cl.members.map(m => Number(m.importance)))
      const created = cl.members.map(m => new Date(m.created_at).getTime())
      products.push({
        cluster: cl, content: gate.canonical, f32: e.f32, embedding_model_id: e.model_id, embedMeta: { model_id: e.model_id, provider: e.provider }, importance,
        time_range: { from: new Date(Math.min(...created)).toISOString(), to: new Date(Math.max(...created)).toISOString() },
        output_checksum: createHash('sha256').update(gate.canonical).digest('hex'),
      })
    }
  } catch (e) {
    if (e.terminal) {
      await inSerializableTx(async (c) => fenceUpdate(c, fence, `status='failed', error_code=$4`, [e.message.slice(0, 60)]), 'dream-fail')
      const r = { outcome: 'failed', run_id: claim.run_id, reason: e.message, control: claim.control }
      console.log(JSON.stringify({ evt: 'dream_run', tenant_id: tenantId, scheduled_for: evaluationAtIso, ...r }))
      return r
    }
    if (isTransient(e)) {
      await markRetryable({ ...fence, errorCode: 'provider_transient' })
      const r = { outcome: 'retryable', run_id: claim.run_id, reason: e.message?.slice(0, 120), control: claim.control }
      console.log(JSON.stringify({ evt: 'dream_run', tenant_id: tenantId, scheduled_for: evaluationAtIso, ...r }))
      return r
    }
    await markRetryable({ ...fence, errorCode: 'unclassified_error' }).catch(() => {})
    throw e
  }

  // 最终事务：revalidate 全簇 -> 逐簇 idempotent insert + edges -> fade 全部源 -> receipt -> completed
  const result = await inSerializableTx(async (c) => {
    const allIds = claim.sources.flatMap(cl => cl.members.map(m => m.memory_id))
    const live = (await c.query(
      `SELECT memory_id, revision FROM memories WHERE tenant_id=$1 AND memory_id = ANY($2)`,
      [tenantId, allIds])).rows
    const revById = new Map(live.map(r => [r.memory_id, String(r.revision)]))
    const mismatch = claim.sources.some(cl => cl.members.some(m => revById.get(m.memory_id) !== String(m.revision)))
    if (mismatch) {
      await fenceUpdate(c, fence, `status='stale'`)
      return { outcome: 'stale', run_id: claim.run_id }
    }
    for (const p of products) {
      const cl = p.cluster
      const existing = (await c.query(
        `SELECT content, agent_id, episode_id, source, admission, embedding::STRING AS emb
         FROM memories WHERE tenant_id=$1 AND memory_id=$2`, [tenantId, cl.derived_memory_id])).rows[0]
      if (existing) {
        // 幂等重入必须逐字段核对 payload/provenance（一审#7 尾款）——任何分歧=不变量破坏
        const embSame = existing.emb != null
          && canonicalDigest(Float32Array.from(JSON.parse(existing.emb))).equals(canonicalDigest(p.f32))
        if (existing.content !== p.content || existing.agent_id !== cl.members[0].agent_id
            || existing.episode_id !== cl.members[0].episode_id || existing.source !== 'derived'
            || existing.admission !== 'accepted' || !embSame) {
          throw new Error(`derived_payload_divergence:${cl.derived_memory_id}`)
        }
      } else {
        const halfLife = 72 * (1 + p.importance)
        const nextAt = scheduleNext({ admission: 'accepted', pinned: false, state: 'fresh',
          strength_anchor: 1.0, strength_anchor_at: new Date(evalMs), half_life_hours: halfLife,
          credited_success_count: 0, consolidation_baseline: 0 }, evalMs)
        await c.query(
          `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, embedding_model_id, source,
             admission, state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at,
             half_life_hours, credited_success_count, consolidation_baseline, next_transition_at)
           VALUES ($1,$2,$3,'event',$4,$5,$6,$7,'derived','accepted','fresh',false,$8,1.0,$9,$9,$10,0,0,$11)`,
          [tenantId, cl.members[0].agent_id, cl.derived_memory_id, cl.members[0].episode_id,
           p.content, toVectorLiteral(p.f32), p.embedding_model_id, p.importance, new Date(evalMs), halfLife, nextAt])
      }
      for (const m of cl.members) {
        const ins = await c.query(
          `INSERT INTO memory_derivations (tenant_id, derived_memory_id, source_memory_id, run_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, derived_memory_id, source_memory_id) DO NOTHING`,
          [tenantId, cl.derived_memory_id, m.memory_id, claim.run_id])
        if (ins.rowCount === 0) {
          // edge 已存在只可能是同 run retry（fingerprint 含 evaluation，跨晚 id 必不同）——核对 run 归属
          const edge = (await c.query(
            'SELECT run_id FROM memory_derivations WHERE tenant_id=$1 AND derived_memory_id=$2 AND source_memory_id=$3',
            [tenantId, cl.derived_memory_id, m.memory_id])).rows[0]
          if (edge.run_id !== claim.run_id) throw new Error(`derivation_edge_run_divergence:${cl.derived_memory_id}`)
        }
      }
    }
    // 全簇成功才 fade 全部源（dream 专属 fade：baseline=count 照常）
    await c.query(
      `UPDATE memories SET state='faded', next_transition_at=NULL, consolidation_baseline=credited_success_count,
         revision=revision+1 WHERE tenant_id=$1 AND memory_id = ANY($2)`,
      [tenantId, allIds])
    const receipt = {
      schema_version: 'dream-receipt-v1',
      clusters: products.map(p => ({
        cluster_fingerprint: p.cluster.cluster_fingerprint.toString('hex'),
        derived_memory_id: p.cluster.derived_memory_id,
        provider: NIGHTLY_PROVIDER, model_id: NIGHTLY_MODEL_ID, prompt_version: PROMPT_VERSION,
        embed: p.embedMeta ?? null, output_checksum: p.output_checksum, time_range: p.time_range,
        source_count: p.cluster.members.length,
      })),
    }
    await fenceUpdate(c, fence, `status='completed', completed_at=now(), result_receipt=$4`, [receipt])
    return { outcome: 'completed', run_id: claim.run_id,
             counts: { clusters: products.length, sources_faded: allIds.length } }
  }, 'dream-execute')
  const final = { ...result, control: claim.control }
  console.log(JSON.stringify({ evt: 'dream_run', tenant_id: tenantId, scheduled_for: evaluationAtIso, ...final }))
  return final
}

export const runDream = async ({ tenantId, scheduledFor, cfg = DREAM_CFG }) => {
  if (Number.isNaN(new Date(scheduledFor).getTime())) throw new Error('scheduled_for_invalid')
  assertDreamPolicyFrozen(cfg)
  const evaluationAtIso = new Date(scheduledFor).toISOString()
  const claim = await claimDream(tenantId, evaluationAtIso, cfg)
  if (claim.outcome !== 'claimed') {
    console.log(JSON.stringify({ evt: 'dream_run', tenant_id: tenantId, scheduled_for: evaluationAtIso, ...claim }))
    return claim
  }
  return executeDream(tenantId, evaluationAtIso, claim)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  let scheduledFor = null, tenantId = 'demo-tenant'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scheduled-for') scheduledFor = args[++i]
    else if (args[i] === '--tenant') tenantId = args[++i]
    else throw new Error(`unknown argument: ${args[i]}`)
  }
  if (!scheduledFor) throw new Error('--scheduled-for <ISO timestamp> is required')
  const { getPool } = await import('../lib/db.mjs')
  try { await runDream({ tenantId, scheduledFor }) } finally { await getPool().end().catch(() => {}) }
}
