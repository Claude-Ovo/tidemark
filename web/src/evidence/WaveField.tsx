import { useEffect, useRef } from 'react'

// Halftone tide backdrop, v2 (Owner brief 2026-08-14, desktop ovo.txt): one
// visually dominant, asymmetric wave packet travelling left-to-right - a long
// gentle back slope, a narrow forward-leaning crest, a steep front face, then
// a shallow trough and two or three damped wake ripples. The surfer stays
// deleted. PURELY DECORATIVE: encodes no data, reads no endpoint, sits behind
// every panel with pointer-events none.
//
// Rendering language (per the reference frames, 1:1): flat two-tone halftone.
// No alpha gradient - the surface boundary is a crisp dotted edge, the body is
// a woven checker of two fixed dot sizes, and shading is done by SWAPPING INK
// (base grey vs deep grey under the lip and along the steep front face), never
// by fading opacity. Light theme uses the reference's warm dark greys; dark
// theme uses light greys where "shadow" means dimmer, i.e. closer to the
// background - the same physical reading in both themes.
//
// Discipline: prefers-reduced-motion renders one static mature wave;
// forced-colors renders nothing; 30fps cap; pauses when the tab hides.

// Every tunable in one place (acceptance item 9 of the brief).
const WAVE_CFG = {
  amplitude: 0.26,        // mature crest rise, fraction of viewport height
  stillLine: 0.83,        // resting waterline, fraction of viewport height
  cycleDuration: 12000,   // one full left-to-right crossing, ms
  cycleJitter: 0.08,      // per-cycle duration variance (breaks the loop feel)
  backSlopeWidth: 0.30,   // back (left) slope width, fraction of viewport width
  frontSlopeWidth: 0.085, // front (right) face width - roughly backSlope / 3.5
  crestSharpness: 2.6,    // pow() on the lip component; higher = narrower tip
  crestLean: 0.55,        // forward offset of the lip, fraction of front width
  wakeAmplitude: 0.28,    // first wake ripple height relative to main amplitude
  wakeDecay: 2.4,         // exponential decay of successive wake ripples
  wakeLength: 0.16,       // wavelength of the wake train, fraction of width
  breakStrength: 0.9,     // spray emission probability scale in the mature phase
  sprayCount: 10,         // max concurrent spray particles
  orbital: 10,            // max horizontal surface displacement, px
  depthFalloff: 3.2,      // exp() falloff of motion with depth (deep water stands still)
  smallScreenAmp: 0.16,   // amplitude fraction below 720px viewports
}

const CELL = 8
const FRAME_MS = 1000 / 30

type SprayDrop = { x: number; y: number; vx: number; vy: number; born: number; life: number }
type SkyCluster = { x: number; y: number; steps: number; drift: number }

const SKY: SkyCluster[] = [
  { x: 0.42, y: 0.14, steps: 5, drift: 12 },
  { x: 0.72, y: 0.09, steps: 4, drift: -9 },
  { x: 0.87, y: 0.24, steps: 3, drift: 7 },
]

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function WaveField() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (window.matchMedia('(forced-colors: active)').matches) return
    const context = canvas.getContext('2d')
    if (!context) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let raf = 0
    let last = 0
    let width = 0
    let height = 0
    let dpr = 1
    let cycleSeed = 0.5
    let lastPhase = 0
    const spray: SprayDrop[] = []

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const inks = () => {
      const style = getComputedStyle(document.documentElement)
      return {
        base: style.getPropertyValue('--wave-ink').trim() || '#c9c6be',
        deep: style.getPropertyValue('--wave-ink-deep').trim() || '#7d7a74',
      }
    }

    // ---- wave model -------------------------------------------------------
    // The crossing is one cycle; phase in [0,1). Maturity envelope: forms,
    // peaks mid-screen, collapses, decays - the shape itself changes, not just
    // the position (brief: 形成/增高/前倾/坍塌/消退).
    const crossing = (now: number) => {
      const cycle = WAVE_CFG.cycleDuration * (1 + (cycleSeed - 0.5) * 2 * WAVE_CFG.cycleJitter)
      const phase = (now % cycle) / cycle
      // crest spawns fully offscreen left and leaves offscreen right
      const cx = (-0.3 + phase * 1.6) * width
      const maturity = smoothstep(0.12, 0.42, phase) * (1 - smoothstep(0.68, 0.92, phase))
      return { phase, cx, maturity }
    }

    const surfaceAt = (x: number, cx: number, maturity: number, now: number) => {
      const small = width < 720
      const ampMax = height * (small ? WAVE_CFG.smallScreenAmp : WAVE_CFG.amplitude)
      const amp = ampMax * (0.3 + 0.7 * maturity)
      const backW = width * WAVE_CFG.backSlopeWidth * (1 - 0.25 * maturity) // narrows as it matures
      const frontW = width * WAVE_CFG.frontSlopeWidth
      const dx = x - cx

      // asymmetric packet: wide gaussian back, steep front
      const body = dx <= 0
        ? Math.exp(-((dx / backW) ** 2))
        : Math.exp(-((dx / frontW) ** 2))

      // forward-leaning lip - a narrower component shifted toward travel
      const lean = frontW * WAVE_CFG.crestLean * maturity
      const lip = 0.38 * maturity *
        Math.exp(-(((dx - lean) / (frontW * 0.8)) ** 2)) ** WAVE_CFG.crestSharpness

      // damped wake train trailing behind the back slope: shallow trough first,
      // then 2-3 shrinking ripples (sin starts negative), dying exponentially
      let wake = 0
      const wakeStart = -backW * 0.9
      if (dx < wakeStart) {
        const wd = (wakeStart - dx) / (width * WAVE_CFG.wakeLength)
        wake = -Math.sin(wd * Math.PI * 2) * Math.exp(-wd * WAVE_CFG.wakeDecay) *
          amp * WAVE_CFG.wakeAmplitude * maturity
      }

      // faint ambient swell so flat water still breathes, never competes
      const ambient = Math.sin(x * 0.008 + now * 0.00022) * height * 0.006

      const still = height * WAVE_CFG.stillLine
      return {
        y: still - amp * (body + lip) - wake + ambient,
        elevation: body + lip,
        frontness: dx > -frontW * 0.4 && dx < frontW * 2.2 ? 1 - Math.abs(dx - frontW * 0.5) / (frontW * 1.8) : 0,
      }
    }

    // ---- painting ---------------------------------------------------------
    const draw = (now: number) => {
      context.clearRect(0, 0, width, height)
      const ink = inks()
      const { cx, maturity, phase } = crossing(now)

      // cycle rollover: reseed the jitter offscreen so no visible jump
      if (phase < lastPhase) cycleSeed = ((cycleSeed * 9301 + 49297) % 233280) / 233280
      lastPhase = phase

      // sea - crisp edge, flat two-size checker body, ink-swap shading
      for (let gx = 0; gx <= width; gx += CELL) {
        const s = surfaceAt(gx, cx, maturity, now)
        // orbital shear: near-surface dots lean toward travel with the wave,
        // deep dots stand still - the whole column never slides as one block
        const shear = WAVE_CFG.orbital * s.elevation * maturity
        const top = Math.floor(s.y / CELL) * CELL
        for (let gy = top; gy <= height + CELL; gy += CELL) {
          const depthNorm = Math.min(1, (gy - s.y) / (height - s.y || 1))
          if (depthNorm < 0) continue
          const fall = Math.exp(-depthNorm * WAVE_CFG.depthFalloff)
          const px = gx + shear * fall
          const row = Math.round((gy - top) / CELL)
          // crisp boundary: one small edge row, then the flat woven body -
          // two fixed sizes on a checker, NO alpha ramp, NO size gradient
          const checker = ((gx / CELL + row) & 1) === 0
          const size = row === 0 ? 1.7 : checker ? 2.2 : 2.9
          // shading swaps ink: deep tone under the lip / along the steep face
          const shaded = s.frontness > 0.15 && depthNorm < 0.4 && maturity > 0.3
          context.fillStyle = shaded ? ink.deep : ink.base
          context.globalAlpha = 0.92
          context.fillRect(px, gy, size, size)
        }
      }

      // spray: few, short-lived, shed rightward off the lip only (brief: 坍塌)
      if (!reduced.matches && maturity > 0.55 && spray.length < WAVE_CFG.sprayCount) {
        if (Math.random() < WAVE_CFG.breakStrength * 0.35) {
          const tip = surfaceAt(cx + width * WAVE_CFG.frontSlopeWidth * 0.4, cx, maturity, now)
          spray.push({
            x: cx + width * WAVE_CFG.frontSlopeWidth * (0.3 + Math.random() * 0.5),
            y: tip.y - 4,
            vx: 0.9 + Math.random() * 0.8,
            vy: -0.3 + Math.random() * 0.4,
            born: now,
            life: 450 + Math.random() * 350,
          })
        }
      }
      context.fillStyle = ink.base
      context.globalAlpha = 0.85
      for (let i = spray.length - 1; i >= 0; i--) {
        const drop = spray[i]
        const age = now - drop.born
        if (age > drop.life) { spray.splice(i, 1); continue }
        drop.x += drop.vx
        drop.y += drop.vy
        drop.vy += 0.06 // falls back into the water
        context.fillRect(drop.x, drop.y, 1.8, 1.8)
      }

      // sky stair-clusters from the reference, drifting slowly
      context.globalAlpha = 0.55
      for (const cluster of SKY) {
        const ox = cluster.x * width + Math.sin(now * 0.00013 + cluster.x * 9) * cluster.drift
        const oy = cluster.y * height + Math.cos(now * 0.0001 + cluster.y * 7) * 4
        for (let sIdx = 0; sIdx < cluster.steps; sIdx++) {
          for (let d = 0; d <= sIdx; d++) context.fillRect(ox + sIdx * 5, oy - d * 4, 1.6, 1.6)
        }
      }
      context.globalAlpha = 1
    }

    // reduced motion: one static frame, frozen at the mature midpoint
    const drawStatic = () => {
      context.clearRect(0, 0, width, height)
      const saveNow = WAVE_CFG.cycleDuration * 0.5
      const cx = 0.5 * width
      const ink = inks()
      for (let gx = 0; gx <= width; gx += CELL) {
        const s = surfaceAt(gx, cx, 1, saveNow)
        const top = Math.floor(s.y / CELL) * CELL
        for (let gy = top; gy <= height + CELL; gy += CELL) {
          const depthNorm = Math.min(1, (gy - s.y) / (height - s.y || 1))
          if (depthNorm < 0) continue
          const row = Math.round((gy - top) / CELL)
          const checker = ((gx / CELL + row) & 1) === 0
          const size = row === 0 ? 1.7 : checker ? 2.2 : 2.9
          const shaded = s.frontness > 0.15 && depthNorm < 0.4
          context.fillStyle = shaded ? ink.deep : ink.base
          context.globalAlpha = 0.92
          context.fillRect(gx, gy, size, size)
        }
      }
      context.globalAlpha = 1
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < FRAME_MS) return
      last = now
      draw(now)
    }

    resize()
    if (reduced.matches) drawStatic()
    else raf = requestAnimationFrame(loop)

    const onResize = () => { resize(); if (reduced.matches) drawStatic() }
    const onVisibility = () => {
      if (reduced.matches) return
      cancelAnimationFrame(raf)
      if (!document.hidden) { last = 0; raf = requestAnimationFrame(loop) }
    }
    const observer = new MutationObserver(() => { if (reduced.matches) drawStatic() })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return <canvas ref={canvasRef} className="wave-field" aria-hidden="true" />
}
