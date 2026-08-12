import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { groupCrossesFade, retentionRange, uniformRetentionPercent } from './evidence-model.mjs'
import type { MemoryWithEpisode } from './types'

// Form choice (2026-08-12, Owner directive to drop the ring): retention is a
// magnitude, and magnitude is read most accurately as bar length off a shared
// baseline. The former concentric pool encoded it as radius, which is both a
// weaker channel and one the reader has to decode against a moving centre. A
// horizontal bar ledger sorted by retention makes the tideline literal: the
// fade threshold is a vertical line, and every record is visibly above or below
// it. Colour does no encoding work here - length already carries the value, so
// the bars stay neutral ink and selection uses value, edge and text contrast.

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
const clampStrength = (value: number) => Math.min(1, Math.max(0, value))

type TideGroup = (typeof TIDE_LAYERS)[number] & { rows: MemoryWithEpisode[] }

const rangeLabel = (rows: MemoryWithEpisode[]) => {
  const range = retentionRange(rows)
  return range ? `${pct(range.max)}–${pct(range.min)}` : '—'
}

function DistributionStrip({ rows }: { rows: MemoryWithEpisode[] }) {
  if (!rows.length) return <span className="tide-card__empty-line" aria-hidden="true" />
  const height = 42
  const range = retentionRange(rows)
  const uniformPercent = uniformRetentionPercent(rows)
  if (range && uniformPercent != null) {
    return (
      <span className="tide-card__uniform">
        <svg className="tide-card__distribution" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={`M0 ${height / 2}H${(range.max * 100).toFixed(3)}`} strokeWidth="1.25" />
        </svg>
        <small>no visible spread</small>
      </span>
    )
  }
  const step = height / rows.length
  const strokeWidth = Math.max(.32, Math.min(1.25, 25 / rows.length))
  const path = rows.map((memory, index) => {
    const y = ((index + .5) * step).toFixed(3)
    const x = (clampStrength(memory.effective_strength) * 100).toFixed(3)
    return `M0 ${y}H${x}`
  }).join('')
  return (
    <svg className="tide-card__distribution" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={path} strokeWidth={strokeWidth} />
    </svg>
  )
}

function TideRows({ group, fadeThreshold, selectedId, groupLimit, expanded, onToggle, onSelect }: {
  group: TideGroup
  fadeThreshold: number
  selectedId: string | null
  groupLimit: number
  expanded: boolean
  onToggle: () => void
  onSelect: (memoryId: string) => void
}) {
  const visibleRows = expanded ? group.rows : group.rows.slice(0, groupLimit)
  const hiddenCount = group.rows.length - visibleRows.length
  const showFadeLine = groupCrossesFade(group.rows, fadeThreshold)
  const fadeLeft = `${Math.min(100, Math.max(0, fadeThreshold * 100))}%`
  return (
    <>
      <div className="tide-ledger__scale" aria-hidden="true">
        <span className="tide-ledger__scale-label">retention</span>
        <span className="tide-ledger__axis">{showFadeLine && <b className="is-fade" style={{ left: fadeLeft }}>fade {pct(fadeThreshold)}</b>}</span>
        <span />
      </div>
      <section className="tide-group" aria-label={`${group.label}, ${group.rows.length} records`}>
        <header className="tide-group__head">
          <span>{group.label}</span>
          <small>{group.note}</small>
          <b>{group.rows.length}</b>
        </header>
        {visibleRows.map((memory) => {
          const selected = memory.memory_id === selectedId
          return (
            <button
              key={memory.memory_id}
              type="button"
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
                {showFadeLine && <i className="tide-row__fade" style={{ left: fadeLeft }} aria-hidden="true" />}
                <i className="tide-row__bar" style={{ width: `${Math.min(100, Math.max(1.5, memory.effective_strength * 100))}%` }} />
              </span>
              <span className="tide-row__value">{pct(memory.effective_strength)}</span>
            </button>
          )
        })}
        {group.rows.length > groupLimit && (
          <button type="button" className="tide-group__toggle" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? `Show first ${groupLimit}` : `Show all ${group.rows.length}`}
            {!expanded && <span>{hiddenCount} more</span>}
          </button>
        )}
      </section>
    </>
  )
}

export function TideMap({
  memories,
  fadeThreshold,
  selectedId,
  onSelect,
  groupLimit = 10,
  emptyMessage = 'No memories are exposed in this snapshot.',
}: {
  memories: MemoryWithEpisode[]
  fadeThreshold: number
  selectedId: string | null
  onSelect: (memoryId: string) => void
  groupLimit?: number
  emptyMessage?: string
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<TideLayer>>(() => new Set())
  const [openLayer, setOpenLayer] = useState<TideLayer | null>(null)
  const [closing, setClosing] = useState(false)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef(0)
  const restoreFocusRef = useRef(false)
  const dialogTitleId = useId()
  const groups = useMemo(() => {
    const sorted = [...memories].sort((a, b) =>
      b.effective_strength - a.effective_strength || a.memory_id.localeCompare(b.memory_id))
    return TIDE_LAYERS.map((layer) => ({
      ...layer,
      rows: sorted.filter((memory) => tideLayerOf(memory) === layer.id),
    }))
  }, [memories])
  const activeGroup = openLayer ? groups.find((group) => group.id === openLayer) ?? null : null

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), [])

  useEffect(() => {
    if (!openLayer || activeGroup?.rows.length) return
    restoreFocusRef.current = true
    setClosing(false)
    setOpenLayer(null)
  }, [openLayer, activeGroup])

  useEffect(() => {
    if (!openLayer) {
      if (!restoreFocusRef.current) return
      restoreFocusRef.current = false
      const frame = window.requestAnimationFrame(() => {
        if (openerRef.current?.isConnected) openerRef.current.focus()
      })
      return () => window.cancelAnimationFrame(frame)
    }
    const shell = document.querySelector<HTMLElement>('.evidence-shell')
    const previousAriaHidden = shell?.getAttribute('aria-hidden')
    shell?.setAttribute('inert', '')
    shell?.setAttribute('aria-hidden', 'true')
    document.body.classList.add('has-tide-dialog')
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      shell?.removeAttribute('inert')
      if (previousAriaHidden == null) shell?.removeAttribute('aria-hidden')
      else shell?.setAttribute('aria-hidden', previousAriaHidden)
      document.body.classList.remove('has-tide-dialog')
    }
  }, [openLayer])

  const openGroup = (group: TideGroup, opener: HTMLButtonElement) => {
    if (!group.rows.length) return
    window.clearTimeout(closeTimerRef.current)
    openerRef.current = opener
    restoreFocusRef.current = false
    setClosing(false)
    setOpenLayer(group.id)
  }

  const closeGroup = (afterClose?: () => void) => {
    if (!openLayer || closing) return
    restoreFocusRef.current = !afterClose
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => {
      setOpenLayer(null)
      setClosing(false)
      afterClose?.()
    }, 160)
  }

  const keepFocusInDialog = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeGroup()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') ?? [])]
    if (!focusable.length) { event.preventDefault(); dialogRef.current?.focus(); return }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus() }
  }

  const toggleExpanded = (layer: TideLayer) => setExpandedGroups((current) => {
    const next = new Set(current)
    if (next.has(layer)) next.delete(layer)
    else next.add(layer)
    return next
  })

  return (
    <div className="tide-ledger tide-ledger--cards">
      <div className="tide-ledger__body">
        {!memories.length && <p className="empty-state">{emptyMessage}</p>}
        <div className="tide-cards" aria-label="Memory retention groups">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="tide-card"
              disabled={!group.rows.length}
              data-active={openLayer === group.id || undefined}
              data-current={group.rows.some((memory) => memory.memory_id === selectedId) || undefined}
              aria-haspopup="dialog"
              aria-expanded={openLayer === group.id}
              aria-controls={group.rows.length ? dialogTitleId : undefined}
              onClick={(event) => openGroup(group, event.currentTarget)}
            >
              <span className="tide-card__head"><strong>{group.label}</strong><b>{group.rows.length || '—'}</b></span>
              <span className="tide-card__meta"><small>{group.note}</small><em>{rangeLabel(group.rows)}</em></span>
              <DistributionStrip rows={group.rows} />
              <span className="tide-card__action">{group.rows.length ? 'Open records' : 'No records'}</span>
            </button>
          ))}
        </div>
      </div>
      {activeGroup && createPortal(
        <div
          className="tide-dialog-scrim"
          data-closing={closing || undefined}
          onPointerDown={(event) => { if (event.target === event.currentTarget) closeGroup() }}
        >
          <div
            ref={dialogRef}
            id={dialogTitleId}
            className="tide-dialog"
            data-closing={closing || undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${dialogTitleId}-title`}
            tabIndex={-1}
            onKeyDown={keepFocusInDialog}
          >
            <header className="tide-dialog__head">
              <div>
                <span>Observe one tide band</span>
                <h2 id={`${dialogTitleId}-title`}>{activeGroup.label}</h2>
                <p>{activeGroup.rows.length} records · {rangeLabel(activeGroup.rows)} retained</p>
              </div>
              <button type="button" onClick={() => closeGroup()} aria-label={`Close ${activeGroup.label} records`}>Close</button>
            </header>
            <div className="tide-dialog__ledger">
              <TideRows
                group={activeGroup}
                fadeThreshold={fadeThreshold}
                selectedId={selectedId}
                groupLimit={groupLimit}
                expanded={expandedGroups.has(activeGroup.id)}
                onToggle={() => toggleExpanded(activeGroup.id)}
                onSelect={(memoryId) => closeGroup(() => onSelect(memoryId))}
              />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
