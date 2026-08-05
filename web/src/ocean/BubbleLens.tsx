// 泡内文字层（V-8 重构）：泡的全部视觉（折射膜/rim/生长/缩回）归 OceanCanvas 的
// 场景实体管线——本组件只剩三职：泡内凝出的文字内容、焦点/aria/键盘语义、关闭手势捕获。
// 定位与透明度由画布逐帧直写（与 caption 同源手法），React 零参与帧循环。
import { useEffect, useRef, type RefObject } from 'react'
import type { VizMemory } from './types'

export type LensTarget = { m: VizMemory; episode_id: string | null; sx: number; sy: number; bleached: boolean
  animateEntrance: boolean }
type Props = { target: LensTarget; onClose: () => void; textRef: RefObject<HTMLDivElement | null> }

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined,
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export const BubbleLens = ({ target, onClose, textRef }: Props) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const { m } = target

  const close = () => { if (!closingRef.current) { closingRef.current = true; onClose() } }

  useEffect(() => {
    rootRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // close 経 closingRef 幂等；依赖刻意为空——target 变化由 key 重挂
  }, [])

  const state = m.pinned ? 'pinned ashore'
    : target.bleached ? 'bleaching away'
    : `strength ${(m.effective_strength * 100).toFixed(0)}%`

  return (
    <div ref={rootRef} onPointerDown={close} role="dialog" aria-modal="true" tabIndex={-1}
      aria-label={`memory detail, ${state}`}
      style={{ position: 'fixed', inset: 0, zIndex: 10, outline: 'none' }}>
      <div ref={textRef} onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', left: 0, top: 0, opacity: 0,
          textAlign: 'center', color: '#fdfbf5', pointerEvents: 'auto',
          textShadow: '0 0 6px rgba(4,14,30,0.95), 0 0 18px rgba(4,14,30,0.8)',
        }}>
        <em style={{ fontSize: 13, opacity: 0.85 }}>
          {state}{m.kind ? ` · ${m.kind}` : ''}{m.layer === 'experience' ? `, pearl (${m.exp_status})` : ''}
        </em>
        <p style={{ fontSize: 14, lineHeight: 1.6, margin: '8px 0 6px' }}>{m.content_preview}</p>
        <em style={{ fontSize: 11, opacity: 0.65, lineHeight: 1.55 }}>
          born {fmt(m.created_at)}
          {m.credited > 0 ? `, credited x${m.credited}` : ''}
          {m.blamed > 0 ? `, blamed x${m.blamed}` : ''}
          <br />click outside or press ESC to let it go.
        </em>
      </div>
    </div>
  )
}
