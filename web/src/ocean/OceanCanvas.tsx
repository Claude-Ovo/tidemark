// 海景画布 v1：世界坐标 4.5 屏深，滚动=下潜（相机进 ref 不进 state）。
// 一审动效修订全落在这：
//   A. 渲染循环单例——mount 建一次；snap/waves/camera 全走 ref 同步，绝不重建 rAF/backdrop
//   B. reduced-motion 真静态——呼吸停 + 空闲帧跳过绘制（脏帧标记），浪降级为静态潮痕
//   C. 悬停不打 React state——字幕内容仅在 memory_id 变化时 setState 一次，
//      跟随坐标直接写 DOM transform；连续指针值零 rerender
// 铁律不变：零方框零按钮；强度/深度全来自服务端快照，动画只做视觉呼吸不做衰减。
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { OceanSnapshot } from './types'
import { layoutOcean, type PlacedEpisode } from './layout'
import { hash01, WORLD, splatsPerMemory, hitTestOcean } from './layout-core.mjs'
import { FISH, GOLD_DUST, FOAM, memoryColor, pearlColor } from './palette'

export type FoamWave = { request_id: string; episode_id: string | null; arrivedAt: number }
export type OpenTarget = { m: import('./types').VizMemory; episode_id: string | null; sx: number; sy: number; bleached: boolean
  animateEntrance: boolean }
type Caption = { pinned: boolean; bleached: boolean; kind: string | null; strength: number; preview: string }
type Props = {
  snap: OceanSnapshot; waves: FoamWave[]; cameraRef: RefObject<number>
  onOpen: (t: OpenTarget) => void        // 点击命中一颗记忆 -> 交给透镜（同一 hitTestOcean）
  highlightId: string | null             // 键盘巡航聚焦的记忆（视觉高亮与 hover 同款）
}

// 淡出必须淡向【同色 alpha=0】——CSS 'transparent' 是 rgba(0,0,0,0)，
// 渐变会朝黑色插值，给每枚色粒镶一圈脏黑晕（v0 首屏截图实锤过）
const fade = (c: string): string =>
  c.startsWith('#') ? c + '00'
  : c.startsWith('hsl(') ? c.replace(')', ' / 0)')
  : c.replace(/[\d.]+\)\s*$/, '0)')

const splat = (ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number,
  rot: number, color: string, alpha: number, lighter = false) => {
  ctx.save()
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(1, ry / rx)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  g.addColorStop(0, color); g.addColorStop(0.62, color); g.addColorStop(1, fade(color))
  ctx.globalAlpha = alpha
  if (lighter) ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = g
  ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}

// 背景 v3（她拍板：参考图直接照搬当底图，不再手绘模仿）：
// ovo.jpg 顶段（天空->水线，图 0-40%）1:1 贴世界 0-15%，底段（深海珊瑚，图 74-100%）
// 贴世界 85-100%（轻拉伸 1.5x）；中段水体用图采样色渐变 + 程序化层（鱼群/光柱/光尘/水母）。
// 全部贴图过 saturate(72%) ——她钦定降淡 30%。图挂载失败自动退回纯渐变（fail-safe）。
let masterImg: HTMLImageElement | null = null
let masterLoading: Promise<void> | null = null
const loadMasterArt = () => {
  masterLoading ??= new Promise((res) => {
    const im = new Image()
    im.onload = () => { masterImg = im; res() }
    im.onerror = () => res()
    im.src = '/ocean-master.jpg'
  })
  return masterLoading
}

const fishSplat = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number,
  ang: number, alpha: number) => {
  splat(ctx, x, y, size, size * 0.42, ang, FISH, alpha)
  splat(ctx, x - Math.cos(ang) * size * 1.15, y - Math.sin(ang) * size * 0.5,
    size * 0.42, size * 0.3, ang + 0.55, FISH, alpha * 0.85)
}

// 贴图段 + 上下缘羽化（接缝融进渐变，不留硬线）
const drawSliceFeather = (ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  sy0: number, sy1: number, dy0: number, dy1: number, W: number,
  featherTop: number, featherBottom: number) => {
  const sh = img.naturalHeight, sw = img.naturalWidth
  const h = Math.max(1, Math.round(dy1 - dy0))
  const tmp = document.createElement('canvas')
  tmp.width = W; tmp.height = h
  const tc = tmp.getContext('2d')!
  tc.filter = 'saturate(72%) brightness(1.03)'
  tc.drawImage(img, 0, sy0 * sh, sw, (sy1 - sy0) * sh, 0, 0, W, h)
  tc.filter = 'none'
  tc.globalCompositeOperation = 'destination-out'
  if (featherTop > 0) {
    const g = tc.createLinearGradient(0, 0, 0, featherTop)
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)')
    tc.fillStyle = g; tc.fillRect(0, 0, W, featherTop)
  }
  if (featherBottom > 0) {
    const g = tc.createLinearGradient(0, h - featherBottom, 0, h)
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)')
    tc.fillStyle = g; tc.fillRect(0, h - featherBottom, W, featherBottom)
  }
  tc.globalCompositeOperation = 'source-over'
  ctx.drawImage(tmp, 0, Math.round(dy0))
}

const paintBackdrop = (c: HTMLCanvasElement, W: number, WORLD_H: number) => {
  const ctx = c.getContext('2d')!
  // 中段水体渐变：色标从参考图取样后降饱和（顶部天空色作贴图羽化的承接底）
  const lg = ctx.createLinearGradient(0, 0, 0, WORLD_H)
  lg.addColorStop(0, '#a9c9e6'); lg.addColorStop(0.13, '#8fd0d2')
  lg.addColorStop(0.16, '#7cc4c9'); lg.addColorStop(0.34, '#4f93c6')
  lg.addColorStop(0.52, '#2f5fab'); lg.addColorStop(0.7, '#1e3d85')
  lg.addColorStop(0.85, '#1b2c6c'); lg.addColorStop(1, '#14224f')
  ctx.fillStyle = lg; ctx.fillRect(0, 0, W, WORLD_H)

  // 印象派中层色粒（层次感，参考图的碎光质地）
  const midColors = ['#7cc4c9', '#4f93c6', '#2f5fab', '#1e3d85']
  for (let i = 0; i < 340; i++) {
    const y = 0.16 + hash01(`bg${i}`, 31) * 0.68
    splat(ctx, hash01(`bg${i}`, 37) * W, y * WORLD_H, (0.04 + hash01(`bg${i}`, 41) * 0.09) * W,
      (0.01 + hash01(`bg${i}`, 43) * 0.02) * WORLD_H, (hash01(`bg${i}`, 47) - 0.5) * 0.9,
      midColors[Math.floor(hash01(`bg${i}`, 49) * 4)], 0.035 + hash01(`bg${i}`, 53) * 0.05)
  }

  // 丁达尔光柱：宽软斜光束
  for (let r = 0; r < 5; r++) {
    const rx = 0.16 + r * 0.16 + hash01(`ray${r}`, 141) * 0.05
    const topY = WORLD.beachEnd + 0.012, len = 0.18 + hash01(`ray${r}`, 143) * 0.08
    for (let seg = 0; seg < 4; seg++) {
      const t = seg / 4
      splat(ctx, (rx + t * 0.05) * W, (topY + (t + 0.12) * len) * WORLD_H,
        (0.034 - t * 0.01) * W, len * WORLD_H * 0.34, 0.1,
        '#e6f3f6', (1 - t) * 0.038, true)
    }
  }

  // 鱼群洋流三条 + 漩涡一枚
  const bez = (p0: number[], p1: number[], p2: number[], t: number) => [
    (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
    (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
  ]
  const bands: Array<{ p: number[][]; n: number; s: number; a: number; flip?: boolean }> = [
    { p: [[0.02, 0.305], [0.45, 0.385], [0.9, 0.32]], n: 110, s: 1.0, a: 0.6 },
    { p: [[0.96, 0.47], [0.55, 0.555], [0.06, 0.5]], n: 88, s: 0.9, a: 0.5, flip: true },
    { p: [[0.04, 0.635], [0.5, 0.68], [0.94, 0.625]], n: 66, s: 0.8, a: 0.38 },
  ]
  for (let bi = 0; bi < bands.length; bi++) {
    const b = bands[bi]
    for (let i = 0; i < b.n; i++) {
      const t = hash01(`f${bi}-${i}`, 151)
      const [px, py] = bez(b.p[0], b.p[1], b.p[2], t)
      const [qx, qy] = bez(b.p[0], b.p[1], b.p[2], Math.min(1, t + 0.02))
      const ang = Math.atan2((qy - py) * WORLD_H, (qx - px) * W) + (b.flip ? Math.PI : 0)
      const jx = (hash01(`f${bi}-${i}`, 153) - 0.5) * 0.05
      const jy = (hash01(`f${bi}-${i}`, 155) - 0.5) * 0.018
      fishSplat(ctx, (px + jx) * W, (py + jy) * WORLD_H,
        (0.0035 + hash01(`f${bi}-${i}`, 157) * 0.003) * W * b.s, ang,
        b.a * (0.6 + hash01(`f${bi}-${i}`, 159) * 0.4))
    }
  }
  for (let i = 0; i < 38; i++) {
    const a = hash01(`v${i}`, 161) * Math.PI * 2
    const rr = 0.032 + hash01(`v${i}`, 163) * 0.02
    fishSplat(ctx, (0.74 + Math.cos(a) * rr * 1.15) * W, (0.425 + Math.sin(a) * rr * 0.5) * WORLD_H,
      (0.003 + hash01(`v${i}`, 165) * 0.002) * W, a + Math.PI / 2, 0.5)
  }
  splat(ctx, 0.74 * W, 0.425 * WORLD_H, 0.03 * W, 0.014 * WORLD_H, 0, '#cfe8ec', 0.16, true)

  // 光衰（只压中深段；底段贴图自带暗部）
  const dk = ctx.createLinearGradient(0, WORLD_H * 0.5, 0, WORLD_H * 0.85)
  dk.addColorStop(0, 'rgba(4,10,24,0)'); dk.addColorStop(1, 'rgba(6,10,28,0.42)')
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = dk; ctx.fillRect(0, WORLD_H * 0.5, W, WORLD_H * 0.35)

  // 金色光尘 + 生物荧光 + 海雪（都钳在中段，不压贴图区）
  for (let i = 0; i < 60; i++) {
    const y = 0.4 + hash01(`gd${i}`, 171) * 0.4
    splat(ctx, hash01(`gd${i}`, 173) * W, y * WORLD_H, 0.0022 * W, 0.0016 * W,
      0, GOLD_DUST, 0.1 + hash01(`gd${i}`, 175) * 0.12, true)
  }
  for (let i = 0; i < 46; i++) {
    const y = 0.48 + hash01(`gl${i}`, 107) * 0.32
    splat(ctx, hash01(`gl${i}`, 109) * W, y * WORLD_H, 0.004 * W, 0.003 * W,
      0, i % 3 ? '#7fd4d4' : '#b7e6c9', 0.18, true)
  }
  for (let i = 0; i < 30; i++) {
    const y = 0.4 + hash01(`sn${i}`, 111) * 0.4
    splat(ctx, hash01(`sn${i}`, 113) * W, y * WORLD_H, 0.0016 * W, 0.0012 * W, 0, '#e8f2f2', 0.09, true)
  }

  // 装饰玻璃泡（钳中段）
  for (let i = 0; i < 7; i++) {
    const bx = hash01(`db${i}`, 181) * 0.9 + 0.05, by = 0.38 + hash01(`db${i}`, 183) * 0.42
    const br = (0.008 + hash01(`db${i}`, 185) * 0.01) * W
    ctx.save(); ctx.globalAlpha = 0.35; ctx.strokeStyle = 'rgba(235,248,250,0.7)'
    ctx.lineWidth = Math.max(1, br * 0.09)
    ctx.beginPath(); ctx.arc(bx * W, by * WORLD_H, br, 0, Math.PI * 2); ctx.stroke()
    ctx.globalAlpha = 0.55; ctx.lineWidth = Math.max(1, br * 0.14)
    ctx.beginPath(); ctx.arc(bx * W, by * WORLD_H, br * 0.82, -2.3, -1.1); ctx.stroke(); ctx.restore()
  }

  // 水母两只
  for (const [jx, jy, js] of [[0.17, 0.73, 1], [0.83, 0.68, 0.8]] as const) {
    const R = 0.024 * W * js
    splat(ctx, jx * W, jy * WORLD_H, R * 3, R * 2.4, 0, '#b9a8d6', 0.22, true)
    splat(ctx, jx * W, jy * WORLD_H, R, R * 0.7, 0, '#eee4f6', 0.75)
    splat(ctx, jx * W, jy * WORLD_H + R * 0.28, R * 0.85, R * 0.4, 0, '#c9b6e2', 0.4)
    splat(ctx, jx * W - R * 0.25, jy * WORLD_H - R * 0.3, R * 0.5, R * 0.32, -0.3, '#fbf8fe', 0.85, true)
    for (let tt = 0; tt < 6; tt++) {
      for (let seg = 1; seg <= 11; seg++) {
        splat(ctx, (jx + (tt - 2.5) * 0.0045 + Math.sin(seg * 0.9 + tt * 1.7) * 0.0026) * W,
          jy * WORLD_H + R * 0.55 + seg * R * 0.42,
          R * 0.08, R * 0.2, 0.2, '#d8cbee', 0.42 - seg * 0.033, true)
      }
    }
  }

  // 顶段与底段贴图（她的画上墙）；图未就绪时先跑纯程序化底，onload 后重画
  if (masterImg) {
    drawSliceFeather(ctx, masterImg, 0, 0.4, 0, WORLD_H * 0.15, W, 0, 70)
    drawSliceFeather(ctx, masterImg, 0.72, 1.0, WORLD_H * 0.84, WORLD_H, W, 220, 0)
  }
}

export const OceanCanvas = ({ snap, waves, cameraRef, onOpen, highlightId }: Props) => {
  const cvsRef = useRef<HTMLCanvasElement>(null)
  const capRef = useRef<HTMLDivElement>(null)
  const placedRef = useRef<PlacedEpisode[]>([])
  const snapDirtyRef = useRef(true)
  const wavesRef = useRef<FoamWave[]>([])
  const hoverIdRef = useRef<string | null>(null)
  // 实际绘制那一帧的相机（二审 Block 项：hit-test 只许读它，绝不读目标相机——
  // 快速滚动中两者可差数屏，用目标相机会命中不在屏上的记忆）
  const paintedCamRef = useRef(0)
  const [caption, setCaption] = useState<Caption | null>(null)

  // 数据经 ref 进入渲染循环（动效A：绝不作为 effect 依赖重建循环）
  useEffect(() => { placedRef.current = layoutOcean(snap); snapDirtyRef.current = true }, [snap])
  useEffect(() => { wavesRef.current = waves; snapDirtyRef.current = true }, [waves])
  const highlightRef = useRef<string | null>(null)
  useEffect(() => { highlightRef.current = highlightId; snapDirtyRef.current = true }, [highlightId])

  useEffect(() => {
    const cvs = cvsRef.current!
    const ctx = cvs.getContext('2d')!
    const bg = document.createElement('canvas')
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = mq.matches
    const onMq = () => { reduced = mq.matches; snapDirtyRef.current = true }
    mq.addEventListener('change', onMq)

    let W = 0, H = 0, WORLD_H = 0
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      W = Math.round(cvs.clientWidth * dpr); H = Math.round(cvs.clientHeight * dpr)
      cvs.width = W; cvs.height = H
      WORLD_H = Math.round(H * WORLD.DEPTH_SCALE)
      bg.width = W; bg.height = WORLD_H
      paintBackdrop(bg, W, WORLD_H)
      snapDirtyRef.current = true
    }
    fit()
    loadMasterArt().then(() => fit())   // 底图到货重铺一次（未到时纯渐变已可看）
    const ro = new ResizeObserver(fit); ro.observe(cvs)

    let cam = cameraRef.current ?? 0
    let lastPaintedCam = -1
    let hadActiveWaves = false
    let raf = 0
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame)
      const target = cameraRef.current ?? 0
      // 相机平滑（梦感滞后）；reduced 下直达不飘
      cam = reduced ? target : cam + (target - cam) * 0.14
      if (Math.abs(target - cam) < 0.0004) cam = target
      const nowT = performance.now()
      const activeWaves = wavesRef.current.some((w) => nowT - w.arrivedAt < 4200)
      // 动效B：reduced 时空闲帧完全不碰画布；浪的收场帧靠 hadActiveWaves 补一笔
      const mustPaint = !reduced
        || snapDirtyRef.current || cam !== lastPaintedCam || activeWaves || hadActiveWaves
      hadActiveWaves = activeWaves
      if (!mustPaint) return
      snapDirtyRef.current = false
      lastPaintedCam = cam
      paintedCamRef.current = cam

      const camOff = cam * (WORLD_H - H)
      ctx.clearRect(0, 0, W, H)
      ctx.drawImage(bg, 0, camOff, W, H, 0, 0, W, H)
      const bob = (id: string, amp: number) =>
        reduced ? 0 : Math.sin(t / 2600 + hash01(id, 73) * 6.28) * amp * H
      const sy = (worldY: number, b = 0) => worldY * WORLD_H - camOff + b
      const onScreen = (y: number, m = 80) => y > -m && y < H + m

      for (const ep of placedRef.current) {
        if (ep.episode_id === null || ep.cr === 0) continue   // loose 散粒无膜（一审 P1-3）
        const cx = ep.cx * W, cy = sy(ep.cy, bob(ep.episode_id, 0.004)), cr = ep.cr * W
        if (!onScreen(cy, cr + 80)) continue
        // 玻璃环膜（参考图的透明泡质感）：宽淡外圈 + 内侧高光弧 + 顶部反光点
        ctx.save()
        ctx.globalAlpha = 0.2; ctx.strokeStyle = 'rgba(230,248,250,0.85)'
        ctx.lineWidth = Math.max(1, cr * 0.06)
        ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 0.38; ctx.lineWidth = Math.max(1, cr * 0.05)
        ctx.beginPath(); ctx.arc(cx, cy, cr * 0.9, -2.3, -1.0); ctx.stroke()
        ctx.globalAlpha = 0.22; ctx.lineWidth = Math.max(1, cr * 0.03)
        ctx.beginPath(); ctx.arc(cx, cy, cr * 0.93, 0.6, 1.5); ctx.stroke()
        ctx.restore()
        splat(ctx, cx - cr * 0.5, cy - cr * 0.62, cr * 0.14, cr * 0.09, -0.6, '#f6fcff', 0.5, true)
      }
      for (const ep of placedRef.current) {
        const lod = splatsPerMemory(ep.memories.length)   // 一审 P1-6：密度降档
        for (const p of ep.memories) {
          const amp = p.m.pinned ? 0 : p.bleached ? 0.001 : 0.003   // 岸上不漂，海床微动
          const x = p.x * W, y = sy(p.y, bob(p.m.memory_id, amp))
          if (!onScreen(y)) continue
          const base = (p.m.layer === 'experience' ? 9 : 7) * p.r * (W / 1400)
          const hovered = hoverIdRef.current === p.m.memory_id || highlightRef.current === p.m.memory_id
          const color = p.m.layer === 'experience'
            ? pearlColor(p.m.exp_status)
            : memoryColor(p.m.kind, p.m.effective_strength, p.bleached)
          splat(ctx, x, y, base * 3.2, base * 2.2, 0, color, p.bleached ? 0.05 : 0.13, true)
          for (let i = 0; i < lod; i++) {
            splat(ctx, x + (hash01(p.m.memory_id + i, 79) - 0.5) * base * 1.6,
              y + (hash01(p.m.memory_id + i, 83) - 0.5) * base * 1.2,
              base * (0.75 + hash01(p.m.memory_id + i, 89) * 0.6),
              base * (0.4 + hash01(p.m.memory_id + i, 97) * 0.4),
              hash01(p.m.memory_id + i, 101) * 3.1, color, p.bleached ? 0.16 : 0.26)
          }
          splat(ctx, x, y, base * 0.65, base * 0.5, 0.4, '#ffffff', p.bleached ? 0.1 : 0.28, true)
          if (p.m.layer === 'experience')
            splat(ctx, x - base * 0.25, y - base * 0.25, base * 0.22, base * 0.18, 0, '#ffffff', 0.75, true)
          if (hovered)
            splat(ctx, x, y, base * 4.4, base * 3.2, 0, color, 0.22, true)
        }
      }
      // 浪：persisted receipt 的泡沫痕；reduced 下静态潮痕（不扩散），4 秒后消失
      for (const w of wavesRef.current) {
        const age = (nowT - w.arrivedAt) / 4000
        if (age >= 1) continue
        const ep = w.episode_id ? placedRef.current.find((e) => e.episode_id === w.episode_id) : null
        const fx = (ep ? ep.cx : hash01(w.request_id, 103)) * W
        const fy = sy(WORLD.beachEnd)
        if (!onScreen(fy)) continue
        const prog = reduced ? 0.5 : age
        const spread = (0.03 + prog * 0.1) * W
        for (let i = 0; i < 9; i++) {
          splat(ctx, fx + (i - 4) * spread * 0.25,
            fy + (reduced ? 0 : Math.sin(i * 1.7 + age * 9) * 0.0012 * WORLD_H),
            spread * 0.3, 0.0011 * WORLD_H, 0, FOAM, (1 - age) * 0.4, true)
        }
      }
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mq.removeEventListener('change', onMq) }
  }, [])   // 单例循环：依赖为空是设计（动效A），数据全走 ref

  // 动效C：hit-test 每次指针动都跑（纯计算），但 setState 只在悬停对象变化时发生；
  // 字幕跟随坐标绕开 React，直接写 transform
  const onMove = (e: React.PointerEvent) => {
    const rect = cvsRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const found = hitTestOcean(placedRef.current, mx, my, rect.width, rect.height, paintedCamRef.current)
    const p = found?.placed
    const hit: { id: string; c: Caption } | null = p
      ? { id: p.m.memory_id, c: { pinned: p.m.pinned, bleached: p.bleached,
          kind: p.m.kind, strength: p.m.effective_strength, preview: p.m.content_preview } }
      : null
    if (capRef.current) {
      capRef.current.style.transform = `translate(${mx + 14}px, ${my - 10}px)`
      capRef.current.style.opacity = hit ? '1' : '0'
    }
    if ((hit?.id ?? null) !== hoverIdRef.current) {
      hoverIdRef.current = hit?.id ?? null
      snapDirtyRef.current = true
      if (hit) setCaption(hit.c)
    }
  }

  // 点击开透镜：与 hover 同一 hitTestOcean、同一 painted 相机——坐标真相只有一份。
  // 四审 P1：开泡瞬间清干净 hover 字幕与高亮——半透明泡体挡不住底下的残字；
  // 泡开着时透镜 overlay 覆盖全屏，pointermove 到不了画布，不会被重新点亮。
  const onClick = (e: React.MouseEvent) => {
    const rect = cvsRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const found = hitTestOcean(placedRef.current, mx, my, rect.width, rect.height, paintedCamRef.current)
    if (found) {
      hoverIdRef.current = null
      snapDirtyRef.current = true
      setCaption(null)
      if (capRef.current) capRef.current.style.opacity = '0'
      onOpen({ m: found.placed.m, episode_id: found.episode.episode_id,
        sx: e.clientX, sy: e.clientY, bleached: found.placed.bleached, animateEntrance: true })
    }
  }

  return (
    <div style={{ position: 'absolute', inset: 0 }}
      onPointerMove={onMove}
      onClick={onClick}
      onPointerLeave={() => {
        hoverIdRef.current = null; snapDirtyRef.current = true
        if (capRef.current) capRef.current.style.opacity = '0'
      }}>
      <canvas ref={cvsRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <div ref={capRef} style={{
        position: 'absolute', left: 0, top: 0, maxWidth: 300, opacity: 0,
        pointerEvents: 'none', color: '#fdfbf5', fontSize: 13, lineHeight: 1.5,
        transition: 'opacity 0.25s',
        textShadow: '0 0 6px rgba(6,20,40,0.95), 0 0 18px rgba(6,20,40,0.85), 0 0 34px rgba(6,20,40,0.7)',
      }}>
        {caption && (<>
          <em style={{ opacity: 0.85 }}>
            {caption.pinned ? 'pinned ashore' : caption.bleached ? 'bleaching away' : `strength ${(caption.strength * 100).toFixed(0)}%`}
            {caption.kind ? ` · ${caption.kind}` : ''}
          </em>
          <br />{caption.preview}
        </>)}
      </div>
    </div>
  )
}
