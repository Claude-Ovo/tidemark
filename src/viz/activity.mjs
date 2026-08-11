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
import { SAFETY_GRACE_MS } from '../lib/viz-config.mjs'

export const ACTIVITY_CFG = {
  safety_grace_ms: SAFETY_GRACE_MS,   // 单一真相源 viz-config.mjs；严格不等式在那里守
  default_limit: 100,
  max_limit: 500,
}

// recall memory_ids 投影（动效批二审 P1-1）：receipt_json 无库级 schema，投影必须
// fail-closed——只放行 canonical UUID string（归一小写），对象/非 UUID/null/缺字段
// 一律丢弃；cap=12 在合法筛选之后应用，畸形项不得挤占合法项的名额。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const projectInjectedUuids = (ritems) => Array.isArray(ritems)
  ? ritems.filter(i => i?.injected === true)
      .map(i => i?.memory_id)
      .filter(id => typeof id === 'string' && UUID_RE.test(id))
      .map(id => id.toLowerCase())
      .slice(0, 12)
  : []

export const encodeCursor = (at, kind, id) => Buffer.from(`${at}|${kind}|${id}`).toString('base64')
const decodeCursor = (after) => {
  const [at, kind, id] = Buffer.from(String(after), 'base64').toString('utf8').split('|')
  if (!at || Number.isNaN(new Date(at).getTime())) throw new Error('bad')
  return { at, kind: kind ?? '', id: id ?? '' }
}
// snapshot-bounded page token（Codex 二审 P1-1）：ephemeral 翻页必须冻结
// {起点元组, checkpoint(=首响应的 durable cursor), upper_bound(=首响应 server_now)}——
// 每页查询限定 <= upper_bound、durable cursor 恒回冻结 checkpoint，不随页推进。
// 否则慢 drain 期间合法晚提交（<=15s）的行会被"越过 token 起点 + 新 watermark"永久跳过。
const encodePageToken = (t) => 'P.' + Buffer.from(JSON.stringify(t)).toString('base64')
// 三审 P2：token 字段逐项校验——坏 at/upper 不许变成 CRDB 22007→500，
// 坏 checkpoint 不许 ok:true 原样回流；一律 cursor_invalid。tenant-scoped 只读 token，不上 HMAC。
const tsOk = (s) => typeof s === 'string' && s.length <= 64 && !Number.isNaN(new Date(s).getTime())
const decodePageToken = (s) => {
  if (String(s).length > 2048) throw new Error('bad')
  const t = JSON.parse(Buffer.from(String(s).slice(2), 'base64').toString('utf8'))
  if (!tsOk(t.at) || !tsOk(t.upper)) throw new Error('bad')
  if (typeof t.id !== 'string' || t.id.length > 128 || typeof (t.kind ?? '') !== 'string') throw new Error('bad')
  if (new Date(t.at).getTime() > new Date(t.upper).getTime()) throw new Error('bad')
  const cp = decodeCursor(t.checkpoint)             // checkpoint 必须能被 durable 解码
  if (new Date(cp.at).getTime() > new Date(t.upper).getTime()) throw new Error('bad')
  return t
}
// 确定性全序：(occurred_at exact, kind, id)——exact 串字典序即时间序
const tupleCmp = (a, b) =>
  (a.at_exact < b.at_exact ? -1 : a.at_exact > b.at_exact ? 1 : 0) ||
  (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
  (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0)
// graceMs 仅测试注入（加速"watermark 越过晚提交"场景，免等真实 30s）；生产路由不传。
// bootstrap 基线不在本端点——由 /viz/ocean 同事务返回 activity_baseline（同一可见性边界，
// live 环二审 P1-1：head-only 对齐时间不对齐可见性，快照已表示的热窗口事件会重演）
export const vizActivity = async ({ principal, after, limit, graceMs }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  const { tenant_id, agent_id } = principal
  let cur = { at: '1970-01-01 00:00:00+00', kind: '', id: '' }
  let page = null   // 冻结 page token（翻页模式）
  if (after) {
    try {
      if (String(after).startsWith('P.')) {
        page = decodePageToken(after)
        cur = { at: page.at, kind: page.kind ?? '', id: page.id ?? '' }
      } else cur = decodeCursor(after)
    } catch { return { ok: false, error: 'cursor_invalid' } }
  }
  const n = Math.min(Math.max(1, Number(limit) || ACTIVITY_CFG.default_limit), ACTIVITY_CFG.max_limit)
  const grace = Number.isFinite(graceMs) ? Number(graceMs) : ACTIVITY_CFG.safety_grace_ms

  return inSerializableTx(async (c) => {
    const wm = (await c.query(
      `SELECT (now() - $1::INTERVAL)::STRING AS wm_exact, now()::STRING AS now_exact`,
      [`${grace} milliseconds`])).rows[0]

    // Codex activity 一审 P1-1：完整三元组 keyset **下推 SQL**——JS 过滤 SQL LIMIT 截过
    // 的行会永久跳行（170 条同微秒反例）。固定 kind 的源，谓词按 kind 与 cur.kind 的
    // 序关系化简：kind > cur.kind → at >= cur.at；kind = cur.kind → (at,id) > (cur.at,cur.id)；
    // kind < cur.kind → at > cur.at。每源取 n+1（判断 has_more 够用，不再靠 buffer 撞运气）。
    const fetchN = n + 1
    const srcPredicate = (kind, col, idCol) => {
      if (kind > cur.kind) return { sql: `${col} >= $3::TIMESTAMPTZ`, params: [cur.at] }
      if (kind === cur.kind) return { sql: `(${col}, ${idCol}) > ($3::TIMESTAMPTZ, $4)`, params: [cur.at, cur.id] }
      return { sql: `${col} > $3::TIMESTAMPTZ`, params: [cur.at] }
    }
    const q = async (kind, sql, baseParams, mapRow) => {
      const pred = srcPredicate(kind, sql.col, sql.id)
      // 翻页模式：查询窗口冻结在 token 的 upper_bound——drain 只吐首响应快照内的事件，
      // 期间的新写/迟提交留给下一轮从冻结 checkpoint 重放
      const ub = page ? ` AND ${sql.col} <= $${3 + pred.params.length}::TIMESTAMPTZ` : ''
      return (await c.query(
        `SELECT ${sql.select}, ${sql.col}::STRING AS at_exact FROM ${sql.from}
         WHERE tenant_id=$1 AND agent_id=$2 ${sql.extra ?? ''} AND ${pred.sql}${ub}
         ORDER BY ${sql.col}, ${sql.id} LIMIT ${fetchN}`,
        [...baseParams, ...pred.params, ...(page ? [page.upper] : [])])).rows.map(mapRow)
    }
    const remembers = await q('remember',
      { select: 'memory_id, created_at', col: 'created_at', id: 'memory_id', from: 'memories', extra: `AND admission='accepted'` },
      [tenant_id, agent_id],
      r => ({ kind: 'remember', event_id: r.memory_id, occurred_at: r.created_at, at_exact: r.at_exact, memory_ids: [r.memory_id] }))
    const recalls = await q('recall',
      { select: `request_id, episode_id, attempt_id, created_at, jsonb_array_length(receipt_json->'receipt'->'items') AS items_count, receipt_json->'receipt'->'items' AS ritems`,
        col: 'created_at', id: 'request_id', from: 'recall_requests' },
      [tenant_id, agent_id],
      r => ({ kind: 'recall', event_id: r.request_id, occurred_at: r.created_at, at_exact: r.at_exact,
        episode_id: r.episode_id, attempt_id: r.attempt_id, items_count: Number(r.items_count ?? 0),
        // 动效批增补（Owner 裁定涟漪打在被召回粒子上）：投影 injected receipt items 的
        // memory_id。receipt_json 无库级 schema——投影前 fail-closed 筛 canonical UUID
        // string（对象/非 UUID/null/缺字段全丢弃，绝不透传任意 JSON），归一小写，
        // cap=12 在合法筛选【之后】应用（动效批二审 P1-1）
        memory_ids: projectInjectedUuids(r.ritems) }))
    const outcomes = await q('outcome',
      { select: `outcome_request_id, status, reported_at, response_json->'items' AS items`,
        col: 'reported_at', id: 'outcome_request_id', from: 'outcomes' },
      [tenant_id, agent_id],
      r => ({ kind: 'outcome', event_id: r.outcome_request_id, occurred_at: r.reported_at, at_exact: r.at_exact,
        status: r.status,
        // items 为 null（response_json '{}' 占位——事务 B 未完成）时给空数组；提交后重放补全
        items: Array.isArray(r.items)
          ? r.items.map(i => ({ memory_id: i.memory_id, role: i.role, applied: i.applied === true, reason: i.reason ?? null }))
          : [] }))

    // 第四源（证据前端 Verify 区）：agent action。attempt_events 里 agent 侧的执行痕迹——
    // 没有它，"Remember → Recall → **Agent action** → Outcome → Plasticity" 这条链中间是断的。
    // content-free：只出 ID/类型/工具名/时间，payload 一律不出（正文与证据细节归 detail 面）。
    // memory_used 不在此源——它是 credited/blamed 的 item 级证据，归 outcome 的归因链。
    const agentActions = await q('agent_action',
      { select: `event_id, attempt_id, task_instance_id, episode_id, event_type, tool_name, created_at`,
        col: 'created_at', id: 'event_id', from: 'attempt_events',
        extra: `AND event_type IN ('attempt_start', 'tool_call', 'tool_error', 'attempt_end')` },
      [tenant_id, agent_id],
      r => ({ kind: 'agent_action', event_id: r.event_id, occurred_at: r.created_at, at_exact: r.at_exact,
        attempt_id: r.attempt_id, task_instance_id: r.task_instance_id, episode_id: r.episode_id,
        event_type: r.event_type, tool_name: r.tool_name ?? null }))

    const merged = [...remembers, ...recalls, ...outcomes, ...agentActions].sort(tupleCmp)   // SQL 已保证 > cursor
    const events = merged.slice(0, n)
    const last = events[events.length - 1]
    const hasMore = merged.length > n

    // durable cursor：backlog 截断（最后返回事件 <= watermark，含恰等边界——P1-1 修订，
    // 恰等 watermark 的大组不得被 ~|~ 哨兵跳过）→ 停在最后返回事件；否则推进到 watermark。
    // hot-window 事件永远不入 durable cursor——下轮重放，客户端 (kind,id) 去重。
    let cursor, pageCursor
    if (page) {
      // 翻页模式：durable 恒回冻结 checkpoint（Codex 二审 P1-1——绝不随页重算 watermark）
      cursor = page.checkpoint
      pageCursor = hasMore && last
        ? encodePageToken({ at: last.at_exact, kind: last.kind, id: last.event_id, checkpoint: page.checkpoint, upper: page.upper })
        : null
    } else {
      const backlogTruncated = hasMore && last && last.at_exact <= wm.wm_exact
      cursor = backlogTruncated
        ? encodeCursor(last.at_exact, last.kind, last.event_id)
        : encodeCursor(wm.wm_exact, '~', '~')
      // 首响应铸造冻结 token：{起点=最后返回事件, checkpoint=本轮 durable, upper=本轮 server_now}
      pageCursor = hasMore && last
        ? encodePageToken({ at: last.at_exact, kind: last.kind, id: last.event_id, checkpoint: cursor, upper: wm.now_exact })
        : null
    }

    const hotReplay = events.some(ev => ev.at_exact >= wm.wm_exact)
    return {
      ok: true,
      events: events.map(({ at_exact, ...ev }) => ev),
      cursor,
      has_more: hasMore,
      page_cursor: pageCursor,     // has_more 时非空：当轮 drain 用；不要持久化它
      watermark_at: wm.wm_exact,
      server_now: wm.now_exact,
      hot_replay: hotReplay || undefined,
    }
  }, 'viz-activity')
}
