// live 消费协调器回归（一审 P1-5 + 二审全项 + 三审 B 组 + 四审修订，注入 fetch/storage）
import assert from 'node:assert/strict'
import { makeLiveCoordinator, outcomeActions, eventCausesRefresh, diffSnapshot } from './src/pool/live-coordinator.mjs'

let passed = 0
const t = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`) }
const makeStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, String(v)), _m: m }
}
const ev = (kind, id, at = '2026-08-08T10:00:01.000Z', extra = {}) => ({ kind, event_id: id, occurred_at: at, ...extra })
const BL = (over = {}) => ({
  cursor: 'WM', watermark_at: '2026-08-08T09:59:30.000Z',
  seen: [{ k: 'recall|hot-old', at: '2026-08-08T09:59:40.000Z' }, { k: 'outcome|hot-old2', at: '2026-08-08T09:59:45.000Z' }],
  ...over,
})
const SNAP = (over = {}) => ({
  ok: true, tenant_id: 't1', agent_id: 'a1', snapshot_at: '2026-08-08T10:00:00.000Z',
  activity_baseline: BL(), ...over,
})

await t('B1 baseline bootstrap：快照已表示的热事件不重演，快照后的新事件照常动画', async () => {
  const got = []
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async ({ after }) => {
      assert.equal(after, 'WM')
      return { ok: true, events: [ev('recall', 'hot-old', '2026-08-08T09:59:40.000Z'), ev('recall', 'new-1')], cursor: 'C1', has_more: false }
    },
    fetchSnapshot: async () => SNAP(),
    onEvent: (e) => got.push(e.event_id), onSnapshot: () => {},
  })
  assert.equal(await c.bootstrap(SNAP()), 'baseline')
  await c.poll()
  assert.deepEqual(got, ['new-1'])
})

await t('B2 热窗口越界：baseline 诚实报错，自愈恢复且画面被原子接管', async () => {
  const snapsApplied = []
  let snapCall = 0
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async () => ({ ok: true, events: [], cursor: 'C', has_more: false }),
    fetchSnapshot: async () => (++snapCall === 1
      ? SNAP({ activity_baseline: { error: 'hot_window_overflow' } })
      : SNAP({ snapshot_at: '2026-08-08T10:01:00.000Z' })),
    onEvent: () => {}, onSnapshot: (s) => snapsApplied.push(s.snapshot_at),
  })
  assert.equal(await c.bootstrap(SNAP({ activity_baseline: { error: 'hot_window_overflow' } })), 'error')
  assert.equal(c._debug().ready, false)
  assert.equal(await c.poll(), 'not-ready(error)', '越界窗口内继续拒绝')
  assert.equal(await c.poll(), 'recovered-degraded', '恢复必须以显式降级口径上报（四审 P1-3）')
  assert.deepEqual(snapsApplied, ['2026-08-08T10:01:00.000Z'], '自愈快照必须原子交给画面（四审 P1-2）')
  assert.equal(await c.poll(), 'done')
})

await t('B3 命名空间：principal 隔离 + legacy fail-closed + 点号碰撞反例', async () => {
  const storage = makeStorage({ tm_cursor: 'LEGACY', tm_seen: '[["recall|x",1]]' })
  const mk = (snap) => makeLiveCoordinator({
    storage,
    fetchActivity: async () => ({ ok: true, events: [], cursor: 'C', has_more: false }),
    fetchSnapshot: async () => snap,
    onEvent: () => {}, onSnapshot: () => {},
  })
  const c1 = mk(SNAP())
  assert.equal(await c1.bootstrap(SNAP()), 'baseline', 'legacy 键不得被当作 restored 来源')
  assert.equal(storage.get('tm_cursor'), '')
  const nsKeys1 = [...storage._m.keys()].filter(k => k.startsWith('tm.') && k.endsWith('.cursor'))
  assert.equal(nsKeys1.length, 1)
  const c2 = mk(SNAP({ agent_id: 'a2' }))
  assert.equal(await c2.bootstrap(SNAP({ agent_id: 'a2' })), 'baseline')
  const nsKeys2 = [...storage._m.keys()].filter(k => k.startsWith('tm.') && k.endsWith('.cursor'))
  assert.equal(nsKeys2.length, 2, '不同 agent 各有独立 cursor 键')
  const keysOf = async (snap) => {
    const st = makeStorage()
    const cx = makeLiveCoordinator({ storage: st, fetchActivity: async () => ({ ok: true, events: [], cursor: 'C', has_more: false }), fetchSnapshot: async () => snap, onEvent: () => {}, onSnapshot: () => {} })
    await cx.bootstrap(snap)
    return [...st._m.keys()].filter(k => k.startsWith('tm.'))
  }
  const kA = await keysOf(SNAP({ tenant_id: 'a.b', agent_id: 'c' }))
  const kB = await keysOf(SNAP({ tenant_id: 'a', agent_id: 'b.c' }))
  assert.ok(kA.length && kB.length)
  assert.equal(kA.some(k => kB.includes(k)), false, `点号碰撞未消除: ${kA} vs ${kB}`)
})

await t('B4 离线间隙 reload：新 baseline 压过旧 cursor，离线事件不重演', async () => {
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
  const g1 = []
  const snap1 = SNAP({ activity_baseline: BL({ cursor: 'C0-old', seen: [] }) })
  const c1 = mk(g1, snap1, [ev('recall', 'hot-1')])
  await c1.bootstrap(snap1)
  await c1.poll()
  const g2 = []
  const snap2 = SNAP({ snapshot_at: '2026-08-08T11:00:00.000Z',
    activity_baseline: BL({ cursor: 'WM-new', seen: [{ k: 'recall|offline', at: '2026-08-08T10:30:00.000Z' }] }) })
  const c2 = mk(g2, snap2, [ev('recall', 'offline', '2026-08-08T10:30:00.000Z'), ev('recall', 'hot-1'), ev('recall', 'post-snap', '2026-08-08T11:00:01.000Z')], 'C0-old')
  const verdict = await c2.bootstrap(snap2)
  assert.ok(verdict.startsWith('baseline'), `新 baseline 必须接管（实际 ${verdict}）`)
  assert.equal(c2._debug().durable, 'WM-new')
  await c2.poll()
  assert.deepEqual(g2, ['post-snap'])
})

await t('B5 bootstrap 瞬断自愈 + 恢复快照上画面', async () => {
  let snapCall = 0
  const got = [], snaps = []
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async () => ({ ok: true, events: [ev('recall', 'e1')], cursor: 'C', has_more: false }),
    fetchSnapshot: async () => (++snapCall === 1 ? null : SNAP()),
    onEvent: (e) => got.push(e.event_id), onSnapshot: (s) => snaps.push(s.snapshot_at),
  })
  assert.equal(await c.bootstrap(), 'error')
  assert.equal(await c.poll(), 'recovered-degraded')
  assert.equal(snaps.length, 1, '自愈快照交给画面')
  assert.equal(await c.poll(), 'done')
  assert.deepEqual(got, ['e1'])
})

await t('B6 watermark 淘汰（四审等比反例）：淘汰只随 watermark，旧热事件绝不复活重演', async () => {
  const got = []
  let round = 0
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async () => {
      round++
      // 服务端每轮都重放三条旧热事件 + 第二轮起一条新事件；watermark 未过它们的时间
      const olds = ['old0', 'old1', 'old2'].map(id => ev('recall', id, '2026-08-08T09:59:50.000Z'))
      const fresh = round >= 2 ? [ev('recall', `fresh${round}`, `2026-08-08T10:00:0${round}.000Z`)] : []
      return { ok: true, events: [...olds, ...fresh], cursor: 'WM', has_more: false, watermark_at: '2026-08-08T09:59:30.000Z' }
    },
    fetchSnapshot: async () => SNAP({ activity_baseline: BL({ seen: ['old0', 'old1', 'old2'].map(k => ({ k: `recall|${k}`, at: '2026-08-08T09:59:50.000Z' })) }) }),
    onEvent: (e) => got.push(e.event_id), onSnapshot: () => {},
  })
  await c.bootstrap()
  await c.poll()                                       // 第一轮：olds 全被 baseline seen 拦下
  await c.poll()                                       // 第二轮：只有 fresh2
  await c.poll()                                       // 第三轮：只有 fresh3——olds 永不复活
  assert.deepEqual(got, ['fresh2', 'fresh3'], `旧热事件复活即四审反例重现：${got}`)
  assert.ok(c._debug().seenSize >= 3, 'watermark 未推进前 olds 必须还在 seen 里')
})

await t('B6b watermark 真推进后安全淘汰（五审点名 B6 假覆盖的真实版）', async () => {
  let wm = '2026-08-08T09:59:30.000Z'
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async () => ({ ok: true, events: [], cursor: 'WM', has_more: false, watermark_at: wm }),
    fetchSnapshot: async () => SNAP({ activity_baseline: BL({ seen: ['old0', 'old1', 'old2'].map(k => ({ k: `recall|${k}`, at: '2026-08-08T09:59:50.000Z' })) }) }),
    onEvent: () => {}, onSnapshot: () => {},
  })
  await c.bootstrap()
  await c.poll()
  assert.equal(c._debug().seenSize, 3, 'watermark(09:59:30) 未过 olds(09:59:50)：不淘汰')
  wm = '2026-08-08T10:00:10.000Z'                       // watermark 真推过 olds
  await c.poll()                                        // 干净轮（从 durable 起、无分页）→ 安全淘汰
  assert.equal(c._debug().seenSize, 0, 'watermark 推过后 olds 安全淘汰（重放窗口已不含它们）')
})

await t('B8 冻结分页不淘汰（五审反例）：后页事件下轮重放不复活', async () => {
  // 首响应 e1/cursor=D1/has_more/P1；末页 e2/cursor=D1；下一轮从 D1 重放 e2——
  // onEvent 必须恰 [e1, e2]（分页链内若按每页新鲜 watermark 淘汰，e2 会被踢出 seen 复活）
  const got = []
  let round = 0
  const c = makeLiveCoordinator({
    storage: makeStorage(), maxPages: 1,
    fetchActivity: async ({ after }) => {
      round++
      if (after === 'WM') return { ok: true, events: [ev('recall', 'e1', '2026-08-08T10:00:01.000Z')], cursor: 'D1', has_more: true, page_cursor: 'P1', watermark_at: '2026-08-08T10:00:05.000Z' }
      if (after === 'P1') return { ok: true, events: [ev('recall', 'e2', '2026-08-08T10:00:02.000Z')], cursor: 'D1', has_more: false, watermark_at: '2026-08-08T10:00:06.000Z' }
      // 下一轮从 D1（冻结 checkpoint）：服务端重放 e2
      return { ok: true, events: [ev('recall', 'e2', '2026-08-08T10:00:02.000Z')], cursor: 'WM3', has_more: false, watermark_at: '2026-08-08T10:00:07.000Z' }
    },
    fetchSnapshot: async () => SNAP({ activity_baseline: BL({ seen: [] }) }),
    onEvent: (e) => got.push(e.event_id), onSnapshot: () => {},
  })
  await c.bootstrap()
  assert.equal(await c.poll(), 'paged-out')             // e1
  assert.equal(await c.poll(), 'done')                  // e2（末页——不得按其 watermark 淘汰）
  assert.equal(await c.poll(), 'done')                  // 从 D1 重放 e2：seen 必须拦下
  assert.deepEqual(got, ['e1', 'e2'], `后页事件复活即五审反例重现：${got}`)
})

await t('B7 过载停流：seen 超硬界显式 halted，绝不静默重演', async () => {
  const c = makeLiveCoordinator({
    storage: makeStorage(), seenHardCap: 2,
    fetchActivity: async () => ({ ok: true,
      events: [ev('recall', 'a'), ev('recall', 'b'), ev('recall', 'c')],
      cursor: 'WM', has_more: false, watermark_at: '2026-08-08T09:00:00.000Z' }),
    fetchSnapshot: async () => SNAP({ activity_baseline: BL({ seen: [] }) }),
    onEvent: () => {}, onSnapshot: () => {},
  })
  await c.bootstrap()
  assert.equal(await c.poll(), 'halted-overloaded', '无法安全保住完整 hot set 时必须显式停流')
  assert.equal(await c.poll(), 'halted-overloaded', '停流态持续，不偷偷恢复')
})

await t('L3 单飞：慢链在途时新 tick 让路，durable cursor 不回退', async () => {
  let release
  const gate = new Promise(r => { release = r })
  let call = 0
  const c = makeLiveCoordinator({
    storage: makeStorage(),
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
  assert.equal(c._debug().durable, 'C2-new')
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
  assert.deepEqual(afters.slice(3), ['P3', 'P4'])
})

await t('L5 快照单调门：旧响应 stale-rejected 且 onSnapshot 不增', async () => {
  const applied = []
  let snapAt = '2026-08-08T10:00:05.000Z'
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async () => ({ ok: true, events: [], cursor: 'C', has_more: false }),
    fetchSnapshot: async () => SNAP({ snapshot_at: snapAt }),
    onEvent: () => {}, onSnapshot: (s) => applied.push(s.snapshot_at),
  })
  await c.bootstrap(SNAP({ snapshot_at: '2026-08-08T10:00:05.000Z' }))
  snapAt = '2026-08-08T10:00:04.000Z'
  assert.equal(await c.refreshSnapshot(), 'stale-rejected')
  assert.equal(applied.length, 0)
  snapAt = '2026-08-08T10:00:06.000Z'
  assert.equal(await c.refreshSnapshot(), 'applied')
  assert.equal(await c.refreshSnapshot(), 'stale-rejected')   // 等值也拒
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
  assert.equal(eventCausesRefresh({ kind: 'outcome', items: [] }), false)
  assert.equal(eventCausesRefresh({ kind: 'outcome', items: [{ memory_id: 'm', role: 'blamed', applied: false }] }), false)
  assert.equal(eventCausesRefresh({ kind: 'outcome', items: [{ memory_id: 'm', role: 'blamed', applied: true }] }), true)
  assert.equal(eventCausesRefresh({ kind: 'remember' }), true)
  assert.equal(eventCausesRefresh({ kind: 'recall' }), false)
})

await t('L7 pending 生命周期集成：spawn→attach 清账→snapshot 移除生效', () => {
  const c = makeLiveCoordinator({ storage: makeStorage(), fetchActivity: async () => ({}), fetchSnapshot: async () => ({}), onEvent: () => {}, onSnapshot: () => {} })
  c.markPending('m1')
  const d1 = diffSnapshot(['m1', 'm0'], ['m0'], (id) => c.isPending(id))
  assert.deepEqual(d1, { added: [], removedIds: [] })
  c.clearPending('m1')
  const d2 = diffSnapshot(['m0'], ['m0', 'm1'], (id) => c.isPending(id))
  assert.deepEqual(d2, { added: [], removedIds: ['m1'] })
})

await t('L8 抢跑防护：bootstrap 未完成时 poll 先自愈再消费，绝不 epoch 拉取', async () => {
  const activityCalls = []
  const c = makeLiveCoordinator({
    storage: makeStorage(),
    fetchActivity: async (a) => { activityCalls.push(a.after); return { ok: true, events: [], cursor: 'C', has_more: false } },
    fetchSnapshot: async () => SNAP(),
    onEvent: () => {}, onSnapshot: () => {},
  })
  const first = await c.poll()
  assert.ok(first === 'done' || first === 'recovered-degraded' || first.startsWith('baseline'), String(first))
  assert.ok(!activityCalls.includes(null) && !activityCalls.includes(undefined), `epoch 拉取不存在：${activityCalls}`)
})

console.log(`\n${passed} 项全过`)
