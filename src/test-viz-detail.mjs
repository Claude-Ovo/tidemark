// /viz/memory 详情面回归（交互层一审 P1-6，自包含：真实 CRDB）
//   D1 未认证/坏 id
//   D2 viewer preview vs agent 全文（principal-aware 内容界）
//   D3 跨 agent memory 不可见；跨 agent derivation 边不泄露对方 UUID
//   D4 曲线锚点前 null（pinned 与非 pinned 同规），pinned 锚点后水平
//   D5 receipt score projection（content-free 数值投影，经真实证据链）
//   D6 只读零副作用（revision/strength 前后不变）
// 测试专用租户，setup 走正常 rememberTool（stub embedding），仅跨 agent 边用 SQL seam。
// 运行：node --env-file=.env src/test-viz-detail.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
process.env.EMBED_PROVIDER = 'stub'
process.env.TIDEMARK_DEV_INSECURE = '1'
process.env.TIDEMARK_POOL_MAX = process.env.TIDEMARK_POOL_MAX || '4'

const { inSerializableTx, getPool } = await import('./lib/db.mjs')
const { vizMemoryDetail, DETAIL_CFG } = await import('./viz/detail.mjs')
const { rememberTool } = await import('./tools/remember.mjs')
const { recallTool } = await import('./tools/recall.mjs')
const { logEventTool } = await import('./tools/log-event.mjs')
const { reportOutcomeTool } = await import('./tools/report-outcome.mjs')
const { pinTool } = await import('./tools/pin.mjs')

const T = 'detail-test-tenant'
const agentA = { tenant_id: T, agent_id: 'detail-agent-a', capabilities: ['memory:pin'] }
const agentB = { tenant_id: T, agent_id: 'detail-agent-b', capabilities: [] }
const viewerA = { tenant_id: T, agent_id: 'detail-agent-a', capabilities: [], scope: 'viz' }
let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`) }

const cleanup = () => inSerializableTx(async (c) => {
  await c.query('DELETE FROM memory_derivations WHERE tenant_id=$1', [T]);  await c.query('DELETE FROM nightly_runs WHERE tenant_id=$1', [T])
  await c.query('DELETE FROM attempt_events WHERE tenant_id=$1', [T])
  await c.query('DELETE FROM outcomes WHERE tenant_id=$1', [T])
  await c.query('DELETE FROM recall_requests WHERE tenant_id=$1', [T])
  await c.query('DELETE FROM tool_requests WHERE tenant_id=$1', [T])
  await c.query('DELETE FROM memories WHERE tenant_id=$1', [T])
}, 'detail-test-clean')

const remember = async (principal, content, importance = 0.5) => {
  const r = await rememberTool({ principal, content, kind: 'fact', episode_id: 'ep-detail', request_id: randomUUID(), importance })
  assert.equal(r.ok, true, JSON.stringify(r))
  return r.memory_id
}

await cleanup()
try {
  const LONG = 'detail test long content '.repeat(20)   // 500 chars > preview 140
  const midA = await remember(agentA, LONG, 0.9)        // 高 importance：stub 下走第二路注入
  const midB = await remember(agentB, 'other agent private memory content')

  await t('D1 未认证 / 坏 id', async () => {
    assert.equal((await vizMemoryDetail({ principal: null, memory_id: midA })).error, 'unauthorized')
    assert.equal((await vizMemoryDetail({ principal: agentA, memory_id: 'not-a-uuid' })).error, 'memory_id_invalid')
  })

  await t('D2 principal-aware 内容界：viewer preview / agent 全文', async () => {
    const v = await vizMemoryDetail({ principal: viewerA, memory_id: midA })
    assert.equal(v.ok, true)
    assert.equal(v.memory.content_scope, 'preview')
    assert.equal(v.memory.content.length, DETAIL_CFG.preview_chars)
    assert.equal(v.memory.content_truncated, true)
    const a = await vizMemoryDetail({ principal: agentA, memory_id: midA })
    assert.equal(a.memory.content_scope, 'full')
    assert.equal(a.memory.content, LONG.trim())   // remember 写入时 trim 尾空格
    assert.equal(a.memory.content_truncated, false)
  })

  await t('D3 跨 agent：memory 不可见；derivation 边不泄露对方 UUID', async () => {
    assert.equal((await vizMemoryDetail({ principal: agentA, memory_id: midB })).error, 'not_found')
    // SQL seam：造一条跨 agent 遗留边（A 的 memory 派生自 B 的 memory）——schema 只保证 tenant。
    // FK 需先立合法 nightly_runs 行（全 NOT NULL 列补齐；事务内不许吞错——25P02 教训）
    const RUN = '99999999-9999-4999-8999-999999999999'
    await inSerializableTx(async (c) => {
      await c.query(
        `INSERT INTO nightly_runs (tenant_id, run_id, job_kind, scheduled_for, pipeline_version,
           status, batch_size, source_snapshot, source_fingerprint)
         VALUES ($1, $2, 'dream', now(), 'test', 'completed', 1, '[]', $3)
         ON CONFLICT (tenant_id, job_kind, scheduled_for, pipeline_version) DO NOTHING`,
        [T, RUN, Buffer.from('00', 'hex')])
      await c.query(
        `INSERT INTO memory_derivations (tenant_id, derived_memory_id, source_memory_id, run_id)
         VALUES ($1, $2, $3, $4)`,
        [T, midA, midB, RUN])
    }, 'detail-test-edge')
    const d = await vizMemoryDetail({ principal: agentA, memory_id: midA })
    assert.equal(d.ok, true)
    assert.equal(d.related.some(r => r.memory_id === midB), false, '跨 agent 边不得返回对方 memory UUID')
  })

  await t('D4 曲线：锚点前 null 同规（含 pinned），pinned 锚点后水平线', async () => {
    const fresh = await vizMemoryDetail({ principal: agentA, memory_id: midA })
    assert.equal(fresh.curve[0].s, null, '刚创建的记忆：-96h 采样点必须 null')
    assert.ok(fresh.curve[fresh.curve.length - 1].s > 0, '未来采样点有值')
    const pinId = await remember(agentA, 'pinned curve subject memory')
    const pr = await pinTool({ principal: agentA, memory_id: pinId, pinned: true, reason: 'test-pin', request_id: randomUUID() })
    assert.equal(pr.ok, true, JSON.stringify(pr))
    const pd = await vizMemoryDetail({ principal: agentA, memory_id: pinId })
    assert.equal(pd.curve[0].s, null, 'pinned 也不得虚构锚点前历史（一审 P1-1）')
    const vals = pd.curve.filter(c => c.s != null).map(c => c.s)
    assert.ok(vals.length >= 2)
    assert.ok(vals.every(v => v === vals[0]), 'pinned 锚点后必须水平')
  })

  await t('D5 receipt score projection（真实证据链，content-free）', async () => {
    const attempt = randomUUID(), task = randomUUID(), epi = 'ep-detail-ev'
    // stub 向量 = 整文 sha256：query 与正文逐字相同才有 sim=1（其余近 0 过不了 gate）
    const rec = await recallTool({ principal: agentA, query: LONG.trim(), purpose: 'test',
      episode_id: epi, attempt_id: attempt, request_id: randomUUID() })
    assert.equal(rec.ok, true)
    const item = rec.receipt.items.find(i => i.injected && i.memory_id === midA)
    assert.ok(item, '高 importance 记忆应经第二路注入')
    const ev = await logEventTool({ principal: agentA, episode_id: epi, task_instance_id: task, attempt_id: attempt,
      event_type: 'memory_used', request_id: randomUUID(),
      payload: { recall_request_id: rec.receipt.request_id, receipt_item_id: item.receipt_item_id, memory_id: midA } })
    assert.equal(ev.ok, true)
    const out = await reportOutcomeTool({ principal: agentA, outcome_request_id: randomUUID(), episode_id: epi,
      task_instance_id: task, attempt_id: attempt, status: 'success',
      attributions: [{ recall_request_id: rec.receipt.request_id, receipt_item_id: item.receipt_item_id,
        memory_id: midA, role: 'credited', evidence_event_id: ev.event_id }] })
    assert.equal(out.ok, true)
    const d = await vizMemoryDetail({ principal: agentA, memory_id: midA })
    assert.ok(d.attributions.length >= 1)
    const sc = d.attributions[0].receipt_scores
    assert.ok(sc, '归因必须带 receipt score projection')
    for (const k of ['rank', 'similarity', 'effective_strength', 'utility', 'importance', 'final_score']) {
      assert.equal(typeof sc[k], 'number', `score.${k} 必须是数值`)
    }
    assert.equal(Object.keys(sc).length, 6, 'projection 有界 content-free：恰好六个数值字段')
    assert.ok(d.attributions.length <= DETAIL_CFG.max_attributions)
    assert.ok(d.related.length <= DETAIL_CFG.max_related)
  })

  await t('D6 只读零副作用：revision/anchor 前后不变', async () => {
    const before = await inSerializableTx(async (c) => (await c.query(
      'SELECT revision, strength_anchor, strength_anchor_at FROM memories WHERE tenant_id=$1 AND memory_id=$2', [T, midA])).rows[0], 'd6-before')
    await vizMemoryDetail({ principal: agentA, memory_id: midA })
    await vizMemoryDetail({ principal: viewerA, memory_id: midA })
    const after = await inSerializableTx(async (c) => (await c.query(
      'SELECT revision, strength_anchor, strength_anchor_at FROM memories WHERE tenant_id=$1 AND memory_id=$2', [T, midA])).rows[0], 'd6-after')
    assert.deepEqual(after, before)
  })
} finally {
  await cleanup()
  await getPool().end()
}
console.log(`\n${passed} 项全过`)
process.exit(0)
