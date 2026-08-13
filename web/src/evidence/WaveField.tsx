import { useEffect, useRef } from 'react'

// Halftone tide backdrop, v3 (Owner brief 2026-08-14 #2): the solitary wave
// packet is GONE - it read as a terrain block sliding across the screen. This
// version is a simplified 2D Gerstner/Stokes surface: every particle is
// anchored to its rest coordinate (x0, y0) and only orbits that anchor in a
// small ellipse; what travels left-to-right is the PHASE, never an outline.
// Two superposed waves (one long and low, one shorter and weaker) plus a small
// second harmonic that sharpens crests slightly - no envelopes, no breaking,
// no spray in this version. The surfer stays deleted.
//
// Rendering language unchanged from v2 (reference 1:1): flat two-tone
// halftone, crisp one-row edge, two-size woven checker body at constant
// alpha, shading by swapping ink on the leeward face - never by fading.
// PURELY DECORATIVE: encodes no data, reads no endpoint, pointer-events none.
//
// Discipline: prefers-reduced-motion renders one static frame; forced-colors
// renders nothing; 30fps cap; pauses when the tab hides.

// Every tunable in one place. Conservative ranges straight from the brief.
const WAVE_CFG = {
  stillLine: 0.83,        // resting waterline, fraction of viewport height
  mainAmplitude: 0.045,   // main swell, fraction of viewport height (3.5-5.5%)
  mainWavelength: 0.55,   // main wavelength, fraction of viewport width (45-65%)
  crestCrossSeconds: 8.5, // one crest crosses the viewport in 7-10s
  harmonic: 0.22,         // 2nd-harmonic share of main amplitude (sharper crest, wider trough)
  secondAmplitude: 0.3,   // secondary wave, share of main amplitude (25-35%)
  secondWavelength: 0.52, // secondary wavelength, share of main wavelength (45-60%)
  secondSpeed: 0.82,      // secondary phase speed, share of main speed
  horizontalShare: 0.28,  // horizontal orbit radius as share of vertical (20-35%)
  depthFalloff: 3.5,      // exp() decay of orbit with depth - lower half stays still
  leewardSlope: 0.012,    // surface slope beyond which the face counts as shaded
}

const CELL = 8
const FRAME_MS = 1000 / 30

type SkyCluster = { x: number; y: number; steps: number; drift: number }

const SKY: SkyCluster[] = [
  { x: 0.42, y: 0.14, steps: 5, drift: 12 },
  { x: 0.72, y: 0.09, steps: 4, drift: -9 },
  { x: 0.87, y: 0.24, steps: 3, drift: 7 },
]

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

    // ---- Gerstner displacement field --------------------------------------
    // Anchors never move; this returns the offset a particle at (x0, depth)
    // orbits with at time t, plus the local leeward flag for ink shading.
    // theta = k*x0 - omega*t: the phase travels rightward, the particle loops.
    const field = (x0: number, influence: number, t: number) => {
      const A1 = height * WAVE_CFG.mainAmplitude
      const L1 = width * WAVE_CFG.mainWavelength
      const k1 = (Math.PI * 2) / L1
      const omega1 = (k1 * (width + L1)) / (WAVE_CFG.crestCrossSeconds * 1000) * (width / (width + L1))
      const theta1 = k1 * x0 - omega1 * t

      const A2 = A1 * WAVE_CFG.secondAmplitude
      const L2 = L1 * WAVE_CFG.secondWavelength
      const k2 = (Math.PI * 2) / L2
      const omega2 = omega1 * WAVE_CFG.secondSpeed * (L1 / L2)
      const theta2 = k2 * x0 - omega2 * t + 1.3

      // vertical: main + sharpening harmonic + secondary; capped well under 7%vh
      const dy =
        (Math.sin(theta1) + WAVE_CFG.harmonic * Math.sin(2 * theta1 + 0.6)) * A1 +
        Math.sin(theta2) * A2

      // horizontal: small cos() orbit so surface particles trace ellipses
      const dx =
        (Math.cos(theta1) * A1 + Math.cos(theta2) * A2) * WAVE_CFG.horizontalShare

      // leeward (right-falling) face of the main crest -> deep ink near surface
      const slope = Math.cos(theta1) * A1 * k1 + Math.cos(theta2) * A2 * k2
      const leeward = slope < -WAVE_CFG.leewardSlope * height

      return { dx: dx * influence, dy: -dy * influence, leeward }
    }

    // ---- painting ---------------------------------------------------------
    // The anchor grid starts one max-amplitude above the still line (so crests
    // have room) and runs to the bottom. Row 0 of each column is the surface.
    const paint = (t: number) => {
      context.clearRect(0, 0, width, height)
      const ink = inks()
      const still = height * WAVE_CFG.stillLine
      const maxAmp = height * WAVE_CFG.mainAmplitude * (1 + WAVE_CFG.harmonic + WAVE_CFG.secondAmplitude)
      const top = Math.floor((still) / CELL) * CELL
      const bottomSpan = height - still + maxAmp

      for (let gx = 0; gx <= width; gx += CELL) {
        let row = 0
        for (let gy = top; gy <= height + CELL; gy += CELL, row++) {
          // depth from the rest surface; orbit dies out fast - the lower half
          // of the body never deforms (brief: 水体底部基本稳定)
          const depthNorm = Math.min(1, (gy - still + maxAmp) / (bottomSpan || 1))
          const influence = Math.exp(-Math.max(0, depthNorm) * WAVE_CFG.depthFalloff)
          const f = field(gx, influence, t)
          // crisp edge row, then the flat two-size checker - no alpha ramp
          const checker = ((gx / CELL + row) & 1) === 0
          const size = row === 0 ? 1.7 : checker ? 2.2 : 2.9
          context.fillStyle = f.leeward && row < 4 ? ink.deep : ink.base
          context.globalAlpha = 0.92
          context.fillRect(gx + f.dx, gy + f.dy, size, size)
        }
      }

      // sky stair-clusters from the reference, drifting slowly
      context.globalAlpha = 0.55
      context.fillStyle = ink.base
      for (const cluster of SKY) {
        const ox = cluster.x * width + Math.sin(t * 0.00013 + cluster.x * 9) * cluster.drift
        const oy = cluster.y * height + Math.cos(t * 0.0001 + cluster.y * 7) * 4
        for (let sIdx = 0; sIdx < cluster.steps; sIdx++) {
          for (let d = 0; d <= sIdx; d++) context.fillRect(ox + sIdx * 5, oy - d * 4, 1.6, 1.6)
        }
      }
      context.globalAlpha = 1
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < FRAME_MS) return
      last = now
      paint(now)
    }

    resize()
    if (reduced.matches) paint(2600) // one static frame mid-phase
    else raf = requestAnimationFrame(loop)

    const onResize = () => { resize(); if (reduced.matches) paint(2600) }
    const onVisibility = () => {
      if (reduced.matches) return
      cancelAnimationFrame(raf)
      if (!document.hidden) { last = 0; raf = requestAnimationFrame(loop) }
    }
    const observer = new MutationObserver(() => { if (reduced.matches) paint(2600) })
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
