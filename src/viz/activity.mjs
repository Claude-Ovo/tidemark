// P0-11 v2 /viz/activity：三源派生活动流（DESIGN-OCEAN.md 契约 B + SPEC §14，冻结）。
// 核心语义（Codex v2 一审 P1-1 + 四审边界）：
//   三源时间列都是事务内 DEFAULT now()——不是提交顺序的全局水位，旧时间戳的行可能
//   晚提交。所以 durable cursor 只推进到 closed watermark = DB now() - SAFETY_GRACE；
//   watermark 之后的 hot-window 事件立即返回（动效不吃 30s 延迟）但后续轮会重放，
//   客户端按 (source_kind, source_id) 幂等去重。SAFETY_GRACE > 写事务 wall-clock 上限
//   （15s，见 db.mjs inWriteTx），保证 watermark 之前的行已全部提交可见。
//   backlog 截断时 cursor 停在最后返回事件（不跳过未返回行）；否则推进到 watermark。
// 排序：确定性全序 (occurred_at 微秒精确串, source_kind, source_id)。
//   时间戳一律取 SQL 侧 ::STRING（微秒精度；同格式 UTC 下字典序 = 时间序——
//   小数尾零截断不破坏比较：整数部分定宽，'+'(0x2b) < '.'(0x2e)）。
// 只读：全程 SELECT，绝不产生 receipt/不触发塑性。
import { inSerializableTx } from '../lib/db.mjs'

export const ACTIVITY_CFG = {
  safety_grace_ms: 30000,   // SPEC §14 冻结：必须 > TIDEMARK_WRITE_TX_TIMEOUT_MS
  default_limit: 100,
  max_limit: 500,
}

const encodeCursor = (at, kind, id) => Buffer.from(`${at}|${kind}|${id}`).toString('base64')
const decodeCursor = (after) => {
  const [at, kind, id] = Buffer.from(String(after), 'base64').toString('utf8').split('|')
  if (!at || Number.isNaN(new Date(at).getTime())) throw new Error('bad')
  return { at, kind: kind ?? '', id: id ?? '' }
}
// 确定性全序：(occurred_at exact, kind, id)——exact 串字典序即时间序
const tupleCmp = (a, b) =>
  (a.at_exact < b.at_exact ? -1 : a.at_exact > b.at_exact ? 1 : 0) ||
  (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
  (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0)
const afterCursor = (ev, cur) =>
  ev.at_exact > cur.at ? true : ev.at_exact < cur.at ? false :
    ev.kind > cur.kind ? true : ev.kind < cur.kind ? false : ev.event_id > cur.id

export const vizActivity = async ({ principal, after, limit }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  const { tenant_id, agent_id } = principal
  let cur = { at: '1970-01-01 00:00:00+00', kind: '', id: '' }
  if (after) {
    try { cur = decodeCursor(after) } catch { return { ok: false, error: 'cursor_invalid' } }
  }
  const n = Math.min(Math.max(1, Number(limit) || ACTIVITY_CFG.default_limit), ACTIVITY_CFG.max_limit)

  return inSerializableTx(async (c) => {
    const wm = (await c.query(
      `SELECT (now() - $1::INTERVAL)::STRING AS wm_exact, now()::STRING AS now_exact`,
      [`${ACTIVITY_CFG.safety_grace_ms} milliseconds`])).rows[0]

    // 三源各取 >= 游标时间（同刻不同 kind/id 由 JS 全序过滤），带 buffer 防同刻挤压
    const fetchN = n + 32
    const remembers = (await c.query(
      `SELECT memory_id, created_at, created_at::STRING AS at_exact
       FROM memories
       WHERE tenant_id=$1 AND agent_id=$2 AND admission='accepted' AND created_at >= $3::TIMESTAMPTZ
       ORDER BY created_at, memory_id LIMIT ${fetchN}`,
      [tenant_id, agent_id, cur.at])).rows.map(r => ({
        kind: 'remember', event_id: r.memory_id, occurred_at: r.created_at, at_exact: r.at_exact,
        memory_ids: [r.memory_id],
      }))
    const recalls = (await c.query(
      `SELECT request_id, episode_id, attempt_id, created_at, created_at::STRING AS at_exact,
              jsonb_array_length(receipt_json->'receipt'->'items') AS items_count
       FROM recall_requests
       WHERE tenant_id=$1 AND agent_id=$2 AND created_at >= $3::TIMESTAMPTZ
       ORDER BY created_at, request_id LIMIT ${fetchN}`,
      [tenant_id, agent_id, cur.at])).rows.map(r => ({
        kind: 'recall', event_id: r.request_id, occurred_at: r.created_at, at_exact: r.at_exact,
        episode_id: r.episode_id, attempt_id: r.attempt_id, items_count: Number(r.items_count ?? 0),
      }))
    const outcomes = (await c.query(
      `SELECT outcome_request_id, status, reported_at, reported_at::STRING AS at_exact,
              response_json->'items' AS items
       FROM outcomes
       WHERE tenant_id=$1 AND agent_id=$2 AND reported_at >= $3::TIMESTAMPTZ
       ORDER BY reported_at, outcome_request_id LIMIT ${fetchN}`,
      [tenant_id, agent_id, cur.at])).rows.map(r => ({
        kind: 'outcome', event_id: r.outcome_request_id, occurred_at: r.reported_at, at_exact: r.at_exact,
        status: r.status,
        // items 为 null（response_json 尚是 '{}' 占位——事务 B 未完成）时给空数组：
        // 占位行随后被同事务 UPDATE，正常提交后重放会带上完整 items
        items: Array.isArray(r.items)
          ? r.items.map(i => ({ memory_id: i.memory_id, role: i.role, applied: i.applied === true, reason: i.reason ?? null }))
          : [],
      }))

    const merged = [...remembers, ...recalls, ...outcomes]
      .filter(ev => afterCursor(ev, cur))
      .sort(tupleCmp)
    const events = merged.slice(0, n)
    const last = events[events.length - 1]

    // cursor 语义：pre-watermark backlog 被截断 → 停在最后返回事件；否则推进到 watermark。
    // hot-window（> watermark）事件永远不入 cursor——下轮重放，客户端去重。
    const truncated = merged.length > n && last && last.at_exact < wm.wm_exact
    const cursor = truncated
      ? encodeCursor(last.at_exact, last.kind, last.event_id)
      : (wm.wm_exact > cur.at ? encodeCursor(wm.wm_exact, '~', '~') : (after ?? null))

    const hotReplay = events.some(ev => ev.at_exact >= wm.wm_exact)
    return {
      ok: true,
      events: events.map(({ at_exact, ...ev }) => ev),
      cursor,
      watermark_at: wm.wm_exact,
      server_now: wm.now_exact,
      hot_replay: hotReplay || undefined,
    }
  }, 'viz-activity')
}
