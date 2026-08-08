// P0-11 契约 D：GET /viz/memory/:memory_id——hover/drawer 冷启动真源（DESIGN-OCEAN.md）。
// 边界（Codex 四审措辞照录）：
//   principal-aware 内容：agent 键得全文，viz viewer 键只得 content_preview（与 /viz/ocean 同界）
//   衰减曲线 = 服务端采样点（同一 decayEffective 实算，客户端只描点——
//   "客户端永不重算衰减"契约无例外）
//   latest-outcome projection 只许展示；动画只认 /viz/activity，projection 不成第二事件源
//   有界：归因列表上限 DETAIL_CFG.max_attributions，全文按 cap 截断声明
// 只读：全程 SELECT，绝不产生 receipt/不触发塑性。
import { inSerializableTx } from '../lib/db.mjs'
import { decayEffective } from '../lib/decay.mjs'
import { TRANSITION_CFG } from '../lib/scheduler.mjs'

export const DETAIL_CFG = {
  curve_points: 33,          // 采样点数（含首尾）
  curve_past_hours: 96,      // 曲线窗口：过去 96h → 未来 96h
  curve_future_hours: 96,
  max_attributions: 10,      // 最近 N 条引用本记忆的 outcome item
  max_related: 10,
  content_cap: 4000,         // agent 全文 cap（截断声明，不静默）
  preview_chars: 140,
}

const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const vizMemoryDetail = async ({ principal, memory_id }) => {
  if (!principal) return { ok: false, error: 'unauthorized' }
  if (!memory_id || !RX_UUID.test(memory_id)) return { ok: false, error: 'memory_id_invalid' }
  const { tenant_id, agent_id } = principal
  const viewer = principal.scope === 'viz'

  return inSerializableTx(async (c) => {
    const snapshotAt = (await c.query('SELECT now() AS t')).rows[0].t
    const nowMs = new Date(snapshotAt).getTime()
    const row = (await c.query(
      `SELECT memory_id, layer, kind, episode_id, exp_status, pinned, state, importance,
              strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
              credited_success_count, evidenced_blame_count, created_at,
              length(content) AS content_length,
              ${viewer ? `left(content, ${DETAIL_CFG.preview_chars})` : `left(content, ${DETAIL_CFG.content_cap})`} AS content_out
       FROM memories
       WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3 AND admission='accepted'`,
      [tenant_id, agent_id, memory_id])).rows[0]
    if (!row) return { ok: false, error: 'not_found' }

    // 衰减曲线：服务端采样（同一 decayEffective）。time-travel 禁区统一先判——
    // 锚点之前的采样点一律 null（含 pinned：pin 冻结从 pin 时刻起，不虚构 pin 前历史，
    // 交互层一审 P1-1）；锚点之后 pinned 为水平线、非 pinned 走衰减。
    const stepMs = (DETAIL_CFG.curve_past_hours + DETAIL_CFG.curve_future_hours) * 3600e3 / (DETAIL_CFG.curve_points - 1)
    const t0 = nowMs - DETAIL_CFG.curve_past_hours * 3600e3
    const anchorMs = new Date(row.strength_anchor_at).getTime()
    const curve = Array.from({ length: DETAIL_CFG.curve_points }, (_, i) => {
      const t = t0 + i * stepMs
      return {
        at: new Date(t).toISOString(),
        s: t < anchorMs ? null : +decayEffective(row, t).toFixed(6),
      }
    })

    // 归因：引用本 memory 的最近 outcome items。attributions 数组与 response_json.items
    // 按 ordinality 对齐（同一 attribution 的写入序），借 attribution 的
    // recall_request_id/receipt_item_id 回读原 receipt item → content-free 评分构成
    //（契约 D 的 receipt 评分构成，交互层一审 P1-3）
    const attrRows = (await c.query(
      `SELECT o.outcome_request_id, o.status, o.reported_at, o.episode_id,
              item.value AS item_json, attr.value AS attr_json
       FROM outcomes o,
            jsonb_array_elements(o.response_json->'items') WITH ORDINALITY AS item(value, ord),
            jsonb_array_elements(o.attributions) WITH ORDINALITY AS attr(value, ord2)
       WHERE o.tenant_id=$1 AND o.agent_id=$2 AND item.value->>'memory_id'=$3 AND item.ord=attr.ord2
       ORDER BY o.reported_at DESC LIMIT ${DETAIL_CFG.max_attributions}`,
      [tenant_id, agent_id, memory_id])).rows
    // 批量回读 receipt items（content-free 数值投影：similarity/effective/utility/importance/final_score/rank）
    const rrIds = [...new Set(attrRows.map(r => r.attr_json?.recall_request_id).filter(Boolean))]
    const receiptItems = new Map()
    if (rrIds.length) {
      for (const rr of (await c.query(
        `SELECT request_id, receipt_json->'receipt'->'items' AS items
         FROM recall_requests WHERE tenant_id=$1 AND agent_id=$2 AND request_id = ANY($3::STRING[])`,
        [tenant_id, agent_id, rrIds])).rows) {
        for (const it of (Array.isArray(rr.items) ? rr.items : [])) {
          receiptItems.set(`${rr.request_id}|${it.receipt_item_id}`, it)
        }
      }
    }
    const attributions = attrRows.map(r => {
      const ri = receiptItems.get(`${r.attr_json?.recall_request_id}|${r.attr_json?.receipt_item_id}`)
      return {
        outcome_request_id: r.outcome_request_id, status: r.status,
        reported_at: r.reported_at, episode_id: r.episode_id,
        role: r.item_json.role, applied: r.item_json.applied === true,
        reason: r.item_json.reason ?? null,
        plasticity: r.item_json.plasticity ?? null,
        receipt_scores: ri ? {
          rank: ri.rank, similarity: ri.similarity, effective_strength: ri.effective_strength,
          utility: ri.utility, importance: ri.importance, final_score: ri.final_score,
        } : null,
      }
    })

    // 关联薄边：derived_from（双向）——两端 join memories 强制同 agent + accepted
    //（交互层一审 P1-2：memory_derivations 只保证 tenant，不保证两端 agent；
    // 不把"producer 恰好同 agent"当授权不变量，跨 agent 边一律不出）
    const derived = (await c.query(
      `SELECT d.derived_memory_id, d.source_memory_id
       FROM memory_derivations d
       JOIN memories md ON md.tenant_id=d.tenant_id AND md.memory_id=d.derived_memory_id
         AND md.agent_id=$3 AND md.admission='accepted'
       JOIN memories ms ON ms.tenant_id=d.tenant_id AND ms.memory_id=d.source_memory_id
         AND ms.agent_id=$3 AND ms.admission='accepted'
       WHERE d.tenant_id=$1 AND (d.derived_memory_id=$2 OR d.source_memory_id=$2)
       LIMIT ${DETAIL_CFG.max_related}`,
      [tenant_id, memory_id, agent_id])).rows.map(r => ({
        kind: r.derived_memory_id === memory_id ? 'derived_from' : 'source_of',
        memory_id: r.derived_memory_id === memory_id ? r.source_memory_id : r.derived_memory_id,
      }))

    return {
      ok: true, snapshot_at: snapshotAt,
      fade_threshold: TRANSITION_CFG.fade_threshold,
      memory: {
        memory_id: row.memory_id, layer: row.layer, kind: row.kind, episode_id: row.episode_id,
        pinned: row.pinned, state: row.state, importance: Number(row.importance),
        effective_strength: decayEffective(row, nowMs),
        credited: Number(row.credited_success_count), blamed: Number(row.evidenced_blame_count),
        created_at: row.created_at,
        content: row.content_out,
        content_scope: viewer ? 'preview' : 'full',                       // 抽屉声明口径
        content_truncated: Number(row.content_length) > (viewer ? DETAIL_CFG.preview_chars : DETAIL_CFG.content_cap),
      },
      curve,
      attributions,
      related: derived,
      // projection 只许展示——动画只认 /viz/activity
      latest_outcome: attributions[0] ?? null,
    }
  }, 'viz-memory-detail')
}
