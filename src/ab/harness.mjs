// P0-12 三臂 A/B harness（预审修订版）。口径：`model: null, agent_policy: deterministic-v1`，
// 指标 = injection hit / lifecycle ablation（不冒充生成质量）。
// 预审 P1 修订：
//   P1-1 outcome 由 oracle 派生——task_success 才 report success + credited（只 credit 实际
//        required 命中项）；miss 报 failure 且【零 attribution】（照单存档零塑性），
//        不用 injected[0] fallback 伪造因果。
//   P1-2 canonical experiment identity = sha256(suite_version | corpus_digest | seed |
//        embedding_identity | recall_cfg_digest)——tenant 与全部请求 ID 从它派生；
//        换 seed/语料/embedding/top-k 即新身份新 tenant，绝不撞旧幂等键。
//        身份组件写进 summary 与 trace header。
// 硬闸：全链零 viz 依赖。
import { createHash } from 'node:crypto'
import { SCENARIOS, SUITE_VERSION, seededRng, distractText } from './tasks.mjs'
import { scoreProbe } from './oracle.mjs'

export const ARMS = ['no-memory', 'vector-only', 'full']

const sha = (s) => createHash('sha256').update(s).digest('hex')
const sha8 = (s) => sha(s).slice(0, 8)

// canonical experiment identity（预审 P1-2）
export const experimentIdentity = ({ seed, embeddingId, recallCfg }) => {
  const corpusDigest = sha(JSON.stringify(SCENARIOS))
  const recallDigest = sha(JSON.stringify(recallCfg))
  const components = {
    suite_version: SUITE_VERSION,
    corpus_digest: corpusDigest.slice(0, 16),
    seed,
    embedding_identity: embeddingId,
    recall_cfg_digest: recallDigest.slice(0, 16),
    agent_policy: 'deterministic-v1',
    model: null,
  }
  const exp_id = sha(JSON.stringify(components)).slice(0, 12)
  return { exp_id, components }
}

const didFactory = (expId, arm) => (label) => {
  const h = sha(`ab|${expId}|${arm}|${label}`)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export const runArm = async ({ arm, identity, tenantBase, tools, seed, trace }) => {
  const did = didFactory(identity.exp_id, arm)
  const rng = seededRng(seed)
  const principal = { tenant_id: `${tenantBase}-${identity.exp_id}-${arm}`, agent_id: 'ab-agent', capabilities: [] }
  trace(arm, { t: 'header', identity: identity.components, exp_id: identity.exp_id, arm })
  const factOfMap = new Map()          // memory_id -> fact_id（oracle 判分的外部 fixture map）
  const poisonIds = new Set()
  const results = []
  let distractSeq = 0

  for (const sc of SCENARIOS) {
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
          if (!r.ok) throw new Error(`remember failed: ${JSON.stringify(r)}`)
          factOfMap.set(r.memory_id, f.id)
          trace(arm, { t: 'plant', sc: sc.id, fact: f.id, poison: !!f.poison, memory: sha8(r.memory_id) })
        }
      } else if (step.op === 'distract') {
        if (arm === 'no-memory') continue
        for (let i = 0; i < step.count; i++) {
          const txt = distractText(rng, ++distractSeq)
          const r = await tools.remember({ principal, content: txt, kind: 'observation',
            episode_id: `ab-noise`, request_id: did(`noise-${tag}-${i}`), importance: 0.4 })
          if (!r.ok) throw new Error('distract remember failed')
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
          if (!rec.ok) throw new Error(`recall failed: ${JSON.stringify(rec)}`)
          receipt = rec.receipt
          const itemByMem = new Map(rec.receipt.items.filter(i => i.injected).map(i => [i.memory_id, i]))
          injected = (rec.injected?.events ?? []).filter(e => e.injected !== false && itemByMem.has(e.memory_id))
            .map(e => ({ memory_id: e.memory_id, receipt_item_id: itemByMem.get(e.memory_id).receipt_item_id }))
        }
        const verdict = scoreProbe({
          injected, required: step.required ?? [], given: step.given ?? [],
          expectAbstain: !!step.expect_abstain, poisonIds, factOf: (id) => factOfMap.get(id),
        })
        scResult.probes.push({ probe: probeSeq, query_hash: sha8(step.query), ...verdict, hit_ids: undefined })
        trace(arm, { t: 'probe', sc: sc.id, probe: probeSeq, query_hash: sha8(step.query),
          injected: injected.map(i => sha8(i.memory_id)), hit: verdict.hit, required: verdict.required,
          poison_hit: verdict.poison_hit, task_success: verdict.task_success, score: verdict.score })
        // full 臂塑性：严格由 oracle 派生（预审 P1-1）
        if (arm === 'full' && step.outcome && arm !== 'no-memory') {
          if (verdict.task_success && verdict.hit_ids.length) {
            const target = injected.find(i => i.memory_id === verdict.hit_ids[0])
            const ev = await tools.logEvent({ principal, episode_id: `ab-${sc.id}`, task_instance_id: task,
              attempt_id: attempt, event_type: 'memory_used', request_id: did(`evt-${tag}`),
              payload: { recall_request_id: receipt.request_id, receipt_item_id: target.receipt_item_id, memory_id: target.memory_id } })
            if (!ev.ok) throw new Error(`log_event failed: ${JSON.stringify(ev)}`)
            const out = await tools.reportOutcome({ principal, outcome_request_id: did(`out-${tag}`),
              episode_id: `ab-${sc.id}`, task_instance_id: task, attempt_id: attempt, status: 'success',
              attributions: [{ recall_request_id: receipt.request_id, receipt_item_id: target.receipt_item_id,
                memory_id: target.memory_id, role: 'credited', evidence_event_id: ev.event_id }] })
            trace(arm, { t: 'outcome', sc: sc.id, probe: probeSeq, status: 'success', role: 'credited',
              applied: out.ok ? out.items?.[0]?.applied === true : false })
          } else if (receipt && verdict.poison_hit) {
            // poison 命中 = deterministic policy【明确使用了错误记忆】的可审计场景（预审留门）：
            // 对被使用的毒记忆 memory_used + blamed——这是 full 臂压掉过期记忆的合法证据链
            const poison = injected.find(i => {
              const fid = factOfMap.get(i.memory_id)
              return fid && poisonIds.has(fid)
            })
            const ev = await tools.logEvent({ principal, episode_id: `ab-${sc.id}`, task_instance_id: task,
              attempt_id: attempt, event_type: 'memory_used', request_id: did(`evt-${tag}`),
              payload: { recall_request_id: receipt.request_id, receipt_item_id: poison.receipt_item_id, memory_id: poison.memory_id } })
            if (!ev.ok) throw new Error(`log_event(poison) failed: ${JSON.stringify(ev)}`)
            const out = await tools.reportOutcome({ principal, outcome_request_id: did(`out-${tag}`),
              episode_id: `ab-${sc.id}`, task_instance_id: task, attempt_id: attempt, status: 'failure',
              attributions: [{ recall_request_id: receipt.request_id, receipt_item_id: poison.receipt_item_id,
                memory_id: poison.memory_id, role: 'blamed', evidence_event_id: ev.event_id }] })
            trace(arm, { t: 'outcome', sc: sc.id, probe: probeSeq, status: 'failure', role: 'blamed',
              target: 'poison', applied: out.ok ? out.items?.[0]?.applied === true : false })
          } else if (receipt) {
            // 普通 miss：failure 照单存档，【零 attribution】——deterministic policy 无法证明
            // "使用了某条错误记忆"，不伪造因果（预审 P1-1）
            const out = await tools.reportOutcome({ principal, outcome_request_id: did(`out-${tag}`),
              episode_id: `ab-${sc.id}`, task_instance_id: task, attempt_id: attempt, status: 'failure', attributions: [] })
            trace(arm, { t: 'outcome', sc: sc.id, probe: probeSeq, status: 'failure', role: null, applied: false, ok: out.ok })
          }
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
