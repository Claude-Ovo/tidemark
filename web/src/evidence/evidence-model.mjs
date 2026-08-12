// Pure evidence-console decisions. Keeping these outside React makes the
// honesty boundary executable: an event may only drive a memory view when one
// of its own references exists in the current snapshot.

export const eventMemoryIds = (event) => {
  if (!event) return []
  if (event.kind === 'outcome') {
    return [...new Set((event.items ?? []).map((item) => item.memory_id).filter(Boolean))]
  }
  return [...new Set((event.memory_ids ?? []).filter(Boolean))]
}

export const eventSummary = (event) => {
  if (event.kind === 'remember') {
    return event.memory_ids
      ? `${event.memory_ids.length} ${event.memory_ids.length === 1 ? 'memory' : 'memories'} persisted`
      : 'persisted memory count unavailable'
  }
  if (event.kind === 'recall') return `${event.items_count ?? 0} receipt items`
  if (event.kind === 'agent_action') {
    return [event.event_type, event.tool_name].filter(Boolean).join(' · ') || 'attempt evidence'
  }
  const applied = (event.items ?? []).filter((item) => item.applied).length
  return `${event.status ?? 'terminal'} · ${applied} applied`
}

export const resolveEventSelection = (event, availableMemoryIds, currentTab) => {
  const referencedMemoryIds = eventMemoryIds(event)
  const targetMemoryId = referencedMemoryIds.find((memoryId) => availableMemoryIds.has(memoryId)) ?? null
  const reason = targetMemoryId
    ? null
    : referencedMemoryIds.length
      ? 'outside_snapshot'
      : 'no_reference'
  const explainTab = !targetMemoryId
    ? currentTab
    : event.kind === 'recall'
      ? 'receipt'
      : event.kind === 'outcome'
        ? 'plasticity'
        : 'overview'
  return { referencedMemoryIds, targetMemoryId, reason, explainTab }
}

export const rememberEvidenceId = (event, selectedMemoryId) =>
  event ? eventMemoryIds(event)[0] ?? null : selectedMemoryId

export const activityPageDecision = (page, pageIndex, maxPages) => {
  if (!page.has_more || !page.page_cursor) {
    return { done: true, truncated: false, resumeCursor: null }
  }
  return {
    done: false,
    truncated: pageIndex + 1 >= maxPages,
    resumeCursor: page.page_cursor,
  }
}

export const initialRetryDelay = (failedAttempts) => {
  const delays = [1_500, 3_000, 5_000, 8_000, 12_000]
  const index = Math.min(delays.length - 1, Math.max(0, Number(failedAttempts) - 1))
  return delays[index]
}

export const displayCount = (count) => Number(count) > 0 ? String(count) : '—'

export const displayRecordRef = (memoryId) => memoryId ? String(memoryId).slice(0, 4) : '—'

export const groupCrossesFade = (rows, fadeThreshold) =>
  rows.some((row) => row.effective_strength <= fadeThreshold) &&
  rows.some((row) => row.effective_strength > fadeThreshold)

export const retentionRange = (rows) => {
  if (!rows.length) return null
  const values = rows.map((row) => Math.min(1, Math.max(0, Number(row.effective_strength))))
  return { min: Math.min(...values), max: Math.max(...values) }
}

export const uniformRetentionPercent = (rows) => {
  const range = retentionRange(rows)
  if (!range) return null
  const min = Math.round(range.min * 100)
  const max = Math.round(range.max * 100)
  return min === max ? max : null
}
