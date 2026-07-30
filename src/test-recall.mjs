// P0-04 recall 验收：node --env-file=.env src/test-recall.mjs（先起 server，EMBED_PROVIDER=stub）
// stub embedding 由内容哈希驱动：同文本=同向量（similarity≈1），异文本≈不相关——检索语义可确定性断言
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { getPool } from './lib/db.mjs'
import { connectWithRetry, withDatabase, isRetryableDatabaseError, sleep } from '../migrations/db.mjs'
import { canonicalJson } from './lib/canonical-json.mjs'
import { CFG } from './lib/recall-config.mjs'

let forensic = null
const q = async (text, params) => {
  const cs = withDatabase(process.env.COCKROACH_DATABASE_URL, process.env.TIDEMARK_DATABASE || 'tidemark_dev')
  for (let attempt = 1; ; attempt++) {
    try { forensic ??= await connectWithRetry(cs, { label: 'forensic' }); return await forensic.query(text, params) }
    catch (e) { await forensic?.end().catch(() => {}); forensic = null; if (!isRetryableDatabaseError(e) || attempt >= 5) throw e; await sleep(800 * attempt) }
  }
}
const url = process.env.TIDEMARK_URL || 'http://localhost:3901'
const withClient = async (headers, fn) => {
  const c = new Client({ name: 'p004-test', version: '0.2.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }))
  try { return await fn(c) } finally { await c.close().catch(() => {}) }
}
const call = async (c, name, args) => {
  try {
    const r = await c.callTool({ name, arguments: args })
    const text = r.content[0].text
    try { return { isError: r.isError === true, body: JSON.parse(text) } }
    catch { return { isError: true, body: { ok: false, error: 'non_json', raw: text.slice(0, 160) } } }
  } catch (e) { return { isError: true, body: { ok: false, error: 'protocol_validation', raw: e.message?.slice(0, 160) } } }
}
const AUTH1 = { 'x-tidemark-auth': 'spike-demo-key' }      // demo-agent
const AUTH2 = { 'x-tidemark-auth': 'spike-second-key' }    // second-agent（同 tenant）
const TENANT = 'demo-tenant', AGENT = 'demo-agent', AGENT2 = 'second-agent'
const suite = 'p004-' + randomUUID().slice(0, 8)
const eps = new Set(), rids = new Set(), directIds = []
const ep = () => { const e = `${suite}-ep-` + randomUUID().slice(0, 6); eps.add(e); return e }
const rid = () => { const r = randomUUID(); rids.add(r); return r }
const P = { purpose: 'unit-test' }
const recallArgs = (over = {}) => ({ purpose: P.purpose, episode_id: ep(), attempt_id: 'att-' + randomUUID().slice(0, 6), request_id: rid(), ...over })

// 直插一行（绕过 remember，用于构造 faded/experience/pinned 等 fixture）
const insertRow = async ({ agent = AGENT, layer = 'event', content, embSourceId, embLiteral, admission = 'accepted', state = 'fresh',
                           pinned = false, importance = 0.5, exp_status = null, experience_body = null,
                           anchor = 1.0, anchorAt = 'now()', halfLife = 72, credited = 0, blamed = 0, episode }) => {
  const id = randomUUID(); directIds.push(id)
  const emb = embLiteral ?? (await q('SELECT embedding::STRING AS e FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, embSourceId])).rows[0].e
  await q(`INSERT INTO memories (tenant_id, agent_id, memory_id, layer, episode_id, content, embedding, experience_body, exp_status,
             source, admission, quarantine_expires_at, state, pinned, importance, strength_anchor, strength_anchor_at, last_rewarded_at,
             half_life_hours, credited_success_count, evidenced_blame_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'agent_inferred',$10,NULL,$11,$12,$13,$14,${anchorAt},now(),$15,$16,$17)`,
    [TENANT, agent, id, layer, episode, content, emb, experience_body, exp_status, admission, state, pinned, importance, anchor, halfLife, credited, blamed])
  return id
}

// ---- 余弦可控向量工坊：镜像服务端 stub 算法，构造与查询向量精确夹角的 fixture ----
const stubVec = (text) => { const h = createHash('sha256').update(text).digest(); return Array.from({ length: 512 }, (_, i) => (h[i % 32] / 255) * 2 - 1) }
const unit = (v) => { const n = Math.hypot(...v); return v.map(x => x / n) }
const craftCosine = (queryText, targetCos, seed) => {
  const u = unit(stubVec(queryText))
  const r = stubVec('orthogonal-' + seed)
  const dot = r.reduce((s, x, i) => s + x * u[i], 0)
  const w = unit(r.map((x, i) => x - dot * u[i]))
  const t = u.map((x, i) => targetCos * x + Math.sqrt(1 - targetCos * targetCos) * w[i])
  return '[' + t.map(x => x.toFixed(6)).join(',') + ']'
}

// 本套件前提：server 以 EMBED_PROVIDER=stub 运行——版本串含 provider，测试进程须对齐后再取常量
process.env.EMBED_PROVIDER ??= 'stub'
const { PIPELINE_VERSION } = await import('./lib/pipeline-version.mjs')

let primaryError = null
try {
  // ---- 种子 ----
  const seedEp = ep()
  const seeds = {}
  const SENTINEL = 'SENTINEL-CONTENT-' + randomUUID().slice(0, 8)   // 用于证明 DB 中不存正文
  await withClient(AUTH1, async (c) => {
    for (const [key, content, importance] of [
      ['tide', `the tide leaves a mark ${SENTINEL}`, 0.5],
      ['coffee', 'she prefers oat milk in her coffee', 0.5],
      ['anchor', 'the anchor holds the ship in the storm', 0.9],
    ]) {
      const r = rid()
      let res = await call(c, 'remember', { content, episode_id: seedEp, request_id: r, importance })
      if (!res.body.ok) { await sleep(3000); res = await call(c, 'remember', { content, episode_id: seedEp, request_id: r, importance }) }
      assert.equal(res.body.ok, true, `seed ${key}: ${JSON.stringify(res.body)}`)
      seeds[key] = res.body.memory_id
    }
  })
  const TIDE_QUERY = `the tide leaves a mark ${SENTINEL}`

  // 1. 无 auth
  await withClient({}, async (c) => {
    const { isError, body } = await call(c, 'recall', recallArgs({ query: 'x' }))
    assert.equal(isError, true); assert.equal(body.error, 'unauthorized')
    console.log('PASS 1 unauthorized isError')
  })

  // 2. 必填参数：attempt_id / purpose（冻结 tool 形状）
  await withClient(AUTH1, async (c) => {
    const a = await call(c, 'recall', { query: 'x', purpose: P.purpose, episode_id: ep(), request_id: rid() })
    assert.equal(a.isError, true, 'missing attempt_id must fail')
    const b = await call(c, 'recall', { query: 'x', episode_id: ep(), attempt_id: 'a', request_id: rid() })
    assert.equal(b.isError, true, 'missing purpose must fail (SPEC §4)')
    console.log('PASS 2 attempt_id + purpose both required')
  })

  // 3. 语义命中 + receipt 落库 + checksum 覆盖【完整持久化 JSON】+ 持久化不含正文
  let baseRid, baseArgs
  await withClient(AUTH1, async (c) => {
    baseArgs = recallArgs({ query: TIDE_QUERY }); baseRid = baseArgs.request_id
    const { body } = await call(c, 'recall', baseArgs)
    assert.equal(body.ok, true, JSON.stringify(body).slice(0, 200))
    const items = body.receipt.items
    assert.equal(items[0].memory_id, seeds.tide, 'top1 is semantically identical memory')
    assert.ok(items[0].similarity > 0.999 && items[0].injected)
    assert.equal(body.receipt.context.purpose, P.purpose, 'purpose recorded in receipt context')
    const evt = body.injected.events.find(e => e.content === TIDE_QUERY)
    assert.ok(evt, 'response hydrates real content')
    assert.ok(evt.created_at && evt.state === 'fresh', 'event injection schema carries created_at + state (SPEC §3)')

    const row = (await q('SELECT receipt_json, serialization_checksum, agent_id, outcome_state, pipeline_version FROM recall_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, baseRid])).rows[0]
    assert.ok(row && row.agent_id === AGENT && row.outcome_state === 'unreported')
    // 三处版本一致：DB 列 == receipt 字段 == 导出常量（防漂移，Codex 三审）
    assert.equal(row.pipeline_version, PIPELINE_VERSION, 'DB column matches exported PIPELINE_VERSION')
    assert.equal(row.receipt_json.receipt.pipeline_version, PIPELINE_VERSION, 'receipt field matches exported PIPELINE_VERSION')
    // v4: receipt item 增加 experience_status_at_recall 冻结快照（P0-05 晋级判定真相源）
    assert.ok(PIPELINE_VERSION.startsWith('recall-v4|'), 'algorithm change bumped the version')
    for (const marker of ['gateA=0.55', 'floorB=0.35', 'limitB=20', 'overfetchMax=1600', 'inject-schema=v2']) {
      assert.ok(PIPELINE_VERSION.includes(marker), `version string carries candidate-semantics param: ${marker}`)
    }
    // checksum 必须覆盖整个持久化对象（receipt + injection_plan）
    const recomputed = createHash('sha256').update(canonicalJson(row.receipt_json)).digest()
    assert.ok(recomputed.equals(row.serialization_checksum), 'checksum covers the entire persisted JSON')
    // 持久化体绝不含正文（§12.5）
    const raw = JSON.stringify(row.receipt_json)
    assert.ok(!raw.includes(SENTINEL), 'persisted receipt_json must be content-free')
    assert.deepEqual(Object.keys(row.receipt_json.injection_plan.events[0]), ['memory_id'], 'injection plan stores ids only')
    console.log('PASS 3 receipt persisted content-free + checksum covers full JSON')
  })

  // 4. 幂等：同 request_id 同全参数 -> replay；attempt_id 变化 -> 拒绝（首审第 3 项，原测试反转）
  await withClient(AUTH1, async (c) => {
    const same = await call(c, 'recall', baseArgs)
    assert.equal(same.body.replay, true, 'identical request replays')
    const revt = same.body.injected.events.find(e => e.content === TIDE_QUERY)
    assert.ok(revt && revt.created_at && revt.state === 'fresh', 'replay injection schema also carries created_at + state')
    const diffAttempt = await call(c, 'recall', { ...baseArgs, attempt_id: 'att-DIFFERENT' })
    assert.equal(diffAttempt.isError, true); assert.equal(diffAttempt.body.error, 'idempotency_key_reused', 'attempt_id change must NOT replay')
    const diffPurpose = await call(c, 'recall', { ...baseArgs, purpose: 'other-purpose' })
    assert.equal(diffPurpose.body.error, 'idempotency_key_reused', 'purpose change must not replay')
    const diffBudget = await call(c, 'recall', { ...baseArgs, token_budget: 300 })
    assert.equal(diffBudget.body.error, 'idempotency_key_reused', 'token_budget change must not replay')
    const diffQuery = await call(c, 'recall', { ...baseArgs, query: 'DIFFERENT' })
    assert.equal(diffQuery.body.error, 'idempotency_key_reused', 'query change must not replay')
    const n = (await q('SELECT count(*)::INT4 AS n FROM recall_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, baseRid])).rows[0].n
    assert.equal(n, 1, 'still exactly one receipt row')
    console.log('PASS 4 request fingerprint covers query+purpose+attempt+budget')
  })

  // 5. 跨 agent 重放必须被拒（首审第 1 项：安全）
  await withClient(AUTH2, async (c) => {
    const stolen = await call(c, 'recall', baseArgs)
    assert.equal(stolen.isError, true, 'cross-agent replay must error')
    assert.equal(stolen.body.error, 'request_id_owned_by_other_agent')
    assert.ok(!JSON.stringify(stolen.body).includes(SENTINEL), 'no content leaked to other agent')
    assert.ok(!JSON.stringify(stolen.body).includes(seeds.tide), 'no memory_id leaked to other agent')
    const owner = (await q('SELECT agent_id FROM recall_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, baseRid])).rows[0].agent_id
    assert.equal(owner, AGENT, 'row still owned by first agent')
    console.log('PASS 5 cross-agent replay rejected, zero leakage')
  })

  // 6. 删除后 replay：不返回正文，标 [deleted] 且 injected=false
  {
    const delEp = ep(), delRid = rid()
    let delId, delArgs
    await withClient(AUTH1, async (c) => {
      const DEL_CONTENT = 'ephemeral memory ' + randomUUID().slice(0, 6)
      const rem = await call(c, 'remember', { content: DEL_CONTENT, episode_id: delEp, request_id: rid() })
      assert.equal(rem.body.ok, true); delId = rem.body.memory_id
      delArgs = recallArgs({ query: DEL_CONTENT, request_id: delRid })
      const first = await call(c, 'recall', delArgs)
      assert.ok(first.body.injected.events.some(e => e.content === DEL_CONTENT), 'first response has content')
      await q('DELETE FROM memories WHERE tenant_id=$1 AND agent_id=$2 AND memory_id=$3', [TENANT, AGENT, delId])
      const replay = await call(c, 'recall', delArgs)
      assert.equal(replay.body.replay, true)
      const ev = replay.body.injected.events.find(e => e.memory_id === delId)
      assert.ok(ev && ev.content === '[deleted]' && ev.injected === false, 'deleted memory hydrates as [deleted], not injected')
      assert.ok(!JSON.stringify(replay.body).includes(DEL_CONTENT), 'no content survives deletion')
      console.log('PASS 6 hard-deleted memory yields [deleted] on replay (no content copy)')
    })
  }

  // 7. 60 条 faded 不得挤掉合格 fresh（首审第 4 项：后过滤语义等价性）
  {
    const fadedEp = ep()
    const FRESH_Q = 'overfetch probe content ' + randomUUID().slice(0, 6)
    let freshId
    await withClient(AUTH1, async (c) => {
      const r = await call(c, 'remember', { content: FRESH_Q, episode_id: fadedEp, request_id: rid() })
      assert.equal(r.body.ok, true); freshId = r.body.memory_id
    })
    // 60 条与 fresh 同向量的 faded 行：距离相同（0），会占满内层 LIMIT 50
    for (let i = 0; i < 60; i++) {
      await insertRow({ content: `faded filler ${i}`, embSourceId: freshId, state: 'faded', episode: fadedEp })
    }
    await withClient(AUTH1, async (c) => {
      const { body } = await call(c, 'recall', recallArgs({ query: FRESH_Q }))
      assert.equal(body.ok, true)
      const ids = body.receipt.items.map(i => i.memory_id)
      assert.ok(ids.includes(freshId), `eligible fresh memory must survive 60 faded rows (rounds=${JSON.stringify(body.receipt.candidate_fetch.path_a)})`)
      assert.ok(body.receipt.candidate_fetch.path_a.length >= 2, 'adaptive overfetch escalated')
      assert.ok(!body.receipt.items.some(i => directIds.includes(i.memory_id)), 'no faded row in candidates')
      console.log(`PASS 7 60 faded rows do not starve eligible fresh (overfetch rounds: ${body.receipt.candidate_fetch.path_a.length})`)
    })
  }

  // 8. 第二路救生圈真实生效（二审第 1 项）：0.35<=sim<0.55 的 pinned 记忆必须经 pinned_path 入选；
  //    pinned 冻结强度；>20 条不相关高优先级行不得挤掉相关行（二审第 2 项）
  {
    const pinEp = ep()
    const PIN_QUERY = 'lifeline probe ' + suite
    // (a) 精确构造 cos=0.40 的 pinned 行——落在救生圈区间 [0.35, 0.55)
    const lifelineId = await insertRow({ content: 'weakly related pinned fact', embLiteral: craftCosine(PIN_QUERY, 0.40, 'lifeline'),
      pinned: true, importance: 0.9, anchor: 0.42, anchorAt: `now() - INTERVAL '30 days'`, halfLife: 1, episode: pinEp })
    // (b) 25 条不相关（cos=0.05 < floor）的更高 importance pinned 行——旧实现里它们会占满 LIMIT 20
    for (let i = 0; i < 25; i++) {
      await insertRow({ content: `irrelevant vip ${i}`, embLiteral: craftCosine(PIN_QUERY, 0.05, 'vip-' + i),
        pinned: true, importance: 0.99, episode: pinEp })
    }
    await withClient(AUTH1, async (c) => {
      const { body } = await call(c, 'recall', recallArgs({ query: PIN_QUERY }))
      const it = body.receipt.items.find(i => i.memory_id === lifelineId)
      assert.ok(it, `0.40-cosine pinned row must be rescued by second path (candidates=${body.receipt.items.length}, path_b_rows=${body.receipt.candidate_fetch.path_b_rows})`)
      assert.ok(it.reason.includes('pinned_path'), 'reason must record pinned_path')
      assert.ok(it.similarity >= 0.35 && it.similarity < 0.55, `similarity in lifeline band (got ${it.similarity})`)
      assert.ok(Math.abs(it.effective_strength - 0.42) < 1e-6, `pinned must not decay (got ${it.effective_strength})`)
      const vipCount = body.receipt.items.filter(i => i.reason.includes('pinned_path') && i.memory_id !== lifelineId).length
      assert.equal(vipCount, 0, 'irrelevant VIPs (cos=0.05) excluded by SQL-level floor, do not consume seats')
      console.log('PASS 8 second-path lifeline works at 0.40 + 25 irrelevant VIPs cannot starve it + pinned frozen')
    })
  }

  // 9. experience 排序（verified 优先）+ 双预算 + 长项跳过（CJK）
  {
    const expEp = ep()
    let embBase
    await withClient(AUTH1, async (c) => {
      const r = await call(c, 'remember', { content: 'experience probe ' + suite, episode_id: expEp, request_id: rid() })
      embBase = r.body.memory_id
    })
    const mkExp = (status, trigger, correct, extra = {}) => insertRow({
      layer: 'experience', content: `exp ${status} ${trigger}`, embSourceId: embBase, episode: expEp,
      exp_status: status, experience_body: { trigger, correct_action: correct, caution: 'be careful' }, ...extra,
    })
    const cand1 = await mkExp('candidate', 'trigger-c1', 'do X')
    const verif1 = await mkExp('verified', 'trigger-v1', 'do Y')
    const superseded = await mkExp('superseded', 'trigger-s1', 'obsolete')
    // 一条超长 CJK 经验：单项 token 估算就超 experience 预算 -> 必须被跳过而非撑爆
    const huge = await mkExp('verified', '汉'.repeat(700), '汉'.repeat(200))
    await withClient(AUTH1, async (c) => {
      const { body } = await call(c, 'recall', recallArgs({ query: 'experience probe ' + suite }))
      const injectedExp = body.injected.experiences.map(e => e.memory_id)
      assert.ok(!body.receipt.items.some(i => i.memory_id === superseded), 'superseded experience excluded from candidates')
      assert.ok(!injectedExp.includes(huge), 'oversized experience skipped, not truncated')
      assert.ok(injectedExp.includes(verif1), 'verified experience injected')
      if (injectedExp.includes(cand1)) {
        assert.ok(injectedExp.indexOf(verif1) < injectedExp.indexOf(cand1), 'verified ranks before candidate')
        const c1 = body.injected.experiences.find(e => e.memory_id === cand1)
        assert.equal(c1.provisional, '待验证建议', 'candidate marked provisional')
      }
      const b = body.receipt.budgets
      assert.ok(b.experience.used_items <= CFG.experience_budget.max_items && b.experience.used_tokens <= CFG.experience_budget.max_tokens)
      assert.ok(b.event.used_items <= CFG.event_budget.max_items && b.event.used_tokens <= CFG.event_budget.max_tokens)
      assert.ok(b.total.used_tokens <= b.total.ceiling)
      console.log('PASS 9 experience ordering + superseded excluded + oversized skipped + dual budgets held')
    })
  }

  // 10. token_budget 收紧生效（且不能放宽硬上限）
  await withClient(AUTH1, async (c) => {
    const tight = await call(c, 'recall', recallArgs({ query: TIDE_QUERY, token_budget: 30 }))
    assert.equal(tight.body.ok, true)
    assert.ok(tight.body.receipt.budgets.total.used_tokens <= 30, 'tight budget respected')
    assert.equal(tight.body.receipt.budgets.total.ceiling, 30)
    const wide = await call(c, 'recall', recallArgs({ query: TIDE_QUERY, token_budget: 999999 }))
    assert.equal(wide.body.receipt.budgets.total.ceiling, CFG.total_token_ceiling, 'cannot widen beyond hard ceiling')
    console.log('PASS 10 token_budget tightens only')
  })

  // 11. 并发同 request_id（SPEC §3）：全部成功、同一 receipt、恰一行
  {
    const args = recallArgs({ query: TIDE_QUERY })
    const results = await Promise.all(Array.from({ length: 20 }, () => withClient(AUTH1, (c) => call(c, 'recall', args))))
    results.forEach((r, i) => assert.equal(r.body.ok, true, `concurrent ${i}: ${JSON.stringify(r.body).slice(0, 160)}`))
    const sigs = new Set(results.map(r => canonicalJson(r.body.receipt.items.map(x => x.memory_id))))
    assert.equal(sigs.size, 1, `all concurrent recalls share one receipt (got ${sigs.size})`)
    const n = (await q('SELECT count(*)::INT4 AS n FROM recall_requests WHERE tenant_id=$1 AND request_id=$2', [TENANT, args.request_id])).rows[0].n
    assert.equal(n, 1, 'exactly one receipt row after concurrency')
    console.log('PASS 11 20 concurrent same request_id -> one receipt, one row')
  }

  // 12. recall 不改 memory 行（outcome-gated）
  {
    const before = (await q('SELECT strength_anchor, strength_anchor_at, last_rewarded_at, revision, credited_success_count FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, seeds.tide])).rows[0]
    await withClient(AUTH1, async (c) => { await call(c, 'recall', recallArgs({ query: TIDE_QUERY })) })
    const after = (await q('SELECT strength_anchor, strength_anchor_at, last_rewarded_at, revision, credited_success_count FROM memories WHERE tenant_id=$1 AND memory_id=$2', [TENANT, seeds.tide])).rows[0]
    assert.deepEqual(after, before, 'recall must not mutate memory rows')
    console.log('PASS 12 recall leaves memory rows untouched (outcome-gated)')
  }

  // 13. EXPLAIN 断言（仓库内可复现）：第一路必须命中 vector search 节点
  {
    const vec = '[' + Array(512).fill('0.01').join(',') + ']'
    const plan = (await q(`EXPLAIN SELECT memory_id FROM memories@mem_vec_idx WHERE tenant_id=$1 AND agent_id=$2 ORDER BY embedding <=> $3 LIMIT 50`,
      [TENANT, AGENT, vec])).rows.map(r => Object.values(r)[0]).join('\n')
    assert.ok(/vector search/i.test(plan), `path A must use vector index:\n${plan}`)
    console.log('PASS 13 EXPLAIN: path A hits vector search node')
  }

  console.log('ALL P0-04 RECALL ASSERTIONS PASSED')
} catch (e) {
  primaryError = e
} finally {
  const cleanupErrors = []
  try {
    const E = [...eps], R = [...rids]
    if (E.length) await q('DELETE FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E])
    if (directIds.length) await q('DELETE FROM memories WHERE tenant_id=$1 AND memory_id = ANY($2)', [TENANT, directIds])
    if (R.length) {
      await q('DELETE FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])
      await q('DELETE FROM recall_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])
    }
    const mem = E.length ? (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND episode_id = ANY($2)', [TENANT, E])).rows[0].n : 0
    const dir = directIds.length ? (await q('SELECT count(*)::INT4 AS n FROM memories WHERE tenant_id=$1 AND memory_id = ANY($2)', [TENANT, directIds])).rows[0].n : 0
    const tr = R.length ? (await q('SELECT count(*)::INT4 AS n FROM tool_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])).rows[0].n : 0
    const rr = R.length ? (await q('SELECT count(*)::INT4 AS n FROM recall_requests WHERE tenant_id=$1 AND request_id = ANY($2)', [TENANT, R])).rows[0].n : 0
    if (mem || dir || tr || rr) cleanupErrors.push(new Error(`residual: memories=${mem} direct=${dir} tool_requests=${tr} recall_requests=${rr}`))
    else console.log('cleanup done (residual: memories=0, tool_requests=0, recall_requests=0)')
  } catch (e) { cleanupErrors.push(e) }
  await forensic?.end().catch(() => {})
  await getPool().end().catch(() => {})
  if (cleanupErrors.length) throw primaryError ? new AggregateError([primaryError, ...cleanupErrors], 'test+cleanup failed') : new AggregateError(cleanupErrors, 'cleanup failed')
  if (primaryError) throw primaryError
}
