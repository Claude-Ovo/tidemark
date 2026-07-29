// remember：写入卫生闸门 -> (accepted 时事务外 embedding) -> 单事务 claim tool_requests + INSERT memories
// SPEC §4/§5/§12 + 结论 21/23/28。source 由 server 按调用路径分配（agent tool = agent_inferred）。
import { createHmac, randomUUID } from 'node:crypto'
import { inSerializableTx } from '../lib/db.mjs'
import { runAdmissionGate, QUARANTINE_TTL_HOURS } from '../lib/admission.mjs'
import { embed } from '../lib/embed.mjs'
import { canonicalDigest, toVectorLiteral } from '../lib/vector-canonical.mjs'

// fail-closed：非空 key 判断经 config.mjs（.env.example 复制出的空串不算已配置）；key 永不落日志
import { resolveHmacKey } from '../lib/config.mjs'
const HMAC_KEY = resolveHmacKey(process.env)
if (!HMAC_KEY) throw new Error('TIDEMARK_HMAC_KEY not set to a non-empty value (or export TIDEMARK_DEV_INSECURE=1 for local dev only)')
const BASE_HALF_LIFE_HOURS = { event: 72, experience: 2160 }
// TODO(P0-06 显式收口，Codex 裁定)：next_transition_at 初始化公式属 P0-06——
// 届时必须 (a) remember 落行时初始化 (b) 回填此前的 NULL 行；两者都进 P0-06 验收测试。

const payloadHmac = (payload) =>
  createHmac('sha256', HMAC_KEY).update(JSON.stringify(payload)).digest()

export const rememberTool = async ({ principal, content, kind, episode_id, request_id, importance }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  if (!request_id || typeof request_id !== 'string') return { ok: false, error: 'request_id_required' }
  if (!episode_id || typeof episode_id !== 'string') return { ok: false, error: 'episode_id_required' }

  // 先过闸门拿 canonical——HMAC/敏感筛/embedding/落库全部使用同一 canonical content
  const gate = runAdmissionGate({ content, kind, importance })
  const { tenant_id, agent_id } = principal
  const hmac = payloadHmac({ content: gate.canonical ?? content, kind: kind ?? null, episode_id, importance: importance ?? null })

  // 幂等 preflight（事务外，省 embedding 钱；事务内还有二次防线）
  const existing = await inSerializableTx(async (c) => {
    const r = await c.query(
      'SELECT payload_hmac, response_json FROM tool_requests WHERE tenant_id=$1 AND agent_id=$2 AND tool_name=$3 AND request_id=$4',
      [tenant_id, agent_id, 'remember', request_id])
    return r.rows[0] ?? null
  }, 'remember-preflight')
  if (existing) {
    if (!existing.payload_hmac.equals(hmac)) return { ok: false, error: 'idempotency_key_reused' }
    return existing.response_json
  }

  const imp = importance ?? 0.5
  const layer = 'event'                       // agent tool 只能写事件层；experience 由 nightly reflection 产生
  const source = 'agent_inferred'             // server 按调用路径分配，不信 client 自报（结论 28）

  // accepted 才 embedding（事务外，Bedrock/stub 网络调用不进事务——结论 23）
  let f32 = null, embeddingMeta = null
  if (gate.admission === 'accepted') {
    const e = await embed(gate.canonical)
    f32 = e.f32
    embeddingMeta = { model_id: e.model_id, provider: e.provider, embedding_sha256: canonicalDigest(e.f32) }
  }

  const memory_id = randomUUID()
  const response = {
    ok: gate.admission !== 'rejected',
    memory_id: gate.admission === 'rejected' ? null : memory_id,
    admission: gate.admission,
    reasons: gate.reasons,
    layer, source,
    ...(embeddingMeta ?? {})
  }

  // 单事务：claim + insert 同 commit（结论 23）；rejected 只记 claim 不落 memory
  return inSerializableTx(async (c) => {
    try {
      await c.query(
        'INSERT INTO tool_requests (tenant_id, agent_id, tool_name, request_id, payload_hmac, response_json) VALUES ($1,$2,$3,$4,$5,$6)',
        [tenant_id, agent_id, 'remember', request_id, hmac, response])
    } catch (e) {
      if (e.code !== '23505') throw e
      throw Object.assign(new Error('concurrent_first_writer'), { code: 'CONCURRENT_WINNER' })
    }
    if (gate.admission !== 'rejected') {
      await c.query(
        `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, kind, episode_id, content, embedding,
           source, admission, quarantine_expires_at, importance, strength_anchor, strength_anchor_at,
           last_rewarded_at, half_life_hours)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, 1.0, now(), now(), $13)`,
        [tenant_id, agent_id, memory_id, layer, kind ?? null, episode_id, gate.canonical,
         f32 ? toVectorLiteral(f32) : null,
         source, gate.admission,
         gate.admission === 'quarantined' ? new Date(Date.now() + QUARANTINE_TTL_HOURS * 3600e3) : null,
         imp, BASE_HALF_LIFE_HOURS[layer] * (1 + imp)])
    }
    console.log(JSON.stringify({ evt: 'remember', request_id, memory_id: response.memory_id, tenant_id, agent_id, admission: gate.admission }))
    return response
  }, 'remember-commit').catch(async (e) => {
    if (e.code !== 'CONCURRENT_WINNER') throw e
    // 并发首提交者语义：loser 新事务重读首次结果（结论 23 + P0-02 审的 ROLLBACK 后重读）
    const winner = await inSerializableTx(async (c) => {
      const r = await c.query(
        'SELECT payload_hmac, response_json FROM tool_requests WHERE tenant_id=$1 AND agent_id=$2 AND tool_name=$3 AND request_id=$4',
        [tenant_id, agent_id, 'remember', request_id])
      return r.rows[0] ?? null
    }, 'remember-winner-read')
    if (!winner) throw e
    if (!winner.payload_hmac.equals(hmac)) return { ok: false, error: 'idempotency_key_reused' }
    return winner.response_json
  })
}
