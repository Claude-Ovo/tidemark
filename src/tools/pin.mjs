// pin：幂等 set/unset（结论 15/21，冻结 §12.3）
// - capability 门槛：principal 须带 memory:pin 能力位（冻结：pin 不是默认权力）
// - 仅 admission=accepted 可 pin；quarantined/superseded/已删除不可
// - pin = 冻结当下：先 materialize（anchor=当前 effective, anchor_at=now）再置 pinned——不是偷偷升满
// - unpin = 保 anchor、重置 anchor_at=now 后恢复衰减
// - 不改 source/utility/last_rewarded_at；转换才 materialize，重复 set 是无副作用 no-op
// - reason 为操作代号（slug），不收散文——tool_requests 会长期保留，不给正文留后门
import { createHmac } from 'node:crypto'
import { inSerializableTx } from '../lib/db.mjs'
import { resolveHmacKey } from '../lib/config.mjs'
import { canonicalJson } from '../lib/canonical-json.mjs'
import { scheduleNext } from '../lib/scheduler.mjs'

const HMAC_KEY = resolveHmacKey(process.env)
if (!HMAC_KEY) throw new Error('TIDEMARK_HMAC_KEY not set to a non-empty value (or export TIDEMARK_DEV_INSECURE=1 for local dev only)')

const RX_SLUG = /^[a-z0-9_.-]{1,64}$/i
const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const fp = (tenant_id, agent_id, params) =>
  createHmac('sha256', `${HMAC_KEY}|${tenant_id}|${agent_id}`).update(canonicalJson(params)).digest()

// clamp 已删：未来锚点在调用前显式拒绝（结论 10——不准用 max(age,0) 掩盖）
const decay = (anchor, anchorAt, halfLife, now) =>
  Number(anchor) * Math.exp(-Math.LN2 * ((now - new Date(anchorAt).getTime()) / 3600e3) / Number(halfLife))

export const pinTool = async ({ principal, memory_id, pinned, reason, request_id }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  if (!(principal.capabilities ?? []).includes('memory:pin')) return { ok: false, error: 'pin_capability_required' }
  if (!request_id || typeof request_id !== 'string') return { ok: false, error: 'request_id_required' }
  if (!memory_id || !RX_UUID.test(memory_id)) return { ok: false, error: 'memory_id_invalid' }
  if (typeof pinned !== 'boolean') return { ok: false, error: 'pinned_must_be_boolean' }
  if (!reason || !RX_SLUG.test(reason)) return { ok: false, error: 'reason_must_be_slug' }

  const { tenant_id, agent_id } = principal
  const fingerprint = fp(tenant_id, agent_id, { memory_id, pinned, reason })

  return inSerializableTx(async (c) => {
    const prior = (await c.query(
      'SELECT payload_hmac, response_json FROM tool_requests WHERE tenant_id=$1 AND agent_id=$2 AND tool_name=$3 AND request_id=$4',
      [tenant_id, agent_id, 'pin', request_id])).rows[0]
    if (prior) {
      if (!prior.payload_hmac.equals(fingerprint)) return { ok: false, error: 'idempotency_key_reused' }
      return prior.response_json
    }

    const m = (await c.query(
      `SELECT admission, state, exp_status, layer, pinned, strength_anchor, strength_anchor_at, half_life_hours,
              credited_success_count, consolidation_baseline
       FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3`,
      [tenant_id, agent_id, memory_id])).rows[0]
    if (!m) return { ok: false, error: 'memory_not_found_in_scope' }
    if (m.admission !== 'accepted') return { ok: false, error: 'only_accepted_memories_pinnable' }
    if (m.layer === 'experience' && m.exp_status === 'superseded') return { ok: false, error: 'superseded_not_pinnable' }

    const now = Date.now()
    // 时间不变量（结论 10）：未来锚点拒绝一切状态转换——pin 会把它 materialize 到 now、
    // unpin 会把它 reset 到 now，两者都是回拨清洗。no-op 路径一并拒，行为统一
    if (new Date(m.strength_anchor_at).getTime() > now) return { ok: false, error: 'future_timestamp_rejected' }
    let response
    if (m.pinned === pinned) {
      // 幂等 set：状态已一致，零副作用
      response = { ok: true, memory_id, pinned, transition: false, strength_anchor: Number(m.strength_anchor) }
    } else if (pinned) {
      // pin：materialize 冻结当下 effective（结论 15：不偷偷升 1）；退出 lifecycle 队列（scheduler: pinned -> NULL）
      const eff = decay(m.strength_anchor, m.strength_anchor_at, m.half_life_hours, now)
      await c.query(
        `UPDATE memories SET pinned=true, strength_anchor=$4, strength_anchor_at=now(), revision=revision+1,
           next_transition_at=NULL
         WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3`,
        [tenant_id, agent_id, memory_id, eff])
      response = { ok: true, memory_id, pinned: true, transition: true, frozen_at_strength: +eff.toFixed(6) }
    } else {
      // unpin：保 anchor、重置 anchor_at，恢复衰减并重新入队——pinned 期间攒的 progress
      // 若已达标，scheduler 会立即 due（修 Codex 方案审 #4 的漏资格）
      const nextAt = scheduleNext({
        admission: m.admission, pinned: false, state: m.state,
        strength_anchor: m.strength_anchor, strength_anchor_at: new Date(now),
        half_life_hours: m.half_life_hours, credited_success_count: m.credited_success_count,
        consolidation_baseline: m.consolidation_baseline,
      }, now)
      await c.query(
        `UPDATE memories SET pinned=false, strength_anchor_at=now(), revision=revision+1,
           next_transition_at=$4
         WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3`,
        [tenant_id, agent_id, memory_id, nextAt])
      response = { ok: true, memory_id, pinned: false, transition: true, resumed_at_strength: Number(m.strength_anchor) }
    }
    await c.query(
      'INSERT INTO tool_requests (tenant_id, agent_id, tool_name, request_id, payload_hmac, response_json) VALUES ($1,$2,$3,$4,$5,$6)',
      [tenant_id, agent_id, 'pin', request_id, fingerprint, response])
    // reason 不进日志：任意 slug 是低门槛正文通道，CloudWatch 残留会破坏硬删除承诺；
    // 它只参与 payload_hmac（密文）——审计需要时以 request_id 对账调用方自己的记录
    console.log(JSON.stringify({ evt: 'pin', memory_id, pinned, transition: response.transition, tenant_id, agent_id }))
    return response
  }, 'pin-commit').catch(async (e) => {
    if (e.code !== '23505') throw e
    const winner = await inSerializableTx(async (c) => (await c.query(
      'SELECT payload_hmac, response_json FROM tool_requests WHERE tenant_id=$1 AND agent_id=$2 AND tool_name=$3 AND request_id=$4',
      [tenant_id, agent_id, 'pin', request_id])).rows[0] ?? null, 'pin-winner')
    if (!winner) throw e
    if (!winner.payload_hmac.equals(fingerprint)) return { ok: false, error: 'idempotency_key_reused' }
    return winner.response_json
  })
}
