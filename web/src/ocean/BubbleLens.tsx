// 水泡透镜（批4）：点一颗记忆，从它所在处长出一只水泡，详情悬浮在泡里。
// 零方框宪法：泡是 radial-gradient 膜 + 弧形高光 + backdrop blur，无边框无卡片；
// 关闭 = 泡破（快速 scale+淡出，reduced-motion 下直接消失）。
// 命中来自 hitTestOcean（唯一坐标真相），本组件只负责呈现与生命周期。
import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import type { VizMemory } from './types'

export type LensTarget = { m: VizMemory; episode_id: string | null; sx: number; sy: number }
type Props = { target: LensTarget; onClose: () => void }

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined,
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export const BubbleLens = ({ target, onClose }: Props) => {
  const ref = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const { m } = target

  // 泡从点击点长出（elastic），泡破 = 短促胀裂
  useEffect(() => {
    const el = ref.current!
    if (!reduced) {
      gsap.fromTo(el, { scale: 0.15, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.55, ease: 'elastic.out(1, 0.55)' })
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') pop() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint 无此仓；依赖刻意为空——target 变化由 key 重挂
  }, [])

  const pop = () => {
    if (closingRef.current) return
    closingRef.current = true
    const el = ref.current
    if (reduced || !el) { onClose(); return }
    gsap.timeline({ onComplete: onClose })
      .to(el, { scale: 1.14, opacity: 0, duration: 0.16, ease: 'power2.in' })
  }

  // 泡心尽量在点击处，但钳进视口
  const W = window.innerWidth, H = window.innerHeight
  const cx = Math.min(W - 190, Math.max(190, target.sx))
  const cy = Math.min(H - 170, Math.max(170, target.sy))

  const state = m.pinned ? 'pinned ashore'
    : m.effective_strength < 0.15 ? 'bleaching away'
    : `strength ${(m.effective_strength * 100).toFixed(0)}%`

  return (
    <div onPointerDown={pop} role="dialog" aria-label={`memory detail, ${state}`}
      style={{ position: 'fixed', inset: 0, zIndex: 10 }}>
      <div ref={ref} onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', left: cx, top: cy, width: 360, height: 300,
          transform: 'translate(-50%, -50%)', transformOrigin: '50% 50%',
          marginLeft: -0, borderRadius: '50%',
          background: 'radial-gradient(ellipse at 42% 38%, rgba(235,251,253,0.20), rgba(190,228,236,0.12) 52%, rgba(150,205,220,0.05) 68%, transparent 74%)',
          backdropFilter: 'blur(7px) saturate(1.15)', WebkitBackdropFilter: 'blur(7px) saturate(1.15)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', padding: '52px 58px', boxSizing: 'border-box',
          color: '#fdfbf5',
          textShadow: '0 0 6px rgba(6,20,40,0.95), 0 0 20px rgba(6,20,40,0.8)',
        }}>
        {/* 弧形高光：泡的上左缘一道光，泡之所以是泡 */}
        <svg aria-hidden="true" viewBox="0 0 100 100" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <path d="M 22 30 A 34 30 0 0 1 55 12" fill="none" stroke="rgba(245,253,255,0.55)"
            strokeWidth="2.2" strokeLinecap="round" />
          <path d="M 70 84 A 36 32 0 0 0 84 62" fill="none" stroke="rgba(245,253,255,0.22)"
            strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <em style={{ fontSize: 13, opacity: 0.85 }}>
          {state}{m.kind ? ` · ${m.kind}` : ''}{m.layer === 'experience' ? ` · pearl (${m.exp_status})` : ''}
        </em>
        <p style={{ fontSize: 14, lineHeight: 1.65, margin: '10px 0 8px' }}>{m.content_preview}</p>
        <em style={{ fontSize: 11.5, opacity: 0.65, lineHeight: 1.6 }}>
          born {fmt(m.created_at)}
          {m.credited > 0 ? ` · credited x${m.credited}` : ''}
          {m.blamed > 0 ? ` · blamed x${m.blamed}` : ''}
          <br />the tide keeps its receipt. click outside or press ESC to let it go.
        </em>
      </div>
    </div>
  )
}
