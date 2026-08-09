// P0-12 A/B harness 判别套件（零 DB，纯 mock）——一审三 P1 的回归钉子。
// AB1  identity 确定性：同输入同 exp_id
// AB2  P1-3 判别：只改一条 distract pool 文本 → exp_id 必变
// AB3  P1-3 判别：seed / recallCfg / embedding 任一变化 → exp_id 必变
// AB4  replica 非科学身份：不进 exp_id；同配置双 replica 的 request_id 序列逐位相同、tenant 不同
// AB5  P1-1（Codex 全空注入反例）：oracle success 的 given-only probe 必须报 success+空 attribution，
//      不得伪造 failure
// AB6  P1-1（Codex 预审 wrong-memory 反例）：注入未植入的错误记忆 → 零 credited 零 blamed，
//      任何 attribution 不得引用它
// AB7  P1-2 忠实注入：credited 全部命中项 / poison 必 blamed 附 evidence；每条 evidence 的
//      memory_id ⊆ 该 probe 声明的 used（policy 先行，oracle 后判，不倒灌）
// AB8  P1-2 policy 纯度：行动只依赖 {given, injected}，ground truth 翻转不改变行动；
//      oracle 的 poison 归因只从 used 派生
// AB9  P1-1 fail-closed：reportOutcome ok:false 或 applied:false → runArm 必须抛出
import { strict as assert } from 'node:assert'
import { experimentIdentity, runArm, defaultSuite } from './harness.mjs'
import { deterministicPolicy } from './policy.mjs'
import { scoreProbe } from './oracle.mjs'

let pass = 0
const ok = (name) => { pass++; console.log(`  AB ok: ${name}`) }

const ID_ARGS = { seed: 42, embeddingId: 'emb-test@v1', recallCfg: { topK: 5, floor: 0.3 } }

// ---------- mock tools ----------
const makeMockTools = ({ injectMode, outcome = {} }) => {
  const state = {
    byEpisode: new Map(),          // episode_id -> [{memory_id, kind}]
    rememberIds: [], tenants: new Set(),
    recallInjected: new Map(),     // recall request_id -> Set(memory_id)
    events: [], outcomes: [],
    seq: 0,
  }
  const tools = {
    remember: async ({ principal, kind, episode_id, request_id }) => {
      state.tenants.add(principal.tenant_id)
      state.rememberIds.push(request_id)
      const memory_id = `m-${++state.seq}`
      if (!state.byEpisode.has(episode_id)) state.byEpisode.set(episode_id, [])
      state.byEpisode.get(episode_id).push({ memory_id, kind })
      return { ok: true, memory_id }
    },
    recall: async ({ episode_id, request_id }) => {
      let ids = []
      if (injectMode === 'faithful') {
        ids = (state.byEpisode.get(episode_id) ?? []).filter(m => m.kind === 'fact').map(m => m.memory_id)
      } else if (injectMode === 'wrong') {
        ids = ['m-wrong']
      } // 'empty' -> []
      state.recallInjected.set(request_id, new Set(ids))
      return {
        ok: true,
        receipt: { request_id, items: ids.map((id, i) => ({ memory_id: id, receipt_item_id: `ri-${request_id}-${i}`, injected: true })) },
        injected: { events: ids.map(id => ({ memory_id: id, injected: true })) },
      }
    },
    logEvent: async ({ payload, request_id }) => {
      state.events.push({ request_id, payload })
      return { ok: true, event_id: `ev-${request_id}` }
    },
    reportOutcome: async ({ status, attributions, outcome_request_id }) => {
      state.outcomes.push({ status, attributions, outcome_request_id })
      if (outcome.failOk) return { ok: false, error: 'mock-forced' }
      const applied = outcome.failApplied ? false : true
      return { ok: true, items: attributions.map(() => ({ applied })) }
    },
  }
  return { tools, state }
}

const runFull = async ({ injectMode, outcome, replica = null }) => {
  const { tools, state } = makeMockTools({ injectMode, outcome })
  const traces = []
  const identity = experimentIdentity(ID_ARGS)
  const r = await runArm({ arm: 'full', identity, tenantBase: 't', tools, seed: ID_ARGS.seed,
    trace: (_, obj) => traces.push(obj), replica })
  return { r, state, traces }
}

// ---------- AB1-AB3 identity 判别 ----------
{
  const a = experimentIdentity(ID_ARGS)
  const b = experimentIdentity(ID_ARGS)
  assert.equal(a.exp_id, b.exp_id)
  assert.deepEqual(a.components, b.components)
  ok('AB1 同输入同 exp_id')

  const suite = defaultSuite()
  const mutated = { ...suite, distract_pool: [...suite.distract_pool] }
  mutated.distract_pool[0] = mutated.distract_pool[0] + '（改一个字）'
  const c = experimentIdentity({ ...ID_ARGS, suite: mutated })
  assert.notEqual(a.exp_id, c.exp_id, '只改 distract pool 必须换 exp_id')
  const g = experimentIdentity({ ...ID_ARGS, suite: { ...suite, distract_generator: 'other-gen-v2' } })
  assert.notEqual(a.exp_id, g.exp_id, '改生成器版本必须换 exp_id')
  ok('AB2 只改干扰语料/生成器 → exp_id 变')

  assert.notEqual(a.exp_id, experimentIdentity({ ...ID_ARGS, seed: 43 }).exp_id)
  assert.notEqual(a.exp_id, experimentIdentity({ ...ID_ARGS, recallCfg: { topK: 6, floor: 0.3 } }).exp_id)
  assert.notEqual(a.exp_id, experimentIdentity({ ...ID_ARGS, embeddingId: 'emb-test@v2' }).exp_id)
  ok('AB3 seed/recallCfg/embedding 变 → exp_id 变')
}

// ---------- AB4 replica = 非科学身份 ----------
{
  const one = await runFull({ injectMode: 'empty', replica: 'r1' })
  const two = await runFull({ injectMode: 'empty', replica: 'r2' })
  assert.deepEqual(one.state.rememberIds, two.state.rememberIds, '同配置双 replica request_id 序列必须逐位相同')
  assert.notDeepEqual([...one.state.tenants], [...two.state.tenants], 'replica 必须隔离 tenant')
  const h1 = one.traces.find(t => t.t === 'header'), h2 = two.traces.find(t => t.t === 'header')
  assert.deepEqual(h1.identity, h2.identity, 'replica 不得进入科学身份')
  assert.equal(h1.replica, 'r1'); assert.equal(h2.replica, 'r2')
  ok('AB4 replica 只隔离 tenant，不进 exp_id，request_id 确定性成立')
}

// ---------- AB5 Codex 全空注入反例 ----------
{
  const { state, traces } = await runFull({ injectMode: 'empty' })
  const stale = traces.filter(t => t.t === 'outcome' && t.sc === 'nc-stale')
  assert.equal(stale.length, 3)
  for (const o of stale) {
    assert.equal(o.status, 'success', 'given-only 成功不得伪造 failure')
    assert.equal(o.n_attributions, 0, '未靠记忆的成功必须空 attribution')
  }
  assert.ok(state.outcomes.every(o => o.status !== 'failure' || o.attributions.length === 0))
  assert.ok(!state.outcomes.some(o => o.status === 'failure' && ['sc-retention'].includes(o.sc)), 'sanity')
  ok('AB5 全空注入：oracle success ⇒ outcome success + 空 attribution')
}

// ---------- AB6 Codex 预审 wrong-memory 反例 ----------
{
  const { state } = await runFull({ injectMode: 'wrong' })
  const allAttr = state.outcomes.flatMap(o => o.attributions)
  assert.equal(allAttr.length, 0, '未植入的错误记忆不得产生任何 credited/blamed')
  assert.ok(!state.events.some(e => e.payload.memory_id === 'm-wrong'), '不得为 wrong-memory 写 memory_used')
  const staleOut = state.outcomes.filter(o => o.status === 'success')
  assert.ok(staleOut.length >= 3, 'given-only 场景仍应 success（wrong-memory 非 poison）')
  ok('AB6 wrong-memory：零归因，零 evidence，不奖励错误记忆')
}

// ---------- AB7 忠实注入：credited/blamed + evidence ⊆ used ----------
{
  const { state, traces } = await runFull({ injectMode: 'faithful' })
  const byProbe = (sc) => traces.filter(t => t.t === 'outcome' && t.sc === sc)
  const retention = byProbe('sc-retention')
  assert.equal(retention.length, 1)
  assert.equal(retention[0].status, 'success')
  assert.equal(retention[0].n_attributions, 2, 'sc-retention 两条 required 命中都应 credited')
  assert.deepEqual(retention[0].roles, ['credited', 'credited'])
  const stale = byProbe('nc-stale')
  assert.equal(stale.length, 3)
  for (const o of stale) {
    assert.equal(o.status, 'failure', 'mock 无塑性，poison 持续注入即持续 failure')
    assert.deepEqual(o.roles, ['blamed'], 'poison 使用必须 blamed 且只 blame 毒项')
  }
  // evidence ⊆ 该 probe 的注入集（policy used = 全部注入，oracle 只从 used 归因）
  for (const e of state.events) {
    const injectedSet = state.recallInjected.get(e.payload.recall_request_id)
    assert.ok(injectedSet?.has(e.payload.memory_id), `evidence ${e.payload.memory_id} 必须 ⊆ used`)
  }
  assert.ok(state.events.length > 0)
  ok('AB7 忠实注入：credited 全命中项 / blamed 毒项，evidence ⊆ used')
}

// ---------- AB8 policy 纯度 + oracle 只看 used ----------
{
  const injected = [{ memory_id: 'm-1', receipt_item_id: 'ri-1' }, { memory_id: 'm-2', receipt_item_id: 'ri-2' }]
  const a1 = deterministicPolicy({ given: [], injected })
  const a2 = deterministicPolicy({ given: [], injected })
  assert.deepEqual(a1, a2)
  // ground truth 翻转不进 policy 签名——同输入行动恒等；毒性只在 oracle 按 used 归因时出现
  const factOf = (id) => ({ 'm-1': 'f-good', 'm-2': 'f-bad' }[id])
  const vClean = scoreProbe({ action: a1, required: ['f-good'], poisonIds: new Set(), factOf })
  const vPoison = scoreProbe({ action: a1, required: ['f-good'], poisonIds: new Set(['f-bad']), factOf })
  assert.deepEqual(a1, deterministicPolicy({ given: [], injected }), '标签变化不得改变行动')
  assert.equal(vClean.task_success, true)
  assert.equal(vPoison.task_success, false)
  assert.deepEqual(vPoison.poison_ids, ['m-2'], 'poison 归因只从 used 查标签')
  const vUnused = scoreProbe({ action: { used_memory_ids: [], abstained: false }, required: [], given: ['g'], poisonIds: new Set(['f-bad']), factOf })
  assert.equal(vUnused.poison_hit, false, '未被 used 的毒不构成 poison_hit')
  assert.equal(vUnused.task_success, true)
  ok('AB8 policy 看不见 ground truth；oracle 归因只从 used 派生')
}

// ---------- AB9 fail-closed ----------
{
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { failOk: true } }),
    /report_outcome.*failed/, 'ok:false 必须抛出')
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { failApplied: true } }),
    /not applied/, 'applied:false 必须抛出')
  ok('AB9 reportOutcome ok:false / applied:false → fail closed')
}

console.log(`AB harness 判别 ${pass}/9 全绿`)
