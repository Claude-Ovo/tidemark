import * as THREE from 'three'
import { POOL_3D_CONFIG, polarToWorld } from './config.mjs'

const pointVertexShader = /* glsl */`
  attribute float aSizeCss;
  attribute float aScale;
  uniform float uPixelRatio;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(aSizeCss * aScale * uPixelRatio, 8.0 * uPixelRatio, 14.3 * uPixelRatio);
  }
`

const pointFragmentShader = /* glsl */`
  uniform vec3 uPointWhite;
  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float radial = length(point) * 2.0;
    float alpha = 1.0 - smoothstep(0.88, 1.0, radial);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uPointWhite, alpha);
    #include <colorspace_fragment>
  }
`

// Visual points keep their truthful below-surface position but render after the
// almost transparent water base so submission readability never depends on a
// refraction pass. Invisible anchors retain the same XZ interaction source.
export const createDataModelGroup = () => {
  const cfg = POOL_3D_CONFIG
  const capacity = cfg.maxMemoryPoints
  const group = new THREE.Group()
  group.name = 'UnderwaterMemoryField'
  const nodes = new Map()

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3))
  geometry.setAttribute('aSizeCss', new THREE.BufferAttribute(new Float32Array(capacity), 1))
  geometry.setAttribute('aScale', new THREE.BufferAttribute(new Float32Array(capacity).fill(1), 1))
  geometry.setDrawRange(0, 0)
  const uniforms = {
    uPixelRatio: { value: 1 },
    uPointWhite: { value: new THREE.Color(0xf8fcff) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: pointVertexShader,
    fragmentShader: pointFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  })
  const points = new THREE.Points(geometry, material)
  points.name = 'ReadablePersistedMemoryPoints'
  points.frustumCulled = false
  points.renderOrder = 20
  group.add(points)

  const createNode = (particle) => {
    const node = new THREE.Object3D()
    node.name = `memory-landing-${particle.memory_id}`
    node.userData.particle = particle
    group.add(node)
    nodes.set(particle.memory_id, node)
    return node
  }

  const writePoints = () => {
    const positions = geometry.attributes.position.array
    const sizes = geometry.attributes.aSizeCss.array
    let index = 0
    for (const node of nodes.values()) {
      const point = polarToWorld(node.userData.particle)
      const strength = THREE.MathUtils.clamp(Number(node.userData.particle?.s) || 0.5, 0, 1)
      positions[index * 3] = point.x
      positions[index * 3 + 1] = cfg.water.underwaterY
      positions[index * 3 + 2] = point.z
      sizes[index] = 8 + strength * 3
      index++
    }
    geometry.setDrawRange(0, index)
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.aSizeCss.needsUpdate = true
  }

  const setParticles = (particles) => {
    if (particles.length > capacity) throw new Error(`underwater_memory_capacity_exceeded:${particles.length}>${capacity}`)
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
    writePoints()
  }

  const update = () => {
    let moved = false
    for (const node of nodes.values()) {
      const point = polarToWorld(node.userData.particle)
      if (node.position.x !== point.x || node.position.z !== point.z) moved = true
      node.position.set(point.x, cfg.water.underwaterY, point.z)
    }
    if (moved) writePoints()
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
    points,
    setGuides() {},
    setParticles,
    resize(_height, pixelRatio = 1) { uniforms.uPixelRatio.value = Math.max(1, Number(pixelRatio) || 1) },
    setInteractionState({ hoveredId = null, selectedId = null } = {}) {
      const scales = geometry.attributes.aScale.array
      let index = 0
      for (const [id] of nodes) {
        scales[index++] = id === hoveredId ? 1.3 : id === selectedId ? 1.18 : 1
      }
      geometry.attributes.aScale.needsUpdate = true
    },
    update,
    project,
    metrics() { return { underwaterPointCount: geometry.drawRange.count } },
    dispose() {
      nodes.clear()
      geometry.dispose()
      material.dispose()
      group.clear()
    },
  }
}
