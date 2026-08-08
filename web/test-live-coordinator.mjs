// live 消费协调器回归（一审 P1-5 + 二审全项判别，注入 fetch/storage）
import assert from 'node:assert/strict'
import { makeLiveCoordinator, outcomeActions, eventCausesRefresh, diffSnapshot } from './src/pool/live-coordinator.mjs'

let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`) }
const makeStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, String(v)), _m: m }
}
const ev = (kind, id, extra = {}) => ({ kind, event_id: id, ...extra })
const SNAP = (over = {}) => ({
  ok: true, tenant_id: 't1', agent_id: 'a1', snapshot_at: '2026-08-08T10:00:00.000Z',
  activity_baseline: { cursor: 'WM', cursor_snapshot: 'SNAPC', seen_keys: ['recall|hot-old', 'outcome|hot-old2'], truncated: false },
  ...over,
})

await t('B1 baseline bootstrap：快照已表示的热事件不重演，快照后的新事件照常动画', async () => {
  const got = []
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async ({ after }) => {
      assert.equal(after, 'WM', '首轮必须从 baseline cursor 起')
      // 服务端 hot 重放：含快照已表示的 hot-old 与快照后的新事件 new-1
      return { ok: true, events: [ev('recall', 'hot-old'), ev('recall', 'new-1')], cursor: 'C1', has_more: false }
    },
    fetchSnapshot: async () => SNAP(),
    onEvent: (e) => got.push(e.event_id), onSnapshot: () => {},
  })
  assert.equal(await c.bootstrap(SNAP()), 'baseline')
  await c.poll()
  assert.deepEqual(got, ['new-1'], '快照可见性边界内的 hot-old 必须被 baseline seen 拦下')
})

await t('B2 热窗口越界：baseline 诚实报错不跳窗（无损协议），poll 自愈重试后恢复', async () => {
  const afters = []
  let snapCall = 0
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async ({ after }) => { afters.push(after); return { ok: true, events: [], cursor: 'C', has_more: false } },
    fetchSnapshot: async () => (++snapCall === 1
      ? SNAP({ activity_baseline: { error: 'hot_window_overflow' } })
      : SNAP()),
    onEvent: () => {}, onSnapshot: () => {},
  })
  assert.equal(await c.bootstrap(SNAP({ activity_baseline: { error: 'hot_window_overflow' } })), 'error', '越界=失败，绝不跳窗丢晚提交')
  assert.equal(c._debug().ready, false)
  assert.equal(await c.poll(), 'not-ready(error)', '越界窗口内继续拒绝（自愈拿到的仍是 overflow）')
  assert.equal(await c.poll(), 'done', '下个窗口 baseline 正常后恢复消费')
  assert.deepEqual(afters, ['WM'])
})

await t('B3 命名空间：切换 principal 不复用他人 checkpoint；legacy 无 scope 键清除', async () => {
  const storage = makeStorage({ tm_cursor: 'LEGACY', tm_seen: '["recall|x"]' })
  const mk = (snap) => makeLiveCoordinator({
    storage,
    fetchActivity: async () => ({ ok: true, events: [], cursor: 'C', has_more: false }),
    fetchSnapshot: async () => snap,
    onEvent: () => {}, onSnapshot: () => {},
  })
  const c1 = mk(SNAP())
  assert.equal(await c1.bootstrap(SNAP()), 'baseline', 'legacy 键不得被当作 restored 来源')
  assert.equal(storage.get('tm_cursor'), '', 'legacy 键 fail-closed 清除')
  const nsKeys1 = [...storage._m.keys()].filter(k => k.startsWith('tm.') && k.endsWith('.cursor'))
  assert.equal(nsKeys1.length, 1, '本 principal 命名空间键写入')
  // 换 agent：不复用 a1 的 checkpoint（键集必须新增而非复用）
  const c2 = mk(SNAP({ agent_id: 'a2' }))
  assert.equal(await c2.bootstrap(SNAP({ agent_id: 'a2' })), 'baseline')
  const nsKeys2 = [...storage._m.keys()].filter(k => k.startsWith('tm.') && k.endsWith('.cursor'))
  assert.equal(nsKeys2.length, 2, '不同 agent 各有独立 cursor 键')
  // 碰撞反例（三审 P1-4）：('a.b','c') 与 ('a','b.c') 必须不同键
  const keysOf = (snap) => {
    const st = makeStorage()
    const cx = makeLiveCoordinator({ storage: st, fetchActivity: async () => ({ ok: true, events: [], cursor: 'C', has_more: false }), fetchSnapshot: async () => snap, onEvent: () => {}, onSnapshot: () => {} })
    return cx.bootstrap(snap).then(() => [...st._m.keys()].filter(k => k.startsWith('tm.')))
  }
  const kA = await keysOf(SNAP({ tenant_id: 'a.b', agent_id: 'c' }))
  const kB = await keysOf(SNAP({ tenant_id: 'a', agent_id: 'b.c' }))
  assert.ok(kA.length && kB.length)
  assert.equal(kA.some(k => kB.includes(k)), false, `点号碰撞未消除: ${kA} vs ${kB}`)
})

await t('B4 离线间隙 reload：新 baseline 压过旧 cursor，离线事件不重演（三审 P1-1 反例）', async () => {
  const storage = makeStorage()
  const mk = (got, snap, events, forbidAfter = null) => makeLiveCoordinator({
    storage,
    fetchActivity: async ({ after }) => {
      if (forbidAfter && after === forbidAfter) assert.fail('旧 cursor 不得作为消费起点')
      return { ok: true, events, cursor: 'WM2', has_more: false }
    },
    fetchSnapshot: async () => snap,
    onEvent: (e) => got.push(e.event_id), onSnapshot: () => {},
  })
  // 会话 1：只见过 hot-1，留下旧 cursor C0-old 与含 hot-1 的持久 seen
  const g1 = []
  const snap1 = SNAP({ activity_baseline: { cursor: 'C0-old', seen_keys: [] } })
  const c1 = mk(g1, snap1, [ev('recall', 'hot-1')])
  await c1.bootstrap(snap1)
  await c1.poll()
  // 离线间隙：产生 recall|offline，且新 boot snapshot 的 baseline 已把它列为 seen
  const g2 = []
  const snap2 = SNAP({ snapshot_at: '2026-08-08T11:00:00.000Z', activity_baseline: { cursor: 'WM-new', seen_keys: ['recall|offline'] } })
  const c2 = mk(g2, snap2, [ev('recall', 'offline'), ev('recall', 'hot-1'), ev('recall', 'post-snap')], 'C0-old')   // 会话 2：热重放含离线事件；旧 cursor 是禁区
  const verdict = await c2.bootstrap(snap2)
  assert.ok(verdict.startsWith('baseline'), `新 baseline 必须接管（实际 ${verdict}——restored 即 bug）`)
  assert.equal(c2._debug().durable, 'WM-new', '旧 cursor 不得压过新可见性边界')
  await c2.poll()
  assert.deepEqual(g2, ['post-snap'], '离线事件（新快照已表示）与已见 hot-1 都不重演，快照后新事件照常')
})

await t('B5 bootstrap 瞬断自愈：head 失败后 poll 触发重新 bootstrap，不永久沉默', async () => {
  let snapCall = 0
  const got = []
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async () => ({ ok: true, events: [ev('recall', 'e1')], cursor: 'C', has_more: false }),
    fetchSnapshot: async () => (++snapCall === 1 ? null : SNAP()),   // 首次瞬断
    onEvent: (e) => got.push(e.event_id), onSnapshot: () => {},
  })
  assert.equal(await c.bootstrap(), 'error')
  assert.equal(await c.poll(), 'done', 'poll 自愈：内部重新 bootstrap 后继续消费')
  assert.deepEqual(got, ['e1'])
})

await t('L3 单飞：慢链在途时新 tick 让路，durable cursor 不回退', async () => {
  const storage = makeStorage()
  let release
  const gate = new Promise(r => { release = r })
  let call = 0
  const c = makeLiveCoordinator({
    storage,
    fetchActivity: async () => {
      if (++call === 1) { await gate; return { ok: true, events: [], cursor: 'C1-old', has_more: false } }
      return { ok: true, events: [], cursor: 'C2-new', has_more: false }
    },
    fetchSnapshot: async () => SNAP(),
    onEvent: () => {}, onSnapshot: () => {},
  })
  await c.bootstrap(SNAP())
  const slow = c.poll()
  assert.equal(await c.poll(), 'busy')
  release()
  await slow
  assert.equal(c._debug().durable, 'C1-old')
  await c.poll()
  assert.equal(c._debug().durable, 'C2-new', 'cursor 只能沿串行链前进')
})

await t('L4 超页续排：maxPages 用尽保留 page_cursor，下轮从续排点继续', async () => {
  const afters = []
  let n = 0
  const c = makeLiveCoordinator({
    storage: makeStorage(), maxPages: 3,
    fetchActivity: async ({ after }) => {
      afters.push(after); n++
      return { ok: true, events: [ev('recall', `e${n}`)], cursor: 'WM', has_more: n < 5, page_cursor: `P${n}` }
    },
    fetchSnapshot: async () => SNAP(),
    onEvent: () => {}, onSnapshot: () => {},
  })
  await c.bootstrap(SNAP())
  assert.equal(await c.poll(), 'paged-out')
  assert.deepEqual(afters, ['WM', 'P1', 'P2'])
  assert.equal(await c.poll(), 'done')
  assert.deepEqual(afters.slice(3), ['P3', 'P4'], '续排从 P3 起，不从 durable 重排队')
})

await t('L5 快照单调门：明确旧于水位的响应 stale-rejected 且 onSnapshot 不增', async () => {
  const applied = []
  let snapAt = '2026-08-08T10:00:05.000Z'
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async () => ({ ok: true, events: [], cursor: 'C', has_more: false }),
    fetchSnapshot: async () => SNAP({ snapshot_at: snapAt }),
    onEvent: () => {}, onSnapshot: (s) => applied.push(s.snapshot_at),
  })
  await c.bootstrap(SNAP({ snapshot_at: '2026-08-08T10:00:05.000Z' }))   // 水位 = 10:00:05
  snapAt = '2026-08-08T10:00:04.000Z'                                    // 旧响应（严格更早的合法 ISO）
  assert.equal(await c.refreshSnapshot(), 'stale-rejected')
  assert.equal(applied.length, 0, '旧快照绝不应用')
  snapAt = '2026-08-08T10:00:06.000Z'
  assert.equal(await c.refreshSnapshot(), 'applied')
  assert.deepEqual(applied, ['2026-08-08T10:00:06.000Z'])
  // 等值也拒（<=）
  assert.equal(await c.refreshSnapshot(), 'stale-rejected')
  assert.equal(applied.length, 1)
})

await t('L6 outcomeActions + eventCausesRefresh：cancelled/late/未 applied 连 fetch 都不许', () => {
  assert.deepEqual(outcomeActions({ items: [] }), [])
  assert.deepEqual(outcomeActions({ items: [{ memory_id: 'm', role: 'credited', applied: false, reason: 'late_no_plasticity' }] }), [])
  assert.deepEqual(outcomeActions({ items: [
    { memory_id: 'a', role: 'credited', applied: true },
    { memory_id: 'b', role: 'blamed', applied: true },
    { memory_id: 'c', role: 'credited', applied: false },
  ] }), [{ memory_id: 'a', role: 'credited' }, { memory_id: 'b', role: 'blamed' }])
  assert.equal(eventCausesRefresh({ kind: 'outcome', items: [] }), false, 'cancelled：零刷新')
  assert.equal(eventCausesRefresh({ kind: 'outcome', items: [{ memory_id: 'm', role: 'blamed', applied: false }] }), false, 'late/未 applied：零刷新')
  assert.equal(eventCausesRefresh({ kind: 'outcome', items: [{ memory_id: 'm', role: 'blamed', applied: true }] }), true)
  assert.equal(eventCausesRefresh({ kind: 'remember' }), true)
  assert.equal(eventCausesRefresh({ kind: 'recall' }), false)
})

await t('L7 pending 生命周期集成：spawn→attach 清账→snapshot 移除生效（无幽灵粒子）', () => {
  const c = makeLiveCoordinator({ storage: makeStorage(), fetchActivity: async () => ({}), fetchSnapshot: async () => ({}), onEvent: () => {}, onSnapshot: () => {} })
  // 快照 A：m1 新增 → 落滴在途（pending）
  c.markPending('m1')
  const d1 = diffSnapshot(['m1', 'm0'], ['m0'], (id) => c.isPending(id))
  assert.deepEqual(d1, { added: [], removedIds: [] }, '落滴在途：相邻快照不重复生成')
  // attach 完成 → 统一清账（二审 P1-3：任何 attach 路径都必须清）
  c.clearPending('m1')
  // 快照 B：m1 已消失 → 必须可移除（不清账就是永久幽灵）
  const d2 = diffSnapshot(['m0'], ['m0', 'm1'], (id) => c.isPending(id))
  assert.deepEqual(d2, { added: [], removedIds: ['m1'] }, 'attach 清账后 snapshot 移除必须生效')
})

await t('L8 抢跑防护：bootstrap 未完成时 poll 先自愈再消费，绝不 epoch 拉取', async () => {
  const activityCalls = []
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async (a) => { activityCalls.push(a.after); return { ok: true, events: [], cursor: 'C', has_more: false } },
    fetchSnapshot: async () => SNAP(),
    onEvent: () => {}, onSnapshot: () => {},
  })
  assert.equal(await c.poll(), 'done')                     // 自愈 bootstrap 后消费
  assert.ok(activityCalls.every(a => a === 'WM' || a === 'C'), `绝无 after=null 的 epoch 拉取：${activityCalls}`)
  assert.ok(!activityCalls.includes(null) && !activityCalls.includes(undefined))
})

console.log(`\n${passed} 项全过`)
