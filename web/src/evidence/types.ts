import type { OceanSnapshot, VizMemory } from '../ocean/types'

export type ActivityKind = 'remember' | 'recall' | 'agent_action' | 'outcome'

export type ActivityEvent = {
  kind: ActivityKind
  event_id: string
  occurred_at: string
  memory_ids?: string[]
  episode_id?: string | null
  attempt_id?: string | null
  task_instance_id?: string | null
  event_type?: string | null
  tool_name?: string | null
  items_count?: number
  status?: string
  items?: Array<{
    memory_id: string
    role: 'credited' | 'blamed' | string
    applied: boolean
    reason: string | null
  }>
}

export type ActivityPage = {
  ok: true
  events: ActivityEvent[]
  cursor: string
  has_more: boolean
  page_cursor: string | null
  watermark_at: string
  server_now: string
  hot_replay?: boolean
}

export type EvidenceSnapshot = OceanSnapshot & {
  activity_baseline?: {
    cursor?: string
    watermark_at?: string
    seen?: Array<{ k: string; at: string }>
    error?: string
  }
}

export type MemoryWithEpisode = VizMemory & { episode_id: string | null }

export type ReceiptScores = {
  rank: number
  similarity: number
  effective_strength: number
  utility: number
  importance: number
  final_score: number
}

export type Attribution = {
  outcome_request_id: string
  status: string
  reported_at: string
  episode_id: string | null
  role: 'credited' | 'blamed' | string
  applied: boolean
  reason: string | null
  plasticity: {
    effective_before?: number
    reinforcement_gain?: number
    strength_anchor_after?: number
    [key: string]: unknown
  } | null
  receipt_scores: ReceiptScores | null
}

export type MemoryDetail = {
  ok: true
  snapshot_at: string
  fade_threshold: number
  memory: {
    memory_id: string
    layer: string
    kind: string | null
    episode_id: string | null
    pinned: boolean
    state: string
    importance: number
    effective_strength: number
    credited: number
    blamed: number
    created_at: string
    content: string
    content_scope: 'preview' | 'full'
    content_truncated: boolean
  }
  curve: Array<{ at: string; s: number | null }>
  attributions: Attribution[]
  related: Array<{ kind: 'derived_from' | 'source_of' | string; memory_id: string }>
  latest_outcome: Attribution | null
}

export type LoadState = 'idle' | 'loading' | 'connected' | 'degraded' | 'failed'

export type CapabilityStatus =
  | 'live'
  | 'documented'
  | 'evidence_pending'
  | 'blocked_external'
  | 'unavailable'
  | 'degraded'

export type CapabilityItem = {
  id: string
  name: string
  status: CapabilityStatus
  role: string
  evidence: string
  evidence_ref: string
}

export type CapabilityResponse = {
  ok: true
  status: 'connected' | 'degraded'
  server_now: string | null
  database: { engine: string; status: CapabilityStatus; error?: string }
  tenant_id: string
  agent_id: string
  principal_scope: string
  counts: null | {
    memories: number
    recalls: number
    outcomes: number
    attempt_events: number
    pinned: number
    credited: number
    blamed: number
    nightly_runs: number
  }
  cockroachdb_tools: CapabilityItem[]
  aws_services: CapabilityItem[]
  lifecycle: Array<{
    id: string
    stage: number
    status: CapabilityStatus
    evidence: string
  }>
  unavailable: Array<{ field: string; reason: string }>
}
