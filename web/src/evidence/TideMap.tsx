import { useMemo } from 'react'
import type { MemoryWithEpisode } from './types'

// Form choice (2026-08-12, Owner directive to drop the ring): retention is a
// magnitude, and magnitude is read most accurately as bar length off a shared
// baseline. The former concentric pool encoded it as radius, which is both a
// weaker channel and one the reader has to decode against a moving centre. A
// horizontal bar ledger sorted by retention makes the tideline literal: the
// fade threshold is a vertical line, and every record is visibly above or below
// it. Colour does no encoding work here - length already carries the value, so
// the bars stay neutral ink and the accent is spent only on selection.

export type TideLayer = 'held' | 'active' | 'receding'

export const TIDE_LAYERS: Array<{ id: TideLayer; label: string; note: string }> = [
  { id: 'held', label: 'Held', note: 'pinned or >= 70%' },
  { id: 'active', label: 'Active tide', note: '35-70%' },
  { id: 'receding', label: 'Receding', note: '<= 35%' },
]

// Single source of truth for the three bands - the stats row and the ledger must
// never drift apart (they were two separate hardcoded thresholds before).
export const tideLayerOf = (memory: { pinned?: boolean; effective_strength: number }): TideLayer => {
  if (memory.pinned || memory.effective_strength >= 0.7) return 'held'
  if (memory.effective_strength > 0.35) return 'active'
  return 'receding'
}

const pct = (value: number) => `${(value * 100).toFixed(0)}%`

export function TideMap({
  memories,
  fadeThreshold,
  selectedId,
  onSelect,
}: {
  memories: MemoryWithEpisode[]
  fadeThreshold: number
  selectedId: string | null
  onSelect: (memoryId: string) => void
}) {
  const groups = useMemo(() => {
    const sorted = [...memories].sort((a, b) =>
      b.effective_strength - a.effective_strength || a.memory_id.localeCompare(b.memory_id))
    return TIDE_LAYERS.map((layer) => ({
      ...layer,
      rows: sorted.filter((memory) => tideLayerOf(memory) === layer.id),
    }))
  }, [memories])

  const fadeLeft = `${Math.min(100, Math.max(0, fadeThreshold * 100))}%`

  return (
    <div className="tide-ledger">
      {/* The scale row shares the row grid so the fade label sits over the same
          track the per-row fade line is drawn in - one geometry, not two. */}
      <div className="tide-ledger__scale" aria-hidden="true">
        <span className="tide-ledger__scale-label">retention</span>
        <span className="tide-ledger__axis">
          {/* Only the threshold is labelled: 0 and 100 are implied by the shared
              baseline and the value at each bar's tip, and a 0% label collides
              with the fade marker at narrow panel widths. */}
          <b className="is-fade" style={{ left: fadeLeft }}>fade {pct(fadeThreshold)}</b>
        </span>
        <span />
      </div>
      <div className="tide-ledger__body">
        {!memories.length && <p className="empty-state">No memories are exposed in this snapshot.</p>}
        {groups.filter((group) => group.rows.length).map((group) => (
          <section key={group.id} className="tide-group" aria-label={`${group.label}, ${group.rows.length} records`}>
            <header className="tide-group__head">
              <span>{group.label}</span>
              <small>{group.note}</small>
              <b>{group.rows.length}</b>
            </header>
            {group.rows.map((memory) => {
              const selected = memory.memory_id === selectedId
              return (
                <button
                  key={memory.memory_id}
                  className="tide-row"
                  data-selected={selected || undefined}
                  data-layer={group.id}
                  onClick={() => onSelect(memory.memory_id)}
                  title={memory.content_preview ?? memory.memory_id}
                  aria-label={`${memory.kind ?? 'memory'}, ${pct(memory.effective_strength)} retained${memory.pinned ? ', pinned' : ''}`}
                >
                  <span className="tide-row__name">
                    {memory.pinned && <i className="tide-row__pin" aria-hidden="true" />}
                    {memory.content_preview ?? memory.memory_id.slice(0, 8)}
                  </span>
                  <span className="tide-row__track">
                    <i className="tide-row__fade" style={{ left: fadeLeft }} aria-hidden="true" />
                    <i className="tide-row__bar" style={{ width: `${Math.max(1.5, memory.effective_strength * 100)}%` }} />
                  </span>
                  <span className="tide-row__value">{pct(memory.effective_strength)}</span>
                </button>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}
