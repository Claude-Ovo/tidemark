// P0-11 验收：node src/test-viz.mjs——【自包含】（二审 P1-1）：自己加载 .env、自己锁 stub、
// 自己用 app.listen(0) 起临时 listener，npm test 直跑必须绿，不依赖开发者恰好开着 3901。
// 覆盖：V0 scope 校验与工具面守卫 / V1 未认证（临时端口 HTTP）/ V2 海湾清单收权 /
// V3 viz 面与工具面分离 / V4 keyset 游标（翻页、重放、坏游标、limit 钳制、隔离）/
// V5 NULL episode 散粒 / V6 阈值同源 / V7 cap 边界 cap-1/cap/cap+1（二审 P1-2：
// total 恰好等于 cap 时数据完整，capped 必须为 false）/ V8 waves 走 042 索引。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ---- env 自举：一切项目模块动态 import，顺序完全受控 ----
if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
process.env.EMBED_PROVIDER = 'stub'        // 夹具向量走 stub，套件锁死不看外部环境
process.env.TIDEMARK_DEV_INSECURE = '1'    // dev 键表（viz-demo-key）是被测面的一部分
delete process.env.TIDEMARK_SECRET_ARN
delete process.env.TIDEMARK_AGENT_KEYS

const { assertStubLocked } = await import('./lib/test-env.mjs')
const { getPool } = await import('./lib/db.mjs')
const { connectWithRetry, withDatabase, isRetryableDatabaseError, sleep } = await import('../migrations/db.mjs')
const { vizOcean, vizWaves } = await import('./viz/ocean.mjs')
const { toolPrincipal, resolveAuthMap, _resetAuthMapCacheForTest, app } = await import('./server.mjs')
const { rememberTool } = await import('./tools/remember.mjs')
const { TRANSITION_CFG } = await import('./lib/scheduler.mjs')
const { embed } = await import('./lib/embed.mjs')
const { toVectorLiteral } = await import('./lib/vector-canonical.mjs')

assertStubLocked()

// 临时 listener：随机端口，测完必关（自包含的 HTTP 段）
const listener = app.listen(0)
await new Promise((r) => listener.once('listening', r))
const url = `http://127.0.0.1:${listener.address().port}`

let conn = null
const q = async (text, params) => {
  const cs = withDatabase(process.env.COCKROACH_DATABASE_URL, process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  for (let attempt = 1; ; attempt++) {
    try { conn ??= await connectWithRetry(cs, { label: 'viz-test' }); return await conn.query(text, params) }
    catch (e) { await conn?.end().catch(() => {}); conn = null; if (!isRetryableDatabaseError(e) || attempt >= 5) throw e; await sleep(800 * attempt) }
  }
}
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
  try {
    _resetAuthMapCacheForTest()
    process.env.TIDEMARK_AGENT_KEYS = JSON.stringify({ k1: { tenant_id: 't', agent_id: 'a', capabilities: [], scope: 'viz' } })
    assert.equal(resolveAuthMap().k1.scope, 'viz', 'V0 scope viz accepted by validation')
    _resetAuthMapCacheForTest()
    process.env.TIDEMARK_AGENT_KEYS = JSON.stringify({ k1: { tenant_id: 't', agent_id: 'a', capabilities: [], scope: 'admin' } })
    assert.throws(() => resolveAuthMap(), /entry invalid/, 'V0 unknown scope rejected')
  } finally {
    delete process.env.TIDEMARK_AGENT_KEYS
    _resetAuthMapCacheForTest()
  }
  console.log('PASS V0 scope validation + tool-face guard')

  // V1 HTTP 未认证与认证（临时端口上的 dev 键表）
  assert.equal((await http('/viz/ocean')).error, 'unauthorized', 'V1 no key rejected')
  assert.equal((await http('/viz/ocean', 'viz-demo-key')).ok, true, 'V1 viz key accepted over HTTP')
  console.log('PASS V1 http auth on self-owned listener')

  // 夹具：A1 两个 episode + pinned + 散粒；A2 一条（隔离对照）
  const ep1 = suite + '-ep1', ep2 = suite + '-ep2'
  await insMem(A1, { episode: ep1, anchor: 0.9 })
  await insMem(A1, { episode: ep1, anchor: 0.6 })
  await insMem(A1, { episode: ep2, anchor: 0.8 })
  await insMem(A1, { episode: ep2, anchor: 0.9, pinned: true })
  await insMem(A1, { episode: null, anchor: 0.7 })
  await insMem(A1, { episode: null, anchor: 0.05, ageH: 2000 })
  await insMem(A2, { episode: suite + '-other', anchor: 0.9 })

  // V2 海湾清单收权
  const seenByViewer = await vizOcean({ principal: P_VIEWER })
  assert.equal(seenByViewer.ok, true)
  assert.deepEqual(seenByViewer.agents.map(a => a.agent_id).sort(), [A1, A2], 'V2 viewer sees the whole cove list')
  const seenByAgent = await vizOcean({ principal: P_AGENT })
  assert.deepEqual(seenByAgent.agents.map(a => a.agent_id), [A1], 'V2 agent key sees only itself')
  const seenByAgent2 = await vizOcean({ principal: P_AGENT2 })
  assert.deepEqual(seenByAgent2.agents.map(a => a.agent_id), [A2], 'V2 second agent sees only itself')
  assert.equal(seenByAgent2.episodes.some(e => e.episode_id === ep1), false, 'V2 no cross-agent episode leak')
  console.log('PASS V2 cove list scoping (viewer vs agent)')

  // V3 viz 面与工具面分离：V0 拒了工具，这里 viz 面本身可用
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

  // V4b 微秒精度（浪实测抓获的回归）：游标若经 JS Date 截断到毫秒，
  // 微秒时间戳的行会永远小于自己的游标——每轮被重新返回，游标推不过最后一行
  const rMicro = await insReceipt(A1, '2001-01-02T00:00:00.123456Z', 1)
  const drain = await vizWaves({ principal: P_AGENT, after: page2.cursor })
  assert.equal(drain.waves.some(w => w.request_id === rMicro), true, 'V4b microsecond row drains once')
  const afterDrain = await vizWaves({ principal: P_AGENT, after: drain.cursor })
  assert.deepEqual(afterDrain.waves, [], 'V4b cursor advances PAST a microsecond row: nothing replays')
  console.log('PASS V4b cursor is microsecond-exact (no eternal last row)')

  // V5 NULL episode 散粒
  assert.equal(seenByAgent.loose.length, 2, 'V5 loose memories returned individually')
  assert.equal(seenByAgent.episodes.some(e => e.episode_id == null || e.episode_id === '(no-episode)'), false,
    'V5 no synthetic shared bucket')
  console.log('PASS V5 loose memories stay loose')

  // V6 阈值同源
  assert.equal(seenByAgent.fade_threshold, TRANSITION_CFG.fade_threshold, 'V6 threshold from TRANSITION_CFG only')
  console.log('PASS V6 threshold single source')

  // V7 cap 边界（二审 P1-2）：A1 共 6 条；total==cap 时数据完整，capped 必须 false
  const under = await vizOcean({ principal: P_AGENT, cap: 7 })
  assert.equal(under.total_memories, 6, 'V7 total counts agent memories')
  assert.equal(under.capped, false, 'V7 cap+1: not capped')
  const exact = await vizOcean({ principal: P_AGENT, cap: 6 })
  assert.equal(exact.capped, false, 'V7 total == cap means COMPLETE, never report truncation')
  assert.equal(exact.episodes.flatMap(e => e.memories).length + exact.loose.length, 6, 'V7 exact returns all rows')
  const over = await vizOcean({ principal: P_AGENT, cap: 5 })
  assert.equal(over.capped, true, 'V7 cap-1: truncation declared')
  assert.equal(over.episodes.flatMap(e => e.memories).length + over.loose.length, 5, 'V7 over returns capped rows')
  assert.equal(over.total_memories, 6, 'V7 total still reports the full count when capped')
  console.log('PASS V7 cap boundary cap-1/cap/cap+1 (exact-cap is not a lie)')

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
  await new Promise((r) => listener.close(r))
}
