// P0-12 三臂 A/B harness（冻结契约 + Codex 硬闸）：
//   三臂同任务/同 seed/同 embedding/同 top-k/同预算；各臂独立 tenant；
//   外部确定性 oracle 判分（见 oracle.mjs）；公开 trace 为 content-free（哨兵 ID + 哈希）。
//   硬闸：任何 viz/半径/环带/截图/交互都不进指标与 oracle 输入——本模块零 viz 依赖。
// 臂定义（"vector-only 必须与 full 同 embedding/top-k/模型，只关 outcome plasticity、
// dream/reflection、生命周期重排"——PLAN 特别注意条原文）：
//   no-memory   ：remember/recall 全跳过（agent 只有当前任务文本）
//   vector-only ：remember + recall 原路径；不 report_outcome（零塑性）、不跑 nightly
//   full        ：remember + recall + memory_used + report_outcome + （后续版）nightly
import { randomUUID, createHash } from 'node:crypto'
import { SCENARIOS, seededRng, distractText } from './tasks.mjs'
import { scoreProbe } from './oracle.mjs'

export const ARMS = ['no-memory', 'vector-only', 'full']

const sha8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8)

// 确定性 ID：同 run-key 同臂同步骤 → 同请求 ID（崩溃重跑走幂等 replay，demo-refresh 同法）
const didFactory = (runKey, arm) => (label) => {
  const h = createHash('sha256').update(`ab|${runKey}|${arm}|${label}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export const runArm = async ({ arm, runKey, tenantBase, tools, seed, trace }) => {
  const did = didFactory(runKey, arm)
  const rng = seededRng(seed)
  const principal = { tenant_id: `${tenantBase}-${arm}`, agent_id: 'ab-agent', capabilities: [] }
  const results = []
  let distractSeq = 0

  for (const sc of SCENARIOS) {
    const scResult = { scenario: sc.id, probes: [] }
    let probeSeq = 0
    for (const [si, step] of sc.steps.entries()) {
      const tag = `${sc.id}-s${si}`
      if (step.op === 'plant') {
        if (arm === 'no-memory') { trace(arm, { t: 'plant-skipped', sc: sc.id, n: step.facts.length }); continue }
        for (const f of step.facts) {
          const r = await tools.remember({ principal, content: f.text, kind: 'fact',
            episode_id: `ab-${sc.id}`, request_id: did(`rem-${tag}-${f.id}`), importance: f.importance })
          if (!r.ok) throw new Error(`remember failed: ${JSON.stringify(r)}`)
          trace(arm, { t: 'plant', sc: sc.id, fact: f.id, memory: sha8(r.memory_id) })
        }
      } else if (step.op === 'distract') {
        if (arm === 'no-memory') continue
        for (let i = 0; i < step.count; i++) {
          const txt = distractText(rng, ++distractSeq)
          const r = await tools.remember({ principal, content: txt, kind: 'observation',
            episode_id: `ab-noise`, request_id: did(`noise-${tag}-${i}`), importance: 0.4 })
          if (!r.ok) throw new Error(`distract remember failed`)
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
          // 注入正文在 rec.injected.events（agent 面数据）；receipt items 是 content-free，
          // 只用来配 receipt_item_id（证据链需要）——两路按 memory_id 合并
          const itemByMem = new Map(rec.receipt.items.filter(i => i.injected).map(i => [i.memory_id, i]))
          injected = (rec.injected?.events ?? []).filter(e => e.injected !== false && itemByMem.has(e.memory_id))
            .map(e => ({ memory_id: e.memory_id, content: e.content, receipt_item_id: itemByMem.get(e.memory_id).receipt_item_id }))
        }
        // 确定性 agent："使用"注入集合作答——oracle 按哨兵匹配判分（外部、零自评）
        const verdict = await scoreProbe({ injected, required: step.required, tools, principal })
        scResult.probes.push({ probe: probeSeq, query_hash: sha8(step.query), ...verdict })
        trace(arm, { t: 'probe', sc: sc.id, probe: probeSeq, query_hash: sha8(step.query),
          injected: injected.map(i => sha8(i.memory_id)), hit: verdict.hit, required: verdict.required, score: verdict.score })
        // full 臂：结果门控塑性（证据链走正常工具路径；vector-only 按契约不做）
        if (arm === 'full' && step.outcome && injected.length) {
          const hitItems = injected.filter(i => verdict.hit_ids.includes(i.memory_id))
          const target = hitItems[0] ?? injected[0]
          const role = step.outcome === 'success' ? 'credited' : 'blamed'
          const ev = await tools.logEvent({ principal, episode_id: `ab-${sc.id}`, task_instance_id: task,
            attempt_id: attempt, event_type: 'memory_used', request_id: did(`evt-${tag}`),
            payload: { recall_request_id: receipt.request_id, receipt_item_id: target.receipt_item_id, memory_id: target.memory_id } })
          if (ev.ok) {
            const out = await tools.reportOutcome({ principal, outcome_request_id: did(`out-${tag}`),
              episode_id: `ab-${sc.id}`, task_instance_id: task, attempt_id: attempt, status: step.outcome === 'success' ? 'success' : 'failure',
              attributions: [{ recall_request_id: receipt.request_id, receipt_item_id: target.receipt_item_id,
                memory_id: target.memory_id, role, evidence_event_id: ev.event_id }] })
            trace(arm, { t: 'outcome', sc: sc.id, probe: probeSeq, role, applied: out.ok ? out.items?.[0]?.applied : false })
          }
        }
      } else if (step.op === 'wait_decay') {
        trace(arm, { t: 'wait_decay', sc: sc.id, hours: step.hours, note: 'logical-time-only, no clock forgery' })
      }
    }
    results.push(scResult)
  }
  // 臂级汇总：probe 平均分（oracle 产出的确定性分）
  const probes = results.flatMap(r => r.probes)
  const score = probes.length ? probes.reduce((a, p) => a + p.score, 0) / probes.length : 0
  return { arm, score: +score.toFixed(4), probes: probes.length, scenarios: results }
}
