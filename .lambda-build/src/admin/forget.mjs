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

// 撤销重建授权（round-1/round-3 P0）：ids 既作为"被删 derived"撤销其自身 queue，也作为
// "已死源"从其他 active queue 的 remaining_source_memory_ids 中剪除；剪空即 abandoned。
// P2 worker fencing 契约（启用前冻结）：attempt_count 是 generation token——
//   claim = SET status='processing', attempt_count=attempt_count+1, lease...（记住读到的新值）
//   commit = CAS WHERE status='processing' AND attempt_count=<claim 时的值>，rowCount 必须=1
// forget 对【部分剪枝的 processing】行：剪数组 + 回 pending + attempt_count+1 + 清 lease——
// 旧 claim 的 generation 立即失效（提交 CAS=0），S3 类幸存源的重建资格保留给下一次领取；
// 这是 round-3 的 ABA 封口：数组剪了而 status 不动 = 旧 worker 带死源提交仍会成功。
const revokeRebuildAuthorizations = async (c, tenantId, explicitIds, allDeadIds) => {
  // (a) 只有【显式点名】的对象撤销自身授权——级联死者的 queue 是合法登记（F6 语义），
  // 它们的复活权由"源是否幸存"裁决，不因级联本身作废
  const own = await c.query(
    `UPDATE memory_rebuild_queue SET status='abandoned', last_error='explicitly_forgotten', updated_at=now()
     WHERE tenant_id=$1 AND deleted_derived_memory_id = ANY($2) AND status IN ('pending','processing')`,
    [tenantId, explicitIds])
  // (b1) 部分剪枝的 processing：剪数组 + 回 pending + generation++（夺走旧 claim 提交资格）
  await c.query(
    `UPDATE memory_rebuild_queue
     SET remaining_source_memory_ids = ARRAY(SELECT x FROM unnest(remaining_source_memory_ids) AS x WHERE x <> ALL($2::UUID[])),
         status='pending', lease_expires_at=NULL, attempt_count=attempt_count+1, updated_at=now()
     WHERE tenant_id=$1 AND status='processing' AND remaining_source_memory_ids && $2::UUID[]`,
    [tenantId, allDeadIds])
  // (b2) pending 只剪数组（无在途 claim，无 generation 语义）
  await c.query(
    `UPDATE memory_rebuild_queue
     SET remaining_source_memory_ids = ARRAY(SELECT x FROM unnest(remaining_source_memory_ids) AS x WHERE x <> ALL($2::UUID[])),
         updated_at = now()
     WHERE tenant_id=$1 AND status='pending' AND remaining_source_memory_ids && $2::UUID[]`,
    [tenantId, allDeadIds])
  const emptied = await c.query(
    `UPDATE memory_rebuild_queue SET status='abandoned', last_error='all_sources_forgotten', updated_at=now()
     WHERE tenant_id=$1 AND status IN ('pending','processing') AND cardinality(remaining_source_memory_ids) = 0`,
    [tenantId])
  return own.rowCount + emptied.rowCount
}

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
      if (tomb) {
        // 显式 forget 一个已被 cascade 删除的 ID：幂等，但它的重建授权必须随显式意图撤销
        //（round-1 P0：pending queue 就是未来复活授权，用户点名删=授权作废）
        const revoked = await revokeRebuildAuthorizations(c, tenantId, [memoryId], [memoryId])
        return { ok: true, already_forgotten: true, deleted: [], rebuilds_revoked: revoked }
      }
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
    // round-1 P0：显式删除意图统治重建授权——
    // (a) 本次删除集合成员自身的 active queue 全部 abandoned（被删对象不许复活）；
    // (b) 本次删除集合从所有 active queue 的幸存源里原子剪除，剪空的 queue 同样 abandoned
    //（重建不能引用已死的源）。注意时序：先于本轮新登记？——不，新登记发生在上面且只含
    // 幸存源；(a) 会把"目标行自己旧有的 queue"清掉，(b) 会把兄弟 queue 里的本批死者剪掉。
    const revoked = await revokeRebuildAuthorizations(c, tenantId, [memoryId], [...toDelete])
    console.log(JSON.stringify({ evt: 'forget', tenant_id: tenantId, target: memoryId, deleted: deleted.length, rebuilds, rebuilds_revoked: revoked }))
    return { ok: true, deleted, rebuilds, rebuilds_revoked: revoked }
  }, 'forget-commit')
}
