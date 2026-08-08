// live 消费协调器回归（live 环一审 P1-5 点名的判别集，注入 fetch/storage）
import assert from 'node:assert/strict'
import { makeLiveCoordinator, outcomeActions } from './src/pool/live-coordinator.mjs'

let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`) }
const makeStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, String(v)), _m: m }
}
const ev = (kind, id, extra = {}) => ({ kind, event_id: id, ...extra })

await t('L1 bootstrap：head cursor 对齐，历史事件不重演', async () => {
  const got = []
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async ({ head, after }) => head
      ? { ok: true, events: [], cursor: 'HEAD', has_more: false }
      : (assert.equal(after, 'HEAD', '首轮 poll 必须从 head 起，不许 epoch'),
         { ok: true, events: [ev('recall', 'new-1')], cursor: 'C1', has_more: false }),
    fetchSnapshot: async () => ({ ok: true }),
    onEvent: (e) => got.push(e.event_id), onSnapshot: () => {},
  })
  assert.equal(await c.bootstrap(), 'head')
  assert.equal(await c.poll(), 'done')
  assert.deepEqual(got, ['new-1'])
})

await t('L2 remount：cursor 与去重集持久，热窗口重放不漏不重', async () => {
  const storage = makeStorage()
  const mk = (got) => makeLiveCoordinator({
    storage,
    fetchActivity: async ({ head, after }) => head
      ? { ok: true, events: [], cursor: 'WM', has_more: false }
      : { ok: true, events: [ev('recall', 'hot-1'), ev('outcome', 'hot-2', { items: [] })], cursor: 'WM', has_more: false },
    fetchSnapshot: async () => ({ ok: true }),
    onEvent: (e) => got.push(e.event_id), onSnapshot: () => {},
  })
  const got1 = []
  const c1 = mk(got1)
  await c1.bootstrap(); await c1.poll()
  assert.deepEqual(got1, ['hot-1', 'hot-2'])
  const got2 = []
  const c2 = mk(got2)                                  // remount：同一 storage 新实例
  assert.equal(await c2.bootstrap(), 'restored')
  await c2.poll()                                       // 热窗口事件被服务端重放
  assert.deepEqual(got2, [], 'remount 后重放事件必须被持久去重集拦下——不重')
})

await t('L3 单飞：慢链在途时新 tick 让路，durable cursor 不回退', async () => {
  const storage = makeStorage({ tm_cursor: 'C0' })
  let release
  const gate = new Promise(r => { release = r })
  let call = 0
  const c = makeLiveCoordinator({
    storage,
    fetchActivity: async () => {
      if (++call === 1) { await gate; return { ok: true, events: [], cursor: 'C1-old', has_more: false } }
      return { ok: true, events: [], cursor: 'C2-new', has_more: false }
    },
    fetchSnapshot: async () => ({ ok: true }),
    onEvent: () => {}, onSnapshot: () => {},
  })
  const slow = c.poll()                                 // 链 A：挂在 gate 上
  assert.equal(await c.poll(), 'busy', '在途时第二条链必须让路')
  release()
  await slow
  assert.equal(c._debug().durable, 'C1-old')            // 串行完成——此后不存在并发旧链可覆盖
  await c.poll()
  assert.equal(c._debug().durable, 'C2-new', 'cursor 只能沿串行链前进')
})

await t('L4 超页续排：maxPages 用尽保留 page_cursor，下轮从续排点继续', async () => {
  const storage = makeStorage({ tm_cursor: 'D0' })
  const afters = []
  let n = 0
  const c = makeLiveCoordinator({
    storage, maxPages: 3,
    fetchActivity: async ({ after }) => {
      afters.push(after)
      n++
      return { ok: true, events: [ev('recall', `e${n}`)], cursor: 'D0', has_more: n < 5, page_cursor: `P${n}` }
    },
    fetchSnapshot: async () => ({ ok: true }),
    onEvent: () => {}, onSnapshot: () => {},
  })
  assert.equal(await c.poll(), 'paged-out')
  assert.deepEqual(afters, ['D0', 'P1', 'P2'])
  assert.equal(await c.poll(), 'done')
  assert.deepEqual(afters.slice(3), ['P3', 'P4'], '续排必须从 P3 起，不从 durable 重排队')
})

await t('L5 快照：旧 snapshot_at 拒收；在途合并 queued 重跑', async () => {
  const storage = makeStorage()
  const applied = []
  let resolveA
  const gateA = new Promise(r => { resolveA = r })
  let call = 0
  const c = makeLiveCoordinator({
    storage,
    fetchActivity: async () => ({ ok: true, events: [], cursor: 'X', has_more: false }),
    fetchSnapshot: async () => {
      if (++call === 1) { await gateA; return { ok: true, snapshot_at: '2026-08-08T10:00:00Z' } }  // 旧 A 晚到
      return { ok: true, snapshot_at: `2026-08-08T10:00:0${call}Z` }
    },
    onEvent: () => {}, onSnapshot: (s) => applied.push(s.snapshot_at),
  })
  const a = c.refreshSnapshot()                          // A 在途（将返回旧水位）
  assert.equal(await c.refreshSnapshot(), 'queued')      // B 合并进 A 的重跑
  resolveA()
  await a
  // A 先应用（10:00:00），queued 重跑取到 10:00:02 应用；此后旧水位一律拒
  assert.deepEqual(applied, ['2026-08-08T10:00:00Z', '2026-08-08T10:00:02Z'])
  const verdict = await (async () => {                   // 手工旧响应：<= 水位必须拒
    call = 98
    const c2v = await c.refreshSnapshot()
    return c2v
  })()
  assert.equal(applied.length, 3, '更新水位继续应用')
})

await t('L6 outcomeActions：仅 applied=true 的 credited/blamed 产生动作', () => {
  assert.deepEqual(outcomeActions({ items: [] }), [])                                     // cancelled：无 item
  assert.deepEqual(outcomeActions({ items: [{ memory_id: 'm', role: 'credited', applied: false, reason: 'late_no_plasticity' }] }), [])
  assert.deepEqual(outcomeActions({ items: [
    { memory_id: 'a', role: 'credited', applied: true },
    { memory_id: 'b', role: 'blamed', applied: true },
    { memory_id: 'c', role: 'credited', applied: false },
  ] }), [{ memory_id: 'a', role: 'credited' }, { memory_id: 'b', role: 'blamed' }])
})

await t('L7 pendingSpawn：落滴在途的 id 不重复生成', () => {
  const c = makeLiveCoordinator({ storage: makeStorage(), fetchActivity: async () => ({}), fetchSnapshot: async () => ({}), onEvent: () => {}, onSnapshot: () => {} })
  c.markPending('m1')
  assert.equal(c.isPending('m1'), true)
  c.clearPending('m1')
  assert.equal(c.isPending('m1'), false)
})

await t('L8 抢跑防护：bootstrap 未完成时 poll 拒绝，绝不 epoch 拉取', async () => {
  const calls = []
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async (a) => { calls.push(a); return { ok: true, events: [], cursor: 'H', has_more: false } },
    fetchSnapshot: async () => ({ ok: true }),
    onEvent: () => {}, onSnapshot: () => {},
  })
  assert.equal(await c.poll(), 'not-ready', 'interval 第一拍抢在 bootstrap 前必须让路')
  assert.equal(calls.length, 0, '零 fetch——after=null 的 epoch 拉取不存在')
  await c.bootstrap()
  assert.equal(await c.poll(), 'done')
})

console.log(`\n${passed} 项全过`)
