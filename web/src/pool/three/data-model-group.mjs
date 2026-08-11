import * as THREE from 'three'
import { polarToWorld } from './config.mjs'

// Memory records are rendered by RainSystem as vertical strands. This group is
// deliberately visual-free: it preserves the one true landing point used by
// hover, keyboard focus and detail selection without leaving a second set of
// flat dots on the water.
export const createDataModelGroup = () => {
  const group = new THREE.Group()
  group.name = 'MemoryLandingAnchors'
  const nodes = new Map()

  const createNode = (particle) => {
    const node = new THREE.Object3D()
    node.name = `memory-landing-${particle.memory_id}`
    node.userData.particle = particle
    group.add(node)
    nodes.set(particle.memory_id, node)
    return node
  }

  const setParticles = (particles) => {
    const live = new Set(particles.map(particle => particle.memory_id))
    for (const [id, node] of nodes) {
      if (live.has(id)) continue
      group.remove(node)
      nodes.delete(id)
    }
    for (const particle of particles) {
      const node = nodes.get(particle.memory_id) ?? createNode(particle)
      node.userData.particle = particle
    }
  }

  const update = () => {
    let moved = false
    for (const node of nodes.values()) {
      const point = polarToWorld(node.userData.particle)
      if (node.position.x !== point.x || node.position.z !== point.z) moved = true
      node.position.set(point.x, point.y, point.z)
    }
    return moved
  }

  const project = (particle, camera, domElement) => {
    const node = nodes.get(particle.memory_id)
    if (!node) return null
    const point = node.getWorldPosition(new THREE.Vector3()).project(camera)
    const rect = domElement.getBoundingClientRect()
    return [
      rect.left + (point.x * 0.5 + 0.5) * rect.width,
      rect.top + (-point.y * 0.5 + 0.5) * rect.height,
    ]
  }

  return {
    group,
    setGuides() {},
    setParticles,
    update,
    project,
    dispose() {
      nodes.clear()
      group.clear()
    },
  }
}
