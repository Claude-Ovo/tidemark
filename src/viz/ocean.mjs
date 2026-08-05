// P0-11 viz 只读面（owner/viewer face，agent 面 5 工具不动）：给"会遗忘的海"供数。
// 契约（DESIGN-OCEAN.md 数据契约，Codex kickoff 四条）：
//   #2 单一快照：snapshot_at 取【同一事务内的 DB now()】，全部 effective_strength 由
//      服务端用与 recall 完全相同的 decayEffective 在该时刻计算；一个事务=一个快照。
//   #3 浪的真源：waves 只吐 persisted recall receipt（recall_requests 行），
//      keyset 游标 (created_at, request_id) 稳定增量，重放天然去重（游标单调）。
// 只读：全程 SELECT，绝不产生 receipt/不触发塑性。auth 复用 agent key（tenant/agent 定界）。
import { inSerializableTx } from '../lib/db.mjs'
import { decayEffective } from '../lib/decay.mjs'

const FADE_THRESHOLD = 0.15   // 与 TRANSITION_CFG.fade_threshold 同值（沙水线，契约冻结）

const PREVIEW_CHARS = 140

export const vizOcean = async ({ principal }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  const { tenant_id, agent_id } = principal
  return inSerializableTx(async (c) => {
    const snapshotAt = (await c.query('SELECT now() AS t')).rows[0].t
    const nowMs = new Date(snapshotAt).getTime()
    // 海湾（岛屿）：同租户各 agent 的记忆量——隔离即地理
    const agents = (await c.query(
      `SELECT agent_id, count(*)::INT AS memory_count FROM memories
       WHERE tenant_id = $1 AND admission = 'accepted' GROUP BY agent_id ORDER BY agent_id`,
      [tenant_id])).rows
    // 本海湾的记忆（accepted 全量；demo 规模有界，天然 < 数千）
    const rows = (await c.query(
      `SELECT memory_id, layer, kind, episode_id, exp_status, pinned, state,
              strength_anchor, strength_anchor_at, half_life_hours,
              credited_success_count, evidenced_blame_count, created_at,
              left(content, ${PREVIEW_CHARS}) AS content_preview
       FROM memories
       WHERE tenant_id = $1 AND agent_id = $2 AND admission = 'accepted'
       ORDER BY created_at, memory_id`,
      [tenant_id, agent_id])).rows
    const episodes = new Map()
    for (const r of rows) {
      const ep = r.episode_id ?? '(no-episode)'
      if (!episodes.has(ep)) episodes.set(ep, [])
      episodes.get(ep).push({
        memory_id: r.memory_id, layer: r.layer, kind: r.kind, exp_status: r.exp_status,
        pinned: r.pinned, state: r.state,
        effective_strength: decayEffective(r, nowMs),
        credited: Number(r.credited_success_count), blamed: Number(r.evidenced_blame_count),
        created_at: r.created_at, content_preview: r.content_preview,
      })
    }
    return {
      ok: true, snapshot_at: snapshotAt, fade_threshold: FADE_THRESHOLD,
      tenant_id, agent_id,
      agents,
      episodes: [...episodes.entries()].map(([episode_id, memories]) => ({ episode_id, memories })),
    }
  }, 'viz-ocean')
}

// 浪流：persisted receipt 的 keyset 增量。after = base64("createdAtIso|request_id")
export const vizWaves = async ({ principal, after, limit = 50 }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  const { tenant_id, agent_id } = principal
  let curAt = new Date(0).toISOString(), curId = ''
  if (after) {
    try {
      const [a, b] = Buffer.from(String(after), 'base64').toString('utf8').split('|')
      if (!a || Number.isNaN(new Date(a).getTime())) throw new Error('bad')
      curAt = a; curId = b ?? ''
    } catch { return { ok: false, error: 'cursor_invalid' } }
  }
  const n = Math.min(Math.max(1, Number(limit) || 50), 200)
  return inSerializableTx(async (c) => {
    const rows = (await c.query(
      `SELECT request_id, episode_id, attempt_id, created_at,
              jsonb_array_length(receipt_json->'receipt'->'items') AS items_count
       FROM recall_requests
       WHERE tenant_id = $1 AND agent_id = $2
         AND (created_at, request_id) > ($3::TIMESTAMPTZ, $4)
       ORDER BY created_at, request_id LIMIT ${n}`,
      [tenant_id, agent_id, curAt, curId])).rows
    const last = rows[rows.length - 1]
    return {
      ok: true,
      waves: rows.map(r => ({ request_id: r.request_id, episode_id: r.episode_id,
        attempt_id: r.attempt_id, created_at: r.created_at, items_count: Number(r.items_count ?? 0) })),
      cursor: last
        ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.request_id}`).toString('base64')
        : (after ?? null),
    }
  }, 'viz-waves')
}
