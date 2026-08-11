import * as THREE from 'three'
import { POOL_3D_CONFIG, polarToWorld } from './config.mjs'

const pointVertexShader = /* glsl */`
  attribute float aOpacity;
  attribute float aSize;
  uniform float uViewportHeight;
  varying float vOpacity;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    // Preserve the data-driven aSize while guaranteeing a 50%-screenshot-safe
    // raster footprint. This is a display floor, not a new data encoding.
    gl_PointSize = clamp(aSize * uViewportHeight / max(1.0, -viewPosition.z), 3.2, 10.0);
    vOpacity = aOpacity;
  }
`

const pointFragmentShader = /* glsl */`
  uniform vec3 uPearl;
  uniform vec3 uColdGlint;
  varying float vOpacity;
  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float radial = length(point) * 2.0;
    float core = 1.0 - smoothstep(0.0, 0.24, radial);
    float halo = (1.0 - smoothstep(0.08, 1.0, radial)) * 0.38;
    float alpha = max(core, halo) * vOpacity;
    if (alpha < 0.012) discard;
    gl_FragColor = vec4(mix(uColdGlint, uPearl, core), alpha);
    #include <colorspace_fragment>
  }
`

// Visual points keep their truthful below-surface position but render after the
// almost transparent water base so submission readability never depends on a
// refraction pass. Invisible anchors retain the same XZ interaction source.
export const createDataModelGroup = () => {
  const cfg = POOL_3D_CONFIG
  const capacity = cfg.rain.maxMemoryStrands
  const group = new THREE.Group()
  group.name = 'UnderwaterMemoryField'
  const nodes = new Map()

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3))
  geometry.setAttribute('aOpacity', new THREE.BufferAttribute(new Float32Array(capacity), 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(capacity), 1))
  geometry.setDrawRange(0, 0)
  const uniforms = {
    uViewportHeight: { value: Math.max(1, window.innerHeight) },
    uPearl: { value: new THREE.Color(cfg.palette.pearl) },
    uColdGlint: { value: new THREE.Color(cfg.palette.coldGlint) },
  }
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: pointVertexShader,
    fragmentShader: pointFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  const points = new THREE.Points(geometry, material)
  points.name = 'ReadablePersistedMemoryPoints'
  points.frustumCulled = false
  points.renderOrder = 2
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
    const opacity = geometry.attributes.aOpacity.array
    const sizes = geometry.attributes.aSize.array
    let index = 0
    for (const node of nodes.values()) {
      const point = polarToWorld(node.userData.particle)
      const strength = THREE.MathUtils.clamp(Number(node.userData.particle?.s) || 0.5, 0, 1)
      positions[index * 3] = point.x
      positions[index * 3 + 1] = cfg.water.underwaterY
      positions[index * 3 + 2] = point.z
      opacity[index] = cfg.water.underwaterPointTransmission * (0.80 + strength * 0.20)
      sizes[index] = 0.075 + strength * 0.045
      index++
    }
    geometry.setDrawRange(0, index)
    geometry.attributes.position.needsUpdate = true
    geometry.attributes.aOpacity.needsUpdate = true
    geometry.attributes.aSize.needsUpdate = true
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
      node.position.set(point.x, point.y, point.z)
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
    resize(height) { uniforms.uViewportHeight.value = Math.max(1, Number(height) || 1) },
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
