// report_outcome：事务 B——结果门控塑性的唯一入口（SPEC §1.4/§2.3/§4，冻结 §12.2/§12.7，结论 26/27）
// recall 只开回执；这里才是记忆变强/变弱的地方：
//   success + credited(item-bound memory_used 证据) -> 边际递减加固（pinned 只计数）
//   failure + blamed(本 attempt 证据)               -> blame_factor 降权（默认不罚无辜）
//   cancelled / late / 无证据                        -> 照单存档，零塑性
import { createHmac } from 'node:crypto'
import { inSerializableTx } from '../lib/db.mjs'
import { resolveHmacKey } from '../lib/config.mjs'
import { canonicalJson } from '../lib/canonical-json.mjs'

const HMAC_KEY = resolveHmacKey(process.env)
if (!HMAC_KEY) throw new Error('TIDEMARK_HMAC_KEY not set to a non-empty value (or export TIDEMARK_DEV_INSECURE=1 for local dev only)')

export const OUTCOME_CFG = {
  base_gain: 0.3,
  cooldown_hours: 24,
  blame_factor: 0.8,
  outcome_window_hours: 24,
  base_half_life: { event: 72, experience: 2160 },
  promotion_distinct_instances: 2,
}

const fp = (tenant_id, agent_id, params) =>
  createHmac('sha256', `${HMAC_KEY}|${tenant_id}|${agent_id}`).update(canonicalJson(params)).digest()

const decay = (anchor, anchorAt, halfLife, now) =>
  Number(anchor) * Math.exp(-Math.LN2 * Math.max(0, (now - new Date(anchorAt).getTime()) / 3600e3) / Number(halfLife))

export const reportOutcomeTool = async ({ principal, outcome_request_id, episode_id, task_instance_id, attempt_id, status, attributions }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  for (const [k, v] of [['outcome_request_id', outcome_request_id], ['episode_id', episode_id],
                        ['task_instance_id', task_instance_id], ['attempt_id', attempt_id], ['status', status]]) {
    if (!v || typeof v !== 'string') return { ok: false, error: `${k}_required` }
  }
  if (!['success', 'failure', 'cancelled'].includes(status)) return { ok: false, error: 'status_invalid' }
  const attrs = attributions ?? []
  if (!Array.isArray(attrs)) return { ok: false, error: 'attributions_must_be_array' }
  // 状态-角色耦合（SPEC §1.4）
  if (status === 'cancelled' && attrs.length > 0) return { ok: false, error: 'cancelled_allows_no_attributions' }
  for (const a of attrs) {
    if (!a || typeof a !== 'object') return { ok: false, error: 'attribution_invalid' }
    for (const k of ['recall_request_id', 'receipt_item_id', 'memory_id', 'role', 'evidence_event_id']) {
      if (!a[k] || typeof a[k] !== 'string') return { ok: false, error: `attribution_missing_${k}` }
    }
    if (status === 'success' && a.role !== 'credited') return { ok: false, error: 'success_allows_only_credited' }
    if (status === 'failure' && a.role !== 'blamed') return { ok: false, error: 'failure_allows_only_blamed' }
  }
  const { tenant_id, agent_id } = principal
  const fingerprint = fp(tenant_id, agent_id, { episode_id, task_instance_id, attempt_id, status, attributions: attrs })

  return inSerializableTx(async (c) => {
    // 幂等 claim（outcome_request_id 是本调用自己的键，与 recall 的键分离——冻结 P0-3）
    const prior = (await c.query(
      'SELECT payload_hmac, response_json FROM tool_requests WHERE tenant_id=$1 AND agent_id=$2 AND tool_name=$3 AND request_id=$4',
      [tenant_id, agent_id, 'report_outcome', outcome_request_id])).rows[0]
    if (prior) {
      if (!prior.payload_hmac.equals(fingerprint)) return { ok: false, error: 'idempotency_key_reused' }
      return prior.response_json
    }
    // attempt 终态唯一（UNIQUE (tenant, attempt_id)）：同 attempt 另一个 key 的终态 = 冲突
    const existing = (await c.query('SELECT status FROM outcomes WHERE tenant_id=$1 AND attempt_id=$2', [tenant_id, attempt_id])).rows[0]
    if (existing) return { ok: false, error: 'outcome_conflict', existing_status: existing.status }

    const now = Date.now()
    const items = []
    const seenMemory = new Set()          // 同 outcome 按 memory_id 去重（SPEC §1.4）
    const receiptCache = new Map()
    let anyPlasticity = false
    const promotions = []

    for (const a of attrs) {
      const item = { memory_id: a.memory_id, role: a.role, applied: false, reason: null }
      items.push(item)
      if (seenMemory.has(a.memory_id)) { item.reason = 'duplicate_memory_skipped'; continue }
      seenMemory.add(a.memory_id)

      // 1) receipt 归属校验（同 tenant/agent/attempt/episode）
      let rr = receiptCache.get(a.recall_request_id)
      if (!rr) {
        rr = (await c.query(
          'SELECT agent_id, attempt_id, episode_id, created_at, terminal_attempt_id, receipt_json FROM recall_requests WHERE tenant_id=$1 AND request_id=$2',
          [tenant_id, a.recall_request_id])).rows[0] ?? null
        receiptCache.set(a.recall_request_id, rr)
      }
      if (!rr || rr.agent_id !== agent_id) { item.reason = 'receipt_not_found_in_scope'; continue }
      if (rr.attempt_id !== attempt_id) { item.reason = 'receipt_attempt_mismatch'; continue }
      if (rr.episode_id !== episode_id) { item.reason = 'receipt_episode_mismatch'; continue }
      if (rr.terminal_attempt_id && rr.terminal_attempt_id !== attempt_id) { item.reason = 'receipt_already_settled'; continue }
      const rItem = (rr.receipt_json?.receipt?.items ?? []).find(i => i.receipt_item_id === a.receipt_item_id)
      if (!rItem || rItem.memory_id !== a.memory_id) { item.reason = 'receipt_item_mismatch'; continue }

      // 2) 证据校验：credited 必须 item-bound memory_used（冻结 §12.2）；blamed 必须本 attempt 事件
      const ev = (await c.query(
        'SELECT event_type, payload FROM attempt_events WHERE tenant_id=$1 AND attempt_id=$2 AND event_id=$3',
        [tenant_id, attempt_id, a.evidence_event_id])).rows[0]
      if (!ev) { item.reason = 'evidence_not_found_in_attempt'; continue }
      if (a.role === 'credited') {
        const ok = ev.event_type === 'memory_used'
          && ev.payload?.recall_request_id === a.recall_request_id
          && ev.payload?.receipt_item_id === a.receipt_item_id
          && ev.payload?.memory_id === a.memory_id
        if (!ok) { item.reason = 'credited_requires_item_bound_memory_used'; continue }
        if (!rItem.injected) { item.reason = 'credited_item_not_injected'; continue }
      }

      // 3) 迟到窗口：超窗照存档，零塑性
      const late = now - new Date(rr.created_at).getTime() > OUTCOME_CFG.outcome_window_hours * 3600e3
      if (late) { item.reason = 'late_no_plasticity'; continue }

      // 4) 塑性（行仍在才施加；删除在途 -> memory_deleted，其余照常）
      const m = (await c.query(
        `SELECT layer, state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
                credited_success_count, evidenced_blame_count, exp_status
         FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3`,
        [tenant_id, agent_id, a.memory_id])).rows[0]
      if (!m) { item.reason = 'memory_deleted'; continue }

      if (a.role === 'credited') {
        if (m.pinned) {
          await c.query(
            'UPDATE memories SET credited_success_count = credited_success_count + 1, revision = revision + 1 WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3',
            [tenant_id, agent_id, a.memory_id])
          item.applied = true; item.reason = 'pinned_count_only'
        } else {
          const eff = decay(m.strength_anchor, m.strength_anchor_at, m.half_life_hours, now)
          const spacing = 1 - Math.exp(-Math.max(0, (now - new Date(m.last_rewarded_at).getTime()) / 3600e3) / OUTCOME_CFG.cooldown_hours)
          const gain = OUTCOME_CFG.base_gain * spacing * (1 - eff)
          const newAnchor = Math.min(1, eff + gain)
          const revive = m.state === 'faded'
          // faded -> fresh 唯一复活路径：half_life 重置回 fresh 基础值（consolidation 重新挣，SPEC §2.4）
          const newHalfLife = revive ? OUTCOME_CFG.base_half_life[m.layer] * (1 + Number(m.importance)) : Number(m.half_life_hours)
          await c.query(
            `UPDATE memories SET strength_anchor=$4, strength_anchor_at=now(), last_rewarded_at=now(),
               credited_success_count = credited_success_count + 1, revision = revision + 1,
               state = $5, half_life_hours = $6
             WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3`,
            [tenant_id, agent_id, a.memory_id, newAnchor, revive ? 'fresh' : m.state, newHalfLife])
          item.applied = true
          item.plasticity = { effective_before: +eff.toFixed(6), spacing_factor: +spacing.toFixed(6), reinforcement_gain: +gain.toFixed(6), strength_anchor_after: +newAnchor.toFixed(6), revived: revive }
        }
        anyPlasticity = true
        // 经验晋级候选（冻结 §12.7 + 结论 14）：恰 1 条 candidate 注入 + success + 本 attempt 无 user_correction
        // 实际写 success_evidence 延到 outcome 落库之后（其外键指向 outcomes）
        if (m.layer === 'experience' && m.exp_status === 'candidate') {
          const injectedCandidates = (rr.receipt_json?.receipt?.items ?? []).filter(i => i.layer === 'experience' && i.injected).length
          const corrections = (await c.query(
            `SELECT count(*)::INT4 AS n FROM attempt_events WHERE tenant_id=$1 AND attempt_id=$2 AND event_type='user_correction'`,
            [tenant_id, attempt_id])).rows[0].n
          if (injectedCandidates === 1 && corrections === 0) item._promoteCandidate = a.memory_id
          else item.promotion_guard = injectedCandidates !== 1 ? 'not_sole_candidate' : 'user_correction_present'
        }
      } else { // blamed（failure 已由耦合校验保证）
        if (m.pinned) {
          await c.query(
            'UPDATE memories SET evidenced_blame_count = evidenced_blame_count + 1, revision = revision + 1 WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3',
            [tenant_id, agent_id, a.memory_id])
          item.applied = true; item.reason = 'pinned_count_only'
        } else {
          const eff = decay(m.strength_anchor, m.strength_anchor_at, m.half_life_hours, now)
          const newAnchor = eff * OUTCOME_CFG.blame_factor
          await c.query(
            `UPDATE memories SET strength_anchor=$4, strength_anchor_at=now(),
               evidenced_blame_count = evidenced_blame_count + 1, revision = revision + 1
             WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3`,     // last_rewarded_at 不动：惩罚不重置 spacing
            [tenant_id, agent_id, a.memory_id, newAnchor])
          item.applied = true
          item.plasticity = { effective_before: +eff.toFixed(6), strength_anchor_after: +newAnchor.toFixed(6) }
        }
        anyPlasticity = true
      }
    }

    // 落 outcome（success_evidence 的外键父行，必须先插）
    await c.query(
      `INSERT INTO outcomes (tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, attributions, plasticity_applied)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenant_id, outcome_request_id, agent_id, episode_id, task_instance_id, attempt_id, status, JSON.stringify(attrs), anyPlasticity])

    // outcome 落库后：写 success_evidence + 判经验晋级（外键此刻满足）
    for (const item of items) {
      if (!item._promoteCandidate) continue
      const mid = item._promoteCandidate; delete item._promoteCandidate
      await c.query(
        `INSERT INTO success_evidence (tenant_id, experience_id, task_instance_id, outcome_request_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, experience_id, task_instance_id) DO NOTHING`,
        [tenant_id, mid, task_instance_id, outcome_request_id])
      const distinct = (await c.query(
        'SELECT count(*)::INT4 AS n FROM success_evidence WHERE tenant_id=$1 AND experience_id=$2', [tenant_id, mid])).rows[0].n
      if (distinct >= OUTCOME_CFG.promotion_distinct_instances) {
        const upd = await c.query(
          `UPDATE memories SET exp_status='verified', revision = revision + 1 WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3 AND exp_status='candidate'`,
          [tenant_id, agent_id, mid])
        if (upd.rowCount > 0) promotions.push(mid)
      }
    }
    const response = { ok: true, outcome_request_id, attempt_id, status, plasticity_applied: anyPlasticity, items, promotions }
    for (const rrId of receiptCache.keys()) {
      const rr = receiptCache.get(rrId)
      if (rr && rr.agent_id === agent_id && rr.attempt_id === attempt_id) {
        await c.query(
          `UPDATE recall_requests SET outcome_state='reported', terminal_attempt_id=$3 WHERE tenant_id=$1 AND request_id=$2`,
          [tenant_id, rrId, attempt_id])
      }
    }
    await c.query(
      'INSERT INTO tool_requests (tenant_id, agent_id, tool_name, request_id, payload_hmac, response_json) VALUES ($1,$2,$3,$4,$5,$6)',
      [tenant_id, agent_id, 'report_outcome', outcome_request_id, fingerprint, response])
    console.log(JSON.stringify({ evt: 'report_outcome', outcome_request_id, attempt_id, status, applied: anyPlasticity, items: items.length, promotions: promotions.length, tenant_id, agent_id }))
    return response
  }, 'report-outcome-commit').catch(async (e) => {
    if (e.code !== '23505') throw e
    const winner = await inSerializableTx(async (c) => (await c.query(
      'SELECT payload_hmac, response_json FROM tool_requests WHERE tenant_id=$1 AND agent_id=$2 AND tool_name=$3 AND request_id=$4',
      [tenant_id, agent_id, 'report_outcome', outcome_request_id])).rows[0] ?? null, 'report-outcome-winner')
    if (!winner) {
      // 23505 也可能来自 outcomes 的 attempt 唯一键（并发双终态）——读已存终态返回冲突
      const existing = await inSerializableTx(async (c) => (await c.query(
        'SELECT status FROM outcomes WHERE tenant_id=$1 AND attempt_id=$2', [tenant_id, attempt_id])).rows[0] ?? null, 'report-outcome-conflict-read')
      if (existing) return { ok: false, error: 'outcome_conflict', existing_status: existing.status }
      throw e
    }
    if (!winner.payload_hmac.equals(fingerprint)) return { ok: false, error: 'idempotency_key_reused' }
    return winner.response_json
  })
}
