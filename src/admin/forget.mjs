// P0-08 forget（owner/admin 面，SPEC §1 硬删除 + 结论 31）：
// - HTTP admin 路由，不是 agent MCP 工具（冻结 §12：agent 面固定 5 tools）
// - 硬删 = DELETE 行 + content-free 墓碑（memory_id/deleted_at/reason；reason 只收 slug，
//   拒 content hash——低熵可枚举仍是个人数据，结论 31）
// - 血统级联：被删行的全部 derived 后代一并删（隐私：派生物含源的内容）；
//   memory_derivations 的 source_fk 是 restrictive——按逆拓扑逐层删（叶子先），
//   边由 derived_fk 的 ON DELETE CASCADE 随行自动清
// - 被级联的 derived 若有幸存 source（不在删除集合内）-> 登记 memory_rebuild_queue
//   （content-free：只存 ID；重建本身是 P2，队列先欠着）——用户点名删的目标行不重建
// - 幂等：tombstone 已在且行已无 -> already_forgotten；单 SERIALIZABLE 事务全有或全无
// - receipt 侧无需改动：recall_requests.receipt_json 本就 content-free，hydrate 读不到行
//   即显示 [deleted]（P0-04 已实现）
import { inSerializableTx } from '../lib/db.mjs'

const RX_SLUG = /^[a-z0-9_.-]{1,64}$/i
const RX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const forgetMemory = async ({ tenantId, memoryId, reason }) => {
  if (!tenantId || typeof tenantId !== 'string') return { ok: false, error: 'tenant_id_required' }
  if (!memoryId || !RX_UUID.test(memoryId)) return { ok: false, error: 'memory_id_invalid' }
  if (!reason || !RX_SLUG.test(reason)) return { ok: false, error: 'reason_must_be_slug' }

  return inSerializableTx(async (c) => {
    const target = (await c.query(
      'SELECT memory_id FROM memories WHERE tenant_id=$1 AND memory_id=$2', [tenantId, memoryId])).rows[0]
    if (!target) {
      const tomb = (await c.query(
        'SELECT memory_id FROM memory_tombstones WHERE tenant_id=$1 AND memory_id=$2', [tenantId, memoryId])).rows[0]
      if (tomb) return { ok: true, already_forgotten: true, deleted: [] }
      return { ok: false, error: 'memory_not_found' }
    }

    // 递归收集 derived 后代（CRDB WITH RECURSIVE）
    const descendants = (await c.query(
      `WITH RECURSIVE lineage AS (
         SELECT derived_memory_id FROM memory_derivations WHERE tenant_id=$1 AND source_memory_id=$2
         UNION
         SELECT md.derived_memory_id FROM memory_derivations md
         JOIN lineage l ON md.tenant_id=$1 AND md.source_memory_id = l.derived_memory_id
       ) SELECT derived_memory_id FROM lineage`,
      [tenantId, memoryId])).rows.map(r => r.derived_memory_id)
    const toDelete = new Set([memoryId, ...descendants])

    // 被级联的 derived：幸存 source（删除集合外）存在 -> 登记 rebuild（目标行本身不重建）
    let rebuilds = 0
    for (const did of descendants) {
      const srcs = (await c.query(
        'SELECT source_memory_id FROM memory_derivations WHERE tenant_id=$1 AND derived_memory_id=$2',
        [tenantId, did])).rows.map(r => r.source_memory_id)
      const surviving = srcs.filter(s => !toDelete.has(s))
      if (surviving.length > 0) {
        const agentRow = (await c.query(
          'SELECT agent_id FROM memories WHERE tenant_id=$1 AND memory_id=$2', [tenantId, did])).rows[0]
        await c.query(
          `INSERT INTO memory_rebuild_queue (tenant_id, agent_id, deleted_derived_memory_id, remaining_source_memory_ids)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id, deleted_derived_memory_id) DO NOTHING`,
          [tenantId, agentRow?.agent_id ?? 'unknown', did, surviving])
        rebuilds++
      }
    }

    // 逆拓扑逐层删除（source_fk restrictive：作为集合内他行 source 的行必须后删）。
    // 每层 = 集合内"不再被集合内任何未删行引用为 source"的行；边随 derived 行 CASCADE 消失。
    const remaining = new Set(toDelete)
    const deleted = []
    while (remaining.size > 0) {
      const ids = [...remaining]
      const blocked = new Set((await c.query(
        `SELECT DISTINCT source_memory_id FROM memory_derivations
         WHERE tenant_id=$1 AND source_memory_id = ANY($2) AND derived_memory_id = ANY($2)`,
        [tenantId, ids])).rows.map(r => r.source_memory_id))
      const layer = ids.filter(id => !blocked.has(id))
      if (layer.length === 0) throw new Error('forget_cycle_detected')   // 血统图无环不变量破坏
      await c.query('DELETE FROM memories WHERE tenant_id=$1 AND memory_id = ANY($2)', [tenantId, layer])
      for (const id of layer) {
        await c.query(
          `INSERT INTO memory_tombstones (tenant_id, memory_id, reason)
           VALUES ($1,$2,$3) ON CONFLICT (tenant_id, memory_id) DO NOTHING`,
          [tenantId, id, id === memoryId ? reason : `cascade.${reason}`.slice(0, 64)])
        deleted.push(id)
        remaining.delete(id)
      }
    }
    console.log(JSON.stringify({ evt: 'forget', tenant_id: tenantId, target: memoryId, deleted: deleted.length, rebuilds }))
    return { ok: true, deleted, rebuilds }
  }, 'forget-commit')
}
