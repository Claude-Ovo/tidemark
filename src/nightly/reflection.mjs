// nightly reflection job（P0-07 方案 C + 二审收口）：failure->success 配对 -> 结构化经验 candidate。
// 契约：
//   - exactly-once 由 reflection_pairs 账本承担（027）：PK (tenant,agent,failure_attempt,success_attempt)，
//     选源 NOT EXISTS 反连接；semantic dedup 只去语义重复（一审#5）
//   - 配对规则冻结：failure outcome 后 72h 内、同 (agent,task,episode) 的最早 success，
//     tiebreak (reported_at, outcome_request_id, attempt_id)；双方 reported_at <= evaluation_at；
//     选源由近期 success 驱动反查（retention=120h 界定扫描窗，根治 failure 队首饥饿）
//   - 终态真相=outcomes（二审#2）：账本存双方 outcome_request_id 并 FK；不伪造 attempt_end；
//     pair_fingerprint 覆盖两 outcome IDs/status/reported_at + 全部送模事件 hashes
//   - 截断先保必需证据（二审#3）：failure 侧 error/user_correction anchors + success 侧
//     terminal anchor（其事件中 created_at 最大者，若有）固定入选，再按 created_at 升序填
//     剩余额度（32 事件 / 16384 canonical-UTF8 字节）；必需 anchors 自身超限 -> 该 pair
//     input_too_large 跳过并记 receipt，绝不悄悄删证据
//   - dedup scope-aware + batch-aware（二审#4）：同批产物按稳定 pair 顺序互查 + DB 内
//     (tenant,agent,experience,candidate,accepted,scope 相等) 有界候选精确 cosine >= 0.92，
//     ORDER BY distance, memory_id 定胜者；命中则账本/evidence 全指向 winner
//   - server 封口（二审#6）：evidence_ids 由 server 从冻结 anchors 写入，模型只产叙述字段；
//     scope v1 由 server 冻结为 'task'；结构校验 -> admission -> 才 embedding
//   - 失败分类（二审#5）：transient -> markRetryable；schema/admission/事件 hash 不符 -> terminal
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inSerializableTx } from '../lib/db.mjs'
import { canonicalJson } from '../lib/canonical-json.mjs'
import { scheduleNext } from '../lib/scheduler.mjs'
import { embed } from '../lib/embed.mjs'
import { toVectorLiteral } from '../lib/vector-canonical.mjs'
import { runAdmissionGate } from '../lib/admission.mjs'
import { reflectExtract, NIGHTLY_PROVIDER, NIGHTLY_MODEL_ID, PROMPT_VERSION } from '../lib/nightly-provider.mjs'
import { claimNightlyRun, fenceUpdate, markRetryable } from './run-harness.mjs'

export const REFLECT_CFG = {
  window_hours: 72,            // 只约束 success.reported_at - failure.reported_at
  retention_hours: 120,        // failure 扫描下限=窗口+领取延迟 grace（覆盖 nightly 周期，一审#4）
  max_pairs: 5,
  max_events_per_pair: 32,
  max_pair_bytes: 16384,
  dedup_threshold: 0.92,
  batch_size: 200,          // reflect_scan_failures：failure 扫描行数上限
  lease_minutes: 10,
  max_attempts: 3,
}

export const reflectPipelineVersionOf = (cfg) => [
  'reflect-v2', 'cursor=v1',   // v2: durable keyset cursor 选源（round-4/5）——snapshot/fingerprint/重试语义全变
  `prov=${NIGHTLY_PROVIDER}`, `model=${NIGHTLY_MODEL_ID}`, `prompt=${PROMPT_VERSION}`,
  `win=${REFLECT_CFG.window_hours}`, `ret=${REFLECT_CFG.retention_hours}`, `maxp=${REFLECT_CFG.max_pairs}`, `maxev=${REFLECT_CFG.max_events_per_pair}`,
  `maxb=${REFLECT_CFG.max_pair_bytes}`, `dedup=${REFLECT_CFG.dedup_threshold}`, `scan=${cfg.batch_size}`,
].join('|')

export const assertReflectPolicyFrozen = (cfg) => {
  for (const k of ['window_hours', 'retention_hours', 'max_pairs', 'max_events_per_pair', 'max_pair_bytes', 'dedup_threshold']) {
    if (k in cfg && cfg[k] !== REFLECT_CFG[k]) throw new Error(`semantic_policy_override_forbidden:${k}`)
  }
}

const experienceIdOf = (pairFingerprint) => {
  const b = Buffer.from(pairFingerprint)
  b[6] = (b[6] & 0x0f) | 0x80
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.subarray(0, 16).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// hash 覆盖全部实际送模字段（一审#9）：event_type/attempt/created_at 参与判定与 prompt，全部入指纹
const eventHash = (e) => createHash('sha256').update(canonicalJson(
  [e.event_id, e.event_type, e.attempt_id, new Date(e.created_at).toISOString(), e.payload ?? {}])).digest('hex')

// canonical provider envelope（二审#4）：budget、fingerprint、provider 请求共用【同一字节串】——
// 计数器与真实模型输入不可能再分离；attempt/task 字符串的长度也天然被同一预算约束
export const mkEnvelope = (f, s, events) => canonicalJson({
  task_instance_id: f.task_instance_id,
  failure_attempt_id: f.attempt_id,
  success_attempt_id: s.attempt_id,
  events: events.map(e => [e.event_id, e.event_type, e.attempt_id, new Date(e.created_at).toISOString(), e.payload ?? {}]),
})
const envelopeBytes = (f, s, events) => Buffer.byteLength(mkEnvelope(f, s, events), 'utf8')

// 截断（二审#3）：先固定必需 anchors，再按 created_at 升序填充；anchors 自身超限 -> null（input_too_large）
const selectPairEvents = (f, s, failureEvents, successEvents) => {
  const anchors = [
    ...failureEvents.filter(e => e.event_type === 'tool_error' || e.event_type === 'user_correction'),
  ]
  const successTerminal = successEvents.length
    ? [successEvents.reduce((a, b) => (a.created_at > b.created_at ? a : b))]
    : []
  anchors.push(...successTerminal)
  if (anchors.length > REFLECT_CFG.max_events_per_pair || envelopeBytes(f, s, anchors) > REFLECT_CFG.max_pair_bytes) return null
  const anchorIds = new Set(anchors.map(e => e.event_id))
  const rest = [...failureEvents, ...successEvents]
    .filter(e => !anchorIds.has(e.event_id))
    .sort((a, b) => a.created_at - b.created_at || (a.event_id < b.event_id ? -1 : 1))
  const chosen = [...anchors]
  for (const e of rest) {
    if (chosen.length >= REFLECT_CFG.max_events_per_pair) break
    if (envelopeBytes(f, s, [...chosen, e]) > REFLECT_CFG.max_pair_bytes) continue
    chosen.push(e)
  }
  return { chosen, anchors }
}

const OUT_COLS = 'outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, reported_at'

const mkSelectAndSnapshot = (tenantId, cfg, pipelineVersion) => async (c, evalIso) => {
  // round-3 #1/#2：durable keyset cursor + 单条 set-based 查询。
  // 扫描 = cursor 之后的 failure 有界 200 行（无论有无 success——方向回到 failure 驱动，
  // 但 cursor 保证 keyset progress：过窗无望的行被永久越过，不再遮挡后来者）；
  // LATERAL 在同一查询内为每行取最早 success（计划内点查，非 200 次 round trip）。
  // fan-out 天然成立：五个 failure 共享同一 success 也各自成对。
  // cursor 推进规则：只越过【前缀连续的已终结行】——本晚配对/skip 入账本、历史已消费、
  // 或 已过窗且无 success（永久无望）；窗内 waiting 或本晚超额度的行挡住 cursor（语义正确的等待）。
  // 容量 SLA（SPEC §6）：每 tenant 窗内未配对 failure 须 < scan(200)，超出属运维事件。
  // cursor 比较全程留在 SQL 域（微秒精度）：JS Date 只有毫秒，读回再传回会把 cursor
  // 压小一截、行反复扫到自己。JS 只读 cursor 作 snapshot 审计记录，不参与比较。
  // retention seed（round-5 #2 + round-6 #1）：每次 claim 都以 tuple-max 语义把 cursor
  // 抬到"retention 窗外最后一行"——不仅覆盖首次接触，也升级 round-4 遗留的 epoch/落后
  // cursor（它们同样不许按 200/晚回放 migration 前历史）。当前 cursor 已更远则 no-op；
  // 与推进用同一单调不变量，seed 永不使 cursor 后退。
  await c.query(
    `INSERT INTO reflection_cursor (tenant_id, last_reported_at, last_outcome_request_id, updated_at)
     SELECT $1, reported_at, outcome_request_id, now() FROM outcomes
     WHERE tenant_id=$1 AND status='failure'
       AND reported_at < $2::TIMESTAMPTZ - ($3::FLOAT8 * INTERVAL '1 hour')
     ORDER BY reported_at DESC, outcome_request_id DESC LIMIT 1
     ON CONFLICT (tenant_id) DO UPDATE SET
       last_reported_at=excluded.last_reported_at,
       last_outcome_request_id=excluded.last_outcome_request_id,
       updated_at=now()
     WHERE (excluded.last_reported_at, excluded.last_outcome_request_id)
         > (reflection_cursor.last_reported_at, reflection_cursor.last_outcome_request_id)`,
    [tenantId, evalIso, REFLECT_CFG.retention_hours])
  const cur = (await c.query(
    'SELECT last_reported_at, last_outcome_request_id FROM reflection_cursor WHERE tenant_id=$1',
    [tenantId])).rows[0] ?? { last_reported_at: new Date(0), last_outcome_request_id: '' }
  const scan = (await c.query(
    `WITH cur AS (
       SELECT COALESCE((SELECT last_reported_at FROM reflection_cursor WHERE tenant_id=$1), '1970-01-01'::TIMESTAMPTZ) AS at,
              COALESCE((SELECT last_outcome_request_id FROM reflection_cursor WHERE tenant_id=$1), '') AS orid
     ), scan AS MATERIALIZED (
       SELECT ${OUT_COLS} FROM outcomes, cur
       WHERE tenant_id=$1 AND status='failure' AND reported_at <= $2
         AND (reported_at, outcome_request_id) > (cur.at, cur.orid)
       ORDER BY reported_at, outcome_request_id LIMIT ${cfg.batch_size}
     )
     SELECT f.*, s.outcome_request_id AS s_orid, s.attempt_id AS s_attempt, s.reported_at AS s_reported,
            EXISTS (SELECT 1 FROM reflection_pairs rp
                    WHERE rp.tenant_id=$1 AND rp.agent_id=f.agent_id AND rp.failure_attempt_id=f.attempt_id) AS consumed
     FROM scan f
     LEFT JOIN LATERAL (
       SELECT outcome_request_id, attempt_id, reported_at FROM outcomes s
       WHERE s.tenant_id=$1 AND s.agent_id=f.agent_id AND s.task_instance_id=f.task_instance_id
         AND s.episode_id=f.episode_id AND s.status='success'
         AND s.reported_at > f.reported_at
         AND s.reported_at <= LEAST($2::TIMESTAMPTZ, f.reported_at + ($3::FLOAT8 * INTERVAL '1 hour'))
       ORDER BY s.reported_at, s.outcome_request_id, s.attempt_id LIMIT 1
     ) s ON true
     ORDER BY f.reported_at, f.outcome_request_id`,
    [tenantId, evalIso, REFLECT_CFG.window_hours])).rows
  if (scan.length === 0) return null
  const evalMs = new Date(evalIso).getTime()
  const pairs = []
  let workableCount = 0
  let cursorRow = null
  let prefixOpen = true
  for (const row of scan) {
    const f = { outcome_request_id: row.outcome_request_id, agent_id: row.agent_id, episode_id: row.episode_id,
                task_instance_id: row.task_instance_id, attempt_id: row.attempt_id, status: row.status, reported_at: row.reported_at }
    const expired = row.s_orid == null && new Date(row.reported_at).getTime() + REFLECT_CFG.window_hours * 3600e3 < evalMs
    let terminated = false
    if (row.consumed || expired) {
      terminated = true                       // 历史已消费（幂等防重）或过窗无望（永久越过）
    } else if (row.s_orid != null && workableCount < REFLECT_CFG.max_pairs) {
      const su = { outcome_request_id: row.s_orid, attempt_id: row.s_attempt, reported_at: row.s_reported, status: 'success',
                   agent_id: row.agent_id, episode_id: row.episode_id, task_instance_id: row.task_instance_id }
      const evs = (await c.query(
        `SELECT event_id, attempt_id, event_type, payload, created_at FROM attempt_events
         WHERE tenant_id=$1 AND agent_id=$2 AND attempt_id = ANY($3) AND created_at <= $4
         ORDER BY created_at, event_id`,
        [tenantId, f.agent_id, [f.attempt_id, su.attempt_id], evalIso])).rows
      const failureEvents = evs.filter(e => e.attempt_id === f.attempt_id)
      const successEvents = evs.filter(e => e.attempt_id === su.attempt_id)
      const sel = selectPairEvents(f, su, failureEvents, successEvents)
      if (!sel) {
        pairs.push({ skipped: 'input_too_large', failure: f, success: su })
        terminated = true                     // skip 也落账本 = 终结
      } else {
        const envelope = mkEnvelope(f, su, sel.chosen)
        const eventHashes = sel.chosen.map(e => [e.event_id, eventHash(e)])
        const fp = createHash('sha256').update(canonicalJson({
          failure: [f.outcome_request_id, f.status, new Date(f.reported_at).toISOString()],
          success: [su.outcome_request_id, 'success', new Date(su.reported_at).toISOString()],
          envelope_sha256: createHash('sha256').update(envelope).digest('hex'),
          event_hashes: eventHashes, evaluation_at: evalIso, pipeline_version: pipelineVersion,
        })).digest()
        pairs.push({ failure: f, success: su, events: sel.chosen, anchors: sel.anchors, envelope,
                     event_hashes: eventHashes, pair_fingerprint: fp, experience_id: experienceIdOf(fp) })
        workableCount++
        terminated = true
      }
    }
    // waiting（窗内无 success）或超额度的可配行：挡住 cursor
    if (prefixOpen && terminated) cursorRow = f
    else prefixOpen = false
  }
  const cursorAdvance = cursorRow ? {
    from_at: new Date(cur.last_reported_at).toISOString(), from_orid: cur.last_outcome_request_id,
    to_at: new Date(cursorRow.reported_at).toISOString(), to_orid: cursorRow.outcome_request_id,
  } : null
  if (pairs.length === 0 && !cursorAdvance) return null   // 全 waiting：无事可做、cursor 不动
  return {
    sources: pairs,
    cursorAdvance,
    snapshot: { cursor_advance: cursorAdvance, pairs: pairs.map(p => p.skipped ? {
      skipped: p.skipped, failure_attempt_id: p.failure.attempt_id, success_attempt_id: p.success.attempt_id,
    } : {
      failure_outcome_request_id: p.failure.outcome_request_id, success_outcome_request_id: p.success.outcome_request_id,
      failure_attempt_id: p.failure.attempt_id, success_attempt_id: p.success.attempt_id,
      agent_id: p.failure.agent_id, task_instance_id: p.failure.task_instance_id, episode_id: p.failure.episode_id,
      event_hashes: p.event_hashes, anchors: p.anchors.map(e => e.event_id),
      pair_fingerprint: p.pair_fingerprint.toString('hex'), experience_id: p.experience_id,
    }) },
    fingerprint: createHash('sha256').update(canonicalJson({
      job_kind: 'reflection',
      pair_fingerprints: pairs.filter(p => !p.skipped).map(p => p.pair_fingerprint.toString('hex')),
      cursor_advance: cursorAdvance, evaluation_at: evalIso, pipeline_version: pipelineVersion,
    })).digest(),
  }
}

const SCOPE_V1 = 'task'
const FIELD_MAX = 200
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', '57P01', '08006', '08001'])
const isTransient = (e) => TRANSIENT_CODES.has(e?.code) || /timeout|throttl|5\d\d|reset/i.test(e?.message ?? '')

export const claimReflection = async (tenantId, evaluationAtIso, cfg = REFLECT_CFG) => {
  const pipelineVersion = reflectPipelineVersionOf(cfg)
  return claimNightlyRun({
    tenantId, evaluationAtIso, jobKind: 'reflection', pipelineVersion, cfg,
    selectAndSnapshot: mkSelectAndSnapshot(tenantId, cfg, pipelineVersion),
  })
}

// execute 阶段独立导出（二审#5：真实 stale/race 测试需要 claim 与 execute 之间的注入点）
export const executeReflection = async (tenantId, evaluationAtIso, claim) => {
  const evalMs = new Date(evaluationAtIso).getTime()
  const fence = { tenantId, runId: claim.run_id, expectedAttempt: claim.expected_attempt }
  const workable = claim.sources.filter(p => !p.skipped)
  const skipped = claim.sources.filter(p => p.skipped)
  // resolved_experience_id 显式贯穿（一审#7）：product 上保存最终指向，receipt 三值分明

  // 模型段 + 校验 + embedding（事务外）
  let products
  try {
    products = []
    for (const p of workable) {
      // provider 直接收 canonical envelope 字符串（round-3 #4）：budget/fingerprint/请求同一字节串，
      // provider 内部自行解析——不存在第二种序列化形态
      const narrative = await reflectExtract(p.envelope)
      for (const k of ['trigger', 'wrong_action', 'correct_action', 'caution']) {
        if (typeof narrative?.[k] !== 'string' || narrative[k].length < 1 || narrative[k].length > FIELD_MAX) {
          throw Object.assign(new Error(`reflection_output_schema_rejected:${k}`), { terminal: true })
        }
      }
      if (typeof narrative.confidence !== 'number' || !Number.isFinite(narrative.confidence)
          || narrative.confidence < 0 || narrative.confidence > 1) {
        throw Object.assign(new Error('reflection_output_schema_rejected:confidence'), { terminal: true })
      }
      const text = `${narrative.trigger} ${narrative.correct_action} ${narrative.caution}`
      const gate = runAdmissionGate({ content: text })
      if (gate.admission !== 'accepted') throw Object.assign(new Error('reflection_output_admission_rejected'), { terminal: true })
      const e = await embed(gate.canonical)
      products.push({
        pair: p, narrative, content: gate.canonical, f32: e.f32,
        embedMeta: { model_id: e.model_id, provider: e.provider },
        evidence_ids: p.anchors.map(a => a.event_id),   // server 封口：模型永不生成
        output_checksum: createHash('sha256').update(gate.canonical).digest('hex'),
      })
    }
  } catch (e) {
    if (e.terminal) {
      await inSerializableTx(async (c) => fenceUpdate(c, fence, `status='failed', error_code=$4`, [e.message.slice(0, 60)]), 'reflect-fail')
      const r = { outcome: 'failed', run_id: claim.run_id, reason: e.message, control: claim.control }
      console.log(JSON.stringify({ evt: 'reflection_run', tenant_id: tenantId, scheduled_for: evaluationAtIso, ...r }))
      return r
    }
    if (isTransient(e)) {
      await markRetryable({ ...fence, errorCode: 'provider_transient' })
      const r = { outcome: 'retryable', run_id: claim.run_id, reason: e.message?.slice(0, 120), control: claim.control }
      console.log(JSON.stringify({ evt: 'reflection_run', tenant_id: tenantId, scheduled_for: evaluationAtIso, ...r }))
      return r
    }
    // 未分类异常：run 标 retryable（lease 立即过期可 takeover）后再抛——绝不悬 running 等 lease
    await markRetryable({ ...fence, errorCode: 'unclassified_error' }).catch(() => {})
    throw e
  }

  // batch 内 dedup（一审#1 + 二审#1）：仅同 (agent, scope) 分区内互查；winner 存【root product
  // 引用】而非 ID——root 的最终 resolved_experience_id 要等 DB dedup 之后才知道，
  // 后继沿引用链取根，绝不指向可能永不落库的生成 ID
  const rootOf = (prod) => { let r = prod; while (r.batchRoot) r = r.batchRoot; return r }
  for (let i = 0; i < products.length; i++) {
    for (let j = 0; j < i; j++) {
      if (products[j].pair.failure.agent_id !== products[i].pair.failure.agent_id) continue   // scope v1 恒 'task'
      const w = rootOf(products[j])
      if (cosine(products[i].f32, w.f32) >= REFLECT_CFG.dedup_threshold) {
        products[i].batchRoot = w
        break
      }
    }
  }

  let result
  try {
    result = await inSerializableTx(async (c) => {
      // 事件 hash 重读核对（append-only 的 revalidate 替代，一审#9：全字段同指纹）
      for (const p of workable) {
        const evs = (await c.query(
          `SELECT event_id, attempt_id, event_type, payload, created_at FROM attempt_events
           WHERE tenant_id=$1 AND agent_id=$2 AND attempt_id = ANY($3) AND created_at <= $4`,
          [tenantId, p.failure.agent_id, [p.failure.attempt_id, p.success.attempt_id], evaluationAtIso])).rows
        const liveHash = new Map(evs.map(e => [e.event_id, eventHash(e)]))
        for (const [id, h] of p.event_hashes) {
          if (liveHash.get(id) !== h) {
            await fenceUpdate(c, fence, `status='failed', error_code='event_snapshot_divergence'`)
            return { outcome: 'failed', run_id: claim.run_id, reason: 'event_snapshot_divergence' }
          }
        }
      }
      let inserted = 0, dedupBatch = 0, dedupDb = 0
      // pass 1a：只有 batch root 做 DB dedup（二审#1：root 的最终 ID 可能是既有 DB candidate，
      // 后继必须等 root 定型后沿引用链取，绝不提前指向可能永不落库的生成 ID）
      for (const prod of products) {
        if (prod.batchRoot) continue
        // DB 内 (agent, scope) dedup：有界候选 + 精确 cosine 复核（低频 nightly 路径，LIMIT 10）
        const cands = (await c.query(
          `SELECT memory_id, embedding::STRING AS emb FROM memories
           WHERE tenant_id=$1 AND agent_id=$2 AND layer='experience' AND exp_status='candidate'
             AND admission='accepted' AND (experience_body->>'scope') = $3 AND embedding IS NOT NULL
           ORDER BY embedding <=> $4 LIMIT 10`,
          [tenantId, prod.pair.failure.agent_id, SCOPE_V1, toVectorLiteral(prod.f32)])).rows
        let winner = null, best = -1
        for (const cd of cands) {
          const v = Float32Array.from(JSON.parse(cd.emb))
          const sim = cosine(prod.f32, v)
          if (sim >= REFLECT_CFG.dedup_threshold && (sim > best || (sim === best && (!winner || cd.memory_id < winner)))) {
            best = sim; winner = cd.memory_id
          }
        }
        if (winner) { prod.resolved_experience_id = winner; dedupDb++ }
        else prod.resolved_experience_id = prod.pair.experience_id
      }
      // pass 1b：非 root 沿链传播 root 的【最终】resolved（含 root 命中 DB winner 的情形）
      for (const prod of products) {
        if (!prod.batchRoot) continue
        let r = prod
        while (r.batchRoot) r = r.batchRoot
        prod.resolved_experience_id = r.resolved_experience_id
        dedupBatch++
      }
      // pass 2：ledger 原子先占（一审#6）——任何副作用之前。冲突读现行核对指纹：
      // 同指纹=另一 run 已消费该 pair（幂等，本批放弃其副作用）；异指纹=竞态 -> 整批 stale
      const consumedElsewhere = new Set()
      const claimPair = async (agentId, fAtt, sAtt, fOrid, sOrid, fingerprint, experienceId, status) => {
        const ins = await c.query(
          `INSERT INTO reflection_pairs (tenant_id, agent_id, failure_attempt_id, success_attempt_id,
             failure_outcome_request_id, success_outcome_request_id, pair_fingerprint, experience_id, run_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (tenant_id, agent_id, failure_attempt_id, success_attempt_id) DO NOTHING`,
          [tenantId, agentId, fAtt, sAtt, fOrid, sOrid, fingerprint, experienceId, claim.run_id, status])
        if (ins.rowCount === 1) return 'claimed'
        const cur = (await c.query(
          `SELECT pair_fingerprint, run_id FROM reflection_pairs
           WHERE tenant_id=$1 AND agent_id=$2 AND failure_attempt_id=$3 AND success_attempt_id=$4`,
          [tenantId, agentId, fAtt, sAtt])).rows[0]
        if (cur.run_id === claim.run_id) return 'claimed'                      // 同 run retry：已占即幂等
        if (!cur.pair_fingerprint.equals(fingerprint)) {
          throw Object.assign(new Error('pair_ledger_conflict'), { stale: true })
        }
        return 'consumed_elsewhere'                                            // 异 run 同指纹：放弃副作用
      }
      for (const prod of products) {
        const p = prod.pair
        const got = await claimPair(p.failure.agent_id, p.failure.attempt_id, p.success.attempt_id,
          p.failure.outcome_request_id, p.success.outcome_request_id, p.pair_fingerprint,
          prod.resolved_experience_id, 'resolved')
        if (got === 'consumed_elsewhere') consumedElsewhere.add(p.pair_fingerprint.toString('hex'))
      }
      // skipped pairs 也落账本（status='skipped_input_too_large'，确定性指纹不含 evaluation——跨晚幂等）
      for (const p of skipped) {
        const skipFp = createHash('sha256').update(canonicalJson({
          skipped: 'input_too_large', failure_attempt_id: p.failure.attempt_id, success_attempt_id: p.success.attempt_id,
        })).digest()
        await claimPair(p.failure.agent_id, p.failure.attempt_id, p.success.attempt_id,
          p.failure.outcome_request_id, p.success.outcome_request_id, skipFp, null, 'skipped_input_too_large')
      }
      // pass 3：副作用（仅本 run 占到的 pair）
      for (const prod of products) {
        if (consumedElsewhere.has(prod.pair.pair_fingerprint.toString('hex'))) continue
        const finalExperienceId = prod.resolved_experience_id
        if (finalExperienceId === prod.pair.experience_id) {
          const existing = (await c.query('SELECT content, agent_id, episode_id, source, admission FROM memories WHERE tenant_id=$1 AND memory_id=$2',
            [tenantId, finalExperienceId])).rows[0]
          if (existing) {
            if (existing.content !== prod.content || existing.agent_id !== prod.pair.failure.agent_id
                || existing.episode_id !== prod.pair.failure.episode_id
                || existing.source !== 'derived' || existing.admission !== 'accepted') {
              throw new Error(`derived_payload_divergence:${finalExperienceId}`)
            }
          } else {
            const body = { trigger: prod.narrative.trigger, wrong_action: prod.narrative.wrong_action,
              correct_action: prod.narrative.correct_action, caution: prod.narrative.caution,
              evidence_ids: prod.evidence_ids, confidence: prod.narrative.confidence, scope: SCOPE_V1 }
            const halfLife = 2160 * (1 + 0.5)
            const nextAt = scheduleNext({ admission: 'accepted', pinned: false, state: 'fresh',
              strength_anchor: 1.0, strength_anchor_at: new Date(evalMs), half_life_hours: halfLife,
              credited_success_count: 0, consolidation_baseline: 0 }, evalMs)
            await c.query(
              `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding,
                 experience_body, exp_status, source, admission, state, pinned, importance,
                 strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
                 credited_success_count, consolidation_baseline, next_transition_at)
               VALUES ($1,$2,$3,'experience',$4,$5,$6,$7,'candidate','derived','accepted','fresh',false,0.5,
                 1.0,$8,$8,$9,0,0,$10)`,
              [tenantId, prod.pair.failure.agent_id, finalExperienceId, prod.pair.failure.episode_id,
               prod.content, toVectorLiteral(prod.f32), JSON.stringify(body), new Date(evalMs), halfLife, nextAt])
            inserted++
          }
        }
        for (const a of prod.pair.anchors) {
          await c.query(
            `INSERT INTO memory_event_evidence (tenant_id, derived_memory_id, attempt_id, event_id, run_id)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, derived_memory_id, attempt_id, event_id) DO NOTHING`,
            [tenantId, finalExperienceId, a.attempt_id, a.event_id, claim.run_id])
        }
      }
      // receipt 三值分明（一审#7）：生成 ID、最终指向、生成物 checksum 各是各的
      const receipt = {
        schema_version: 'reflection-receipt-v1',
        provider: NIGHTLY_PROVIDER, model_id: NIGHTLY_MODEL_ID, prompt_version: PROMPT_VERSION,
        pairs_processed: products.length, inserted, dedup_batch: dedupBatch, dedup_db: dedupDb,
        skipped: skipped.map(p => ({ reason: p.skipped, failure_attempt_id: p.failure.attempt_id })),
        outputs: products.map(p => ({ pair_fingerprint: p.pair.pair_fingerprint.toString('hex'),
          generated_experience_id: p.pair.experience_id, resolved_experience_id: p.resolved_experience_id,
          generated_output_checksum: p.output_checksum, embed: p.embedMeta,
          consumed_elsewhere: consumedElsewhere.has(p.pair.pair_fingerprint.toString('hex')) || undefined })),
      }
      // durable cursor 推进（round-3 #1）：读本 run 行冻结的 snapshot（takeover 后依然一致），
      // 与 completed 同一 fencing 事务——幂等重放/竞态下 cursor 不会双跳
      const snap = (await c.query('SELECT source_snapshot FROM nightly_runs WHERE tenant_id=$1 AND run_id=$2',
        [tenantId, claim.run_id])).rows[0].source_snapshot
      if (snap?.cursor_advance) {
        // 微秒精度陷阱：JS Date/ISO 只有毫秒——cursor 若经 JS 序列化会永远比行小一截，
        // 行反复扫到自己。按 orid 回表取原生 TIMESTAMPTZ，微秒不过 JS 之手
        // 单调不变量（round-5 #1）：反序提交的旧 run 绝不能把 cursor 写回退——
        // ON CONFLICT 带 tuple-max 条件，只允许前进；平行 cursor-only run 反序到达时为 no-op
        await c.query(
          `INSERT INTO reflection_cursor (tenant_id, last_reported_at, last_outcome_request_id, updated_at)
           SELECT $1, reported_at, outcome_request_id, now() FROM outcomes
           WHERE tenant_id=$1 AND outcome_request_id=$2
           ON CONFLICT (tenant_id) DO UPDATE SET
             last_reported_at=excluded.last_reported_at,
             last_outcome_request_id=excluded.last_outcome_request_id,
             updated_at=now()
           WHERE (excluded.last_reported_at, excluded.last_outcome_request_id)
               > (reflection_cursor.last_reported_at, reflection_cursor.last_outcome_request_id)`,
          [tenantId, snap.cursor_advance.to_orid])
      }
      await fenceUpdate(c, fence, `status='completed', completed_at=now(), result_receipt=$4`, [receipt])
      return { outcome: 'completed', run_id: claim.run_id,
               counts: { pairs: products.length, inserted, dedup_batch: dedupBatch, dedup_db: dedupDb, skipped: skipped.length } }
    }, 'reflect-execute')
  } catch (e) {
    if (!e.stale) throw e
    await inSerializableTx(async (c) => fenceUpdate(c, fence, `status='stale'`), 'reflect-stale')
    result = { outcome: 'stale', run_id: claim.run_id, reason: 'pair_ledger_conflict' }
  }
  const final = { ...result, control: claim.control }
  console.log(JSON.stringify({ evt: 'reflection_run', tenant_id: tenantId, scheduled_for: evaluationAtIso, ...final }))
  return final
}

export const runReflection = async ({ tenantId, scheduledFor, cfg = REFLECT_CFG }) => {
  if (Number.isNaN(new Date(scheduledFor).getTime())) throw new Error('scheduled_for_invalid')
  assertReflectPolicyFrozen(cfg)
  const evaluationAtIso = new Date(scheduledFor).toISOString()
  const claim = await claimReflection(tenantId, evaluationAtIso, cfg)
  if (claim.outcome !== 'claimed') {
    console.log(JSON.stringify({ evt: 'reflection_run', tenant_id: tenantId, scheduled_for: evaluationAtIso, ...claim }))
    return claim
  }
  return executeReflection(tenantId, evaluationAtIso, claim)
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
  try { await runReflection({ tenantId, scheduledFor }) } finally { await getPool().end().catch(() => {}) }
}
