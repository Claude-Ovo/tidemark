import * as THREE from 'three'
import { POOL_3D_CONFIG, polarToWorld } from './config.mjs'

const circlePoints = (radius, from, to, segments) => {
  const points = []
  for (let i = 0; i <= segments; i++) {
    const angle = from + (to - from) * i / segments
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius))
  }
  return points
}

const createMark = (ring) => {
  const radius = Math.max(0.11, (Number(ring.p.markR ?? 0.014) + 0.009) * POOL_3D_CONFIG.worldRadius)
  const material = new THREE.LineBasicMaterial({
    color: ring.kind === 'credited' ? 0xb9d8ea : 0x88a0b2,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  })
  let geometry
  let line
  if (ring.kind === 'credited') {
    geometry = new THREE.BufferGeometry().setFromPoints(circlePoints(radius, 0, Math.PI * 2, 72))
    line = new THREE.LineLoop(geometry, material)
  } else {
    const positions = []
    for (const [from, to] of [[0.1, 1.7], [2.3, 3.9], [4.5, 6.0]]) {
      const arc = circlePoints(radius, from, to, 18)
      for (let i = 1; i < arc.length; i++) positions.push(arc[i - 1], arc[i])
    }
    geometry = new THREE.BufferGeometry().setFromPoints(positions)
    line = new THREE.LineSegments(geometry, material)
  }
  line.renderOrder = 4
  line.userData = { ring }
  return line
}

export const createTideMarkGroup = () => {
  const group = new THREE.Group()
  group.name = 'TideMarkGroup'
  const marks = new Map()

  const setRings = (rings) => {
    const live = new Set()
    for (const ring of rings) {
      const key = `${ring.p.memory_id}|${ring.kind}|${ring.t0}`
      live.add(key)
      let mark = marks.get(key)
      if (!mark) {
        mark = createMark(ring)
        marks.set(key, mark)
        group.add(mark)
      }
      mark.userData.ring = ring
    }
    for (const [key, mark] of marks) {
      if (live.has(key)) continue
      marks.delete(key)
      group.remove(mark)
      mark.geometry.dispose()
      mark.material.dispose()
    }
  }

  const update = (nowMs, reducedMotion = false) => {
    const { stayMs, fadeMs } = POOL_3D_CONFIG.tideMark
    for (const mark of marks.values()) {
      const ring = mark.userData.ring
      const point = polarToWorld(ring.p)
      mark.position.set(point.x, point.y + 0.035, point.z)
      const settle = reducedMotion ? 1 : Math.min(1, Math.max(0, (nowMs - ring.t0) / 900))
      const scale = 0.72 + (1 - (1 - settle) ** 3) * 0.28
      mark.scale.setScalar(scale)
      const fade = nowMs < ring.t0 + stayMs
        ? 1
        : Math.max(0, 1 - (nowMs - ring.t0 - stayMs) / fadeMs)
      mark.material.opacity = (ring.kind === 'credited' ? 0.58 : 0.42) * fade
    }
  }

  return {
    group,
    setRings,
    update,
    dispose() {
      for (const mark of marks.values()) { mark.geometry.dispose(); mark.material.dispose() }
      marks.clear()
      group.clear()
    },
  }
}
