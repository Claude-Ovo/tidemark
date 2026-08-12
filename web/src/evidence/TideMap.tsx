import { useEffect, useMemo, useRef, useState } from 'react'
import { layoutPool, POOL_CFG } from '../pool/layout-pool.mjs'
import type { MemoryWithEpisode } from './types'

type PlacedMemory = {
  memory_id: string
  s: number
  layer: 'anchor' | 'active_tide' | 'receding_edge'
  r: number
  theta: number
  markR: number
}

type Size = { width: number; height: number }

const EMPTY_SIZE: Size = { width: 0, height: 0 }

export function TideMap({
  memories,
  fadeThreshold,
  selectedId,
  onSelect,
}: {
  memories: MemoryWithEpisode[]
  fadeThreshold: number
  selectedId: string | null
  onSelect: (memoryId: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState<Size>(EMPTY_SIZE)
  const memoryIndex = useMemo(() => new Map(memories.map((memory) => [memory.memory_id, memory])), [memories])
  const layout = useMemo(() => {
    // The evidence overview must keep the complete bounded snapshot visible. The shared
    // monotonic radius remains untouched; only the collision footprint is reduced for
    // dense slices so a point is never silently traded for decoration.
    const cfg = memories.length > 100 ? {
      ...POOL_CFG,
      MARK_R: 0.010,
      MARK_R_MIN: 0.0045,
      HALO_R: 0.006,
      OUTER_INSET: 0.018,
      SEP: 1.05,
      ANGLE_TRIES: 72,
      ANGLE_STEP: 0.035,
    } : POOL_CFG
    return layoutPool(memories, { cfg }) as { placed: PlacedMemory[]; overflow: unknown[] }
  }, [memories])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const resize = () => setSize({ width: host.clientWidth, height: host.clientHeight })
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, size.width, size.height)

    const cx = size.width / 2
    const cy = size.height / 2
    const radius = Math.max(1, Math.min(size.width, size.height) / 2 - 18)
    const line = (r: number, color: string, dash: number[] = []) => {
      context.beginPath()
      context.arc(cx, cy, radius * r, 0, Math.PI * 2)
      context.setLineDash(dash)
      context.strokeStyle = color
      context.lineWidth = 1
      context.stroke()
    }
    line(0.18, 'rgba(185,165,106,.20)')
    line(0.54, 'rgba(143,201,214,.12)')
    line(0.78, 'rgba(143,201,214,.08)')
    const fadeRadius = 0.05 + (1 - 0.024 - 0.05) * (1 - fadeThreshold)
    line(fadeRadius, 'rgba(199,125,107,.24)', [3, 5])

    for (const point of layout.placed) {
      const memory = memoryIndex.get(point.memory_id)
      const x = cx + point.r * radius * Math.cos(point.theta)
      const y = cy + point.r * radius * Math.sin(point.theta)
      const selected = point.memory_id === selectedId
      const base = point.layer === 'anchor' ? 3.4 : point.layer === 'active_tide' ? 2.8 : 2.15
      context.beginPath()
      context.arc(x, y, selected ? base + 2.2 : base, 0, Math.PI * 2)
      context.fillStyle = selected
        ? '#f4e7b6'
        : memory?.pinned
          ? '#d9c887'
          : point.layer === 'receding_edge'
            ? 'rgba(164,190,195,.68)'
            : '#dcebed'
      context.fill()
      if (selected) {
        context.beginPath()
        context.arc(x, y, base + 6.5, 0, Math.PI * 2)
        context.strokeStyle = 'rgba(244,231,182,.42)'
        context.stroke()
      }
    }
  }, [fadeThreshold, layout.placed, memoryIndex, selectedId, size])

  const geometry = useMemo(() => {
    const cx = size.width / 2
    const cy = size.height / 2
    const radius = Math.max(1, Math.min(size.width, size.height) / 2 - 18)
    return { cx, cy, radius }
  }, [size])

  return (
    <div className="tide-map" ref={hostRef}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="tide-map__hits" aria-label="Memory tide map">
        {layout.placed.map((point) => {
          const memory = memoryIndex.get(point.memory_id)
          const x = geometry.cx + point.r * geometry.radius * Math.cos(point.theta)
          const y = geometry.cy + point.r * geometry.radius * Math.sin(point.theta)
          return (
            <button
              className="tide-hit"
              data-selected={point.memory_id === selectedId || undefined}
              key={point.memory_id}
              style={{ transform: `translate(${x - 17}px, ${y - 17}px)` }}
              onClick={() => onSelect(point.memory_id)}
              aria-label={`${memory?.kind ?? 'memory'}, ${(point.s * 100).toFixed(0)} percent retained`}
              title={(memory?.content_preview ?? point.memory_id).slice(0, 90)}
            />
          )
        })}
      </div>
      <div className="tide-map__legend" aria-hidden="true">
        <span>held</span><span>fading</span>
      </div>
      {layout.overflow.length > 0 && <p className="tide-map__overflow">{layout.overflow.length} records outside display capacity</p>}
    </div>
  )
}
