// 水泡透镜（批4，四审修订）：点一颗记忆，从它所在处长出一只水泡，详情悬浮在泡里。
// 零方框宪法：泡是 radial-gradient 膜 + 弧形高光 + backdrop blur，无边框无卡片。
// 四审 P1 落点：
//   - 焦点接管：dialog mount 即 focus（tabIndex=-1）+ aria-modal，背景由 App inert 约束；
//     关闭焦点归还 opener（App 负责记录）。
//   - GSAP 生命周期：useGSAP scope 自动 revert；关闭经 contextSafe + overwrite 杀入场 tween。
//   - ESC/键盘 = 立即关闭（不强制播破泡动画）；指针泡外点击 = 破泡（短促 ease-out）。
//   - bleached 判定由命中方传入（唯一阈值真相源在服务端 snapshot），本组件绝不比较 0.15。
import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import type { VizMemory } from './types'

export type LensTarget = { m: VizMemory; episode_id: string | null; sx: number; sy: number; bleached: boolean
  animateEntrance: boolean }   // 五审 P1：键盘触发不动画——只有指针路径播泡生长
type Props = { target: LensTarget; onClose: () => void }

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined,
  { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

// 透底可读性双闸：浏览器不支持 backdrop-filter，或用户偏好减少透明（五审非阻塞项补齐）
const wantsOpaque = () =>
  (typeof CSS === 'undefined'
    || !(CSS.supports('backdrop-filter: blur(1px)') || CSS.supports('-webkit-backdrop-filter: blur(1px)')))
  || window.matchMedia('(prefers-reduced-transparency: reduce)').matches

export const BubbleLens = ({ target, onClose }: Props) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const { m } = target

  const opaque = wantsOpaque()
  const { contextSafe } = useGSAP(() => {
    if (!reduced && target.animateEntrance) {   // 键盘 Enter 直显（五审 P1），指针才看泡生长
      gsap.fromTo(bubbleRef.current, { scale: 0.15, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.55, ease: 'elastic.out(1, 0.55)' })
    }
  }, { scope: rootRef })

  // 指针路径：破泡动画（overwrite 杀掉可能还在弹的入场 tween，短促 ease-out）
  const pop = contextSafe(() => {
    if (closingRef.current) return
    closingRef.current = true
    if (reduced || !bubbleRef.current) { onClose(); return }
    gsap.to(bubbleRef.current, { scale: 1.12, opacity: 0, duration: 0.14,
      ease: 'power2.out', overwrite: true, onComplete: onClose })
  })

  // 键盘路径：立即关闭，不强制观赏动画；mount 即接管焦点
  useEffect(() => {
    rootRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (!closingRef.current) { closingRef.current = true; onClose() } }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 泡心尽量在点击处，但钳进视口
  const W = window.innerWidth, H = window.innerHeight
  const cx = Math.min(W - 190, Math.max(190, target.sx))
  const cy = Math.min(H - 170, Math.max(170, target.sy))

  const state = m.pinned ? 'pinned ashore'
    : target.bleached ? 'bleaching away'
    : `strength ${(m.effective_strength * 100).toFixed(0)}%`

  return (
    <div ref={rootRef} onPointerDown={pop} role="dialog" aria-modal="true" tabIndex={-1}
      aria-label={`memory detail, ${state}`}
      style={{ position: 'fixed', inset: 0, zIndex: 10, outline: 'none' }}>
      <div ref={bubbleRef} onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', left: cx, top: cy, width: 360, height: 300,
          transform: 'translate(-50%, -50%)', transformOrigin: '50% 50%',
          borderRadius: '50%',
          // 无 backdrop-filter 支持时加深膜底，不靠透底也可读（四审顺手项）
          background: !opaque
            ? 'radial-gradient(ellipse at 42% 38%, rgba(235,251,253,0.20), rgba(190,228,236,0.12) 52%, rgba(150,205,220,0.05) 68%, transparent 74%)'
            : 'radial-gradient(ellipse at 42% 38%, rgba(20,52,70,0.88), rgba(16,44,62,0.82) 58%, rgba(12,34,52,0.5) 70%, transparent 76%)',
          backdropFilter: !opaque ? 'blur(7px) saturate(1.15)' : undefined,
          WebkitBackdropFilter: !opaque ? 'blur(7px) saturate(1.15)' : undefined,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', padding: '52px 58px', boxSizing: 'border-box',
          color: '#fdfbf5',
          textShadow: '0 0 6px rgba(6,20,40,0.95), 0 0 20px rgba(6,20,40,0.8)',
        }}>
        <svg aria-hidden="true" viewBox="0 0 100 100" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <path d="M 22 30 A 34 30 0 0 1 55 12" fill="none" stroke="rgba(245,253,255,0.55)"
            strokeWidth="2.2" strokeLinecap="round" />
          <path d="M 70 84 A 36 32 0 0 0 84 62" fill="none" stroke="rgba(245,253,255,0.22)"
            strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <em style={{ fontSize: 13, opacity: 0.85 }}>
          {state}{m.kind ? ` · ${m.kind}` : ''}{m.layer === 'experience' ? `, pearl (${m.exp_status})` : ''}
        </em>
        <p style={{ fontSize: 14, lineHeight: 1.65, margin: '10px 0 8px' }}>{m.content_preview}</p>
        <em style={{ fontSize: 11.5, opacity: 0.65, lineHeight: 1.6 }}>
          born {fmt(m.created_at)}
          {m.credited > 0 ? `, credited x${m.credited}` : ''}
          {m.blamed > 0 ? `, blamed x${m.blamed}` : ''}
          <br />the tide keeps its receipt. click outside or press ESC to let it go.
        </em>
      </div>
    </div>
  )
}
