// recall：两路候选 -> 读时衰减 + utility + rerank -> 三重预算 packing -> content-free receipt 落库（幂等）
// SPEC v1.2.2.1 §2/§3/§4；结论 20/21/22/23/26。recall 不改任何 memory 行（outcome-gated）。
//
// 持久化不变量（§12.5）：recall_requests.receipt_json 绝不含记忆正文——只存 ID 与分数组件。
// 正文在响应时 hydrate；replay 时按 (tenant, agent) 重新 hydrate，已删除的返回 [deleted] 且不注入。
import { createHmac, createHash, randomUUID } from 'node:crypto'
import { inSerializableTx } from '../lib/db.mjs'
import { embed, embedProviderName, embedModelId } from '../lib/embed.mjs'
import { toVectorLiteral } from '../lib/vector-canonical.mjs'
import { resolveHmacKey } from '../lib/config.mjs'
import { estimateTokens, ITEM_JSON_OVERHEAD, TOKEN_ESTIMATOR_VERSION } from '../lib/tokens.mjs'
import { canonicalJson } from '../lib/canonical-json.mjs'

const HMAC_KEY = resolveHmacKey(process.env)
if (!HMAC_KEY) throw new Error('TIDEMARK_HMAC_KEY not set to a non-empty value (or export TIDEMARK_DEV_INSECURE=1 for local dev only)')

export { PIPELINE_VERSION } from '../lib/pipeline-version.mjs'
import { PIPELINE_VERSION } from '../lib/pipeline-version.mjs'

import { CFG } from '../lib/recall-config.mjs'
export { CFG }

// tenant-scoped keyed HMAC，覆盖【全部行为相关参数】（结论 24 + 首审第 3 项）：
// query 之外 episode/attempt/purpose/token_budget 任一变化都视为不同请求
const requestFingerprint = (tenant_id, agent_id, params) =>
  createHmac('sha256', `${HMAC_KEY}|${tenant_id}|${agent_id}`).update(canonicalJson(params)).digest()

import { decayEffective } from '../lib/decay.mjs'   // 共享唯一实现（viz 同源，公式禁分叉）
const utilityOf = (row) =>
  (Number(row.credited_success_count) + 1) / (Number(row.credited_success_count) + Number(row.evidenced_blame_count) + 2)

// pinned 例外（结论 3"pinned 绕过衰减"的召回面）：faded 但被 pin 的行仍可召回——
// pin 的语义就是"这条不许沉底"，state 保留 faded 以便 unpin 后立即恢复沉底
const isEligible = (r) =>
  r.admission === 'accepted' && (r.state !== 'faded' || r.pinned) && (r.layer === 'event' || r.exp_status !== 'superseded')

const CAND_COLS = `memory_id, layer, kind, content, exp_status, experience_body, pinned, importance,
  strength_anchor, strength_anchor_at, half_life_hours, credited_success_count, evidenced_blame_count,
  admission, state, created_at`

// 第一路：adaptive overfetch。vector index 只能吃 prefix 等值 + ORDER BY 距离 + LIMIT
// （EXPLAIN 实证：把 admission/state 谓词放进内层会让 planner 弃用 vector index）。
// 因此内层不带业务谓词、在外部过滤；但纯后过滤会被大量 faded 行挤掉合格 fresh 行（首审第 4 项），
// 故按需放大内层 LIMIT，直到"合格数达标"或"内层已返回全部行"或"触及硬上限"——三者皆有界。
const fetchVectorCandidates = async (c, tenant_id, agent_id, vecLiteral) => {
  let limit = CFG.vector_top_n
  let lastRows = []
  const trail = []
  for (;;) {
    const rows = (await c.query(
      `SELECT ${CAND_COLS}, embedding <=> $3 AS dist
       FROM memories@mem_vec_id_idx
       WHERE tenant_id = $1 AND agent_id = $2 AND embedding_model_id = $4
       ORDER BY embedding <=> $3 LIMIT ${limit}`, [tenant_id, agent_id, vecLiteral, embedModelId()])).rows
    lastRows = rows
    const eligible = rows.filter(isEligible)
    trail.push({ inner_limit: limit, inner_rows: rows.length, eligible: eligible.length })
    const exhausted = rows.length < limit              // 内层已把符合 prefix 的行取尽
    if (eligible.length >= CFG.vector_top_n || exhausted || limit >= CFG.overfetch_max) {
      return { rows: eligible.slice(0, CFG.vector_top_n), trail, truncated: !exhausted && eligible.length < CFG.vector_top_n }
    }
    limit = Math.min(limit * 4, CFG.overfetch_max)
  }
}

// receipt 中的 memory 引用只有 ID/分数；正文按 (tenant, agent) 现取现用，绝不落库
const hydrate = async (c, tenant_id, agent_id, ids) => {
  if (ids.length === 0) return new Map()
  const rows = (await c.query(
    `SELECT memory_id, layer, kind, content, exp_status, experience_body, created_at, state
     FROM memories WHERE tenant_id = $1 AND agent_id = $2 AND memory_id = ANY($3)`,
    [tenant_id, agent_id, ids])).rows
  return new Map(rows.map(r => [r.memory_id, r]))
}

// event 注入固定 schema（SPEC §3）：content + created_at + state；删除占位保持 content-free
const buildInjection = (plan, live) => {
  const events = [], experiences = []
  for (const { memory_id } of plan.events) {
    const row = live.get(memory_id)
    if (!row) { events.push({ memory_id, content: '[deleted]', created_at: null, state: null, injected: false }); continue }
    events.push({ memory_id, kind: row.kind, content: row.content, created_at: row.created_at, state: row.state, injected: true })
  }
  for (const { memory_id } of plan.experiences) {
    const row = live.get(memory_id)
    if (!row) { experiences.push({ memory_id, trigger: '[deleted]', injected: false }); continue }
    experiences.push({
      memory_id, status: row.exp_status,
      provisional: row.exp_status === 'candidate' ? '待验证建议' : undefined,
      trigger: row.experience_body?.trigger,
      correct_action: row.experience_body?.correct_action,
      caution: row.experience_body?.caution,
      injected: true,
    })
  }
  return { events, experiences }
}

// 同一 request_id 的重读统一入口：必须核对 agent_id（首审第 1 项：跨 agent 绝不返回 receipt）
const readOwnReceipt = async (c, tenant_id, agent_id, request_id, fingerprint) => {
  const row = (await c.query(
    'SELECT agent_id, query_hmac, receipt_json FROM recall_requests WHERE tenant_id = $1 AND request_id = $2',
    [tenant_id, request_id])).rows[0]
  if (!row) return { found: false }
  if (row.agent_id !== agent_id) return { found: true, error: 'request_id_owned_by_other_agent' }
  if (!row.query_hmac.equals(fingerprint)) return { found: true, error: 'idempotency_key_reused' }
  return { found: true, persisted: row.receipt_json }
}

export const recallTool = async ({ principal, query, purpose, episode_id, attempt_id, request_id, token_budget }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  for (const [k, v] of [['request_id', request_id], ['episode_id', episode_id], ['attempt_id', attempt_id],
                        ['query', query], ['purpose', purpose]]) {
    if (!v || typeof v !== 'string') return { ok: false, error: `${k}_required` }
  }
  // token_budget：可进一步收紧总注入量，但绝不能放宽双类硬上限（SPEC §4 bugfix 澄清）
  if (token_budget != null && (!Number.isInteger(token_budget) || token_budget < 1)) {
    return { ok: false, error: 'token_budget_invalid' }
  }
  const totalCeiling = Math.min(token_budget ?? CFG.total_token_ceiling, CFG.total_token_ceiling)

  const { tenant_id, agent_id } = principal
  const fingerprint = requestFingerprint(tenant_id, agent_id, {
    query, purpose, episode_id, attempt_id, token_budget: token_budget ?? null,
  })

  // 幂等 preflight（事务外，省 embedding 开销）
  const pre = await inSerializableTx((c) => readOwnReceipt(c, tenant_id, agent_id, request_id, fingerprint), 'recall-preflight')
  if (pre.found) {
    if (pre.error) return { ok: false, error: pre.error }
    const live = await inSerializableTx((c) => hydrate(c, tenant_id, agent_id,
      [...pre.persisted.injection_plan.events, ...pre.persisted.injection_plan.experiences].map(x => x.memory_id)), 'recall-replay-hydrate')
    return { ok: true, replay: true, receipt: pre.persisted.receipt, injected: buildInjection(pre.persisted.injection_plan, live) }
  }

  // embedding（事务外）
  const { f32 } = await embed(query)
  const vecLiteral = toVectorLiteral(f32)
  const now = Date.now()

  return inSerializableTx(async (c) => {
    // 事务内二次幂等检查（同样核对 agent）
    const again = await readOwnReceipt(c, tenant_id, agent_id, request_id, fingerprint)
    if (again.found) {
      if (again.error) return { ok: false, error: again.error }
      const live = await hydrate(c, tenant_id, agent_id,
        [...again.persisted.injection_plan.events, ...again.persisted.injection_plan.experiences].map(x => x.memory_id))
      return { ok: true, replay: true, receipt: again.persisted.receipt, injected: buildInjection(again.persisted.injection_plan, live) }
    }

    const pathA = await fetchVectorCandidates(c, tenant_id, agent_id, vecLiteral)
    // 第二路：pinned / 高重要度。relevance floor 在 SQL 里、LIMIT 之前——
    // 不相关的高优先级行不占席位（二审第 2 项：先截断后筛会饿死第 21 条真相关行）。
    // 多取 1 行用于诚实标注截断。
    const maxDist = 1 - CFG.second_path_floor
    const pathB = (await c.query(
      `SELECT ${CAND_COLS}, embedding <=> $3 AS dist
       FROM memories
       WHERE tenant_id = $1 AND agent_id = $2 AND embedding IS NOT NULL
         AND embedding_model_id = $4
         AND admission = 'accepted' AND (state <> 'faded' OR pinned)
         AND (layer = 'event' OR exp_status <> 'superseded')
         AND (pinned OR importance >= 0.8)
         AND embedding <=> $3 <= ${maxDist}
       ORDER BY pinned DESC, importance DESC, embedding <=> $3, memory_id
       LIMIT ${CFG.second_path_limit + 1}`,
      [tenant_id, agent_id, vecLiteral, embedModelId()])).rows
    const pathBTruncated = pathB.length > CFG.second_path_limit
    if (pathBTruncated) pathB.length = CFG.second_path_limit

    // 并集：记录每条命中了哪几路——gate 按"任一路满足自己的门槛即入选"判定（二审第 1 项：
    // path A 身份不得覆盖 path B 的 0.35 救生圈）
    const seen = new Map()
    for (const r of pathA.rows) seen.set(r.memory_id, { row: r, reasons: ['semantic_match'], inA: true, inB: false })
    for (const r of pathB) {
      const label = r.pinned ? 'pinned_path' : 'high_importance_path'
      const hit = seen.get(r.memory_id)
      if (hit) { hit.reasons.push(label); hit.inB = true }
      else seen.set(r.memory_id, { row: r, reasons: [label], inA: false, inB: true })
    }

    const scored = []
    for (const { row, reasons, inA, inB } of seen.values()) {
      const similarity = Math.min(1, Math.max(0, 1 - Number(row.dist)))
      const passA = inA && similarity >= CFG.semantic_gate
      const passB = inB && similarity >= CFG.second_path_floor
      if (!passA && !passB) continue
      const effective = decayEffective(row, now)
      const utility = utilityOf(row)
      const importance = Number(row.importance)
      const final_score = CFG.weights.sim * similarity + CFG.weights.vit * effective
        + CFG.weights.util * utility + CFG.weights.imp * importance
      scored.push({ row, reasons, similarity, effective, utility, importance, final_score })
    }
    scored.sort((a, b) => b.final_score - a.final_score || (a.row.memory_id < b.row.memory_id ? -1 : 1))

    // 三重预算 greedy packing：每类 items/tokens 硬上限 + 全局 totalCeiling
    let totalTokens = 0
    const pack = (items, budget) => {
      const chosen = []
      let tokens = 0
      for (const it of items) {
        const text = it.row.layer === 'experience'
          ? [it.row.experience_body?.trigger, it.row.experience_body?.correct_action, it.row.experience_body?.caution].filter(Boolean).join(' ')
          : it.row.content
        const t = estimateTokens(text ?? '') + ITEM_JSON_OVERHEAD
        if (chosen.length >= budget.max_items) break
        if (tokens + t > budget.max_tokens || totalTokens + t > totalCeiling) continue   // 超限跳过换更短的
        chosen.push(it); tokens += t; totalTokens += t
      }
      return { chosen, tokens }
    }
    const events = scored.filter(s => s.row.layer === 'event')
    const experiences = scored.filter(s => s.row.layer === 'experience')
      .sort((a, b) => (b.row.exp_status === 'verified') - (a.row.exp_status === 'verified')
        || b.final_score - a.final_score || (a.row.memory_id < b.row.memory_id ? -1 : 1))
    const evPack = pack(events, CFG.event_budget)
    const exPack = pack(experiences, CFG.experience_budget)
    const injectedIds = new Set([...evPack.chosen, ...exPack.chosen].map(s => s.row.memory_id))

    let rank = 0
    const items = scored.map(s => ({
      receipt_item_id: randomUUID(),
      memory_id: s.row.memory_id,
      layer: s.row.layer,
      // content-free 快照：晋级判定读回执里的召回时点状态，不读 report 时点的活表
      //（否则 recall 后被晋级的 verified 会让"恰 1 条 candidate"数错对象）
      ...(s.row.layer === 'experience' ? { experience_status_at_recall: s.row.exp_status } : {}),
      rank: ++rank,
      raw_cosine_distance: Number(s.row.dist),
      similarity: +s.similarity.toFixed(6),
      effective_strength: +s.effective.toFixed(6),
      utility: +s.utility.toFixed(6),
      importance: s.importance,
      final_score: +s.final_score.toFixed(6),
      reason: s.reasons,
      injected: injectedIds.has(s.row.memory_id),
    }))

    const receipt = {
      request_id, mode: 'recall',
      pipeline_version: PIPELINE_VERSION,
      token_estimator_version: TOKEN_ESTIMATOR_VERSION,
      context: { purpose, episode_id, attempt_id, token_budget: token_budget ?? null, total_token_ceiling: totalCeiling },
      candidate_fetch: { path_a: pathA.trail, path_a_truncated: pathA.truncated, path_b_rows: pathB.length, path_b_limit: CFG.second_path_limit, path_b_truncated: pathBTruncated },
      budgets: {
        event: { used_items: evPack.chosen.length, max_items: CFG.event_budget.max_items, used_tokens: evPack.tokens, max_tokens: CFG.event_budget.max_tokens },
        experience: { used_items: exPack.chosen.length, max_items: CFG.experience_budget.max_items, used_tokens: exPack.tokens, max_tokens: CFG.experience_budget.max_tokens },
        total: { used_tokens: totalTokens, ceiling: totalCeiling },
      },
      items,
    }
    // 持久化体：content-free（只有 ID），checksum 覆盖【实际落库的整个 JSON】
    const injection_plan = {
      events: evPack.chosen.map(s => ({ memory_id: s.row.memory_id })),
      experiences: exPack.chosen.map(s => ({ memory_id: s.row.memory_id })),
    }
    const persisted = { receipt, injection_plan }
    const checksum = createHash('sha256').update(canonicalJson(persisted)).digest()

    await c.query(
      `INSERT INTO recall_requests (tenant_id, request_id, agent_id, episode_id, attempt_id, query_hmac,
         pipeline_version, receipt_json, serialization_checksum, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' days')::INTERVAL)`,
      [tenant_id, request_id, agent_id, episode_id, attempt_id, fingerprint, PIPELINE_VERSION,
       persisted, checksum, String(CFG.receipt_retention_days)])

    console.log(JSON.stringify({ evt: 'recall', request_id, tenant_id, agent_id, attempt_id,
      candidates: scored.length, injected_events: evPack.chosen.length, injected_experiences: exPack.chosen.length,
      overfetch_rounds: pathA.trail.length }))

    // 首次响应：直接用本次已读到的行 hydrate（无需二次查询）
    const live = new Map([...evPack.chosen, ...exPack.chosen].map(s => [s.row.memory_id, s.row]))
    return { ok: true, receipt, injected: buildInjection(injection_plan, live) }
  }, 'recall-commit').catch(async (e) => {
    if (e.code !== '23505') throw e
    // 并发首提交者：新事务重读 winner（同样核对 agent + fingerprint）
    const winner = await inSerializableTx((c) => readOwnReceipt(c, tenant_id, agent_id, request_id, fingerprint), 'recall-winner-read')
    if (!winner.found) throw e
    if (winner.error) return { ok: false, error: winner.error }
    const live = await inSerializableTx((c) => hydrate(c, tenant_id, agent_id,
      [...winner.persisted.injection_plan.events, ...winner.persisted.injection_plan.experiences].map(x => x.memory_id)), 'recall-winner-hydrate')
    return { ok: true, replay: true, receipt: winner.persisted.receipt, injected: buildInjection(winner.persisted.injection_plan, live) }
  })
}
