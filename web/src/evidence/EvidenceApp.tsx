import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchActivityBatch, fetchCapabilities, fetchMemoryDetail, fetchSnapshot } from './api'
import { TideMap } from './TideMap'
import type {
  ActivityEvent,
  ActivityKind,
  CapabilityResponse,
  EvidenceSnapshot,
  LoadState,
  MemoryDetail,
  MemoryWithEpisode,
} from './types'

type StageFilter = 'all' | ActivityKind | 'plasticity'
type ExplainTab = 'overview' | 'receipt' | 'plasticity' | 'decay'
type VerifyTab = 'trace' | 'system'

const STAGES: Array<{ id: StageFilter; label: string; verb: string }> = [
  { id: 'remember', label: 'Remember', verb: 'persist' },
  { id: 'recall', label: 'Recall receipt', verb: 'explain' },
  { id: 'agent_action', label: 'Agent action', verb: 'act' },
  { id: 'outcome', label: 'Outcome', verb: 'attribute' },
  { id: 'plasticity', label: 'Plasticity', verb: 'change' },
]

const shortId = (id?: string | null) => id ? id.slice(0, 8) : 'unavailable'
const asPercent = (value?: number | null) => value == null ? '—' : `${(value * 100).toFixed(1)}%`
const asNumber = (value?: number | null, digits = 4) => value == null ? '—' : Number(value).toFixed(digits)
const dateLabel = (iso?: string | null) => {
  if (!iso) return 'unavailable'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'unavailable' : date.toLocaleString(undefined, { hour12: false })
}

const flattenSnapshot = (snapshot: EvidenceSnapshot | null): MemoryWithEpisode[] => {
  if (!snapshot) return []
  const episodic = snapshot.episodes.flatMap((episode) =>
    episode.memories.map((memory) => ({ ...memory, episode_id: episode.episode_id })))
  return [...episodic, ...snapshot.loose.map((memory) => ({ ...memory, episode_id: null }))]
}

const eventMemoryIds = (event: ActivityEvent | null) => {
  if (!event) return []
  if (event.kind === 'outcome') return [...new Set((event.items ?? []).map((item) => item.memory_id).filter(Boolean))]
  return [...new Set((event.memory_ids ?? []).filter(Boolean))]
}

const eventHasAppliedChange = (event: ActivityEvent) =>
  event.kind === 'outcome' && (event.items ?? []).some((item) => item.applied)

const eventSummary = (event: ActivityEvent) => {
  if (event.kind === 'remember') return `${event.memory_ids?.length ?? 1} memory persisted`
  if (event.kind === 'recall') return `${event.items_count ?? 0} receipt items`
  if (event.kind === 'agent_action') return [event.event_type, event.tool_name].filter(Boolean).join(' · ') || 'attempt evidence'
  const applied = (event.items ?? []).filter((item) => item.applied).length
  return `${event.status ?? 'terminal'} · ${applied} applied`
}

const mergeEvents = (current: ActivityEvent[], incoming: ActivityEvent[]) => {
  const byKey = new Map(current.map((event) => [`${event.kind}|${event.event_id}`, event]))
  for (const event of incoming) byKey.set(`${event.kind}|${event.event_id}`, event)
  return [...byKey.values()]
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || b.event_id.localeCompare(a.event_id))
    .slice(0, 60)
}

function StatusPill({ state, label }: { state: LoadState; label: string }) {
  return <span className="status-pill" data-state={state}><i aria-hidden="true" />{label}</span>
}

function LifecycleRail({ active, events, onChange }: {
  active: StageFilter
  events: ActivityEvent[]
  onChange: (stage: StageFilter) => void
}) {
  return (
    <nav className="lifecycle" aria-label="Memory lifecycle filter">
      <button className="lifecycle__all" data-active={active === 'all' || undefined} onClick={() => onChange('all')}>
        Full trace
      </button>
      <div className="lifecycle__track">
        {STAGES.map((stage, index) => {
          const count = stage.id === 'plasticity'
            ? events.filter(eventHasAppliedChange).length
            : events.filter((event) => event.kind === stage.id).length
          return (
            <button key={stage.id} data-active={active === stage.id || undefined} onClick={() => onChange(stage.id)}>
              <span className="lifecycle__index">{String(index + 1).padStart(2, '0')}</span>
              <span><strong>{stage.label}</strong><small>{stage.verb} · {count}</small></span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function EventStream({ events, selected, filter, state, onSelect }: {
  events: ActivityEvent[]
  selected: ActivityEvent | null
  filter: StageFilter
  state: LoadState
  onSelect: (event: ActivityEvent) => void
}) {
  const visible = events.filter((event) => {
    if (filter === 'all') return true
    if (filter === 'plasticity') return eventHasAppliedChange(event)
    return event.kind === filter
  })
  return (
    <section className="event-stream" aria-labelledby="event-stream-title">
      <div className="section-heading">
        <div><span>Live ledger</span><h2 id="event-stream-title">Event stream</h2></div>
        <small>{visible.length} shown</small>
      </div>
      <div className="event-stream__list">
        {visible.map((event) => (
          <button
            key={`${event.kind}|${event.event_id}`}
            className="event-row"
            data-selected={selected?.kind === event.kind && selected.event_id === event.event_id || undefined}
            data-kind={event.kind}
            onClick={() => onSelect(event)}
          >
            <span className="event-row__kind">{event.kind.replace('_', ' ')}</span>
            <strong>{eventSummary(event)}</strong>
            <span className="event-row__meta"><code>{shortId(event.event_id)}</code><time>{dateLabel(event.occurred_at)}</time></span>
          </button>
        ))}
        {!visible.length && state === 'loading' && <p className="empty-state">Loading persisted events…</p>}
        {!visible.length && state !== 'loading' && (
          <p className="empty-state">No {filter === 'all' ? '' : filter.replace('_', ' ')} records are exposed in this slice.</p>
        )}
      </div>
    </section>
  )
}

function CurveChart({ detail }: { detail: MemoryDetail }) {
  const points = detail.curve
  const segments: string[][] = []
  let active: string[] = []
  points.forEach((point, index) => {
    if (point.s == null) {
      if (active.length) segments.push(active)
      active = []
      return
    }
    const x = points.length === 1 ? 0 : index / (points.length - 1) * 100
    active.push(`${x.toFixed(2)},${(42 - point.s * 36).toFixed(2)}`)
  })
  if (active.length) segments.push(active)
  const fadeY = 42 - detail.fade_threshold * 36
  return (
    <div className="curve-card">
      <svg viewBox="0 0 100 44" preserveAspectRatio="none" role="img" aria-label="Server-sampled retention curve">
        <line x1="0" y1={fadeY} x2="100" y2={fadeY} className="curve-card__fade" />
        {segments.map((segment, index) => <polyline key={index} points={segment.join(' ')} className="curve-card__line" />)}
      </svg>
      <div><span>−96h</span><span>snapshot</span><span>+96h</span></div>
    </div>
  )
}

function Inspector({ memory, detail, state, tab, onTab }: {
  memory: MemoryWithEpisode | null
  detail: MemoryDetail | null
  state: LoadState
  tab: ExplainTab
  onTab: (tab: ExplainTab) => void
}) {
  const source = detail?.memory ?? memory
  const attributions = detail?.attributions ?? []
  const latest = detail?.latest_outcome ?? null
  return (
    <section className="inspector panel" aria-labelledby="inspector-title">
      <div className="section-heading inspector__heading">
        <div>
          <span>Explain one record</span>
          <h2 id="inspector-title">Selected memory evidence</h2>
        </div>
        <StatusPill state={state} label={state === 'connected' ? 'detail verified' : state} />
      </div>
      <div className="tab-list" role="tablist" aria-label="Memory evidence views">
        {(['overview', 'receipt', 'plasticity', 'decay'] as ExplainTab[]).map((item) => (
          <button key={item} role="tab" aria-selected={tab === item} onClick={() => onTab(item)}>{item}</button>
        ))}
      </div>
      <div className="inspector__body">
        {!source && <p className="empty-state empty-state--large">Select a memory point or a ledger event to inspect persisted evidence.</p>}
        {source && tab === 'overview' && (
          <div className="overview-pane">
            <p className="memory-content">{detail?.memory.content ?? memory?.content_preview ?? 'Content preview unavailable.'}</p>
            <p className="scope-note">{detail ? `${detail.memory.content_scope} scope${detail.memory.content_truncated ? ' · truncated' : ''}` : 'snapshot preview'}</p>
            <dl className="fact-grid">
              <div><dt>Memory ID</dt><dd><code>{source.memory_id}</code></dd></div>
              <div><dt>Retention</dt><dd>{asPercent(source.effective_strength)}</dd></div>
              <div><dt>State</dt><dd>{source.pinned ? 'pinned' : source.state}</dd></div>
              <div><dt>Importance</dt><dd>{'importance' in source ? asNumber(source.importance, 2) : 'open detail'}</dd></div>
              <div><dt>Credited / blamed</dt><dd>{source.credited} / {source.blamed}</dd></div>
              <div><dt>Created</dt><dd>{dateLabel(source.created_at)}</dd></div>
            </dl>
          </div>
        )}
        {source && tab === 'receipt' && (
          <div className="receipt-pane">
            <p className="pane-thesis">Why this memory was recalled, using the persisted score components—not a client-side reconstruction.</p>
            {attributions.filter((item) => item.receipt_scores).map((item) => (
              <article className="receipt" key={`${item.outcome_request_id}|${item.reported_at}`}>
                <header><span>Receipt rank {item.receipt_scores?.rank}</span><code>{shortId(item.outcome_request_id)}</code></header>
                <dl>
                  {Object.entries(item.receipt_scores ?? {}).filter(([key]) => key !== 'rank').map(([key, value]) => (
                    <div key={key}><dt>{key.replace('_', ' ')}</dt><dd>{asNumber(value)}</dd></div>
                  ))}
                </dl>
              </article>
            ))}
            {!attributions.some((item) => item.receipt_scores) && <p className="empty-state">No receipt item is linked to this memory in the bounded detail window.</p>}
          </div>
        )}
        {source && tab === 'plasticity' && (
          <div className="plasticity-pane">
            <p className="pane-thesis">Recall is read-only. Only an applied terminal attribution may move the long-term anchor.</p>
            {attributions.map((item) => {
              const before = item.plasticity?.effective_before
              const after = item.plasticity?.strength_anchor_after
              return (
                <article className="change-row" data-applied={item.applied || undefined} key={`${item.outcome_request_id}|${item.reported_at}`}>
                  <div><span>{item.role}</span><strong>{item.applied ? 'persisted change' : 'zero change'}</strong></div>
                  <div className="change-row__values"><b>{asNumber(before)}</b><i aria-hidden="true">→</i><b>{asNumber(after)}</b></div>
                  <footer><code>{shortId(item.outcome_request_id)}</code><time>{dateLabel(item.reported_at)}</time></footer>
                </article>
              )
            })}
            {!attributions.length && <p className="empty-state">No terminal attribution references this memory yet. The anchor remains unchanged by recall alone.</p>}
          </div>
        )}
        {source && tab === 'decay' && (
          <div className="decay-pane">
            <p className="pane-thesis">The server samples the same decay function used by recall. Null segments precede the current anchor and are not invented history.</p>
            {detail ? <CurveChart detail={detail} /> : <p className="empty-state">Open detail to load the server-sampled curve.</p>}
            <dl className="fact-grid fact-grid--compact">
              <div><dt>At snapshot</dt><dd>{asPercent(source.effective_strength)}</dd></div>
              <div><dt>Fade line</dt><dd>{detail ? asPercent(detail.fade_threshold) : '—'}</dd></div>
              <div><dt>Policy</dt><dd>{source.pinned ? 'frozen at anchor' : 'read-time decay'}</dd></div>
            </dl>
          </div>
        )}
      </div>
      <div className="tideline" aria-hidden="true" />
      <div className="persisted-mark">
        <span>Below the tideline · persisted outcome</span>
        {latest ? (
          <div><strong>{latest.role} · {latest.applied ? 'applied' : 'not applied'}</strong><code>{latest.outcome_request_id}</code></div>
        ) : <p>No terminal outcome has crossed the line for this record.</p>}
      </div>
    </section>
  )
}

function TraceView({ event, detail, memory }: {
  event: ActivityEvent | null
  detail: MemoryDetail | null
  memory: MemoryWithEpisode | null
}) {
  const latest = detail?.latest_outcome
  const rows = [
    { label: 'Remember', state: memory ? 'persisted' : 'select a record', evidence: memory?.memory_id },
    { label: 'Recall receipt', state: detail?.attributions.some((item) => item.receipt_scores) ? 'linked' : 'unavailable in selection', evidence: detail?.attributions.find((item) => item.receipt_scores)?.outcome_request_id },
    { label: 'Agent action', state: event?.kind === 'agent_action' ? 'persisted' : 'select an agent-action row', evidence: event?.kind === 'agent_action' ? event.event_id : null },
    { label: 'Outcome', state: latest ? latest.status : 'not reported', evidence: latest?.outcome_request_id },
    { label: 'Plasticity', state: latest?.applied ? `${latest.role} applied` : 'zero or unavailable', evidence: latest?.applied ? latest.outcome_request_id : null },
  ]
  return (
    <ol className="trace-list">
      {rows.map((row, index) => (
        <li key={row.label} data-complete={Boolean(row.evidence) || undefined}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div><strong>{row.label}</strong><small>{row.state}</small></div>
          <code>{shortId(row.evidence)}</code>
        </li>
      ))}
    </ol>
  )
}

function VerifyPane({ tab, onTab, event, detail, memory, activeCapability, capability }: {
  tab: VerifyTab
  onTab: (tab: VerifyTab) => void
  event: ActivityEvent | null
  detail: MemoryDetail | null
  memory: MemoryWithEpisode | null
  activeCapability: string | null
  capability: CapabilityResponse | null
}) {
  const unavailable = new Map((capability?.unavailable ?? []).map((item) => [item.field, item.reason]))
  const systemNodes = [
    ...(capability?.lifecycle ?? []).map((item) => ({
      id: `lifecycle-${item.id}`,
      name: item.id.replaceAll('_', ' '),
      status: item.status,
      role: 'Persisted lifecycle stage exposed by the current principal-scoped capability response.',
      evidence: item.evidence,
      evidence_ref: '/viz/capability',
    })),
    ...(capability?.cockroachdb_tools ?? []),
    ...(capability?.aws_services ?? []),
  ]
  return (
    <aside className="verify panel" aria-labelledby="verify-title">
      <div className="section-heading">
        <div><span>Verify the claim</span><h2 id="verify-title">Proof ledger</h2></div>
      </div>
      <div className="tab-list tab-list--small" role="tablist" aria-label="Proof views">
        <button role="tab" aria-selected={tab === 'trace'} onClick={() => onTab('trace')}>current trace</button>
        <button role="tab" aria-selected={tab === 'system'} onClick={() => onTab('system')}>system map</button>
      </div>
      {tab === 'trace' && <TraceView event={event} detail={detail} memory={memory} />}
      {tab === 'system' && (
        <div className="system-list">
          {systemNodes.map((node) => (
            <article key={node.id} data-active={activeCapability === node.id || undefined} data-status={node.status}>
              <header><strong>{node.name}</strong><span>{node.status}</span></header>
              <p>{node.role}</p>
              <small>{node.evidence}</small>
              <code>{node.evidence_ref}</code>
            </article>
          ))}
          {!systemNodes.length && <p className="empty-state">Capability evidence is unavailable; no system status is inferred.</p>}
        </div>
      )}
      <div className="trace-identifiers">
        <span>Current identifiers</span>
        <dl>
          <div><dt>memory</dt><dd><code>{shortId(memory?.memory_id)}</code></dd></div>
          <div><dt>event</dt><dd><code>{shortId(event?.event_id)}</code></dd></div>
          <div><dt>attempt</dt><dd><code>{shortId(event?.attempt_id)}</code></dd></div>
          <div title={unavailable.get('cockroachdb_transaction_id')}><dt>CRDB transaction</dt><dd>unavailable</dd></div>
          <div title={unavailable.get('aws_xray_trace_id')}><dt>AWS trace</dt><dd>unavailable</dd></div>
        </dl>
      </div>
    </aside>
  )
}

function CapabilityIndex({ capability, state, onSelect }: {
  capability: CapabilityResponse | null
  state: LoadState
  onSelect: (target: string) => void
}) {
  const lifecycle = capability?.lifecycle ?? []
  const systems = [...(capability?.cockroachdb_tools ?? []), ...(capability?.aws_services ?? [])]
  return (
    <nav className="capabilities" aria-label="Capability index">
      <span>Capability access <small>{state}</small></span>
      <div>
        {lifecycle.map((item) => (
          <button key={`lifecycle-${item.id}`} data-status={item.status} title={item.evidence} onClick={() => onSelect(`lifecycle-${item.id}`)}>
            {item.id.replaceAll('_', ' ')} <i>{item.status.replaceAll('_', ' ')}</i>
          </button>
        ))}
        {systems.map((item) => (
          <button key={item.id} data-status={item.status} title={item.evidence} onClick={() => onSelect(item.id)}>
            {item.name} <i>{item.status.replaceAll('_', ' ')}</i>
          </button>
        ))}
        {!lifecycle.length && !systems.length && <span className="capabilities__empty">No capability response; nothing is claimed.</span>}
      </div>
    </nav>
  )
}

export function EvidenceApp() {
  const [snapshot, setSnapshot] = useState<EvidenceSnapshot | null>(null)
  const [snapshotState, setSnapshotState] = useState<LoadState>('loading')
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [activityState, setActivityState] = useState<LoadState>('loading')
  const [capability, setCapability] = useState<CapabilityResponse | null>(null)
  const [capabilityState, setCapabilityState] = useState<LoadState>('loading')
  const [activityTruncated, setActivityTruncated] = useState(false)
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<ActivityEvent | null>(null)
  const [detail, setDetail] = useState<MemoryDetail | null>(null)
  const [detailState, setDetailState] = useState<LoadState>('idle')
  const [stageFilter, setStageFilter] = useState<StageFilter>('all')
  const [explainTab, setExplainTab] = useState<ExplainTab>('overview')
  const [verifyTab, setVerifyTab] = useState<VerifyTab>('trace')
  const [activeCapability, setActiveCapability] = useState<string | null>(null)
  const [judgeStep, setJudgeStep] = useState(() => new URLSearchParams(location.search).get('demo') === 'judge' ? 0 : -1)
  const cursorRef = useRef<string | null>(null)
  const hasSnapshotRef = useRef(false)

  const memories = useMemo(() => flattenSnapshot(snapshot), [snapshot])
  const memoryIndex = useMemo(() => new Map(memories.map((memory) => [memory.memory_id, memory])), [memories])
  const selectedMemory = selectedMemoryId ? memoryIndex.get(selectedMemoryId) ?? null : null

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      if (!hasSnapshotRef.current) setSnapshotState('loading')
      try {
        const next = await fetchSnapshot(controller.signal)
        hasSnapshotRef.current = true
        setSnapshot(next)
        setSnapshotState('connected')
        setSnapshotError(null)
      } catch (error) {
        if (controller.signal.aborted) return
        setSnapshotState(hasSnapshotRef.current ? 'degraded' : 'failed')
        setSnapshotError(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    const interval = window.setInterval(() => void load(), 60_000)
    return () => { controller.abort(); window.clearInterval(interval) }
  }, []) // snapshot refresh is a whole server truth replacement; no client decay

  useEffect(() => {
    const controller = new AbortController()
    let timer = 0
    const poll = async (initial: boolean) => {
      if (initial) setActivityState('loading')
      try {
        const batch = await fetchActivityBatch(initial ? null : cursorRef.current, controller.signal)
        if (controller.signal.aborted) return
        cursorRef.current = batch.cursor
        setActivity((current) => mergeEvents(initial ? [] : current, batch.events))
        setActivityTruncated(batch.truncated)
        setActivityState('connected')
      } catch {
        if (!controller.signal.aborted) setActivityState((current) => current === 'loading' ? 'failed' : 'degraded')
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(false), 8_000)
      }
    }
    void poll(true)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        const next = await fetchCapabilities(controller.signal)
        setCapability(next)
        setCapabilityState(next.status === 'connected' ? 'connected' : 'degraded')
      } catch {
        if (!controller.signal.aborted) setCapabilityState((current) => current === 'loading' ? 'failed' : 'degraded')
      }
    }
    void load()
    const interval = window.setInterval(() => void load(), 60_000)
    return () => { controller.abort(); window.clearInterval(interval) }
  }, [])

  useEffect(() => {
    if (!memories.length) return
    if (selectedMemoryId && memoryIndex.has(selectedMemoryId)) return
    const best = [...memories].sort((a, b) =>
      (b.credited + b.blamed) - (a.credited + a.blamed) || b.effective_strength - a.effective_strength)[0]
    setSelectedMemoryId(best.memory_id)
  }, [memories, memoryIndex, selectedMemoryId])

  useEffect(() => {
    if (!selectedMemoryId) { setDetail(null); setDetailState('idle'); return }
    const controller = new AbortController()
    setDetail(null)
    setDetailState('loading')
    void fetchMemoryDetail(selectedMemoryId, controller.signal)
      .then((next) => { setDetail(next); setDetailState('connected') })
      .catch(() => { if (!controller.signal.aborted) setDetailState('failed') })
    return () => controller.abort()
  }, [selectedMemoryId])

  const selectMemory = (memoryId: string) => {
    setSelectedMemoryId(memoryId)
    setSelectedEvent(null)
    setExplainTab('overview')
  }

  const selectEvent = (event: ActivityEvent) => {
    setSelectedEvent(event)
    const target = eventMemoryIds(event).find((memoryId) => memoryIndex.has(memoryId))
    if (target) setSelectedMemoryId(target)
    if (event.kind === 'recall') setExplainTab('receipt')
    else if (event.kind === 'outcome') setExplainTab('plasticity')
    else setExplainTab('overview')
    setVerifyTab('trace')
  }

  const chooseCapability = (target: string) => {
    setActiveCapability(target)
    setVerifyTab('system')
  }

  const advanceJudge = () => {
    const next = (judgeStep + 1) % 4
    setJudgeStep(next)
    if (next === 0) { setStageFilter('all'); setExplainTab('overview'); setVerifyTab('trace') }
    if (next === 1) {
      const recall = activity.find((event) => event.kind === 'recall' && eventMemoryIds(event).some((id) => memoryIndex.has(id)))
      if (recall) selectEvent(recall)
      setStageFilter('recall'); setExplainTab('receipt')
    }
    if (next === 2) {
      const outcome = activity.find(eventHasAppliedChange)
      if (outcome) selectEvent(outcome)
      setStageFilter('plasticity'); setExplainTab('plasticity')
    }
    if (next === 3) { setVerifyTab('system'); setActiveCapability('distributed_vector_indexing') }
  }

  const connected = snapshotState === 'connected' && activityState === 'connected' && capabilityState === 'connected'
  return (
    <div className="evidence-shell">
      <header className="topbar">
        <div className="brand"><span>TIDEMARK</span><strong>Evidence console</strong></div>
        <p className="thesis">Recall stirs the surface. Outcomes leave the mark.</p>
        <div className="topbar__status">
          <StatusPill state={connected ? 'connected' : snapshotState === 'failed' ? 'failed' : 'degraded'} label={connected ? 'viz connected' : 'data degraded'} />
          <span><b>{snapshot?.total_memories ?? '—'}</b> memories</span>
          <span><b>{snapshot?.agent_id ?? 'unavailable'}</b> agent</span>
        </div>
      </header>

      <LifecycleRail active={stageFilter} events={activity} onChange={setStageFilter} />

      {snapshotError && <div className="error-banner" role="alert">
        {snapshot ? 'Snapshot refresh failed; displaying the last verified snapshot' : 'Snapshot unavailable'}: {snapshotError}. The page will retry without inventing data.
      </div>}

      <main className="workspace">
        <aside className="observe panel" aria-labelledby="observe-title">
          <div className="section-heading">
            <div><span>Observe the system</span><h1 id="observe-title">Memory tide</h1></div>
            <small>{snapshot?.capped ? 'latest slice' : 'complete snapshot'}</small>
          </div>
          <TideMap memories={memories} fadeThreshold={snapshot?.fade_threshold ?? 0.15} selectedId={selectedMemoryId} onSelect={selectMemory} />
          <div className="tide-stats">
            <span><i className="dot dot--held" />held {memories.filter((memory) => memory.pinned || memory.effective_strength >= 0.7).length}</span>
            <span><i className="dot dot--active" />active {memories.filter((memory) => !memory.pinned && memory.effective_strength < 0.7 && memory.effective_strength > 0.35).length}</span>
            <span><i className="dot dot--fading" />receding {memories.filter((memory) => !memory.pinned && memory.effective_strength <= 0.35).length}</span>
          </div>
          <EventStream events={activity} selected={selectedEvent} filter={stageFilter} state={activityState} onSelect={selectEvent} />
          {activityTruncated && <p className="data-note">Activity history exceeded the five-page display budget; the cursor remains resumable.</p>}
        </aside>

        <Inspector memory={selectedMemory} detail={detail} state={detailState} tab={explainTab} onTab={setExplainTab} />

        <VerifyPane tab={verifyTab} onTab={setVerifyTab} event={selectedEvent} detail={detail} memory={selectedMemory} activeCapability={activeCapability} capability={capability} />
      </main>

      <CapabilityIndex capability={capability} state={capabilityState} onSelect={chooseCapability} />

      <footer className="judge-rail" data-active={judgeStep >= 0 || undefined}>
        <div><span>Judge mode</span><strong>{judgeStep >= 0 ? `Read-only walkthrough · step ${judgeStep + 1}/4` : 'Guided evidence path'}</strong></div>
        <p>Current shell navigates persisted evidence only. The write-path run remains unavailable until its real API contract lands.</p>
        <button onClick={advanceJudge}>{judgeStep < 0 ? 'Open walkthrough' : 'Next evidence'}</button>
      </footer>
      <p className="snapshot-note">Snapshot {snapshot ? dateLabel(snapshot.snapshot_at) : 'unavailable'} · viewer scope · client-side decay disabled</p>
    </div>
  )
}
