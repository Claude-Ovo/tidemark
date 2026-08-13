import { useEffect, useRef } from 'react'

// Halftone wave backdrop (Owner directive 2026-08-14, reference: the pixel-surf
// animation, surfer removed - only the sea stays). PURELY DECORATIVE: this layer
// encodes no data, reads no endpoint, and sits behind every panel with
// pointer-events none. The tide LEDGER is the data; this is the room it lives in.
//
// Mechanics, from the reference frames:
// - a dot grid whose dots exist only below a drifting wave surface; dot size
//   ramps with depth (halftone), so the crest reads as a crisp arc and the deep
//   water reads as dense weave
// - a few small "spray" stair-clusters drifting in the sky
// - ink colour follows the theme (--wave-ink): black dots on the light theme,
//   white dots on the dark theme - per Owner: white bg -> black particles,
//   black bg -> white particles
// Discipline: prefers-reduced-motion renders one static frame; forced-colors
// renders nothing; the loop is capped at 30fps and pauses when the tab hides.

const CELL = 8            // grid pitch in CSS px
const FRAME_MS = 1000 / 30

type Spray = { x: number; y: number; steps: number; drift: number }

const SPRAYS: Spray[] = [
  { x: 0.46, y: 0.16, steps: 5, drift: 14 },
  { x: 0.74, y: 0.10, steps: 4, drift: -10 },
  { x: 0.88, y: 0.30, steps: 3, drift: 8 },
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

    const ink = () =>
      getComputedStyle(document.documentElement).getPropertyValue('--wave-ink').trim() || '#ffffff'

    // Two slow sines; the surface lives in the bottom ~42% of the viewport.
    const surfaceAt = (x: number, t: number) => {
      const base = height * 0.72
      const swell = Math.sin(x * 0.0035 + t * 0.00021) * height * 0.055
      const chop = Math.sin(x * 0.011 - t * 0.00034 + 1.7) * height * 0.02
      return base + swell + chop
    }

    const draw = (t: number) => {
      context.clearRect(0, 0, width, height)
      const colour = ink()
      context.fillStyle = colour

      // sea: halftone squares sized by depth below the surface
      for (let gx = 0; gx <= width; gx += CELL) {
        const surface = surfaceAt(gx, t)
        for (let gy = Math.floor(surface / CELL) * CELL; gy <= height; gy += CELL) {
          const depth = (gy - surface) / (height - surface || 1)
          if (depth < 0) continue
          // size ramp 1px at the crest -> 3.4px deep; slight column jitter so
          // rows do not read as ruled lines
          const size = Math.min(3.4, 1 + depth * 3.2) + ((gx * 7 + gy * 13) % 5) * 0.06
          context.globalAlpha = Math.min(0.85, 0.35 + depth * 0.75)
          context.fillRect(gx, gy, size, size)
        }
      }

      // spray: small stair clusters drifting in the sky
      context.globalAlpha = 0.5
      for (const spray of SPRAYS) {
        const ox = spray.x * width + Math.sin(t * 0.00013 + spray.x * 9) * spray.drift
        const oy = spray.y * height + Math.cos(t * 0.0001 + spray.y * 7) * 4
        for (let s = 0; s < spray.steps; s++) {
          for (let d = 0; d <= s; d++) {
            context.fillRect(ox + s * 5, oy - d * 4, 1.6, 1.6)
          }
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
    if (reduced.matches) {
      draw(0)
    } else {
      raf = requestAnimationFrame(loop)
    }

    const onResize = () => { resize(); if (reduced.matches) draw(0) }
    const onVisibility = () => {
      if (reduced.matches) return
      cancelAnimationFrame(raf)
      if (!document.hidden) raf = requestAnimationFrame(loop)
    }
    // theme flips repaint immediately rather than waiting a frame (matters for
    // the reduced-motion static frame, which has no loop to pick it up)
    const observer = new MutationObserver(() => { if (reduced.matches) draw(0) })
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
