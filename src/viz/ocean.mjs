// P0-11 viz 只读面（owner/viewer face，agent 面 5 工具不动）：给"会遗忘的海"供数。
// 契约（DESIGN-OCEAN.md 数据契约，Codex kickoff 四条 + 一审修订）：
//   #2 单一快照：snapshot_at 取【同一事务内的 DB now()】，全部 effective_strength 由
//      服务端用与 recall 完全相同的 decayEffective 在该时刻计算；一个事务=一个快照。
//   #3 浪的真源：waves 只吐 persisted recall receipt（recall_requests 行），
//      keyset 游标 (created_at, request_id) 稳定增量，重放天然去重（游标单调）。
//   一审 P0-2：海湾清单（全租户 agents）只给 scope='viz' 的 viewer 键——它是 owner 建的
//      观景凭证；agent 键只见自己，不越 agent 隔离。
//   一审 P1-3：episode_id 为 NULL 的记忆不合成假气泡——逐条作 loose 散粒返回。
//   一审 P1-4：fade_threshold 只从 TRANSITION_CFG 取，禁止第二真相源。
//   一审 P1-5：快照有上界（cap 时保留 total_memories 声明截断），绝不静默。
// 只读：全程 SELECT，绝不产生 receipt/不触发塑性。
import { inSerializableTx } from '../lib/db.mjs'
import { decayEffective } from '../lib/decay.mjs'
import { TRANSITION_CFG } from '../lib/scheduler.mjs'
import { SAFETY_GRACE_MS } from '../lib/viz-config.mjs'
import { encodeCursor } from './activity.mjs'

const BASELINE_KEY_CAP = 400   // 每源热窗口 key 上限（30s 窗口远够；触顶声明 truncated）

const PREVIEW_CHARS = 140
export const MAX_SNAPSHOT_MEMORIES = 2000   // demo 规模远低于此；触顶取最新、total 照报

const memoryView = (r, nowMs) => ({
  memory_id: r.memory_id, layer: r.layer, kind: r.kind, exp_status: r.exp_status,
  pinned: r.pinned, state: r.state,
  effective_strength: decayEffective(r, nowMs),
  credited: Number(r.credited_success_count), blamed: Number(r.evidenced_blame_count),
  created_at: r.created_at, content_preview: r.content_preview,
})

// cap 可注入仅为测试边界行为（cap-1/cap/cap+1 不必真插两千行）；生产路径永远走默认
export const vizOcean = async ({ principal, cap = MAX_SNAPSHOT_MEMORIES }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  const capN = Math.max(1, Math.floor(Number(cap) || MAX_SNAPSHOT_MEMORIES))
  const { tenant_id, agent_id } = principal
  return inSerializableTx(async (c) => {
    const snapshotAt = (await c.query('SELECT now() AS t')).rows[0].t
    const nowMs = new Date(snapshotAt).getTime()
    // 海湾（岛屿）清单是租户级视图：只有 viewer 键（scope='viz'）配看；agent 键只见自己
    const agents = principal.scope === 'viz'
      ? (await c.query(
          `SELECT agent_id, count(*)::INT AS memory_count FROM memories
           WHERE tenant_id = $1 AND admission = 'accepted' GROUP BY agent_id ORDER BY agent_id`,
          [tenant_id])).rows
      : (await c.query(
          `SELECT agent_id, count(*)::INT AS memory_count FROM memories
           WHERE tenant_id = $1 AND agent_id = $2 AND admission = 'accepted' GROUP BY agent_id`,
          [tenant_id, agent_id])).rows
    const total = (await c.query(
      `SELECT count(*)::INT AS n FROM memories
       WHERE tenant_id = $1 AND agent_id = $2 AND admission = 'accepted'`,
      [tenant_id, agent_id])).rows[0].n
    // 触顶时保最新（画面偏向近期活动），capped 声明截断，绝不装作全量
    const rows = (await c.query(
      `SELECT memory_id, layer, kind, episode_id, exp_status, pinned, state,
              strength_anchor, strength_anchor_at, half_life_hours,
              credited_success_count, evidenced_blame_count, created_at,
              left(content, ${PREVIEW_CHARS}) AS content_preview
       FROM memories
       WHERE tenant_id = $1 AND agent_id = $2 AND admission = 'accepted'
       ORDER BY created_at DESC, memory_id DESC LIMIT ${capN}`,
      [tenant_id, agent_id])).rows.reverse()
    const grouped = new Map()
    const loose = []
    for (const r of rows) {
      if (r.episode_id == null) { loose.push(memoryView(r, nowMs)); continue }
      if (!grouped.has(r.episode_id)) grouped.set(r.episode_id, [])
      grouped.get(r.episode_id).push(memoryView(r, nowMs))
    }
    // activity_baseline（live 环二审 P1-1）：与本快照【同一事务=同一可见性边界】的
    // 消费基线——closed watermark cursor + 快照已见的热窗口事件 key。客户端以此起搏：
    // 已表示的热事件不重演；快照之后的晚提交仍会被 poll 的 hot 重放接住。
    // 任一源触顶 BASELINE_KEY_CAP → truncated=true，另附 snapshot_at 哨兵 cursor 供
    // fail-closed 降级（跳过整个热窗口——零假重演，代价是丢过载边缘的晚提交动画）。
    const wm = (await c.query(
      `SELECT (now() - $1::INTERVAL)::STRING AS wm_exact, now()::STRING AS now_exact`,
      [`${SAFETY_GRACE_MS} milliseconds`])).rows[0]
    const hotKeys = []
    let truncated = false
    for (const src of [
      { kind: 'remember', sql: `SELECT memory_id AS id FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND admission='accepted' AND created_at > $3::TIMESTAMPTZ ORDER BY created_at, memory_id LIMIT ${BASELINE_KEY_CAP + 1}` },
      { kind: 'recall', sql: `SELECT request_id AS id FROM recall_requests WHERE tenant_id=$1 AND agent_id=$2 AND created_at > $3::TIMESTAMPTZ ORDER BY created_at, request_id LIMIT ${BASELINE_KEY_CAP + 1}` },
      { kind: 'outcome', sql: `SELECT outcome_request_id AS id FROM outcomes WHERE tenant_id=$1 AND agent_id=$2 AND reported_at > $3::TIMESTAMPTZ ORDER BY reported_at, outcome_request_id LIMIT ${BASELINE_KEY_CAP + 1}` },
    ]) {
      const r = (await c.query(src.sql, [tenant_id, agent_id, wm.wm_exact])).rows
      if (r.length > BASELINE_KEY_CAP) { truncated = true; r.length = BASELINE_KEY_CAP }
      for (const row of r) hotKeys.push(`${src.kind}|${row.id}`)
    }
    return {
      ok: true, snapshot_at: snapshotAt,
      fade_threshold: TRANSITION_CFG.fade_threshold,
      tenant_id, agent_id,
      agents,
      total_memories: Number(total),
      capped: Number(total) > rows.length,
      episodes: [...grouped.entries()].map(([episode_id, memories]) => ({ episode_id, memories })),
      // NULL episode 不是一个共同气泡：每条散粒独立漂（前端不画膜、按 memory_id 布局）
      loose,
      activity_baseline: {
        cursor: encodeCursor(wm.wm_exact, '~', '~'),
        cursor_snapshot: encodeCursor(wm.now_exact, '~', '~'),   // truncated 降级用
        seen_keys: hotKeys,
        truncated,
      },
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
    // 游标时间戳必须取 SQL 侧精确字符串：CRDB TIMESTAMPTZ 是微秒精度，
    // 走 JS Date/toISOString 会截断到毫秒——截断游标 < 原行，游标行每轮被重新返回，
    // 永远推不过最后一行（浪实测抓获：同一 request_id 连续三轮 n=1 复现）。
    const rows = (await c.query(
      `SELECT request_id, episode_id, attempt_id, created_at, created_at::STRING AS created_at_exact,
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
        ? Buffer.from(`${last.created_at_exact}|${last.request_id}`).toString('base64')
        : (after ?? null),
    }
  }, 'viz-waves')
}
