// log_event：attempt_events 追加式证据台账的唯一写入口（SPEC §1.2/§4）
// - 幂等经 tool_requests（结论 21）
// - memory_used 事件 server-validated（冻结 §12.2）：payload 必含三元组且指向本 agent 的真实 receipt item，
//   attempt 必须与 receipt 绑定的 attempt 一致——它是 credited 的唯一合法证据，不能凭空捏造
// - payload 卫生：大小上限；台账不得复制记忆正文（§12.5，注释性约束+大小闸门兜底）
import { createHmac, randomUUID } from 'node:crypto'
import { inSerializableTx } from '../lib/db.mjs'
import { resolveHmacKey } from '../lib/config.mjs'
import { canonicalJson } from '../lib/canonical-json.mjs'

const HMAC_KEY = resolveHmacKey(process.env)
if (!HMAC_KEY) throw new Error('TIDEMARK_HMAC_KEY not set to a non-empty value (or export TIDEMARK_DEV_INSECURE=1 for local dev only)')

export const EVENT_TYPES = ['tool_call', 'tool_error', 'user_correction', 'attempt_start', 'attempt_end', 'memory_used', 'note']
const MAX_PAYLOAD_CHARS = 4000

const payloadHmac = (tenant_id, agent_id, params) =>
  createHmac('sha256', `${HMAC_KEY}|${tenant_id}|${agent_id}`).update(canonicalJson(params)).digest()

export const logEventTool = async ({ principal, episode_id, task_instance_id, attempt_id, event_type, tool_name, payload, request_id }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  for (const [k, v] of [['request_id', request_id], ['episode_id', episode_id],
                        ['task_instance_id', task_instance_id], ['attempt_id', attempt_id], ['event_type', event_type]]) {
    if (!v || typeof v !== 'string') return { ok: false, error: `${k}_required` }
  }
  if (!EVENT_TYPES.includes(event_type)) return { ok: false, error: 'event_type_invalid' }
  if (tool_name != null && (typeof tool_name !== 'string' || tool_name.length > 128)) return { ok: false, error: 'tool_name_invalid' }
  if (payload !== undefined && payload !== null) {
    if (typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, error: 'payload_must_be_object' }
    if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS) return { ok: false, error: 'payload_too_large' }
  }

  const { tenant_id, agent_id } = principal
  const fp = payloadHmac(tenant_id, agent_id, { episode_id, task_instance_id, attempt_id, event_type, tool_name: tool_name ?? null, payload: payload ?? null })

  return inSerializableTx(async (c) => {
    // 幂等 claim
    const prior = (await c.query(
      'SELECT payload_hmac, response_json FROM tool_requests WHERE tenant_id=$1 AND agent_id=$2 AND tool_name=$3 AND request_id=$4',
      [tenant_id, agent_id, 'log_event', request_id])).rows[0]
    if (prior) {
      if (!prior.payload_hmac.equals(fp)) return { ok: false, error: 'idempotency_key_reused' }
      return prior.response_json
    }

    // memory_used 的 server-side 校验（冻结 §12.2）：三元组齐全 + receipt 属本 agent + attempt 一致 + item 存在且 injected
    if (event_type === 'memory_used') {
      const p = payload ?? {}
      for (const k of ['recall_request_id', 'receipt_item_id', 'memory_id']) {
        if (!p[k] || typeof p[k] !== 'string') return { ok: false, error: `memory_used_payload_missing_${k}` }
      }
      const rr = (await c.query(
        'SELECT agent_id, attempt_id, receipt_json FROM recall_requests WHERE tenant_id=$1 AND request_id=$2',
        [tenant_id, p.recall_request_id])).rows[0]
      if (!rr || rr.agent_id !== agent_id) return { ok: false, error: 'memory_used_receipt_not_found_in_scope' }
      if (rr.attempt_id !== attempt_id) return { ok: false, error: 'memory_used_attempt_mismatch' }
      const item = (rr.receipt_json?.receipt?.items ?? []).find(i => i.receipt_item_id === p.receipt_item_id)
      if (!item || item.memory_id !== p.memory_id) return { ok: false, error: 'memory_used_item_mismatch' }
      if (!item.injected) return { ok: false, error: 'memory_used_item_not_injected' }
    }

    const event_id = randomUUID()
    await c.query(
      `INSERT INTO attempt_events (tenant_id, agent_id, episode_id, task_instance_id, attempt_id, event_id, event_type, tool_name, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenant_id, agent_id, episode_id, task_instance_id, attempt_id, event_id, event_type, tool_name ?? null, payload ?? null])
    const response = { ok: true, event_id, event_type }
    await c.query(
      'INSERT INTO tool_requests (tenant_id, agent_id, tool_name, request_id, payload_hmac, response_json) VALUES ($1,$2,$3,$4,$5,$6)',
      [tenant_id, agent_id, 'log_event', request_id, fp, response])
    console.log(JSON.stringify({ evt: 'log_event', event_id, event_type, tenant_id, agent_id, attempt_id }))
    return response
  }, 'log-event-commit').catch(async (e) => {
    if (e.code !== '23505') throw e
    const winner = await inSerializableTx(async (c) => (await c.query(
      'SELECT payload_hmac, response_json FROM tool_requests WHERE tenant_id=$1 AND agent_id=$2 AND tool_name=$3 AND request_id=$4',
      [tenant_id, agent_id, 'log_event', request_id])).rows[0] ?? null, 'log-event-winner')
    if (!winner) throw e
    if (!winner.payload_hmac.equals(fp)) return { ok: false, error: 'idempotency_key_reused' }
    return winner.response_json
  })
}
