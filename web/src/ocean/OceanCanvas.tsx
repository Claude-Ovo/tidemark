// 海景画布 v1：世界坐标 4.5 屏深，滚动=下潜（相机进 ref 不进 state）。
// 一审动效修订全落在这：
//   A. 渲染循环单例——mount 建一次；snap/waves/camera 全走 ref 同步，绝不重建 rAF/backdrop
//   B. reduced-motion 真静态——呼吸停 + 空闲帧跳过绘制（脏帧标记），浪降级为静态潮痕
//   C. 悬停不打 React state——字幕内容仅在 memory_id 变化时 setState 一次，
//      跟随坐标直接写 DOM transform；连续指针值零 rerender
// 铁律不变：零方框零按钮；强度/深度全来自服务端快照，动画只做视觉呼吸不做衰减。
import { useEffect, useRef, useState, type RefObject } from 'react'
import gsap from 'gsap'
import type { OceanSnapshot } from './types'
import { layoutOcean, type PlacedEpisode } from './layout'
import { hash01, WORLD, splatsPerMemory, hitTestOcean } from './layout-core.mjs'
import { FOAM, memoryColor, pearlColor } from './palette'

export type FoamWave = { request_id: string; episode_id: string | null; arrivedAt: number }
export type OpenTarget = { m: import('./types').VizMemory; episode_id: string | null; sx: number; sy: number; bleached: boolean
  animateEntrance: boolean }
type Caption = { pinned: boolean; bleached: boolean; kind: string | null; strength: number; preview: string }
type Props = {
  snap: OceanSnapshot; waves: FoamWave[]; cameraRef: RefObject<number>
  onOpen: (t: OpenTarget) => void        // 点击命中一颗记忆 -> 交给透镜（同一 hitTestOcean）
  highlightId: string | null             // 键盘巡航聚焦的记忆（视觉高亮与 hover 同款）
  worldScale: number                     // 世界深度变化（图 aspect 实算后）触发重铺
  openTarget: OpenTarget | null          // V-8：展开态——同一只泡在原锚点长大，文字在泡内凝出
  lensTextRef: RefObject<HTMLDivElement | null>   // 泡内文字层（App 渲染，这里逐帧定位）
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
let masterLoading: Promise<HTMLImageElement | null> | null = null
export const loadMasterArt = () => {
  masterLoading ??= new Promise((res) => {
    const im = new Image()
    im.onload = () => { masterImg = im; res(im) }
    im.onerror = () => res(null)
    im.src = '/ocean-master.jpg'
  })
  return masterLoading
}

// 她的画 -> 粒子（批7：整页动态）。图不再当墙纸：模糊版作色底保衔接，
// 细节采样成色粒铺回原位，分三层错相位呼吸——全海点彩明灭。
type ArtParticle = { x: number; y: number; c: string; s: number }
// 必须吐 rgba（带显式 alpha=1）：fade() 的正则替换【最后一个数字】为 0——
// rgb() 三元组会被它误伤蓝通道（实拍：全场褪蓝泛黄绿、粒子镶黄圈），rgba 的末位才是 alpha
const desat = (r: number, g: number, b: number, k = 0.42) => {   // 七审 A：粒子与底图同幅降淡，禁止鲜回去
  const gray = 0.299 * r + 0.587 * g + 0.114 * b
  const f = (v: number) => Math.round(v + (gray - v) * k)
  return `rgba(${f(r)},${f(g)},${f(b)},1)`
}
// 图段 -> 世界段映射与色底贴图一致：顶段 [0,0.40]->[0,0.15]，底段 [0.72,1]->[0.84,1]
const sampleMasterParticles = (img: HTMLImageElement): ArtParticle[] => {
  const SW = 132
  const SH = Math.round(SW * img.naturalHeight / img.naturalWidth)
  const cv = document.createElement('canvas')
  cv.width = SW; cv.height = SH
  const cc = cv.getContext('2d', { willReadFrequently: true })!
  cc.drawImage(img, 0, 0, SW, SH)
  const data = cc.getImageData(0, 0, SW, SH).data
  const out: ArtParticle[] = []
  const grab = (imgY0: number, imgY1: number, wY0: number, wY1: number, step: number) => {
    for (let gy = Math.floor(imgY0 * SH); gy < imgY1 * SH; gy += step) {
      for (let gx = (gy % (step * 2) === 0 ? 0 : Math.floor(step / 2)); gx < SW; gx += step) {
        const i = (gy * SW + gx) * 4
        const jx = hash01(`px${gx}-${gy}`, 201) - 0.5, jy = hash01(`py${gx}-${gy}`, 203) - 0.5
        out.push({
          x: (gx + 0.5 + jx * step) / SW,
          y: wY0 + ((gy + 0.5 + jy * step) / SH - imgY0) / (imgY1 - imgY0) * (wY1 - wY0),
          c: desat(data[i], data[i + 1], data[i + 2]),
          s: 5 + hash01(`ps${gx}-${gy}`, 207) * 9,
        })
      }
    }
  }
  grab(0, 1, 0, 1, 4)   // 世界=图（自然比例）：全图均匀光尘，不再分段
  return out
}

// 三张呼吸层（各 1/3 粒子，错相位）；层为世界尺寸，帧循环整层 blit——零逐粒子帧成本
const buildParticleLayers = (particles: ArtParticle[], W: number, WORLD_H: number): HTMLCanvasElement[] => {
  const layers = [0, 1, 2].map(() => {
    const c = document.createElement('canvas')
    c.width = W; c.height = WORLD_H
    return c
  })
  const ctxs = layers.map((c) => c.getContext('2d')!)
  const scale = W / 1400
  for (let i = 0; i < particles.length; i++) {
    const pt = particles[i]
    const ctx = ctxs[i % 3]
    splat(ctx, pt.x * W, pt.y * WORLD_H, pt.s * scale * 1.6, pt.s * scale * 1.05,
      (hash01(`pr${i}`, 211) - 0.5) * 1.2, pt.c, 0.26 + hash01(`pa${i}`, 213) * 0.2)
  }
  return layers
}

const paintBackdrop = (c: HTMLCanvasElement, W: number, WORLD_H: number) => {
  const ctx = c.getContext('2d')!
  if (masterImg) {
    // 七审 A+B：原画退成环境材质——低频色场打底，细节层低透明恢复（清晰 master
    // 不再 100% 满幅终稿）；基准色调 saturate(58%) brightness(1.04) contrast(0.94)。
    const sw = masterImg.naturalWidth, sh = masterImg.naturalHeight
    ctx.filter = 'blur(5px) saturate(50%) brightness(1.06) contrast(0.9)'
    ctx.drawImage(masterImg, 0, 0, sw, sh, 0, 0, W, WORLD_H)
    ctx.filter = 'saturate(58%) brightness(1.04) contrast(0.94)'
    ctx.globalAlpha = 0.6
    ctx.drawImage(masterImg, 0, 0, sw, sh, 0, 0, W, WORLD_H)
    ctx.globalAlpha = 1; ctx.filter = 'none'
    // 浅海奶蓝雾洗（不靠高饱和碰撞，靠明度与空气感）
    const wash = ctx.createLinearGradient(0, WORLD.beachEnd * WORLD_H, 0, (WORLD.beachEnd + 0.22) * WORLD_H)
    wash.addColorStop(0, 'rgba(228,240,248,0.14)'); wash.addColorStop(1, 'rgba(228,240,248,0)')
    ctx.fillStyle = wash; ctx.fillRect(0, WORLD.beachEnd * WORLD_H, W, 0.22 * WORLD_H)
    // 深海靖蓝 depth haze（低透明，分层靠雾不靠色撞）
    const haze = ctx.createLinearGradient(0, 0.52 * WORLD_H, 0, WORLD_H)
    haze.addColorStop(0, 'rgba(30,38,88,0)'); haze.addColorStop(1, 'rgba(30,38,88,0.3)')
    ctx.fillStyle = haze; ctx.fillRect(0, 0.52 * WORLD_H, W, 0.48 * WORLD_H)
  } else {
    // 图未就绪/加载失败：纯渐变 fail-safe
    const lg = ctx.createLinearGradient(0, 0, 0, WORLD_H)
    lg.addColorStop(0, '#a9c9e6'); lg.addColorStop(0.2, '#e9dab2')
    lg.addColorStop(0.34, '#7cc4c9'); lg.addColorStop(0.55, '#2f5fab')
    lg.addColorStop(0.8, '#1b2c6c'); lg.addColorStop(1, '#14224f')
    ctx.fillStyle = lg; ctx.fillRect(0, 0, W, WORLD_H)
  }
}

export const OceanCanvas = ({ snap, waves, cameraRef, onOpen, highlightId, worldScale, openTarget, lensTextRef }: Props) => {
  const cvsRef = useRef<HTMLCanvasElement>(null)
  const capRef = useRef<HTMLDivElement>(null)
  const placedRef = useRef<PlacedEpisode[]>([])
  const snapDirtyRef = useRef(true)
  const wavesRef = useRef<FoamWave[]>([])
  const hoverIdRef = useRef<string | null>(null)
  // 实际绘制那一帧的相机（二审 Block 项：hit-test 只许读它，绝不读目标相机——
  // 快速滚动中两者可差数屏，用目标相机会命中不在屏上的记忆）
  const paintedCamRef = useRef(0)
  const fitRef = useRef<(() => void) | null>(null)
  const pressIdRef = useRef<string | null>(null)          // pointer-down 轻压（V-8 五态之一）
  const openRef = useRef<{ t: OpenTarget | null; p: number }>({ t: null, p: 0 })
  const [caption, setCaption] = useState<Caption | null>(null)

  // 数据经 ref 进入渲染循环（动效A：绝不作为 effect 依赖重建循环）
  useEffect(() => { placedRef.current = layoutOcean(snap); snapDirtyRef.current = true }, [snap])
  useEffect(() => { wavesRef.current = waves; snapDirtyRef.current = true }, [waves])
  const highlightRef = useRef<string | null>(null)
  useEffect(() => { highlightRef.current = highlightId; snapDirtyRef.current = true }, [highlightId])
  useEffect(() => { fitRef.current?.(); placedRef.current = layoutOcean(snap); snapDirtyRef.current = true }, [worldScale])   // 图 aspect 实算后重铺世界

  // V-8 展开/收回：同一实体从当前呈现值生长/原路缩回；键盘直达，reduced 瞬切
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (openTarget) {
      openRef.current.t = openTarget
      if (reduced || !openTarget.animateEntrance) { openRef.current.p = 1; snapDirtyRef.current = true; return }
      gsap.to(openRef.current, { p: 1, duration: 0.5, ease: 'back.out(1.2)', overwrite: true,
        onUpdate: () => { snapDirtyRef.current = true } })
    } else if (openRef.current.t) {
      if (reduced) { openRef.current.p = 0; openRef.current.t = null; snapDirtyRef.current = true; return }
      gsap.to(openRef.current, { p: 0, duration: 0.32, ease: 'power2.inOut', overwrite: true,
        onUpdate: () => { snapDirtyRef.current = true },
        onComplete: () => { openRef.current.t = null; snapDirtyRef.current = true } })
    }
    return () => { gsap.killTweensOf(openRef.current) }
  }, [openTarget])

  useEffect(() => {
    const cvs = cvsRef.current!
    const ctx = cvs.getContext('2d')!
    const bg = document.createElement('canvas')
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = mq.matches
    const onMq = () => { reduced = mq.matches; snapDirtyRef.current = true }
    mq.addEventListener('change', onMq)

    let W = 0, H = 0, WORLD_H = 0
    let artLayers: HTMLCanvasElement[] | null = null
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      W = Math.round(cvs.clientWidth * dpr); H = Math.round(cvs.clientHeight * dpr)
      cvs.width = W; cvs.height = H
      WORLD_H = Math.round(H * WORLD.DEPTH_SCALE)
      bg.width = W; bg.height = WORLD_H
      paintBackdrop(bg, W, WORLD_H)
      artLayers = masterImg ? buildParticleLayers(sampleMasterParticles(masterImg), W, WORLD_H) : null
      snapDirtyRef.current = true
    }
    fit()
    fitRef.current = fit
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
        || openRef.current.p > 0.001
      hadActiveWaves = activeWaves
      if (!mustPaint) return
      snapDirtyRef.current = false
      lastPaintedCam = cam
      paintedCamRef.current = cam

      const camOff = cam * (WORLD_H - H)
      ctx.clearRect(0, 0, W, H)
      ctx.drawImage(bg, 0, camOff, W, H, 0, 0, W, H)
      // 她的画在呼吸：三层粒子错相位明灭 + 微涌动（reduced 下静止恒亮）
      if (artLayers) {
        for (let k = 0; k < 3; k++) {
          const a = reduced ? 0.66 : 0.62 + 0.16 * Math.sin(t / 1500 + k * 2.1)
          const yOff = reduced ? 0 : Math.sin(t / 2800 + k * 1.9) * 2.2
          ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, a))
          ctx.drawImage(artLayers[k], 0, camOff + yOff, W, H, 0, 0, W, H)
          ctx.restore()
        }
      }
      const bob = (id: string, amp: number) =>
        reduced ? 0 : Math.sin(t / 2600 + hash01(id, 73) * 6.28) * amp * H
      const sy = (worldY: number, b = 0) => worldY * WORLD_H - camOff + b
      const onScreen = (y: number, m = 80) => y > -m && y < H + m

      // 场景实体泡（V-8）：膜 = 身后同一片海的折射（泽内轻微放大上移）+
      // 不规则 Fresnel rim（周向哈希调制，绝非均匀双圆）；hover 膜光苏醒，
      // pointer-down 轻压，展开 = 同一实体从锚点长大（文字由 DOM 层在泡心凝出）。
      const openT = openRef.current.t, openP = openRef.current.p
      const drawBubbleEntity = (cx: number, cy: number, crX: number, crY: number,
        hovered: boolean, opened: number, seed: string) => {
        const worldTop = cy + camOff - crY
        ctx.save()
        ctx.beginPath(); ctx.ellipse(cx, cy, crX, crY, 0, 0, Math.PI * 2); ctx.clip()
        const mag = 1.08 + opened * 0.07
        const srcW = crX * 2 * mag, srcH = crY * 2 * mag
        const sx0 = Math.max(0, Math.min(W - crX * 2, cx - srcW / 2))
        const sy0 = Math.max(0, Math.min(WORLD_H - crY * 2, worldTop - (srcH - crY * 2) / 2 - crY * 0.08))
        ctx.drawImage(bg, sx0, sy0, srcW, srcH, cx - crX, cy - crY, crX * 2, crY * 2)
        // 泡顶透光与泡底暗沉（膜的体积感）；展开时内部轻压暗保文字可读
        splat(ctx, cx, cy - crY * 0.55, crX * 0.85, crY * 0.45, 0, '#eef8fb', 0.16 + (hovered ? 0.08 : 0), true)
        if (opened > 0.01) {
          const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(crX, crY))
          g2.addColorStop(0, `rgba(8,22,44,${0.34 * opened})`)
          g2.addColorStop(1, `rgba(8,22,44,${0.1 * opened})`)
          ctx.fillStyle = g2; ctx.fillRect(cx - crX, cy - crY, crX * 2, crY * 2)
        }
        ctx.restore()
        // 不规则 Fresnel rim：24 段弧，亮度 = 顶光分量 + 哈希起伏；hover 苏醒
        const segs = 24
        for (let i = 0; i < segs; i++) {
          const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1.15) / segs) * Math.PI * 2
          const topness = 0.5 - Math.sin(a0 + Math.PI / 2) * 0.5
          const irr = hash01(seed + i, 219)
          const al = (0.1 + topness * 0.26 + irr * 0.22) * (hovered ? 1.8 : 1) * (0.75 + opened * 0.5)
          ctx.save(); ctx.globalAlpha = Math.min(0.85, al)
          ctx.strokeStyle = irr > 0.72 ? '#f4fbfd' : '#cfe9ef'
          ctx.lineWidth = Math.max(1, crX * (0.018 + irr * 0.03))
          ctx.beginPath(); ctx.ellipse(cx, cy, crX, crY, 0, a0, a1); ctx.stroke(); ctx.restore()
        }
        splat(ctx, cx - crX * 0.45, cy - crY * 0.58, crX * 0.16, crY * 0.1, -0.5, '#ffffff', 0.4 + (hovered ? 0.2 : 0), true)
      }
      for (const ep of placedRef.current) {
        if (ep.episode_id === null || ep.cr === 0) continue   // loose 散粒无膜（一审 P1-3）
        if (openT && openT.episode_id === ep.episode_id && openP > 0.01) continue   // 展开态在下方单独画
        const hovered = ep.memories.some((p) => hoverIdRef.current === p.m.memory_id || highlightRef.current === p.m.memory_id)
        const pressed = ep.memories.some((p) => pressIdRef.current === p.m.memory_id)
        const k = pressed ? 0.965 : 1
        const cx = ep.cx * W, cy = sy(ep.cy, bob(ep.episode_id, 0.004)), cr = ep.cr * W
        if (!onScreen(cy, cr + 80)) continue
        drawBubbleEntity(cx, cy, cr * k, cr * k * (pressed ? 0.94 : 1), hovered, 0, ep.episode_id)
      }
      for (const ep of placedRef.current) {
        const lod = splatsPerMemory(ep.memories.length)   // 一审 P1-6：密度降档
        for (const p of ep.memories) {
          const amp = p.m.pinned ? 0 : p.bleached ? 0.001 : 0.003   // 岸上不漂，海床微动
          const x = p.x * W, y = sy(p.y, bob(p.m.memory_id, amp))
          if (!onScreen(y)) continue
          const base = (p.m.layer === 'experience' ? 11 : 9) * p.r * (W / 1400)
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
      // 展开态：同一只泡从锚点长大（相机已小幅让位），文字在泡内凝出
      if (openT && openP > 0.001) {
        let ax = 0.5, ay = 0.5, ar = 14
        const grp = placedRef.current.find((e) => e.episode_id === openT.episode_id)
        if (grp && grp.episode_id !== null) { ax = grp.cx; ay = grp.cy; ar = grp.cr * W }
        else {
          for (const e of placedRef.current) {
            const pm = e.memories.find((q) => q.m.memory_id === openT.m.memory_id)
            if (pm) { ax = pm.x; ay = pm.y; ar = 16 * (W / 1400) * 3; break }
          }
        }
        const targetR = Math.min(H * 0.34, 300 * (W / (1400 * Math.min(2, window.devicePixelRatio || 1)) ) * (window.devicePixelRatio || 1))
        const R = ar + (targetR - ar) * openP
        // 水平方向没有相机可让（页面只竖向滚），泡自己随生长渐移进安全区，文字不裁边
        const rawCx = ax * W, rawCy = sy(ay)
        const margin = R + 14 * (window.devicePixelRatio || 1)
        const cx = rawCx + (Math.max(margin, Math.min(W - margin, rawCx)) - rawCx) * openP
        const cy = rawCy + (Math.max(margin, Math.min(H - margin, rawCy)) - rawCy) * openP
        drawBubbleEntity(cx, cy, R, R, false, openP, openT.episode_id ?? openT.m.memory_id)
        // 泡内文字层：直写 DOM transform（与 caption 同源手法，零 rerender）
        const el = lensTextRef.current
        if (el) {
          const dpr = Math.min(2, window.devicePixelRatio || 1)
          const cssX = cx / dpr, cssY = cy / dpr, cssR = R / dpr
          el.style.transform = `translate(${cssX}px, ${cssY}px) translate(-50%, -50%)`
          el.style.width = `${cssR * 1.5}px`
          el.style.opacity = String(Math.max(0, (openP - 0.45) / 0.55))
        }
      } else if (lensTextRef.current) lensTextRef.current.style.opacity = '0'

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

  const onDown = (e: React.PointerEvent) => {
    const rect = cvsRef.current!.getBoundingClientRect()
    const found = hitTestOcean(placedRef.current, e.clientX - rect.left, e.clientY - rect.top,
      rect.width, rect.height, paintedCamRef.current)
    pressIdRef.current = found?.placed.m.memory_id ?? null
    if (pressIdRef.current) snapDirtyRef.current = true
  }
  const onUp = () => { if (pressIdRef.current) { pressIdRef.current = null; snapDirtyRef.current = true } }

  return (
    <div style={{ position: 'absolute', inset: 0 }}
      onPointerMove={onMove}
      onPointerDown={onDown}
      onPointerUp={onUp}
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
