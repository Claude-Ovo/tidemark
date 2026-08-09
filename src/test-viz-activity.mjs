// /viz/activity 五个必测场景（SPEC §14 / Codex 四审边界，自包含：真实 CRDB）
//   A1 <=15s 晚提交：watermark 关闭后恰好出现一次
//   A2 >上限 事务 abort 且无事件
//   A3 hot-window 重放：服务端两轮都返回，客户端 (kind,id) 去重后恰一次；cursor 不越 watermark
//   A4 同微秒（同事务 now()）顺序稳定
//   A5 同游标重放字节级一致（remount/StrictMode 的服务端半 + 客户端去重模拟）
// 测试专用租户，开始/结束清场；行为测试 seam 直插（合成数据，不碰 demo tenant）。
// 运行：node --env-file=.env src/test-viz-activity.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// env 自举（与 test-viz 同式，root npm test 不带 --env-file）
if (!process.env.COCKROACH_DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
}
process.env.TIDEMARK_POOL_MAX = process.env.TIDEMARK_POOL_MAX || '4'
const { inSerializableTx, inWriteTx, getPool } = await import('./lib/db.mjs')
const { vizActivity, ACTIVITY_CFG } = await import('./viz/activity.mjs')

const T = 'activity-test-tenant'
const A = 'activity-test-agent'
const principal = { tenant_id: T, agent_id: A, capabilities: [], scope: 'viz' }
const bytes = Buffer.from('00', 'hex')
let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`) }

const cleanup = () => inSerializableTx(async (c) => {
  await c.query('DELETE FROM recall_requests WHERE tenant_id=$1', [T])
  await c.query('DELETE FROM outcomes WHERE tenant_id=$1', [T])
  await c.query('DELETE FROM memories WHERE tenant_id=$1', [T])
}, 'activity-test-clean')

const insRecall = (c, id, backdateSec = null) => c.query(
  `INSERT INTO recall_requests (tenant_id, request_id, agent_id, episode_id, attempt_id,
     query_hmac, pipeline_version, receipt_json, serialization_checksum, created_at)
   VALUES ($1, $2, $3, 'ep-act', $4, $5, 'test', '{"receipt":{"items":[]}}', $5,
     ${backdateSec == null ? 'now()' : `now() - INTERVAL '${Number(backdateSec)} seconds'`})`,
  [T, id, A, `at-${id}`, bytes])

// 大批量单语句插入（同一 now() → 同微秒；逐条 INSERT 会撞 15s 写事务上限——上限在工作）
const insRecallBatch = (c, ids, backdateSec = null) => c.query(
  `INSERT INTO recall_requests (tenant_id, request_id, agent_id, episode_id, attempt_id,
     query_hmac, pipeline_version, receipt_json, serialization_checksum, created_at)
   SELECT $1, id, $2, 'ep-act', 'at-' || id, $3, 'test', '{"receipt":{"items":[]}}', $3,
     ${backdateSec == null ? 'now()' : `now() - INTERVAL '${Number(backdateSec)} seconds'`}
   FROM unnest($4::STRING[]) AS id`,
  [T, A, bytes, ids])

// 客户端去重器（pool 前端将用同一规则）：(kind, event_id) 幂等
const makeDedupe = () => {
  const seen = new Set()
  return (evs) => evs.filter(e => { const k = `${e.kind}|${e.event_id}`; if (seen.has(k)) return false; seen.add(k); return true })
}

await cleanup()
try {
  await t('A4 同微秒（同事务 now()）顺序稳定 + A5 字节级确定性', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort()
    await inWriteTx(async (c) => { for (const id of ids) await insRecall(c, id) }, 'act-a4-ins')
    const r1 = await vizActivity({ principal })
    const r2 = await vizActivity({ principal })
    assert.equal(r1.ok, true)
    assert.equal(r1.events.length, 3)
    // 同事务三行共享同一 now()——同微秒 tie 由 (kind, id) 决定且两轮一致
    assert.deepEqual(r1.events.map(e => e.event_id), ids)
    // 字节级确定性承诺的对象是事件序列（watermark/cursor 是时间派生值，随轮次移动）
    assert.equal(JSON.stringify(r1.events), JSON.stringify(r2.events))
  })

  await t('A3 hot-window 重放：两轮都返回、去重后恰一次、cursor 不越 watermark', async () => {
    const r1 = await vizActivity({ principal })
    assert.equal(r1.hot_replay, true, '刚插入的行应在 hot window')
    const dedupe = makeDedupe()
    const first = dedupe(r1.events)
    assert.equal(first.length, 3)
    // 用返回的 cursor（= watermark）再拉：hot 事件必须重放
    const r2 = await vizActivity({ principal, after: r1.cursor })
    assert.equal(r2.events.length, 3, 'hot-window 事件必须在下一轮重放')
    assert.equal(dedupe(r2.events).length, 0, '客户端去重后不重复消费')
    // cursor 语义：解码时间戳不得超过 watermark
    const curAt = Buffer.from(r1.cursor, 'base64').toString('utf8').split('|')[0]
    assert.ok(curAt <= r1.watermark_at, `cursor(${curAt}) 越过 watermark(${r1.watermark_at})`)
  })

  await t('A1 <=15s 晚提交：先开先插后提交，watermark 关闭后恰好一次', async () => {
    // 手工双连接模拟"旧时间戳晚提交"：T1 BEGIN 插入（now() 锚定较早）保持不提交；
    // T2 插入并提交；轮询若拿"天真 max(created_at) cursor"就会永远漏 T1——
    // 而 closed watermark 语义下 T1 提交后仍在 hot window，必被重放捕获。
    const pool = getPool()
    const c1 = await pool.connect()
    const lateId = randomUUID(), earlyDone = randomUUID()
    try {
      await c1.query('BEGIN')
      await insRecall(c1, lateId)                     // T1: created_at = 此刻，但先不提交
      await new Promise(r => setTimeout(r, 1200))
      await inWriteTx(async (c) => insRecall(c, earlyDone), 'act-a1-t2')   // T2 后插先提交
      const dedupe = makeDedupe()
      const r1 = await vizActivity({ principal })
      dedupe(r1.events)
      assert.ok(r1.events.some(e => e.event_id === earlyDone))
      assert.ok(!r1.events.some(e => e.event_id === lateId), 'T1 未提交不可见')
      await c1.query('COMMIT')                        // 晚提交（<15s，合法）
      const r2 = await vizActivity({ principal, after: r1.cursor })
      const fresh = dedupe(r2.events)
      assert.ok(fresh.some(e => e.event_id === lateId), '晚提交行必须在 watermark 关闭前被重放捕获')
      assert.equal(fresh.filter(e => e.event_id === lateId).length, 1, '恰好一次')
      const r3 = await vizActivity({ principal, after: r2.cursor })
      assert.equal(dedupe(r3.events).filter(e => e.event_id === lateId).length, 0, '去重后不再出现')
    } finally { c1.release() }
  })

  await t('A2 超时事务整体 abort 且无事件（transaction_timeout 机制验证）', async () => {
    const doomedId = randomUUID()
    let aborted = false
    try {
      await inSerializableTx(async (c) => {
        await c.query(`SET LOCAL transaction_timeout = '800ms'`)   // 用短值验证同一机制（生产 15s）
        await insRecall(c, doomedId)
        await c.query('SELECT pg_sleep(2)')
      }, 'act-a2-doomed')
    } catch (e) { aborted = true }
    assert.equal(aborted, true, '超过 transaction_timeout 的写事务必须 abort')
    const r = await vizActivity({ principal })
    assert.ok(!r.events.some(e => e.event_id === doomedId), 'abort 事务不得留下任何事件')
  })

  await t('A5b backlog 截断分页：cursor 停在最后返回事件，不跳行', async () => {
    // pre-watermark backlog 才走截断分页路径（hot-window 截断属最终一致，最长等一个 grace）。
    // 合法回填：显式 created_at 的已提交旧行（测试 seam，模拟历史数据，不伪造 demo）
    const oldIds = Array.from({ length: 5 }, () => randomUUID())
    await inWriteTx(async (c) => { for (const id of oldIds) await insRecall(c, id, 90) }, 'act-a5b-ins')
    const mine = new Set(oldIds)
    const dedupe = makeDedupe()
    let cursor, got = []
    for (let i = 0; i < 12 && got.length < 5; i++) {
      const r = await vizActivity({ principal, after: cursor, limit: 2 })
      got.push(...dedupe(r.events).filter(e => mine.has(e.event_id)))
      cursor = r.cursor
    }
    assert.equal(got.length, 5, `分页应拼出全部 5 条回填行，实际 ${got.length}`)
    // 回填行早于既有行 90s，必须按时间序先于它们出现（keyset 全序）
  })
  await t('A7 同微秒 170 条大组：SQL 元组 keyset 分页恰好 170/170 无重复（Codex 反例）', async () => {
    const big = Array.from({ length: 170 }, () => randomUUID())
    await inWriteTx(async (c) => insRecallBatch(c, big, 90), 'act-a7-ins')  // 单语句同微秒 backlog
    const mine = new Set(big)
    const seen = []
    let cursor
    for (let i = 0; i < 8; i++) {
      const r = await vizActivity({ principal, after: cursor, limit: 100 })
      seen.push(...r.events.filter(e => mine.has(e.event_id)).map(e => e.event_id))
      if (!r.has_more && seen.length >= 170) break
      cursor = r.page_cursor ?? r.cursor
    }
    assert.equal(seen.length, 170, `同微秒大组必须恰好 170/170，实际 ${seen.length}`)
    assert.equal(new Set(seen).size, 170, '且无重复')
  })

  await t('A8 hot burst > limit：page_cursor 当轮 drain，最后一条不等 grace', async () => {
    const burst = Array.from({ length: 130 }, () => randomUUID())
    await inWriteTx(async (c) => insRecallBatch(c, burst), 'act-a8-ins')  // 单语句 now()——hot
    const mine = new Set(burst)
    const got = new Set()
    let after, durable
    for (let i = 0; i < 5; i++) {
      const r = await vizActivity({ principal, after, limit: 100 })
      for (const e of r.events) if (mine.has(e.event_id)) got.add(e.event_id)
      durable = r.cursor
      if (!r.has_more) break
      after = r.page_cursor
      assert.ok(r.page_cursor, 'has_more 时必须给 page_cursor')
    }
    assert.equal(got.size, 130, `hot burst 必须当轮 drain 完，实际 ${got.size}——不等 30s grace`)
    // durable checkpoint 不得越过 watermark（hot 事件下轮仍重放，由客户端去重）
    const durAt = Buffer.from(durable, 'base64').toString('utf8').split('|')[0]
    const r2 = await vizActivity({ principal, limit: 1 })
    assert.ok(durAt <= r2.watermark_at)
  })

  await t('A10 冻结 page token：drain 期间合法晚提交绝不被永久越过（Codex 二审反例）', async () => {
    // 1) 推进 durable 到稳态
    let D0, guard = 0
    for (let after; guard < 20; guard++) {
      const r = await vizActivity({ principal, after, limit: 200 })
      D0 = r.cursor
      if (!r.has_more) break
      after = r.cursor
    }
    const pool = getPool()
    const c1 = await pool.connect()
    const lateId = randomUUID()
    const hotIds = Array.from({ length: 6 }, () => randomUUID())
    try {
      await c1.query('BEGIN')
      await insRecall(c1, lateId)                                    // T1 @t0 未提交
      await new Promise(r => setTimeout(r, 400))
      await inWriteTx(async (c) => insRecallBatch(c, hotIds), 'act-a10-hot')  // H > t0 已提交
      const r1 = await vizActivity({ principal, after: D0, limit: 2 })
      assert.equal(r1.has_more, true)
      assert.ok(r1.page_cursor?.startsWith('P.'), '翻页 token 必须是冻结形态')
      await c1.query('COMMIT')                                       // T1 合法晚提交（<15s）
      // 2) drain 整条 token 链：durable 恒等冻结 checkpoint，绝不随页重算
      const dedupe = makeDedupe()
      dedupe(r1.events)
      let lateSeen = r1.events.filter(e => e.event_id === lateId).length
      let pa = r1.page_cursor
      for (let i = 0; i < 30 && pa; i++) {
        const r = await vizActivity({ principal, after: pa, limit: 50 })
        assert.equal(r.cursor, r1.cursor, '翻页期间 durable cursor 必须恒等冻结 checkpoint')
        lateSeen += dedupe(r.events).filter(e => e.event_id === lateId).length
        pa = r.has_more ? r.page_cursor : null
      }
      // 3) 下一轮从冻结 checkpoint 起步；graceMs 注入让 watermark 越过 t0（免等 30s）——
      //    无论 drain 期间是否撞见过 T1，全程去重后必须恰好一次，绝不为零（永久漏 = 旧 bug）
      const r2 = await vizActivity({ principal, after: r1.cursor, graceMs: 200, limit: 500 })
      lateSeen += dedupe(r2.events).filter(e => e.event_id === lateId).length
      assert.equal(lateSeen, 1, `晚提交行去重后必须恰好一次（实际 ${lateSeen}——0 即永久漏）`)
    } finally { c1.release() }
  })

  await t('A11 page token 输入边界：坏时间与坏 checkpoint 一律 cursor_invalid（不 500 不回流）', async () => {
    const mk = (t) => 'P.' + Buffer.from(JSON.stringify(t)).toString('base64')
    const r1 = await vizActivity({ principal, after: mk({ at: 'bogus', kind: '', id: 'x', checkpoint: 'x', upper: 'bogus' }) })
    assert.deepEqual({ ok: r1.ok, error: r1.error }, { ok: false, error: 'cursor_invalid' })
    const goodAt = '2026-08-08 00:00:00+00'
    const r2 = await vizActivity({ principal, after: mk({ at: goodAt, kind: '', id: 'x', checkpoint: 'bogus-not-base64-cursor', upper: goodAt }) })
    assert.deepEqual({ ok: r2.ok, error: r2.error }, { ok: false, error: 'cursor_invalid' }, '坏 checkpoint 不得 ok:true 回流')
  })

  await t('A12 baseline 协议（真库·独立 principal）：分页取全 / 越界报错 / 恢复不丢晚提交', async () => {
    // 四审 P1-4：独立 tenant fixture——不与 A 系列共享事件计数，判别不看 CN 延迟脸色
    const T12 = 'activity-a12-tenant', A12 = 'activity-a12-agent'
    const vp = { tenant_id: T12, agent_id: A12, capabilities: [], scope: 'viz' }
    const { vizOcean } = await import('./viz/ocean.mjs')
    const ins12 = (c, ids) => c.query(
      `INSERT INTO recall_requests (tenant_id, request_id, agent_id, episode_id, attempt_id,
         query_hmac, pipeline_version, receipt_json, serialization_checksum)
       SELECT $1, id, $2, 'ep-a12', 'at-' || id, $3, 'test', '{"receipt":{"items":[]}}', $3
       FROM unnest($4::STRING[]) AS id`, [T12, A12, bytes, ids])
    const clean12 = () => inSerializableTx(async (c) => c.query('DELETE FROM recall_requests WHERE tenant_id=$1', [T12]), 'a12-clean')
    await clean12()
    try {
      const hot = Array.from({ length: 5 }, () => randomUUID())
      await inWriteTx(async (c) => ins12(c, hot), 'act-a12-ins')            // now()——热窗口内
      // 1) 小页强制分页（page=2 → 3 轮取全）：一条不落
      const ok1 = await vizOcean({ principal: vp, _baselineCfg: { page: 2, total_cap: 100 } })
      assert.equal(ok1.ok, true)
      const keys1 = new Set(ok1.activity_baseline.seen.map(x => x.k))
      for (const id of hot) assert.ok(keys1.has(`recall|${id}`), `分页取全：缺 ${id.slice(0, 8)}`)
      assert.ok(ok1.activity_baseline.cursor && ok1.activity_baseline.watermark_at)
      // 2) 超总界（恰好 5 条 > cap 3——确定性，不依赖别的测试写入）：整体报错，无可推进 cursor
      const ov = await vizOcean({ principal: vp, _baselineCfg: { page: 2, total_cap: 3 } })
      assert.equal(ov.activity_baseline.error, 'hot_window_overflow')
      assert.equal(ov.activity_baseline.cursor, undefined, '越界不得给任何可推进的 cursor')
      // 3) 恢复语义：overflow 期间发生的"晚提交"（新写入 late-1）——恢复 baseline 必须
      //    把它列入 seen（=已被恢复快照表示，画面走快照），服务端零丢失
      const late = randomUUID()
      await inWriteTx(async (c) => ins12(c, [late]), 'act-a12-late')
      const rec = await vizOcean({ principal: vp, _baselineCfg: { page: 2, total_cap: 100 } })
      assert.equal(rec.ok, true)
      const keys2 = new Set(rec.activity_baseline.seen.map(x => x.k))
      assert.ok(keys2.has(`recall|${late}`), '恢复 baseline 必须覆盖 overflow 间隙内的晚提交（不漏）')
      for (const id of hot) assert.ok(keys2.has(`recall|${id}`), '原热事件仍在恢复边界内')
    } finally { await clean12() }
  })

  await t('A13 recall memory_ids 投影：injected-only、保序、cap=12、零泄露（动效批 additive 契约）', async () => {
    // 独立 tenant（同 A12 式）：不与 A 系事件计数纠缠
    const T13 = 'activity-a13-tenant', A13 = 'activity-a13-agent'
    const vp = { tenant_id: T13, agent_id: A13, capabilities: [], scope: 'viz' }
    const clean13 = () => inSerializableTx(async (c) => c.query('DELETE FROM recall_requests WHERE tenant_id=$1', [T13]), 'a13-clean')
    await clean13()
    try {
      // 混合 receipt：16 items = 14 injected + 2 非注入（插在 2、5 位）——
      // 覆盖 injected 过滤、receipt 顺序、cap=12 截断三个判别点
      const inj = Array.from({ length: 14 }, () => randomUUID())
      const noninj = [randomUUID(), randomUUID()]
      const items = []
      let a = 0, b = 0
      for (let i = 0; i < 16; i++) {
        if (i === 2 || i === 5) items.push({ memory_id: noninj[b++], receipt_item_id: `ri-n${i}`, injected: false, similarity: 0.91, final_score: 0.9 })
        else { items.push({ memory_id: inj[a], receipt_item_id: `ri-${a}`, injected: true, similarity: 0.8, final_score: 0.7 }); a++ }
      }
      const rid = randomUUID(), ridEmpty = randomUUID()
      const insReceipt = (c, id, receipt) => c.query(
        `INSERT INTO recall_requests (tenant_id, request_id, agent_id, episode_id, attempt_id,
           query_hmac, pipeline_version, receipt_json, serialization_checksum)
         VALUES ($1, $2, $3, 'ep-a13', $4, $5, 'test', $6::JSONB, $5)`,
        [T13, id, A13, `at-${id}`, bytes, JSON.stringify(receipt)])
      await inWriteTx(async (c) => {
        await insReceipt(c, rid, { receipt: { items } })
        await insReceipt(c, ridEmpty, { receipt: { items: [] } })
      }, 'act-a13-ins')
      const r = await vizActivity({ principal: vp })
      assert.equal(r.ok, true)
      const ev = r.events.find(e => e.event_id === rid)
      const evEmpty = r.events.find(e => e.event_id === ridEmpty)
      assert.ok(ev && evEmpty, '两条 fixture 事件都应可见')
      assert.deepEqual(ev.memory_ids, inj.slice(0, 12), 'memory_ids = injected items 前 12，保 receipt 顺序')
      assert.ok(!ev.memory_ids.includes(noninj[0]) && !ev.memory_ids.includes(noninj[1]), '非注入项不得出现')
      assert.equal(ev.items_count, 16, 'items_count 仍为全量条数（口径不变）')
      assert.deepEqual(evEmpty.memory_ids, [], '空 receipt → 空数组')
      assert.ok(ev.memory_ids.every(x => typeof x === 'string'), '元素只许是 UUID string，不许对象')
      for (const k of ['ritems', 'items', 'receipt', 'receipt_json', 'similarity', 'final_score'])
        assert.ok(!(k in ev), `recall 事件不得泄露 ${k}`)
    } finally { await clean13() }
  })

  await t('A9 配置守卫：29999 接受 / 30000 拒绝（严格不等式）', async () => {
    const { execSync } = await import('node:child_process')
    const probe = (v) => {
      try {
        execSync(`node --input-type=module -e "process.env.TIDEMARK_WRITE_TX_TIMEOUT_MS='${v}'; const m = await import('./src/lib/viz-config.mjs'); console.log(m.WRITE_TX_TIMEOUT_MS)"`,
          { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' })
        return true
      } catch { return false }
    }
    assert.equal(probe(29999), true, '29999 必须接受')
    assert.equal(probe(30000), false, '30000（= SAFETY_GRACE）必须拒绝')
  })
} finally {
  await cleanup()
  await getPool().end()
}
console.log(`\n${passed} 场景全过`)

process.exit(0)
