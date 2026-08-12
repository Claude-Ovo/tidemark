import type { ActivityEvent } from './types'

export function eventMemoryIds(event: ActivityEvent | null): string[]
export function eventSummary(event: ActivityEvent): string
export function resolveEventSelection(
  event: ActivityEvent,
  availableMemoryIds: ReadonlySet<string>,
  currentTab: 'overview' | 'receipt' | 'plasticity' | 'decay',
): {
  referencedMemoryIds: string[]
  targetMemoryId: string | null
  reason: 'outside_snapshot' | 'no_reference' | null
  explainTab: 'overview' | 'receipt' | 'plasticity' | 'decay'
}
export function rememberEvidenceId(event: ActivityEvent | null, selectedMemoryId: string | null): string | null
export function activityPageDecision(
  page: { has_more: boolean; page_cursor: string | null },
  pageIndex: number,
  maxPages: number,
): { done: boolean; truncated: boolean; resumeCursor: string | null }
export function initialRetryDelay(failedAttempts: number): number
export function displayCount(count: number): string
export function groupCrossesFade(
  rows: Array<{ effective_strength: number }>,
  fadeThreshold: number,
): boolean
