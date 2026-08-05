// Tidemark 海景壳：拉单快照（契约#2）+ 轮询浪流（契约#3，游标去重）+ 零方框悬停字幕
// + 可访问性 DOM 镜像（契约#4：视觉零按钮不等于语义零按钮）
import { useCallback, useEffect, useRef, useState } from 'react'
import { OceanCanvas, type FoamWave, type HoverInfo } from './ocean/OceanCanvas'
import type { OceanSnapshot, WavesPage } from './ocean/types'

const KEY = import.meta.env.VITE_TIDEMARK_KEY ?? 'spike-demo-key'
const HDR = { 'x-tidemark-auth': KEY }

export const App = () => {
  const [snap, setSnap] = useState<OceanSnapshot | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [waves, setWaves] = useState<FoamWave[]>([])
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const cursorRef = useRef<string | null>(null)   // keyset 游标（契约#3：刷新/StrictMode 重放天然去重）
  const seenRef = useRef<Set<string>>(new Set())
  const primedRef = useRef(false)                 // 首页浪只推游标不上屏（历史不是新浪）

  useEffect(() => {
    let dead = false
    const pull = async () => {
      try {
        const r = await fetch('/viz/ocean', { headers: HDR })
        const j = await r.json()
        if (!dead && j.ok) { setSnap(j as OceanSnapshot); setErr(null) }
        else if (!dead && !j.ok) setErr(String(j.error))
      } catch (e) { if (!dead) setErr(String(e)) }
    }
    pull()
    const iv = setInterval(pull, 60_000)   // 快照整体换新，客户端绝不本地衰减
    return () => { dead = true; clearInterval(iv) }
  }, [])

  useEffect(() => {
    let dead = false
    const poll = async () => {
      try {
        const q = cursorRef.current ? `?after=${encodeURIComponent(cursorRef.current)}` : ''
        const r = await fetch(`/viz/waves${q}`, { headers: HDR })
        const j = (await r.json()) as WavesPage
        if (dead || !j.ok) return
        if (j.cursor) cursorRef.current = j.cursor
        if (!primedRef.current) { primedRef.current = true; j.waves.forEach((w) => seenRef.current.add(w.request_id)); return }
        const fresh = j.waves.filter((w) => !seenRef.current.has(w.request_id))
        if (fresh.length > 0) {
          fresh.forEach((w) => seenRef.current.add(w.request_id))
          const t = performance.now()
          setWaves((prev) => [...prev.filter((w) => t - w.arrivedAt < 5000),
            ...fresh.map((w) => ({ request_id: w.request_id, episode_id: w.episode_id, arrivedAt: t }))])
        }
      } catch { /* 浪断了不吵，下一轮再来 */ }
    }
    poll()
    const iv = setInterval(poll, 8_000)
    return () => { dead = true; clearInterval(iv) }
  }, [])

  const onHover = useCallback((h: HoverInfo | null) => setHover(h), [])

  return (
    <main style={{ position: 'absolute', inset: 0 }} aria-label="Tidemark memory ocean">
      {snap && <OceanCanvas snap={snap} waves={waves} onHover={onHover} />}
      {!snap && (
        <p style={{ color: '#cfe8ea', textAlign: 'center', marginTop: '40vh', fontStyle: 'italic' }}>
          {err ? `the sea is unreachable — ${err}` : 'listening for the tide...'}
        </p>
      )}
      {hover && (
        <div style={{
          position: 'absolute', left: hover.sx + 14, top: hover.sy - 10, maxWidth: 300,
          pointerEvents: 'none', color: '#fdfbf5', fontSize: 13, lineHeight: 1.5,
          textShadow: '0 0 6px rgba(6,20,40,0.95), 0 0 18px rgba(6,20,40,0.85), 0 0 34px rgba(6,20,40,0.7)',
        }}>
          <em style={{ opacity: 0.85 }}>
            {hover.pinned ? 'pinned ashore' : hover.bleached ? 'bleaching away' : `strength ${(hover.strength * 100).toFixed(0)}%`}
            {hover.kind ? ` · ${hover.kind}` : ''}
          </em>
          <br />{hover.preview}
        </div>
      )}
      {/* 可访问性镜像：键盘可达的语义清单，视觉上离屏（契约#4） */}
      <nav aria-label="memories as list" style={{ position: 'absolute', left: -9999, top: 0 }}>
        {snap?.episodes.map((ep) => (
          <ul key={ep.episode_id} aria-label={`episode ${ep.episode_id}`}>
            {ep.memories.map((m) => (
              <li key={m.memory_id}>
                {m.pinned ? '[pinned] ' : ''}{m.kind ?? 'memory'} at {(m.effective_strength * 100).toFixed(0)}%: {m.content_preview}
              </li>
            ))}
          </ul>
        ))}
      </nav>
      {snap && (
        <p style={{ position: 'absolute', right: 16, bottom: 8, margin: 0, color: 'rgba(220,238,240,0.5)',
          fontSize: 11, fontStyle: 'italic', pointerEvents: 'none' }}>
          snapshot {new Date(snap.snapshot_at).toLocaleTimeString()} · {snap.episodes.reduce((a, e) => a + e.memories.length, 0)} memories · fade line {snap.fade_threshold}
        </p>
      )}
    </main>
  )
}
