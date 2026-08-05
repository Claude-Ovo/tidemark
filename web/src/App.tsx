// Tidemark 海景壳：滚动=下潜（450vh 深潜轨，ScrollTrigger 喂相机 ref，零 rerender）。
// 数据契约不变：单快照 60s 整体换新（#2）、浪流 keyset 游标去重（#3）、
// 语义镜像 + reduced-motion 等价路径（#4）。
// 一审 P0-1：bundle 里【零密钥】——dev 由 Vite 代理注入 header，
// 生产由 CloudFront 给源站请求贴 origin custom header，浏览器永远不持有凭证。
import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import { OceanCanvas, loadMasterArt, type FoamWave, type OpenTarget } from './ocean/OceanCanvas'
import { BubbleLens } from './ocean/BubbleLens'
import { depthEase, WORLD, setDepthScale } from './ocean/layout-core.mjs'
import type { OceanSnapshot, VizMemory, WavesPage } from './ocean/types'

gsap.registerPlugin(ScrollTrigger, useGSAP)

// 下潜途中的注脚（世界深度 -> 滚动轨位置；零方框，纯柔光文字）
// 注脚改百分比定位（世界=图，track 高度动态）：位置随图内区域走，与缩放无关
const DIVE_NOTES = [
  { top: '3%', side: 'left', title: 'the shore', body: 'pinned memories stay above the tide. the sea is told it may not take them.' },
  { top: '30%', side: 'right', title: 'the living water', body: 'strong memories float near the light. every particle\'s depth is its real, server-computed strength.' },
  { top: '48%', side: 'left', title: 'episodes drift as bubbles', body: 'each bubble holds what one episode gathered. hover anything to hear it whisper.' },
  { top: '66%', side: 'right', title: 'the fade line', body: 'below this depth, forgetting has begun. nothing is deleted; it only sinks.' },
  { top: '82%', side: 'left', title: 'the bleached coral', body: 'what the sea let go rests here, colorless but recoverable. recall can still reach it by name.' },
] as const

// 键盘巡航要把相机送到记忆所在深度：世界纵座标从强度按同一公式估算（近似即可，导航语义）。
// 阈值必须来自当前 snapshot（四审 P1：0.15 不许在客户端再长出第二真相源）
const scrollToMemory = (m: VizMemory, fadeThreshold: number) => {
  const worldY = m.pinned ? (WORLD.skyEnd + WORLD.beachEnd) / 2
    : m.effective_strength < fadeThreshold ? (WORLD.waterEnd + 0.96) / 2
    : WORLD.beachEnd + depthEase(1 - m.effective_strength) * (WORLD.waterEnd - WORLD.beachEnd)
  const H = window.innerHeight
  const target = worldY * H * WORLD.DEPTH_SCALE - H / 2
  window.scrollTo({ top: Math.max(0, Math.min(target, H * (WORLD.DEPTH_SCALE - 1))), behavior: 'auto' })
}

export const App = () => {
  const [snap, setSnap] = useState<OceanSnapshot | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [waves, setWaves] = useState<FoamWave[]>([])
  const [lens, setLens] = useState<OpenTarget | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [trackVh, setTrackVh] = useState(WORLD.DEPTH_SCALE * 100)
  const openerRef = useRef<HTMLElement | null>(null)   // 透镜关闭后焦点归还给打开它的元素
  const lensTextRef = useRef<HTMLDivElement | null>(null)   // 泡内文字层，OceanCanvas 逐帧定位
  const openLens = (t: OpenTarget) => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // V-8 相机小幅让位：泡锚在世界原位，滚动把它送到视口 45% 附近（限幅，不是跳转）
    const delta = Math.max(-innerHeight * 0.3, Math.min(innerHeight * 0.3, t.sy - innerHeight * 0.45))
    if (Math.abs(delta) > innerHeight * 0.1) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      window.scrollBy({ top: delta, behavior: reduced ? 'auto' : 'smooth' })
    }
    setLens(t)
  }
  const closeLens = () => setLens(null)
  // 五审 P1：恢复必须发生在 lens=false【提交之后】——同一调用里 focus() 时 nav 还 inert，
  // 浏览器会拒绝聚焦、焦点落 BODY。effect 在 commit 后跑，inert 已解除，且校验 opener 仍在文档里。
  useEffect(() => {
    if (lens !== null) return
    const el = openerRef.current
    openerRef.current = null
    if (el?.isConnected) el.focus()
  }, [lens])
  const cameraRef = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<string | null>(null)   // keyset 游标（契约#3）
  const seenRef = useRef<Set<string>>(new Set())
  const primedRef = useRef(false)                 // 首页浪只推游标不上屏（历史不是新浪）

  // 世界深度 = 图自然比例（六审：宁短勿拉）；视口变化时重算
  useEffect(() => {
    let dead = false
    const applyScale = async () => {
      const img = await loadMasterArt()
      if (dead || !img) return
      const scale = (img.naturalHeight / img.naturalWidth) * (window.innerWidth / window.innerHeight)
      setDepthScale(scale)
      setTrackVh(WORLD.DEPTH_SCALE * 100)
    }
    applyScale()
    window.addEventListener('resize', applyScale)
    return () => { dead = true; window.removeEventListener('resize', applyScale) }
  }, [])

  useEffect(() => {
    let dead = false
    const pull = async () => {
      try {
        const r = await fetch('/viz/ocean')
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
        const r = await fetch(`/viz/waves${q}`)
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

  useEffect(() => { ScrollTrigger.refresh() }, [trackVh])

  useGSAP(() => {
    // 相机：滚动进度直写 ref（连续值不进 React state——与画布同一哲学）
    ScrollTrigger.create({
      trigger: trackRef.current, start: 'top top', end: 'bottom bottom',
      onUpdate: (self) => { cameraRef.current = self.progress },
    })
    // 注脚显隐：仅在用户未要求减少动效时上 scrub 渐入渐出；reduced 下静态可读
    gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
      gsap.utils.toArray<HTMLElement>('.dive-note').forEach((el) => {
        gsap.timeline({
          scrollTrigger: { trigger: el, start: 'top 92%', end: 'bottom 8%', scrub: 0.6 },
        })
          .fromTo(el, { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.35, ease: 'none' })
          .to(el, { opacity: 1, duration: 0.4, ease: 'none' })
          .to(el, { opacity: 0, y: -18, duration: 0.25, ease: 'none' })
      })
    })
  }, { scope: rootRef })

  return (
    <div ref={rootRef}>
      {/* 溶边字层（P2-7）：feTurbulence 位移把字缘碎化成泼溅质感，bloom 由柔光 shadow 给 */}
      <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
        <filter id="splat-edge" x="-12%" y="-12%" width="124%" height="124%">
          <feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="2" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="4.2" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <style>{'.splat-text { filter: url(#splat-edge); }'}</style>
      <div style={{ position: 'fixed', inset: 0 }} aria-hidden="true">
        {snap && <OceanCanvas snap={snap} waves={waves} cameraRef={cameraRef}
          onOpen={openLens} highlightId={focusId} worldScale={trackVh}
          openTarget={lens} lensTextRef={lensTextRef} />}
        {!snap && (
          <p style={{ color: '#cfe8ea', textAlign: 'center', marginTop: '40vh', fontStyle: 'italic' }}>
            {err ? `the sea is unreachable: ${err}` : 'listening for the tide...'}
          </p>
        )}
      </div>
      {/* 深潜轨：给文档高度，让整片海可以滚出来；事件穿透到画布 */}
      <main ref={trackRef} aria-label="Tidemark memory ocean, scroll to dive"
        inert={lens ? true : undefined}
        style={{ height: `${trackVh}vh`, position: 'relative', zIndex: 1, pointerEvents: 'none' }}>
        {DIVE_NOTES.map((n) => (
          <section key={n.title} className="dive-note" style={{
            position: 'absolute', top: n.top,
            ...(n.side === 'right' ? { right: '7vw' } : { left: '7vw' }),
            textAlign: n.side === 'right' ? 'right' : 'left',
            maxWidth: '36ch', color: '#fdfbf5',
            textShadow: '0 0 8px rgba(6,20,40,0.9), 0 0 26px rgba(6,20,40,0.75)',
          }}>
            <h2 className="splat-text" style={{ font: 'italic 400 clamp(20px, 2.6vw, 30px) Georgia, serif', margin: 0 }}>{n.title}</h2>
            <p style={{ fontSize: 14, lineHeight: 1.7, opacity: 0.92, marginTop: 6 }}>{n.body}</p>
          </section>
        ))}
      </main>
      {/* 可访问性镜像：键盘可达的语义清单，视觉离屏（契约#4） */}
      <nav aria-label="memories as list, focus to highlight, enter to open"
        inert={lens ? true : undefined}
        style={{ position: 'absolute', left: -9999, top: 0 }}>
        {snap && [...snap.episodes, { episode_id: null, memories: snap.loose }].map((ep) => (
          <ul key={ep.episode_id ?? 'loose'} aria-label={`episode ${ep.episode_id ?? 'loose memories'}`}>
            {ep.memories.map((m) => (
              <li key={m.memory_id}>
                <button
                  onFocus={() => { setFocusId(m.memory_id); scrollToMemory(m, snap.fade_threshold) }}
                  onBlur={() => setFocusId((cur) => (cur === m.memory_id ? null : cur))}
                  onClick={(e) => openLens({ m, episode_id: ep.episode_id,
                    sx: window.innerWidth / 2, sy: window.innerHeight * 0.45,
                    bleached: !m.pinned && m.effective_strength < snap.fade_threshold,
                    animateEntrance: e.detail !== 0 })}>{/* detail=0 = 键盘激活：直显 */}
                  {m.pinned ? '[pinned] ' : ''}{m.kind ?? 'memory'} at {(m.effective_strength * 100).toFixed(0)}%: {m.content_preview}
                </button>
              </li>
            ))}
          </ul>
        ))}
      </nav>
      {lens && <BubbleLens key={lens.m.memory_id} target={lens} onClose={closeLens} textRef={lensTextRef} />}
      {snap && (
        <p style={{ position: 'fixed', right: 16, bottom: 8, margin: 0, color: 'rgba(220,238,240,0.55)',
          fontSize: 11, fontStyle: 'italic', pointerEvents: 'none', zIndex: 2 }}>
          snapshot {new Date(snap.snapshot_at).toLocaleTimeString()}, {snap.total_memories} memories, fade line {snap.fade_threshold}{snap.capped ? ', showing latest slice' : ''}
        </p>
      )}
    </div>
  )
}
