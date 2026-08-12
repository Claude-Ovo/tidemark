// Evidence console honesty gates: selection must never combine identifiers
// from one event with detail from another memory, and bounded activity drains
// must retain the frozen page cursor rather than replay the same pages forever.
import assert from 'node:assert/strict'
import {
  activityPageDecision,
  eventSummary,
  rememberEvidenceId,
  resolveEventSelection,
} from './src/evidence/evidence-model.mjs'

const available = new Set(['memory-live'])

{
  const event = { kind: 'recall', event_id: 'recall-1', memory_ids: ['memory-outside'] }
  const result = resolveEventSelection(event, available, 'overview')
  assert.equal(result.targetMemoryId, null)
  assert.equal(result.reason, 'outside_snapshot')
  assert.equal(result.explainTab, 'overview', 'a broken link must not switch the inspector tab')
  assert.deepEqual(result.referencedMemoryIds, ['memory-outside'])
  console.log('PASS E1 outside-snapshot event clears the memory link without switching evidence')
}

{
  const event = { kind: 'agent_action', event_id: 'action-1' }
  const result = resolveEventSelection(event, available, 'decay')
  assert.equal(result.targetMemoryId, null)
  assert.equal(result.reason, 'no_reference')
  assert.equal(result.explainTab, 'decay')
  console.log('PASS E2 event without a memory reference cannot inherit stale detail')
}

{
  const event = { kind: 'outcome', event_id: 'outcome-1', items: [
    { memory_id: 'memory-live', role: 'credited', applied: true, reason: null },
  ] }
  const result = resolveEventSelection(event, available, 'overview')
  assert.equal(result.targetMemoryId, 'memory-live')
  assert.equal(result.reason, null)
  assert.equal(result.explainTab, 'plasticity')
  assert.equal(rememberEvidenceId(event, 'stale-memory'), 'memory-live', 'trace uses event reference first')
  console.log('PASS E3 linked outcome selects its own memory and plasticity evidence')
}

assert.equal(
  eventSummary({ kind: 'remember', event_id: 'remember-1', occurred_at: '2026-08-12T00:00:00Z' }),
  'persisted memory count unavailable',
)
assert.equal(
  eventSummary({ kind: 'remember', event_id: 'remember-2', occurred_at: '2026-08-12T00:00:00Z', memory_ids: ['m1'] }),
  '1 memory persisted',
)
console.log('PASS E4 remember summary never invents a missing count')

{
  const stillDraining = activityPageDecision({ has_more: true, page_cursor: 'frozen-page-6' }, 4, 5)
  assert.deepEqual(stillDraining, { done: false, truncated: true, resumeCursor: 'frozen-page-6' })
  const complete = activityPageDecision({ has_more: false, page_cursor: null }, 0, 5)
  assert.deepEqual(complete, { done: true, truncated: false, resumeCursor: null })
  console.log('PASS E5 bounded activity drain preserves its frozen page cursor')
}

console.log('ALL EVIDENCE MODEL TESTS PASSED')
