// log_event：attempt_events 追加式证据台账的唯一写入口（SPEC §1.2/§4）
// - 幂等经 tool_requests（结论 21）
// - memory_used 事件 server-validated（冻结 §12.2）：payload 必含三元组且指向本 agent 的真实 receipt item，
//   attempt 必须与 receipt 绑定的 attempt 一致——它是 credited 的唯一合法证据，不能凭空捏造
// - payload 卫生：大小上限；台账不得复制记忆正文（§12.5，注释性约束+大小闸门兜底）
import { createHmac, randomUUID } from 'node:crypto'
import { inWriteTx as inSerializableTx } from '../lib/db.mjs'
import { resolveHmacKey } from '../lib/config.mjs'
import { canonicalJson } from '../lib/canonical-json.mjs'

const HMAC_KEY = resolveHmacKey(process.env)
if (!HMAC_KEY) throw new Error('TIDEMARK_HMAC_KEY not set to a non-empty value (or export TIDEMARK_DEV_INSECURE=1 for local dev only)')

export const EVENT_TYPES = ['tool_call', 'tool_error', 'user_correction', 'attempt_start', 'attempt_end', 'memory_used', 'note']
const MAX_PAYLOAD_BYTES = 4096   // 防御性兜底（UTF-8 字节，canonical JSON）；白名单下正常不可达

// ---- payload 白名单 schema（Codex P0 二连：台账只准装操作性 ID/有限枚举/有界数值）----
// 语义字符串字段一律【有限枚举】而非通用 slug——任意短正文换个格式也进不来；
// 没有冻结枚举的字段（如原 note.code）直接没收。散文属于 remember，台账是纯骨架。
const RX = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  hex64: /^[0-9a-f]{64}$/i,   // 恰 64 位 hex（sha256），不多不少
}
const vUuid = (v) => typeof v === 'string' && RX.uuid.test(v)
const vHex64 = (v) => typeof v === 'string' && RX.hex64.test(v)
const vInt = (v) => Number.isInteger(v) && v >= 0 && v <= 10_000_000
const vEnum = (set) => (v) => set.includes(v)

export const ERROR_TYPES = ['timeout', 'crash', 'nonzero_exit', 'invalid_input', 'permission_denied', 'not_found', 'network', 'oom', 'assertion_failed', 'other']
export const CORRECTION_TYPES = ['factual_error', 'wrong_approach', 'wrong_scope', 'style', 'safety', 'other']
export const ATTEMPT_STATUSES = ['success', 'failure', 'cancelled']

// 冻结结论 4：失败证据必须可表达 task/attempt/tool/error_type/outcome/trace_id/timestamp——
// tool_error 强制 top-level tool_name + payload error_type/trace_id；attempt_end 强制 status
const PAYLOAD_SCHEMAS = {
  attempt_start: { required: {}, optional: {} },                                  // payload 只能为空
  attempt_end: { required: { status: vEnum(ATTEMPT_STATUSES) }, optional: { trace_id: vUuid } },
  tool_call: { required: {}, optional: { args_digest: vHex64, duration_ms: vInt, exit_code: vInt, trace_id: vUuid } },
  tool_error: { required: { error_type: vEnum(ERROR_TYPES), trace_id: vUuid }, optional: { args_digest: vHex64, duration_ms: vInt, exit_code: vInt } },
  user_correction: { required: {}, optional: { correction_type: vEnum(CORRECTION_TYPES), trace_id: vUuid } },
  note: { required: {}, optional: { ref: vUuid } },                               // code 已没收：无冻结枚举的语义字段不许存在
  memory_used: { required: { recall_request_id: vUuid, receipt_item_id: vUuid, memory_id: vUuid }, optional: {} },
}
const TOOL_NAME_REQUIRED = new Set(['tool_error'])   // 冻结结论 4：失败事件必须带 tool

const validatePayload = (event_type, payload) => {
  const schema = PAYLOAD_SCHEMAS[event_type]
  const p = payload ?? {}
  if (typeof p !== 'object' || Array.isArray(p)) return 'payload_must_be_object'
  const requiredKeys = Object.keys(schema.required ?? {})
  if (requiredKeys.length > 0 && (payload === undefined || payload === null)) return `${event_type}_payload_required`
  const allowed = { ...(schema.required ?? {}), ...(schema.optional ?? {}) }
  for (const k of Object.keys(p)) {
    if (!(k in allowed)) return `payload_key_not_allowed:${k}`
    if (!allowed[k](p[k])) return `payload_value_invalid:${k}`
  }
  for (const k of requiredKeys) {
    if (!(k in p)) return event_type === 'memory_used' ? `memory_used_payload_missing_${k}` : `${event_type}_payload_missing_${k}`
  }
  return null
}

const payloadHmac = (tenant_id, agent_id, params) =>
  createHmac('sha256', `${HMAC_KEY}|${tenant_id}|${agent_id}`).update(canonicalJson(params)).digest()

export const logEventTool = async ({ principal, episode_id, task_instance_id, attempt_id, event_type, tool_name, payload, request_id }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  for (const [k, v] of [['request_id', request_id], ['episode_id', episode_id],
                        ['task_instance_id', task_instance_id], ['attempt_id', attempt_id], ['event_type', event_type]]) {
    if (!v || typeof v !== 'string') return { ok: false, error: `${k}_required` }
  }
  if (!EVENT_TYPES.includes(event_type)) return { ok: false, error: 'event_type_invalid' }
  if (tool_name != null && (typeof tool_name !== 'string' || !/^[a-z0-9_.-]{1,64}$/i.test(tool_name))) return { ok: false, error: 'tool_name_invalid' }
  if (TOOL_NAME_REQUIRED.has(event_type) && !tool_name) return { ok: false, error: `${event_type}_tool_name_required` }
  const schemaError = validatePayload(event_type, payload)
  if (schemaError) return { ok: false, error: schemaError }
  if (payload != null && Buffer.byteLength(canonicalJson(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: 'payload_too_large' }   // UTF-8 字节精确计量；白名单下正常不可达，纯兜底
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

    // memory_used 的 server-side 校验（冻结 §12.2）：receipt 属本 agent + attempt 一致 + episode 一致 + item 存在且 injected
    if (event_type === 'memory_used') {
      const p = payload
      const rr = (await c.query(
        'SELECT agent_id, attempt_id, episode_id, receipt_json FROM recall_requests WHERE tenant_id=$1 AND request_id=$2',
        [tenant_id, p.recall_request_id])).rows[0]
      if (!rr || rr.agent_id !== agent_id) return { ok: false, error: 'memory_used_receipt_not_found_in_scope' }
      if (rr.attempt_id !== attempt_id) return { ok: false, error: 'memory_used_attempt_mismatch' }
      if (rr.episode_id !== episode_id) return { ok: false, error: 'memory_used_episode_mismatch' }
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
