// P0-12 A/B harness 判别套件（零 DB，纯 mock）——一审/二审 P1 的回归钉子。
// AB1  identity 确定性：同输入同 exp_id
// AB2  P1（一审）：只改一条 distract pool 文本 → exp_id 必变
// AB3  P1（一审）：seed / recallCfg / embedding 任一变化 → exp_id 必变
// AB4  replica 非科学身份：不进 exp_id；同配置双 replica 的 request_id 序列逐位相同、tenant 不同
// AB5  P1（一审，Codex 全空注入反例）：oracle success 的 given-only probe 必须报 success+空
//      attribution，不得伪造 failure
// AB6  P1（一审，Codex wrong-memory 反例）：注入未植入的错误记忆 → 零 credited 零 blamed，
//      任何 attribution 不得引用它
// AB7  P1（一审+二审收紧）：credited 全部命中项 / poison 必 blamed 附 evidence；每条 evidence
//      对【该 probe 已固化的 action.used】校验（不再借道 recallInjected 等价性）
// AB8  P1（一审）：policy 行动只依赖 {given, injected}，ground truth 翻转不改变行动；
//      oracle 的 poison 归因只从 used 派生
// AB9  P1（一审）：reportOutcome ok:false 或 applied:false → runArm 必须抛出
// AB10 P1（二审）：seed/suite 单一入口——runArm 无独立 seed/suite 通道，杂散参数不改变执行；
//      identity 换 seed 则 request_id 全集不相交（幂等键结构性不可复用）；invalid seed
//      fail-closed；identity 的 frozen suite 就是执行定义（换语料池即换执行内容）且不可变
// AB11 P1（二审，Codex partial-response 反例）：attribution 回执精确对账——缺条/冒名
//      memory_id/错 role 一律 fail closed
// AB12 P1（三审）：identity 完整性闭环——factory 返回对象（壳/components/suite）mutation 必
//      TypeError；伪造 identity（旧 exp_id+改 seed / 旧 corpus_digest+换 suite / 域外 seed）
//      必须在任何 tool call 之前被 runArm 拒绝
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { experimentIdentity, runArm, defaultSuite } from './harness.mjs'
import { deterministicPolicy } from './policy.mjs'
import { scoreProbe } from './oracle.mjs'

let pass = 0
const ok = (name) => { pass++; console.log(`  AB ok: ${name}`) }
const sha8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8)

const ID_ARGS = { seed: 42, embeddingId: 'emb-test@v1', recallCfg: { topK: 5, floor: 0.3 } }

// ---------- mock tools ----------
const makeMockTools = ({ injectMode, outcome = {} }) => {
  const state = {
    byEpisode: new Map(),          // episode_id -> [{memory_id, kind}]
    rememberIds: [], rememberContents: [], tenants: new Set(),
    recallOrder: [],               // recall request_id 按发生顺序（与 action 行 1:1 对齐）
    recallInjected: new Map(),     // recall request_id -> Set(memory_id)
    events: [], outcomes: [],
    seq: 0,
  }
  const tools = {
    remember: async ({ principal, kind, content, episode_id, request_id }) => {
      state.tenants.add(principal.tenant_id)
      state.rememberIds.push(request_id)
      state.rememberContents.push(content)
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
      state.recallOrder.push(request_id)
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
      if (status === 'cancelled' && outcome.forcePlasticityOnCancelled) {
        return { ok: true, items: [], plasticity_applied: true }   // AB14 反例：取消却报塑性
      }
      if (status === 'cancelled' && outcome.cancelledMissingField) {
        return { ok: true, items: [] }                             // AB14 反例：字段缺失（三审 P1-1）
      }
      if (status === 'cancelled' && outcome.cancelledNullField) {
        return { ok: true, items: [], plasticity_applied: null }   // AB14 反例：null 冒充 false
      }
      let items = attributions.map(a => ({ memory_id: a.memory_id, role: a.role,
        applied: outcome.failApplied ? false : true }))
      if (outcome.partial) items = items.slice(0, Math.max(0, items.length - 1))
      if (outcome.wrongId && items.length) items = items.map((it, i) => i === 0 ? { ...it, memory_id: 'm-imposter' } : it)
      if (outcome.wrongRole && items.length) items = items.map((it, i) => i === 0
        ? { ...it, role: it.role === 'credited' ? 'blamed' : 'credited' } : it)
      return { ok: true, items, plasticity_applied: items.some(i => i.applied) }
    },
  }
  return { tools, state }
}

const runFull = async ({ injectMode, outcome, replica = null, identity = null, extraArgs = {} }) => {
  const { tools, state } = makeMockTools({ injectMode, outcome })
  const traces = []
  const id = identity ?? experimentIdentity(ID_ARGS)
  const r = await runArm({ arm: 'full', identity: id, tenantBase: 't', tools,
    trace: (_, obj) => traces.push(obj), replica, ...extraArgs })
  return { r, state, traces, identity: id }
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
  ok('AB5 全空注入：oracle success ⇒ outcome success + 空 attribution')
}

// ---------- AB6 Codex wrong-memory 反例 ----------
{
  const { state } = await runFull({ injectMode: 'wrong' })
  const allAttr = state.outcomes.flatMap(o => o.attributions)
  assert.equal(allAttr.length, 0, '未植入的错误记忆不得产生任何 credited/blamed')
  assert.ok(!state.events.some(e => e.payload.memory_id === 'm-wrong'), '不得为 wrong-memory 写 memory_used')
  const staleOut = state.outcomes.filter(o => o.status === 'success')
  assert.ok(staleOut.length >= 3, 'given-only 场景仍应 success（wrong-memory 非 poison）')
  ok('AB6 wrong-memory：零归因，零 evidence，不奖励错误记忆')
}

// ---------- AB7 忠实注入：credited/blamed + evidence ⊆ 冻结的 action.used ----------
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
  // 二审收紧：evidence 对【已固化的 action.used】校验——recall 顺序与 action 行 1:1 对齐，
  // 不再借道 recallInjected（那只在 v1 used=全部注入时才恰好等价，policy 收窄会假绿）
  const actionLines = traces.filter(t => t.t === 'action')
  assert.equal(actionLines.length, state.recallOrder.length, 'full 臂 recall 与 action 必须 1:1')
  for (const e of state.events) {
    const idx = state.recallOrder.indexOf(e.payload.recall_request_id)
    assert.ok(idx >= 0, 'evidence 必须挂在真实 recall 上')
    assert.ok(actionLines[idx].used.includes(sha8(e.payload.memory_id)),
      `evidence ${e.payload.memory_id} 必须 ⊆ 该 probe 固化的 action.used`)
  }
  assert.ok(state.events.length > 0)
  ok('AB7 忠实注入：credited 全命中项 / blamed 毒项，evidence ⊆ 冻结 action.used')
}

// ---------- AB8 policy 纯度 + oracle 只看 used ----------
{
  const injected = [{ memory_id: 'm-1', receipt_item_id: 'ri-1' }, { memory_id: 'm-2', receipt_item_id: 'ri-2' }]
  const a1 = deterministicPolicy({ given: [], injected })
  const a2 = deterministicPolicy({ given: [], injected })
  assert.deepEqual(a1, a2)
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

// ---------- AB9 fail-closed（ok:false / applied:false） ----------
{
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { failOk: true } }),
    /report_outcome.*failed/, 'ok:false 必须抛出')
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { failApplied: true } }),
    /not applied/, 'applied:false 必须抛出')
  ok('AB9 reportOutcome ok:false / applied:false → fail closed')
}

// ---------- AB10 seed/suite 单一入口（二审 P1-1） ----------
{
  // invalid seed fail-closed
  for (const bad of [NaN, 1.5, -1, 2 ** 53, 0x100000000, '42', null, undefined]) {
    assert.throws(() => experimentIdentity({ ...ID_ARGS, seed: bad }), /seed must be a safe integer/,
      `invalid seed 必须拒绝: ${String(bad)}`)
  }
  // 杂散 seed 参数不存在任何通道：显式塞进 runArm 也不改变执行（Codex mismatch 反例的结构性否定）
  const base = await runFull({ injectMode: 'empty' })
  const stray = await runFull({ injectMode: 'empty', extraArgs: { seed: 43, suite: { scenarios: [] } } })
  assert.deepEqual(stray.state.rememberIds, base.state.rememberIds, '杂散 seed/suite 不得改变 request_id 序列')
  assert.deepEqual(stray.state.rememberContents, base.state.rememberContents, '杂散 seed/suite 不得改变任何正文')
  // identity 换 seed → request_id 全集不相交：同键异正文结构性不可能
  const other = await runFull({ injectMode: 'empty', identity: experimentIdentity({ ...ID_ARGS, seed: 43 }) })
  const setA = new Set(base.state.rememberIds)
  assert.ok(other.state.rememberIds.every(id => !setA.has(id)), '不同 seed 身份的 request_id 必须全集不相交')
  // frozen suite 即执行定义：换语料池 → 执行内容真的来自新池，且 exp_id 变
  const marker = 'MARKER-POOL-LINE-单入口判别'
  const customSuite = { ...defaultSuite(), distract_pool: [marker] }
  const customId = experimentIdentity({ ...ID_ARGS, suite: customSuite })
  assert.notEqual(customId.exp_id, base.identity.exp_id)
  const custom = await runFull({ injectMode: 'empty', identity: customId })
  assert.ok(custom.state.rememberContents.some(c => c.includes(marker)), '执行必须使用 identity 携带的 frozen suite')
  assert.ok(!base.state.rememberContents.some(c => c.includes(marker)))
  // frozen：事后改不动
  assert.throws(() => { customId.suite.distract_pool.push('x') }, TypeError, 'identity.suite 必须深冻结')
  assert.throws(() => { customId.suite.scenarios[0].id = 'tamper' }, TypeError, 'scenarios 必须深冻结')
  ok('AB10 seed/suite 单一入口：无旁路通道、异 seed 键不相交、frozen suite 即执行定义')
}

// ---------- AB11 attribution 精确对账（二审 P1-2，Codex partial 反例） ----------
{
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { partial: true } }),
    /attribution receipts/, '缺条回执必须拒绝')
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { wrongId: true } }),
    /unexpected|duplicate/, '冒名 memory_id 回执必须拒绝')
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { wrongRole: true } }),
    /unexpected|duplicate/, '错 role 回执必须拒绝')
  ok('AB11 回执精确对账：缺条/冒名/错 role 一律 fail closed')
}

// ---------- AB12 identity 完整性闭环（三审 P1，Codex mutation/forgery 反例） ----------
{
  const identity = experimentIdentity(ID_ARGS)
  // 冻结：壳、components、suite 全部改不动（Codex 反例的第一半：isFrozen 必须为 true）
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.components) && Object.isFrozen(identity.suite),
    'identity 返回对象必须整体冻结')
  assert.throws(() => { identity.components.seed = 43 }, TypeError, 'components mutation 必须 TypeError')
  assert.throws(() => { identity.suite = { scenarios: [] } }, TypeError, 'suite 替换必须 TypeError')
  assert.throws(() => { identity.exp_id = 'forged' }, TypeError, 'exp_id 改写必须 TypeError')

  // 伪造路径（structuredClone 剥掉冻结，模拟绕过 factory 的手搓对象）——
  // 必须在任何 tool call 之前拒绝：mock 记录调用数，断言恒为零
  const rejectForged = async (mutate, pattern, name) => {
    const forged = structuredClone(identity)
    mutate(forged)
    const { tools, state } = makeMockTools({ injectMode: 'empty' })
    await assert.rejects(
      () => runArm({ arm: 'full', identity: forged, tenantBase: 't', tools, trace: () => {} }),
      pattern, name)
    assert.equal(state.rememberIds.length + state.recallOrder.length + state.events.length + state.outcomes.length, 0,
      `${name}：拒绝必须发生在任何 tool call 之前`)
  }
  await rejectForged(f => { f.components.seed = 43 }, /exp_id mismatch/, '旧 exp_id + 改 seed 必须拒绝')
  await rejectForged(f => { f.suite = structuredClone(experimentIdentity({ ...ID_ARGS, suite: { ...defaultSuite(), distract_pool: ['换池'] } }).suite) },
    /corpus_digest mismatch/, '旧 corpus_digest + 换 suite 必须拒绝')
  await rejectForged(f => { f.components.seed = NaN }, /seed out of domain/, '域外 seed 必须拒绝')
  await rejectForged(f => { delete f.components }, /missing/, '缺 components 的裸对象必须拒绝')
  // 合法 factory identity 照常通过（回归保护）
  const { tools } = makeMockTools({ injectMode: 'empty' })
  await runArm({ arm: 'full', identity, tenantBase: 't', tools, trace: () => {} })
  ok('AB12 identity 完整性：mutation 即 TypeError，伪造对象在任何 tool call 前拒绝')
}

// ---------- AB13 分组报表 + fixture 前置验证（v4 预审口径） ----------
{
  const { groupReport, verifyFixtures } = await import('./report.mjs')
  const armResult = { scenarios: [
    { scenario: 's-m1', group: 'main', probes: [{ score: 1, task_success: true }, { score: 0, task_success: false }] },
    { scenario: 's-m2', group: 'main', probes: [{ score: 1, task_success: true }] },
    { scenario: 's-c1', group: 'control', probes: [{ score: 1, task_success: true }] },
    { scenario: 's-c2', group: 'control', probes: [{ score: 0, task_success: false }] },
    // 断言 probe 语义：设置期 miss 不算 control 失效，pass 只看 control_probe 标记的
    { scenario: 's-c3', group: 'control', probes: [
      { score: 0, task_success: false },
      { score: 1, task_success: true, control_probe: true }] },
    { scenario: 's-d1', group: 'diagnostic', probes: [{ score: 0.7143, task_success: true, budget_normalized: 1 }] },
  ] }
  const g = groupReport(armResult)
  assert.equal(g.main.n, 3); assert.equal(g.main.score, 0.6667)
  assert.deepEqual(g.controls.map(c => c.pass), [true, false, true], 'controls pass-fail：无标记看全 probes，有标记只看断言 probe')
  assert.deepEqual(g.diagnostics[0].budget_normalized, [1], 'diagnostic 带 budget-normalized')
  assert.equal(g.reference_overall.n, 8)
  // invalid_fixture 排除出分组统计（s-m1 两 probes 被剔除）
  const g2 = groupReport(armResult, new Set(['s-m1']))
  assert.equal(g2.main.n, 1); assert.equal(g2.main.score, 1)
  assert.equal(g2.reference_overall.n, 6)
  // fixture 前置（三审 P1-3 fail-closed 版）：期望集合来自 suite；
  // vector 目标必须【在候选、injected===false、numeric rank>=6】——缺任何一环即 invalid
  const vLine = (sc, targets) => ({ t: 'receipt_probe', sc, precondition: 'contention', targets })
  const EXP = ['sc-credited-plasticity', 'sc-cancelled-null']
  const goodVec = (sc, fact) => vLine(sc, [{ fact, injected: false, rank: 7 }])
  const goodFull = (sc, fact, util) => vLine(sc, [{ fact, injected: sc === 'sc-credited-plasticity', rank: 5, util }])
  // 干净基线：零误报 + 翻转记录齐全
  const fxClean = verifyFixtures({ expected: EXP,
    vector: [goodVec('sc-credited-plasticity', 'ut-target'), goodVec('sc-cancelled-null', 'cn-target')],
    full: [goodFull('sc-credited-plasticity', 'ut-target'), goodFull('sc-cancelled-null', 'cn-target', 0.5)] })
  assert.deepEqual(fxClean.invalid, []); assert.deepEqual(fxClean.violations, [])
  assert.equal(fxClean.flips['sc-credited-plasticity'].vector.injected, false)
  assert.equal(fxClean.flips['sc-credited-plasticity'].full.injected, true, '坑位证明=injected 翻转配合 rank')
  // 违例：cancelled 目标 utility≠0.5 ⇒ violation（前置成立时才判）
  const fxViol = verifyFixtures({ expected: EXP,
    vector: [goodVec('sc-credited-plasticity', 'ut-target'), goodVec('sc-cancelled-null', 'cn-target')],
    full: [goodFull('sc-credited-plasticity', 'ut-target'), goodFull('sc-cancelled-null', 'cn-target', 0.75)] })
  assert.equal(fxViol.violations.length, 1)
  assert.equal(fxViol.violations[0].kind, 'cancelled-target-utility-changed')
  // 六类 fail-closed 反例（Codex 三审点名五类 + injected=true）：全部必须 invalid
  const cases = [
    ['缺整条 vector trace', { vector: [], full: [goodFull('sc-credited-plasticity', 'ut-target')] }],
    ['缺 full trace', { vector: [goodVec('sc-credited-plasticity', 'ut-target')], full: [] }],
    ['空 receipt（targets 全 absent）', { vector: [vLine('sc-credited-plasticity', [{ fact: 'ut-target', absent: true }])], full: [goodFull('sc-credited-plasticity', 'ut-target')] }],
    ['rank null', { vector: [vLine('sc-credited-plasticity', [{ fact: 'ut-target', injected: false, rank: null }])], full: [goodFull('sc-credited-plasticity', 'ut-target')] }],
    ['rank 5（在席内）', { vector: [vLine('sc-credited-plasticity', [{ fact: 'ut-target', injected: false, rank: 5 }])], full: [goodFull('sc-credited-plasticity', 'ut-target')] }],
    ['injected true', { vector: [vLine('sc-credited-plasticity', [{ fact: 'ut-target', injected: true, rank: 7 }])], full: [goodFull('sc-credited-plasticity', 'ut-target')] }],
  ]
  for (const [name, input] of cases) {
    const r = verifyFixtures({ expected: ['sc-credited-plasticity'], ...input })
    assert.ok(r.invalid.includes('sc-credited-plasticity'), `${name} 必须判 invalid_fixture`)
  }
  ok('AB13 分组报表口径 + invalid_fixture fail-closed 六反例 + matched control 断言')
}

// ---------- AB14 v4 ack 两解释：paraphrase 冻结判据可机械复算 + cancelled 塑性 fail-closed ----------
{
  const { paraphraseDisjoint, SCENARIOS } = await import('./tasks.mjs')
  // 判据本身：当前 fixture 必须满足零共享 CJK 双字（机械复算，不靠标题自述）
  const para = SCENARIOS.find(s => s.id === 'sc-paraphrase')
  const fact = para.steps.find(s => s.op === 'plant').facts[0].text
  const probe = para.steps.find(s => s.op === 'probe').query
  assert.equal(paraphraseDisjoint(fact, probe), true, 'paraphrase fixture 必须满足冻结判据')
  assert.equal(paraphraseDisjoint('客户回访记录', '汇总客户档案'), false, '共享"客户"双字必须判否')
  assert.equal(paraphraseDisjoint('abc 记录', 'ABC 档案'), true, '非 CJK 字符不参与判定')
  // 判据版本进 corpus digest：换版本必须换 exp_id
  const base = experimentIdentity(ID_ARGS)
  const other = experimentIdentity({ ...ID_ARGS, suite: { ...defaultSuite(), paraphrase_criterion: 'other-v2' } })
  assert.notEqual(base.exp_id, other.exp_id, '判据版本变化必须换实验身份')
  // cancelled 塑性 fail-closed（三审 P1-1 严格化）：true/缺字段/null 三类都必须抛出——
  // 只有恒等 false + 空数组 items 放行
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { forcePlasticityOnCancelled: true } }),
    /plasticity must not apply/, 'plasticity_applied=true 必须 fail closed')
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { cancelledMissingField: true } }),
    /plasticity must not apply/, '字段缺失必须 fail closed（undefined!==false）')
  await assert.rejects(() => runFull({ injectMode: 'faithful', outcome: { cancelledNullField: true } }),
    /plasticity must not apply/, 'null 必须 fail closed')
  ok('AB14 paraphrase 判据机械复算+入 digest；cancelled 塑性三反例 fail-closed')
}

console.log(`AB harness 判别 ${pass}/14 全绿`)
