// Judge Demo as a callable module: one implementation shared by the CLI
// (scripts/judge-demo.mjs) and the HTTP trigger, so the proof a judge clicks
// and the proof we run locally can never drift apart.
//
// Everything here goes through the real tools, the real database, the real
// vector retrieval and the real outcome API. The data is seeded and labelled
// as such; the path is production.
//
// Spam safety without rate-limit infrastructure: the run key is derived from a
// time bucket, and every write is idempotent under that key. Clicking the
// button ten times inside one window replays the same run and creates no extra
// rows; the next window produces a genuinely new proof.
import { createHash } from 'node:crypto'
import { inSerializableTx } from '../lib/db.mjs'
import { rememberTool } from '../tools/remember.mjs'
import { recallTool } from '../tools/recall.mjs'
import { logEventTool } from '../tools/log-event.mjs'
import { reportOutcomeTool } from '../tools/report-outcome.mjs'

export const JUDGE_CFG = Object.freeze({
  // Server-chosen demo identity: the caller never picks where writes land.
  tenant_id: 'demo-tenant',
  agent_id: 'judge-demo',
  bucket_ms: 5 * 60 * 1000,
  query: 'What is required before closing a large refund ticket?',
})

// The six persisted fields that decide whether a memory really changed.
export const PERSISTED_FIELDS = ['credited_success_count', 'evidenced_blame_count',
  'strength_anchor', 'strength_anchor_at', 'last_rewarded_at', 'revision']

export const CORPUS = [
  { label: 'target', kind: 'fact',
    text: 'Escalation policy 2026-08: refunds above 500 USD require a supervisor signature before the ticket is closed.' },
  { label: 'control', kind: 'fact',
    text: 'Office logistics 2026-08: the printer on floor 3 was replaced and now needs the new driver bundle.' },
]

export const bucketRunKey = (nowMs, bucketMs = JUDGE_CFG.bucket_ms) =>
  `judge-${Math.floor(nowMs / bucketMs)}`

const idFactory = (tenant, agent, runKey) => (label) => {
  const h = createHash('sha256').update(`${tenant}|${agent}|${runKey}|${label}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const diffRow = (before, after) => PERSISTED_FIELDS
  .filter(f => before?.[f] !== after?.[f])
  .map(f => ({ field: f, before: before?.[f] ?? null, after: after?.[f] ?? null }))

export const runJudgeDemo = async ({
  tenantId = JUDGE_CFG.tenant_id,
  agentId = JUDGE_CFG.agent_id,
  runKey = bucketRunKey(Date.now()),
  onStep,
} = {}) => {
  const principal = { tenant_id: tenantId, agent_id: agentId, capabilities: ['memory:pin'] }
  const did = idFactory(tenantId, agentId, runKey)
  const steps = []
  const emit = (n, title, data = {}) => {
    const entry = { step: n, title, ...data }
    steps.push(entry)
    onStep?.(entry)
    return entry
  }
  const need = (label, r) => {
    if (!r?.ok) throw Object.assign(new Error(`judge_step_failed:${label}`), { detail: r })
    return r
  }
  const snapshot = (ids) => inSerializableTx(async (c) => {
    const { rows } = await c.query(
      `SELECT memory_id, ${PERSISTED_FIELDS.join(', ')} FROM memories
       WHERE tenant_id=$1 AND agent_id=$2 AND memory_id = ANY($3::UUID[])`,
      [tenantId, agentId, ids])
    return Object.fromEntries(rows.map(r => [r.memory_id,
      Object.fromEntries(PERSISTED_FIELDS.map(f => [f, String(r[f])]))]))
  }, 'judge-snapshot')

  // 1. remember
  const memories = {}
  for (const item of CORPUS) {
    const r = need(`remember:${item.label}`, await rememberTool({
      principal, content: item.text, kind: item.kind, episode_id: `judge-${runKey}`,
      request_id: did(`rem-${item.label}`), importance: 0.6,
    }))
    memories[item.label] = r.memory_id
  }
  const ids = Object.values(memories)
  const baseline = await snapshot(ids)
  // Replay detection. Every write here is idempotent under the run key, so a
  // second click inside the same window returns the original results without
  // re-applying plasticity. That is correct system behaviour, and it proves a
  // different property worth showing a judge: a repeated terminal outcome does
  // not double-credit. The assertions below branch on which run this is.
  const isReplay = Number(baseline[memories.target]?.credited_success_count ?? 0) > 0
  emit(1, isReplay
    ? 'Replay of an earlier proof in this window (idempotent - no duplicate rows)'
    : 'Two candidate memories written through the real remember tool',
    { memories, baseline, seeded_demo_data: true, replay: isReplay })

  // 2 + 3. recall and receipt
  const attempt = did('attempt-1')
  const task = did('task-1')
  const recall = need('recall', await recallTool({
    principal, query: JUDGE_CFG.query, purpose: 'judge-demo', episode_id: `judge-${runKey}`,
    attempt_id: attempt, request_id: did('recall-1'),
  }))
  const receiptItems = recall.receipt.items ?? []
  const targetItem = receiptItems.find(i => i.memory_id === memories.target)
  emit(2, 'Recall through the project vector retrieval (CockroachDB VECTOR index)', {
    recall_request_id: recall.receipt.request_id,
    candidates: receiptItems.length,
    injected: (recall.injected?.events ?? []).filter(e => e.injected !== false).length,
  })
  emit(3, 'Recall receipt persisted - the "why was this remembered" record', {
    recall_request_id: recall.receipt.request_id,
    receipt_scores: receiptItems.map(i => ({
      memory_id: i.memory_id, rank: i.rank, injected: i.injected === true,
      similarity: i.similarity, effective_strength: i.effective_strength,
      utility: i.utility, importance: i.importance, final_score: i.final_score,
    })),
  })

  // 4. recall must not have changed long-term state
  const afterRecall = await snapshot(ids)
  const recallDiffs = Object.fromEntries(ids.map(id => [id, diffRow(baseline[id], afterRecall[id])]))
  const recallTouched = Object.values(recallDiffs).some(d => d.length > 0)
  emit(4, 'Recall alone changed no long-term weight', {
    changed_fields: recallDiffs,
    verdict: recallTouched ? 'FAILED' : 'unchanged across all six persisted fields',
  })
  if (recallTouched) throw new Error('judge_invariant_violated:recall_mutated_state')

  // 5. agent action (payload keys follow the server allowlist exactly)
  const events = []
  for (const [label, type, tool, payload] of [
    ['start', 'attempt_start', null, {}],
    ['tool', 'tool_call', 'refund_ticket_close',
      { args_digest: createHash('sha256').update(`${runKey}|refund_ticket_close`).digest('hex'),
        duration_ms: 142, exit_code: 0 }],
  ]) {
    const ev = need(`log_event:${label}`, await logEventTool({
      principal, episode_id: `judge-${runKey}`, task_instance_id: task, attempt_id: attempt,
      event_type: type, tool_name: tool ?? undefined, request_id: did(`evt-${label}`), payload,
    }))
    events.push({ event_id: ev.event_id, event_type: type, tool_name: tool })
  }
  const usedEv = need('log_event:memory_used', await logEventTool({
    principal, episode_id: `judge-${runKey}`, task_instance_id: task, attempt_id: attempt,
    event_type: 'memory_used', request_id: did('evt-used'),
    payload: { recall_request_id: recall.receipt.request_id,
      receipt_item_id: targetItem?.receipt_item_id, memory_id: memories.target },
  }))
  emit(5, 'Agent action recorded on the AWS-hosted path', {
    attempt_id: attempt, task_instance_id: task,
    events: [...events, { event_id: usedEv.event_id, event_type: 'memory_used' }],
  })

  // 6 + 7. outcome credits only the memory with item-bound evidence
  const outcome = need('report_outcome', await reportOutcomeTool({
    principal, outcome_request_id: did('outcome-1'), episode_id: `judge-${runKey}`,
    task_instance_id: task, attempt_id: attempt, status: 'success',
    attributions: [{ recall_request_id: recall.receipt.request_id,
      receipt_item_id: targetItem?.receipt_item_id, memory_id: memories.target,
      role: 'credited', evidence_event_id: usedEv.event_id }],
  }))
  emit(6, 'Terminal outcome reported (success, credited to the memory actually used)', {
    outcome_request_id: outcome.outcome_request_id,
    plasticity_applied: outcome.plasticity_applied === true,
    items: outcome.items ?? [],
  })

  const afterOutcome = await snapshot(ids)
  const outcomeDiffs = Object.fromEntries(ids.map(id => [id, diffRow(afterRecall[id], afterOutcome[id])]))
  const targetChanged = outcomeDiffs[memories.target].length > 0
  const controlChanged = outcomeDiffs[memories.control].length > 0
  // Fresh run  : the credited memory must change and the control must not.
  // Replayed run: nothing may change at all - a resubmitted terminal outcome
  //               must never credit twice.
  const attributionOk = isReplay
    ? (!targetChanged && !controlChanged)
    : (targetChanged && !controlChanged)
  emit(7, isReplay
    ? 'Replayed outcome credited nothing a second time (idempotent terminal outcome)'
    : 'Only the credited memory changed; the control stayed untouched', {
    replay: isReplay,
    credited_memory: memories.target, control_memory: memories.control,
    credited_changed_fields: outcomeDiffs[memories.target],
    control_changed_fields: outcomeDiffs[memories.control],
    // What the first run of this window recorded, so a replay still shows the delta.
    credited_state: afterOutcome[memories.target],
    verdict: attributionOk
      ? (isReplay ? 'idempotent: no double-credit on resubmission' : 'attribution is targeted')
      : 'FAILED',
  })
  if (!attributionOk) {
    throw new Error(`judge_invariant_violated:${isReplay ? 'replay_double_credited' : 'attribution_not_targeted'}`)
  }

  // 8. whole-run diff
  emit(8, 'Before / after diff across the whole run', {
    before: baseline, after: afterOutcome,
    per_memory: Object.fromEntries(ids.map(id => [id, diffRow(baseline[id], afterOutcome[id])])),
  })

  // 9. fresh transaction read-back (page reload equivalent)
  const reread = await snapshot(ids)
  const durable = ids.every(id => PERSISTED_FIELDS.every(f => reread[id][f] === afterOutcome[id][f]))
  emit(9, 'Re-read from CockroachDB in a new transaction (page-reload equivalent)', {
    matches_post_outcome_state: durable, rows: reread,
  })
  if (!durable) throw new Error('judge_invariant_violated:not_persisted')

  const summary = {
    replay: isReplay,
    recall_changed_nothing: !recallTouched,
    outcome_credited_only_used_memory: attributionOk,
    no_double_credit_on_replay: isReplay ? attributionOk : undefined,
    persisted_after_fresh_read: durable,
    credited_delta: diffRow(baseline[memories.target], afterOutcome[memories.target]),
    credited_state: afterOutcome[memories.target],
    identifiers: {
      recall_request_id: recall.receipt.request_id,
      attempt_id: attempt, task_instance_id: task,
      outcome_request_id: outcome.outcome_request_id,
      memory_ids: memories, evidence_event_id: usedEv.event_id,
    },
    unavailable: ['cockroachdb_transaction_id', 'aws_xray_trace_id'],
  }
  emit(10, 'Proof document', { summary })

  return { ok: true, run_key: runKey, tenant_id: tenantId, agent_id: agentId,
    seeded_demo_data: true, real_path: true, steps, summary }
}
