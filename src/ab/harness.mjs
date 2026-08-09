// P0-12 三臂 A/B harness（二审修订版）。口径：`model: null, agent_policy: deterministic-v1`，
// 指标 = injection hit / lifecycle ablation（不冒充生成质量）。
// 二审修订：
//   P1-1 seed/suite 单一入口：experimentIdentity 校验 seed（有限安全整数 ∈ [0, 2^32-1]）并
//        返回 deep-frozen suite；runArm 不再接收独立 seed/suite——RNG 只读
//        identity.components.seed，场景与干扰语料只读 identity.suite。
//        结构性消灭"identity 锁 seed=42 而执行跑 seed=43"的同幂等键异正文形态。
//   P1-2 attribution 精确对账：assertApplied 断言回执条数 === 期望条数、
//        (memory_id, role) 多重集精确相等、每项 applied===true——partial response fail closed。
// 一审既有（保持）：outcome 四路穷尽由 task_success 派生；policy 先行动、oracle 后判分、
//   evidence ⊆ 声明的 used；corpus_digest 覆盖完整 canonical suite。
// 硬闸：全链零 viz 依赖。
import { createHash } from 'node:crypto'
import { SCENARIOS, SUITE_VERSION, DISTRACT_POOL, DISTRACT_GENERATOR_VERSION, seededRng, distractText } from './tasks.mjs'
import { deterministicPolicy, POLICY_VERSION } from './policy.mjs'
import { scoreProbe } from './oracle.mjs'

export const ARMS = ['no-memory', 'vector-only', 'full']

const sha = (s) => createHash('sha256').update(s).digest('hex')
const sha8 = (s) => sha(s).slice(0, 8)

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

export const defaultSuite = () => ({
  scenarios: SCENARIOS,
  distract_pool: DISTRACT_POOL,
  distract_generator: DISTRACT_GENERATOR_VERSION,
  policy: POLICY_VERSION,
})

// canonical experiment identity（一审 P1-3 + 二审 P1-1）：
// suite 全量 hash；返回的 frozen suite 就是唯一可执行定义——hash 与执行不可能分叉。
export const experimentIdentity = ({ seed, embeddingId, recallCfg, suite = defaultSuite() }) => {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) {
    throw new Error(`seed must be a safe integer in [0, 4294967295], got: ${seed}`)
  }
  const frozenSuite = deepFreeze(structuredClone(suite))
  const corpusDigest = sha(JSON.stringify(frozenSuite))
  const recallDigest = sha(JSON.stringify(recallCfg))
  const components = {
    suite_version: SUITE_VERSION,
    corpus_digest: corpusDigest.slice(0, 16),
    seed,
    embedding_identity: embeddingId,
    recall_cfg_digest: recallDigest.slice(0, 16),
    agent_policy: POLICY_VERSION,
    model: null,
  }
  const exp_id = sha(JSON.stringify(components)).slice(0, 12)
  return { exp_id, components, suite: frozenSuite }
}

const didFactory = (expId, arm) => (label) => {
  const h = sha(`ab|${expId}|${arm}|${label}`)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const assertOk = (r, what) => {
  if (!r || r.ok !== true) throw new Error(`${what} failed: ${JSON.stringify(r)}`)
  return r
}

// 塑性分支精确对账（二审 P1-2）：期望的每条 attribution 都必须有 applied===true 的回执，
// 条数相等且 (memory_id, role) 多重集精确相等——partial/错位/冒名回执一律 fail closed。
const assertApplied = (out, attributions, what) => {
  const items = out.items ?? []
  if (items.length !== attributions.length) {
    throw new Error(`${what}: expected ${attributions.length} attribution receipts, got ${items.length}: ${JSON.stringify(out)}`)
  }
  const expect = new Map()
  for (const a of attributions) {
    const k = `${a.memory_id}|${a.role}`
    expect.set(k, (expect.get(k) ?? 0) + 1)
  }
  for (const it of items) {
    if (it.applied !== true) throw new Error(`${what}: attribution not applied: ${JSON.stringify(it)}`)
    const k = `${it.memory_id}|${it.role}`
    const n = expect.get(k) ?? 0
    if (n <= 0) throw new Error(`${what}: unexpected/duplicate receipt ${k}: ${JSON.stringify(out)}`)
    expect.set(k, n - 1)
  }
  return out
}

// 二审 P1-1：runArm 不接收 seed/suite——一切从 identity 派生（单一入口）
export const runArm = async ({ arm, identity, tenantBase, tools, trace, replica = null }) => {
  const did = didFactory(identity.exp_id, arm)
  const rng = seededRng(identity.components.seed)
  const suite = identity.suite
  const tenantId = [tenantBase, identity.exp_id, ...(replica ? [replica] : []), arm].join('-')
  const principal = { tenant_id: tenantId, agent_id: 'ab-agent', capabilities: [] }
  trace(arm, { t: 'header', identity: identity.components, exp_id: identity.exp_id, arm,
    replica: replica ?? null, replica_note: replica ? 'non-scientific tenant namespace, not part of exp_id' : undefined })
  const factOfMap = new Map()          // memory_id -> fact_id（oracle 判分的外部 fixture map）
  const poisonIds = new Set()
  const results = []
  let distractSeq = 0

  for (const sc of suite.scenarios) {
    const scResult = { scenario: sc.id, probes: [] }
    let probeSeq = 0
    for (const [si, step] of sc.steps.entries()) {
      const tag = `${sc.id}-s${si}`
      if (step.op === 'plant') {
        for (const f of step.facts) {
          if (f.poison) poisonIds.add(f.id)
          if (arm === 'no-memory') continue
          const r = await tools.remember({ principal, content: f.text, kind: 'fact',
            episode_id: `ab-${sc.id}`, request_id: did(`rem-${tag}-${f.id}`), importance: f.importance })
          assertOk(r, `remember(${f.id})`)
          factOfMap.set(r.memory_id, f.id)
          trace(arm, { t: 'plant', sc: sc.id, fact: f.id, poison: !!f.poison, memory: sha8(r.memory_id) })
        }
      } else if (step.op === 'distract') {
        if (arm === 'no-memory') continue
        for (let i = 0; i < step.count; i++) {
          const txt = distractText(rng, ++distractSeq, suite.distract_pool)
          const r = await tools.remember({ principal, content: txt, kind: 'observation',
            episode_id: `ab-noise`, request_id: did(`noise-${tag}-${i}`), importance: 0.4 })
          assertOk(r, 'distract remember')
        }
        trace(arm, { t: 'distract', sc: sc.id, n: step.count })
      } else if (step.op === 'probe') {
        probeSeq++
        const attempt = did(`att-${tag}`), task = did(`task-${tag}`)
        let injected = []
        let receipt = null
        if (arm !== 'no-memory') {
          const rec = await tools.recall({ principal, query: step.query, purpose: 'ab-probe',
            episode_id: `ab-${sc.id}`, attempt_id: attempt, request_id: did(`rec-${tag}`) })
          assertOk(rec, 'recall')
          receipt = rec.receipt
          const itemByMem = new Map(rec.receipt.items.filter(i => i.injected).map(i => [i.memory_id, i]))
          injected = (rec.injected?.events ?? []).filter(e => e.injected !== false && itemByMem.has(e.memory_id))
            .map(e => ({ memory_id: e.memory_id, receipt_item_id: itemByMem.get(e.memory_id).receipt_item_id }))
        }
        const receiptItemOf = new Map(injected.map(i => [i.memory_id, i.receipt_item_id]))

        // ① policy 行动（看不见 required/poison ground truth），先固化进 trace（一审 P1-2）
        const action = deterministicPolicy({ given: step.given ?? [], injected })
        trace(arm, { t: 'action', sc: sc.id, probe: probeSeq, policy: action.policy,
          used: action.used_memory_ids.map(sha8), abstained: action.abstained })

        // ② oracle 对行动判分（fixture 标签只在这里出现）
        const verdict = scoreProbe({
          action, required: step.required ?? [], given: step.given ?? [],
          expectAbstain: !!step.expect_abstain, poisonIds, factOf: (id) => factOfMap.get(id),
        })
        scResult.probes.push({ probe: probeSeq, query_hash: sha8(step.query), ...verdict,
          hit_ids: undefined, poison_ids: undefined })
        trace(arm, { t: 'probe', sc: sc.id, probe: probeSeq, query_hash: sha8(step.query),
          injected: injected.map(i => sha8(i.memory_id)), hit: verdict.hit, required: verdict.required,
          poison_hit: verdict.poison_hit, task_success: verdict.task_success, score: verdict.score })

        // ③ full 臂塑性：status 只由 task_success 派生，四路穷尽（一审 P1-1）；
        //    evidence 只为 policy 声明的 used IDs 书写（hit_ids/poison_ids ⊆ used）
        if (arm === 'full' && step.outcome) {
          const usedEvidence = async (memoryId, seq) => {
            const ev = await tools.logEvent({ principal, episode_id: `ab-${sc.id}`, task_instance_id: task,
              attempt_id: attempt, event_type: 'memory_used', request_id: did(`evt-${tag}-${seq}`),
              payload: { recall_request_id: receipt.request_id, receipt_item_id: receiptItemOf.get(memoryId), memory_id: memoryId } })
            assertOk(ev, `log_event(${seq})`)
            return ev.event_id
          }
          const attributionsFor = async (memoryIds, role) => {
            const out = []
            for (const [i, memoryId] of memoryIds.entries()) {
              const evidenceId = await usedEvidence(memoryId, `${role}-${i}`)
              out.push({ recall_request_id: receipt.request_id, receipt_item_id: receiptItemOf.get(memoryId),
                memory_id: memoryId, role, evidence_event_id: evidenceId })
            }
            return out
          }
          let status, attributions
          if (verdict.task_success) {
            status = 'success'
            attributions = verdict.hit_ids.length ? await attributionsFor(verdict.hit_ids, 'credited') : []
          } else {
            status = 'failure'
            attributions = verdict.poison_ids.length ? await attributionsFor(verdict.poison_ids, 'blamed') : []
          }
          const out = await tools.reportOutcome({ principal, outcome_request_id: did(`out-${tag}`),
            episode_id: `ab-${sc.id}`, task_instance_id: task, attempt_id: attempt, status, attributions })
          assertOk(out, `report_outcome(${status})`)
          if (attributions.length) assertApplied(out, attributions, `report_outcome(${status})`)
          trace(arm, { t: 'outcome', sc: sc.id, probe: probeSeq, status,
            roles: attributions.map(a => a.role), n_attributions: attributions.length,
            applied: attributions.length ? true : null })
        }
      } else if (step.op === 'wait_decay') {
        trace(arm, { t: 'wait_decay', sc: sc.id, hours: step.hours, note: 'logical-time-only, no clock forgery' })
      }
    }
    results.push(scResult)
  }
  const probes = results.flatMap(r => r.probes)
  const score = probes.length ? probes.reduce((a, p) => a + p.score, 0) / probes.length : 0
  const successRate = probes.length ? probes.filter(p => p.task_success).length / probes.length : 0
  return { arm, score: +score.toFixed(4), task_success_rate: +successRate.toFixed(4), probes: probes.length, scenarios: results }
}
