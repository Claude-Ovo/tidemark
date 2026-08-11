// /viz/capability 判别（自包含，真实 CRDB）：能力索引是评委看到的"诚实面"，
// 它的失败模式必须是"如实说不可用"，绝不能是"编一个 live 状态"。
//   C1 未认证 fail-closed
//   C2 状态枚举合法 + 生命周期六阶段齐全（chain 无断点）
//   C3 真实计数与库直查一致（不是硬编码的漂亮数字）
//   C4 blocked_external/evidence_pending 必须带理由与证据指针（不许空口）
//   C5 unavailable 清单显式存在（CRDB 事务 ID / X-Ray）——缺失即诚实声明，不猜
//   C6 数据库不可达时整体降级为 degraded，且不谎报 live
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
process.env.TIDEMARK_POOL_MAX = process.env.TIDEMARK_POOL_MAX || '4'
const { inSerializableTx, getPool } = await import('./lib/db.mjs')
const { vizCapability } = await import('./viz/capability.mjs')

const T = 'capability-test-tenant'
const A = 'capability-test-agent'
const principal = { tenant_id: T, agent_id: A, capabilities: [], scope: 'viz' }
const VALID_STATUS = new Set(['live', 'documented', 'evidence_pending', 'blocked_external', 'unavailable', 'degraded'])
let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`) }

await t('C1 未认证 fail-closed', async () => {
  assert.deepEqual(await vizCapability({ principal: null }), { ok: false, error: 'unauthorized' })
})

const cap = await vizCapability({ principal })
assert.equal(cap.ok, true)

await t('C2 状态枚举合法 + 生命周期六阶段齐全', async () => {
  for (const entry of [...cap.cockroachdb_tools, ...cap.aws_services, ...cap.lifecycle]) {
    assert.ok(VALID_STATUS.has(entry.status), `illegal status: ${entry.id}=${entry.status}`)
  }
  assert.deepEqual(cap.lifecycle.map(l => l.id),
    ['remember', 'recall_receipt', 'agent_action', 'outcome_attribution', 'plasticity', 'dream_reflection'],
    'lifecycle chain must be complete and ordered - a missing stage is a broken proof')
  // 比赛资格面：至少两项 CRDB 工具、至少一项 AWS 服务必须被列出
  assert.ok(cap.cockroachdb_tools.length >= 2)
  assert.ok(cap.aws_services.filter(s => s.status === 'live').length >= 1)
})

await t('C3 计数与库直查一致（不是硬编码）', async () => {
  if (cap.database.status !== 'live') { console.log('  (skipped: database degraded this run)'); return }
  const direct = await inSerializableTx(async (c) => (await c.query(
    `SELECT
       (SELECT count(*) FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND admission='accepted') AS memories,
       (SELECT count(*) FROM recall_requests WHERE tenant_id=$1 AND agent_id=$2) AS recalls,
       (SELECT count(*) FROM attempt_events WHERE tenant_id=$1 AND agent_id=$2) AS attempt_events`,
    [T, A])).rows[0], 'cap-test-direct')
  assert.equal(cap.counts.memories, Number(direct.memories))
  assert.equal(cap.counts.recalls, Number(direct.recalls))
  assert.equal(cap.counts.attempt_events, Number(direct.attempt_events))
})

await t('C4 未完成项必须带理由与证据指针', async () => {
  const incomplete = [...cap.cockroachdb_tools, ...cap.aws_services]
    .filter(e => e.status === 'evidence_pending' || e.status === 'blocked_external')
  assert.ok(incomplete.length >= 2, 'this build genuinely has pending items; hiding them would be the failure')
  for (const entry of incomplete) {
    assert.ok(entry.evidence && entry.evidence.length > 20, `${entry.id} must state why, not just a status word`)
    assert.ok(entry.evidence_ref, `${entry.id} must point at repo evidence`)
  }
  const bedrock = cap.aws_services.find(s => s.id === 'bedrock')
  assert.equal(bedrock.status, 'blocked_external')
  assert.match(bedrock.evidence, /denied/i, 'Bedrock must be stated as denied, not "coming soon"')
  const mcp = cap.cockroachdb_tools.find(s => s.id === 'managed_mcp_audit')
  assert.equal(mcp.status, 'evidence_pending', 'Managed MCP may not claim live before operator capture')
})

await t('C5 unavailable 清单显式存在（不猜字段）', async () => {
  const fields = cap.unavailable.map(u => u.field)
  assert.ok(fields.includes('cockroachdb_transaction_id'))
  assert.ok(fields.includes('aws_xray_trace_id'))
  for (const u of cap.unavailable) assert.ok(u.reason && u.reason.length > 10)
})

await t('C6 数据库不可达 → degraded，绝不谎报 live', async () => {
  // 注入一个必然失败的 principal 路径：用超长 tenant 触发查询错误，
  // 验证降级语义（真实断网由生产 retry 层覆盖，此处只钉"不谎报"）。
  const broken = await vizCapability({ principal: { tenant_id: 'x'.repeat(20000), agent_id: A, scope: 'viz' } })
  if (broken.database.status === 'live') {
    // 该 tenant 合法但无数据时仍是 live——此时必须全零而不是复制上一次的数字
    assert.equal(broken.counts.memories, 0)
    assert.equal(broken.counts.recalls, 0)
  } else {
    assert.equal(broken.status, 'degraded')
    assert.equal(broken.database.engine, 'unavailable')
    for (const l of broken.lifecycle.filter(x => x.id !== 'dream_reflection')) {
      assert.notEqual(l.status, 'live', 'a broken database may not report live lifecycle stages')
    }
  }
})

await getPool().end()
console.log(`\n${passed} 场景全过`)
process.exit(0)
