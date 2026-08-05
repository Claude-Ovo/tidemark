// P0-11 一审验收：node --env-file=.env src/test-viz.mjs（HTTP 段需先起 dev server，EMBED_PROVIDER=stub）
// 覆盖一审修订清单：V0 scope 校验与工具面守卫 / V1 未认证 / V2 海湾清单收权（P0-2 的 HTTP 面）/
// V3 viz 键进不了工具 / V4 keyset 游标（翻页、重放、坏游标、limit 钳制）/ V5 NULL episode 散粒 /
// V6 阈值同源 / V7 快照 total 与 cap 声明 / V8 waves 走 042 索引。
import { assertStubLocked } from './lib/test-env.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { connectWithRetry, withDatabase, isRetryableDatabaseError, sleep } from '../migrations/db.mjs'
import { vizOcean, vizWaves } from './viz/ocean.mjs'
import { toolPrincipal, resolveAuthMap, _resetAuthMapCacheForTest } from './server.mjs'
import { rememberTool } from './tools/remember.mjs'
import { TRANSITION_CFG } from './lib/scheduler.mjs'
import { embed } from './lib/embed.mjs'
import { toVectorLiteral } from './lib/vector-canonical.mjs'

assertStubLocked()

let conn = null
const q = async (text, params) => {
  const cs = withDatabase(process.env.COCKROACH_DATABASE_URL, process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  for (let attempt = 1; ; attempt++) {
    try { conn ??= await connectWithRetry(cs, { label: 'viz-test' }); return await conn.query(text, params) }
    catch (e) { await conn?.end().catch(() => {}); conn = null; if (!isRetryableDatabaseError(e) || attempt >= 5) throw e; await sleep(800 * attempt) }
  }
}
const url = process.env.TIDEMARK_URL || 'http://localhost:3901'
const http = async (path, key) => {
  const res = await fetch(url + path, { headers: key ? { 'x-tidemark-auth': key } : {} })
  return res.json()
}

const suite = 'p011-' + randomUUID().slice(0, 8)
const T = suite + '-tenant', A1 = 'viz-agent-a', A2 = 'viz-agent-b'
const P_VIEWER = { tenant_id: T, agent_id: A1, capabilities: [], scope: 'viz' }
const P_AGENT = { tenant_id: T, agent_id: A1, capabilities: [] }
const P_AGENT2 = { tenant_id: T, agent_id: A2, capabilities: [] }

const insMem = async (agent, { episode = null, anchor = 0.9, ageH = 1, pinned = false } = {}) => {
  const id = randomUUID()
  const e = await embed('viz fixture ' + id)
  await q(
    `INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, embedding_model_id,
       source, admission, state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at, half_life_hours,
       credited_success_count, consolidation_baseline)
     VALUES ($1,$2,$3,'event',$4,$5,$6,'stub-sha256-512','agent_inferred','accepted','fresh',$7,0.5,$8,
       now()-($9::FLOAT8||' hours')::INTERVAL, now(), 108, 0, 0)`,
    [T, agent, id, episode, 'viz fixture ' + id, toVectorLiteral(e.f32), pinned, anchor, ageH])
  return id
}
const insReceipt = async (agent, atIso, items = 2) => {
  const id = randomUUID()
  await q(
    `INSERT INTO recall_requests (tenant_id, request_id, agent_id, episode_id, attempt_id, created_at,
       query_hmac, pipeline_version, receipt_json, serialization_checksum)
     VALUES ($1,$2,$3,$4,$5,$6::TIMESTAMPTZ,$7,'recall-v6',$8,$9)`,
    [T, id, agent, suite + '-ep', 'att-' + id.slice(0, 8), atIso,
     Buffer.from('00', 'hex'), JSON.stringify({ receipt: { items: Array.from({ length: items }, () => ({})) } }),
     Buffer.from('00', 'hex')])
  return id
}

try {
  // V0 纯逻辑：viz scope 在工具面等同未认证；auth 表校验收 scope
  assert.equal(toolPrincipal(P_VIEWER), null, 'V0 viz principal blanked at tool face')
  assert.equal(toolPrincipal(P_AGENT), P_AGENT, 'V0 agent principal passes')
  assert.equal(toolPrincipal(null), null, 'V0 null passes through')
  const r0 = await rememberTool({ principal: toolPrincipal(P_VIEWER), content: 'x', episode_id: 'e', request_id: randomUUID() })
  assert.equal(r0.ok, false, 'V0 tool call with blanked principal rejected')
  const envBackup = process.env.TIDEMARK_AGENT_KEYS
  try {
    _resetAuthMapCacheForTest()
    process.env.TIDEMARK_AGENT_KEYS = JSON.stringify({ k1: { tenant_id: 't', agent_id: 'a', capabilities: [], scope: 'viz' } })
    assert.equal(resolveAuthMap().k1.scope, 'viz', 'V0 scope viz accepted by validation')
    _resetAuthMapCacheForTest()
    process.env.TIDEMARK_AGENT_KEYS = JSON.stringify({ k1: { tenant_id: 't', agent_id: 'a', capabilities: [], scope: 'admin' } })
    assert.throws(() => resolveAuthMap(), /entry invalid/, 'V0 unknown scope rejected')
  } finally {
    if (envBackup === undefined) delete process.env.TIDEMARK_AGENT_KEYS
    else process.env.TIDEMARK_AGENT_KEYS = envBackup
    _resetAuthMapCacheForTest()
  }
  console.log('PASS V0 scope validation + tool-face guard')

  // V1 HTTP 未认证与认证（dev server 的 dev 表）
  assert.equal((await http('/viz/ocean')).error, 'unauthorized', 'V1 no key rejected')
  assert.equal((await http('/viz/ocean', 'viz-demo-key')).ok, true, 'V1 viz key accepted over HTTP')
  console.log('PASS V1 http auth')

  // 夹具：A1 两个 episode + pinned + 白化 + 散粒；A2 一条（隔离对照）
  const ep1 = suite + '-ep1', ep2 = suite + '-ep2'
  await insMem(A1, { episode: ep1, anchor: 0.9 })
  await insMem(A1, { episode: ep1, anchor: 0.6 })
  await insMem(A1, { episode: ep2, anchor: 0.8 })
  await insMem(A1, { episode: ep2, anchor: 0.9, pinned: true })
  await insMem(A1, { episode: null, anchor: 0.7 })
  await insMem(A1, { episode: null, anchor: 0.05, ageH: 2000 })
  await insMem(A2, { episode: suite + '-other', anchor: 0.9 })

  // V2 海湾清单收权（直调；HTTP 面 dev 键在 demo-tenant，等价路径 V1 已验 header 映射）
  const seenByViewer = await vizOcean({ principal: P_VIEWER })
  assert.equal(seenByViewer.ok, true)
  assert.deepEqual(seenByViewer.agents.map(a => a.agent_id).sort(), [A1, A2], 'V2 viewer sees the whole cove list')
  const seenByAgent = await vizOcean({ principal: P_AGENT })
  assert.deepEqual(seenByAgent.agents.map(a => a.agent_id), [A1], 'V2 agent key sees only itself')
  const seenByAgent2 = await vizOcean({ principal: P_AGENT2 })
  assert.deepEqual(seenByAgent2.agents.map(a => a.agent_id), [A2], 'V2 second agent sees only itself')
  assert.equal(seenByAgent2.episodes.some(e => e.episode_id === ep1), false, 'V2 no cross-agent episode leak')
  console.log('PASS V2 cove list scoping (viewer vs agent)')

  // V3 viz 键拿不到记忆内容以外的面：工具直调已在 V0 拒绝；这里再验 viz 面本身仍可用
  assert.equal(seenByViewer.episodes.length >= 2, true, 'V3 viz face serves the viewer')
  console.log('PASS V3 viz face vs tool face split')

  // V4 keyset 游标
  const t1 = '2001-01-01T00:00:00.000Z', t2 = '2001-01-01T00:00:01.000Z', t3 = '2001-01-01T00:00:02.000Z'
  const r1 = await insReceipt(A1, t1, 1), r2 = await insReceipt(A1, t2, 2), r3 = await insReceipt(A1, t3, 3)
  const page1 = await vizWaves({ principal: P_AGENT, limit: 2 })
  assert.deepEqual(page1.waves.map(w => w.request_id), [r1, r2], 'V4 page1 in keyset order')
  assert.deepEqual(page1.waves.map(w => w.items_count), [1, 2], 'V4 items_count from receipt_json')
  const page2 = await vizWaves({ principal: P_AGENT, after: page1.cursor, limit: 2 })
  assert.deepEqual(page2.waves.map(w => w.request_id), [r3], 'V4 page2 continues after cursor')
  const replay = await vizWaves({ principal: P_AGENT, limit: 2 })
  assert.deepEqual(replay.waves.map(w => w.request_id), [r1, r2], 'V4 replay is idempotent')
  assert.equal((await vizWaves({ principal: P_AGENT, after: '!!notbase64!!' })).error, 'cursor_invalid', 'V4 bad cursor refused')
  assert.equal((await vizWaves({ principal: P_AGENT, limit: -3 })).ok, true, 'V4 limit clamped low')
  assert.equal((await vizWaves({ principal: P_AGENT, limit: 99999 })).ok, true, 'V4 limit clamped high')
  assert.equal((await vizWaves({ principal: P_AGENT2 })).waves.length, 0, 'V4 waves are agent-scoped')
  console.log('PASS V4 keyset cursor (paging, replay, clamps, isolation)')

  // V5 NULL episode 散粒：绝不合成假气泡
  assert.equal(seenByAgent.loose.length, 2, 'V5 loose memories returned individually')
  assert.equal(seenByAgent.episodes.some(e => e.episode_id == null || e.episode_id === '(no-episode)'), false,
    'V5 no synthetic shared bucket')
  console.log('PASS V5 loose memories stay loose')

  // V6 阈值同源 + V7 total/cap 声明
  assert.equal(seenByAgent.fade_threshold, TRANSITION_CFG.fade_threshold, 'V6 threshold from TRANSITION_CFG only')
  assert.equal(seenByAgent.total_memories, 6, 'V7 total_memories counts the agent memories')
  assert.equal(seenByAgent.capped, false, 'V7 cap not hit at fixture scale')
  console.log('PASS V6+V7 threshold single source, total declared')

  // V8 waves 查询走 042 keyset 索引
  const plan = (await q(
    `EXPLAIN SELECT request_id FROM recall_requests
     WHERE tenant_id = $1 AND agent_id = $2 AND (created_at, request_id) > ($3::TIMESTAMPTZ, $4)
     ORDER BY created_at, request_id LIMIT 50`,
    [T, A1, t1, ''])).rows.map(r => Object.values(r)[0]).join('\n')
  assert.match(plan, /recall_requests_viz_idx/, 'V8 keyset plan uses migration 042 index')
  console.log('PASS V8 waves keyset uses recall_requests_viz_idx')

  console.log('ALL VIZ TESTS PASSED')
} finally {
  await q('DELETE FROM recall_requests WHERE tenant_id = $1', [T])
  await q('DELETE FROM memories WHERE tenant_id = $1', [T])
  const residue = (await q('SELECT count(*)::INT AS n FROM memories WHERE tenant_id = $1', [T])).rows[0].n
  if (Number(residue) !== 0) throw new Error('viz fixtures not cleaned: ' + residue)
  await conn?.end().catch(() => {})
  await getPool().end().catch(() => {})
}
