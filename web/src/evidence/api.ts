import type { ActivityEvent, ActivityPage, CapabilityResponse, EvidenceSnapshot, JudgeProof, MemoryDetail } from './types'
import { activityPageDecision } from './evidence-model.mjs'

const fetchJson = async <T>(url: string, signal?: AbortSignal): Promise<T> => {
  const timeout = AbortSignal.timeout(20_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(url, { signal: combined })
  const body = await response.json() as T & { ok?: boolean; error?: string }
  if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

export const fetchSnapshot = async (signal?: AbortSignal): Promise<EvidenceSnapshot> => {
  const delays = [0, 750, 1_500, 3_000]
  let lastError: unknown = new Error('snapshot unavailable')
  for (const delay of delays) {
    if (delay) await wait(delay)
    if (signal?.aborted) throw signal.reason
    try { return await fetchJson<EvidenceSnapshot>('/viz/ocean', signal) }
    catch (error) { lastError = error }
  }
  throw lastError
}

export const fetchMemoryDetail = (memoryId: string, signal?: AbortSignal) =>
  fetchJson<MemoryDetail>(`/viz/memory/${encodeURIComponent(memoryId)}`, signal)

export const fetchCapabilities = (signal?: AbortSignal) =>
  fetchJson<CapabilityResponse>('/viz/capability', signal)

export const runJudgeProof = async (signal?: AbortSignal): Promise<JudgeProof> => {
  const timeout = AbortSignal.timeout(120_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch('/viz/judge-run', { method: 'POST', signal: combined })
  const body = await response.json() as JudgeProof | { ok: false; error?: string }
  if (!response.ok || body.ok === false) throw new Error('error' in body && body.error ? body.error : `HTTP ${response.status}`)
  return body as JudgeProof
}

const activityUrl = (after?: string | null) => {
  const params = new URLSearchParams({ limit: '100' })
  if (after) params.set('after', after)
  return `/viz/activity?${params}`
}

export type ActivityBatch = {
  events: ActivityEvent[]
  cursor: string
  resumeCursor: string | null
  truncated: boolean
}

export const fetchActivityBatch = async (
  after?: string | null,
  signal?: AbortSignal,
  maxPages = 5,
): Promise<ActivityBatch> => {
  const events: ActivityEvent[] = []
  let next: string | null = after ?? null
  let cursor = after ?? ''
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchJson<ActivityPage>(activityUrl(next), signal)
    events.push(...page.events)
    cursor = page.cursor
    const decision = activityPageDecision(page, pageIndex, maxPages)
    if (decision.done) return { events, cursor, resumeCursor: null, truncated: false }
    if (decision.truncated) return { events, cursor, resumeCursor: decision.resumeCursor, truncated: true }
    next = decision.resumeCursor
  }
  return { events, cursor, resumeCursor: next, truncated: true }
}
