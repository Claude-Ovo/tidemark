// recall：两路候选 -> 读时衰减 + utility + rerank -> 双预算 packing -> receipt 落库（幂等）
// SPEC v1.2.2.1 §2/§3；结论 20/21/23/26。recall 不改任何 memory 行（outcome-gated）。
import { createHmac, createHash, randomUUID } from 'node:crypto'
import { inSerializableTx } from '../lib/db.mjs'
import { embed, embedProviderName } from '../lib/embed.mjs'
import { toVectorLiteral } from '../lib/vector-canonical.mjs'
import { resolveHmacKey } from '../lib/config.mjs'
import { estimateTokens, ITEM_JSON_OVERHEAD, TOKEN_ESTIMATOR_VERSION } from '../lib/tokens.mjs'
import { canonicalJson } from '../lib/canonical-json.mjs'

const HMAC_KEY = resolveHmacKey(process.env)
if (!HMAC_KEY) throw new Error('TIDEMARK_HMAC_KEY not set to a non-empty value (or export TIDEMARK_DEV_INSECURE=1 for local dev only)')

export const PIPELINE_VERSION = `recall-v1|embed=${embedProviderName}|dims=512|rerank=0.5sim+0.2vit+0.2util+0.1imp|tokens=${TOKEN_ESTIMATOR_VERSION}`

// 配置默认值（SPEC §11）
const CFG = {
  vector_top_n: 50,
  semantic_gate: 0.55,
  second_path_floor: 0.35,
  weights: { sim: 0.5, vit: 0.2, util: 0.2, imp: 0.1 },
  event_budget: { max_items: 5, max_tokens: 1200 },
  experience_budget: { max_items: 3, max_tokens: 600 },
  receipt_retention_days: 60,
}

// tenant-scoped keyed HMAC（结论 24：不称匿名化）
const queryHmac = (tenant_id, query) =>
  createHmac('sha256', `${HMAC_KEY}|${tenant_id}`).update(query).digest()

const decayEffective = (row, now) => {
  if (row.pinned) return Number(row.strength_anchor)
  const ageH = (now - new Date(row.strength_anchor_at).getTime()) / 3600e3
  return Number(row.strength_anchor) * Math.exp(-Math.LN2 * Math.max(0, ageH) / Number(row.half_life_hours))
}
const utilityOf = (row) =>
  (Number(row.credited_success_count) + 1) / (Number(row.credited_success_count) + Number(row.evidenced_blame_count) + 2)

const CANDIDATE_FILTER = `admission = 'accepted' AND state <> 'faded' AND (layer = 'event' OR exp_status <> 'superseded')`

export const recallTool = async ({ principal, query, purpose, episode_id, attempt_id, request_id }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  for (const [k, v] of [['request_id', request_id], ['episode_id', episode_id], ['attempt_id', attempt_id], ['query', query]]) {
    if (!v || typeof v !== 'string') return { ok: false, error: `${k}_required` }
  }
  const { tenant_id, agent_id } = principal
  const hmac = queryHmac(tenant_id, query)

  // 幂等 preflight（事务外，省 embedding）
  const existing = await inSerializableTx(async (c) => (await c.query(
    'SELECT query_hmac, receipt_json FROM recall_requests WHERE tenant_id=$1 AND request_id=$2',
    [tenant_id, request_id])).rows[0] ?? null, 'recall-preflight')
  if (existing) {
    if (!existing.query_hmac.equals(hmac)) return { ok: false, error: 'idempotency_key_reused' }
    return { ok: true, replay: true, ...existing.receipt_json }
  }

  // embedding（事务外）
  const { f32 } = await embed(query)
  const vecLiteral = toVectorLiteral(f32)
  const now = Date.now()

  return inSerializableTx(async (c) => {
    // 事务内二次幂等检查
    const again = (await c.query('SELECT query_hmac, receipt_json FROM recall_requests WHERE tenant_id=$1 AND request_id=$2',
      [tenant_id, request_id])).rows[0]
    if (again) {
      if (!again.query_hmac.equals(hmac)) return { ok: false, error: 'idempotency_key_reused' }
      return { ok: true, replay: true, ...again.receipt_json }
    }

    const cols = `tenant_id, agent_id, memory_id, layer, kind, content, exp_status, experience_body, pinned, importance,
      strength_anchor, strength_anchor_at, half_life_hours, credited_success_count, evidenced_blame_count`
    // 第一路：向量 search 先取 top-N（仅 prefix 等值 + ORDER BY 距离 + LIMIT，命中 mem_vec_idx——
    // EXPLAIN 实证：过滤条件放进内层会退化为全表扫，故采用"vector search 打底、谓词外层后过滤"形状；
    // 后过滤可能使命中数 < N，属已知语义（候选池本就要过 gate）
    const pathA = (await c.query(
      `SELECT * FROM (
         SELECT ${cols}, admission, state, embedding <=> $3 AS dist
         FROM memories@mem_vec_idx
         WHERE tenant_id=$1 AND agent_id=$2
         ORDER BY embedding <=> $3 LIMIT ${CFG.vector_top_n}
       ) WHERE ${CANDIDATE_FILTER}`, [tenant_id, agent_id, vecLiteral])).rows
    // 第二路：pinned / 高重要度（独立 relevance floor；OR 的索引形态待 mem_pin_idx EXPLAIN spike，量小先扫）
    const pathB = (await c.query(
      `SELECT ${cols}, embedding <=> $3 AS dist FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND ${CANDIDATE_FILTER} AND embedding IS NOT NULL
       AND (pinned OR importance >= 0.8)`, [tenant_id, agent_id, vecLiteral])).rows

    // 并集（memory_id 去重，保留来源标记）
    const seen = new Map()
    for (const r of pathA) seen.set(r.memory_id, { row: r, reasons: ['semantic_match'] })
    for (const r of pathB) {
      const hit = seen.get(r.memory_id)
      const label = r.pinned ? 'pinned_path' : 'high_importance_path'
      if (hit) hit.reasons.push(label)
      else seen.set(r.memory_id, { row: r, reasons: [label] })
    }

    // 打分 + gate
    const scored = []
    for (const { row, reasons } of seen.values()) {
      const similarity = Math.min(1, Math.max(0, 1 - Number(row.dist)))
      const gate = reasons.includes('semantic_match') ? CFG.semantic_gate : CFG.second_path_floor
      const secondPathOnly = !reasons.includes('semantic_match')
      if (similarity < (secondPathOnly ? CFG.second_path_floor : CFG.semantic_gate)) continue
      const effective = decayEffective(row, now)
      const utility = utilityOf(row)
      const importance = Number(row.importance)
      const final_score = CFG.weights.sim * similarity + CFG.weights.vit * effective + CFG.weights.util * utility + CFG.weights.imp * importance
      scored.push({ row, reasons, similarity, effective, utility, importance, final_score, gate })
    }
    scored.sort((a, b) => b.final_score - a.final_score || (a.row.memory_id < b.row.memory_id ? -1 : 1))

    // 双预算 greedy packing（event 与 experience 分离；experience verified 优先稳定排序）
    const pack = (items, budget) => {
      const chosen = []
      let tokens = 0
      for (const it of items) {
        const text = it.row.layer === 'experience'
          ? [it.row.experience_body?.trigger, it.row.experience_body?.correct_action, it.row.experience_body?.caution].filter(Boolean).join(' ')
          : it.row.content
        const t = estimateTokens(text ?? '') + ITEM_JSON_OVERHEAD
        if (chosen.length >= budget.max_items || tokens + t > budget.max_tokens) continue
        chosen.push(it); tokens += t
      }
      return { chosen, tokens }
    }
    const events = scored.filter(s => s.row.layer === 'event')
    const experiences = scored.filter(s => s.row.layer === 'experience')
      .sort((a, b) => (b.row.exp_status === 'verified') - (a.row.exp_status === 'verified') || b.final_score - a.final_score || (a.row.memory_id < b.row.memory_id ? -1 : 1))
    const evPack = pack(events, CFG.event_budget)
    const exPack = pack(experiences, CFG.experience_budget)
    const injectedIds = new Set([...evPack.chosen, ...exPack.chosen].map(s => s.row.memory_id))

    // receipt items（不存正文——冻结不变量 §12.5）
    let rank = 0
    const items = scored.map(s => ({
      receipt_item_id: randomUUID(),
      memory_id: s.row.memory_id,
      layer: s.row.layer,
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
      budgets: {
        event: { used_items: evPack.chosen.length, max_items: CFG.event_budget.max_items, used_tokens: evPack.tokens, max_tokens: CFG.event_budget.max_tokens },
        experience: { used_items: exPack.chosen.length, max_items: CFG.experience_budget.max_items, used_tokens: exPack.tokens, max_tokens: CFG.experience_budget.max_tokens },
      },
      items,
    }
    const checksum = createHash('sha256').update(canonicalJson(receipt)).digest()   // JSONB 重排键序，必须规范化序列化

    // 注入内容（data role，固定 schema；event 带 content+kind，experience 带三件套+待验证标注）
    const injected = {
      events: evPack.chosen.map(s => ({ memory_id: s.row.memory_id, kind: s.row.kind, content: s.row.content })),
      experiences: exPack.chosen.map(s => ({
        memory_id: s.row.memory_id,
        status: s.row.exp_status,
        provisional: s.row.exp_status === 'candidate' ? '待验证建议' : undefined,
        trigger: s.row.experience_body?.trigger,
        correct_action: s.row.experience_body?.correct_action,
        caution: s.row.experience_body?.caution,
      })),
    }

    const result = { ok: true, receipt, injected }
    await c.query(
      `INSERT INTO recall_requests (tenant_id, request_id, agent_id, episode_id, attempt_id, query_hmac,
         pipeline_version, receipt_json, serialization_checksum, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' days')::INTERVAL)`,
      [tenant_id, request_id, agent_id, episode_id, attempt_id, hmac, PIPELINE_VERSION,
       { receipt, injected }, checksum, String(CFG.receipt_retention_days)])
    console.log(JSON.stringify({ evt: 'recall', request_id, tenant_id, agent_id, candidates: scored.length, injected_events: evPack.chosen.length, injected_experiences: exPack.chosen.length }))
    return result
  }, 'recall-commit').catch(async (e) => {
    if (e.code !== '23505') throw e
    // 并发首提交者：新事务重读 winner
    const winner = await inSerializableTx(async (c) => (await c.query(
      'SELECT query_hmac, receipt_json FROM recall_requests WHERE tenant_id=$1 AND request_id=$2',
      [tenant_id, request_id])).rows[0] ?? null, 'recall-winner-read')
    if (!winner) throw e
    if (!winner.query_hmac.equals(hmac)) return { ok: false, error: 'idempotency_key_reused' }
    return { ok: true, replay: true, ...winner.receipt_json }
  })
}
