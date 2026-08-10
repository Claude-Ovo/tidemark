import * as THREE from 'three'
import { POOL_3D_CONFIG, polarToWorld } from './config.mjs'

const makeGlowTexture = () => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 96
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createRadialGradient(48, 48, 2, 48, 48, 47)
  gradient.addColorStop(0, 'rgba(239,248,255,1)')
  gradient.addColorStop(0.12, 'rgba(215,235,248,.92)')
  gradient.addColorStop(0.3, 'rgba(158,195,220,.38)')
  gradient.addColorStop(0.62, 'rgba(158,195,220,.07)')
  gradient.addColorStop(1, 'rgba(158,195,220,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 96, 96)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const ringGeometry = (radius, y = 0.012, segments = 192) => {
  const points = []
  const arcFade = []
  for (let i = 0; i <= segments; i++) {
    const a = i / segments * Math.PI * 2
    points.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius))
    const drift = 0.5 + 0.5 * Math.sin(a * 1.35 + radius * 0.57)
    arcFade.push(0.18 + drift ** 1.7 * 0.82)
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  geometry.setAttribute('aArcFade', new THREE.Float32BufferAttribute(arcFade, 1))
  return geometry
}

const guideVertexShader = /* glsl */`
  attribute float aArcFade;
  attribute float lineDistance;
  varying float vArcFade;
  varying float vViewAngle;
  varying float vLineDistance;
  #include <fog_pars_vertex>

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vec3 viewDirection = normalize(cameraPosition - worldPosition.xyz);
    vArcFade = aArcFade;
    vViewAngle = smoothstep(0.18, 0.78, abs(viewDirection.y));
    vLineDistance = lineDistance;
    vec4 mvPosition = viewMatrix * worldPosition;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`

const guideFragmentShader = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uDashed;
  varying float vArcFade;
  varying float vViewAngle;
  varying float vLineDistance;
  #include <fog_pars_fragment>

  void main() {
    float dash = uDashed < 0.5 ? 1.0 : step(mod(vLineDistance, 0.19), 0.075);
    float alpha = uOpacity * vArcFade * mix(0.38, 1.0, vViewAngle) * dash;
    if (alpha < 0.008) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <fog_fragment>
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const makeGuide = (radius, opacity, dashed = false) => {
  const geometry = ringGeometry(radius)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uColor: { value: new THREE.Color(0x718798) },
      uOpacity: { value: opacity },
      uDashed: { value: dashed ? 1 : 0 },
    },
    vertexShader: guideVertexShader,
    fragmentShader: guideFragmentShader,
    transparent: true,
    depthWrite: false,
    fog: true,
    toneMapped: true,
  })
  const line = new THREE.Line(geometry, material)
  line.computeLineDistances()
  line.renderOrder = 2
  return line
}

export const createDataModelGroup = () => {
  const group = new THREE.Group()
  group.name = 'DataModelGroup'
  const nodes = new Map()
  const guides = new THREE.Group()
  const nodeLayer = new THREE.Group()
  group.add(guides, nodeLayer)
  const glowTexture = makeGlowTexture()
  let particles = []
  let guideSignature = ''

  const setGuides = ({ pin, anchor, receding, fade }) => {
    const signature = [pin, anchor, receding, fade].map(x => Number(x).toFixed(6)).join('|')
    if (signature === guideSignature) return
    guideSignature = signature
    for (const child of [...guides.children]) {
      guides.remove(child)
      child.geometry?.dispose()
      child.material?.dispose()
    }
    guides.add(
      makeGuide(pin * POOL_3D_CONFIG.worldRadius, 0.052),
      makeGuide(anchor * POOL_3D_CONFIG.worldRadius, 0.046),
      makeGuide(receding * POOL_3D_CONFIG.worldRadius, 0.038),
      makeGuide(fade * POOL_3D_CONFIG.worldRadius, 0.115, true),
    )
  }

  const createNode = (particle) => {
    const node = new THREE.Group()
    node.name = `memory-${particle.memory_id}`
    const material = new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xdceaf3,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.renderOrder = 3
    const reflectionMaterial = material.clone()
    reflectionMaterial.opacity = 0.12
    reflectionMaterial.color.setHex(0x8ea9bc)
    const reflection = new THREE.Sprite(reflectionMaterial)
    reflection.renderOrder = 1
    node.add(sprite, reflection)
    node.userData = { particle, sprite, reflection }
    nodeLayer.add(node)
    nodes.set(particle.memory_id, node)
    return node
  }

  const removeNode = (id) => {
    const node = nodes.get(id)
    if (!node) return
    nodeLayer.remove(node)
    node.userData.sprite.material.dispose()
    node.userData.reflection.material.dispose()
    nodes.delete(id)
  }

  const setParticles = (nextParticles) => {
    particles = nextParticles
    const live = new Set(particles.map(p => p.memory_id))
    for (const id of nodes.keys()) if (!live.has(id)) removeNode(id)
    for (const particle of particles) {
      const node = nodes.get(particle.memory_id) ?? createNode(particle)
      node.userData.particle = particle
    }
  }

  const update = (seconds, reducedMotion = false) => {
    let moved = false
    for (const node of nodes.values()) {
      const p = node.userData.particle
      const point = polarToWorld(p)
      if (node.position.x !== point.x || node.position.z !== point.z) moved = true
      node.position.set(point.x, point.y, point.z)
      const strength = Number(p.s ?? 0.5)
      const breath = reducedMotion ? 1 : 1 + 0.045 * strength * Math.sin(seconds * 0.72 + Number(p.theta) * 5)
      const alpha = Number(p.alpha ?? 1)
      const growth = Number(p.mrScale ?? 1)
      const size = Math.max(0.07, Number(p.markR ?? 0.014) * POOL_3D_CONFIG.worldRadius * 3.45) * growth * breath
      node.userData.sprite.scale.setScalar(size)
      node.userData.sprite.material.opacity = Math.min(1, (0.64 + 0.34 * strength) * alpha)
      // Keep the flattened glint just above the water plane; below it, the
      // nearly opaque disk makes this work invisible.
      node.userData.reflection.position.y = -0.04
      node.userData.reflection.scale.set(size * 0.96, size * 0.18, 1)
      node.userData.reflection.material.opacity = (0.065 + 0.09 * strength) * alpha
    }
    return moved
  }

  const project = (particle, camera, domElement) => {
    const node = nodes.get(particle.memory_id)
    if (!node) return null
    const point = node.getWorldPosition(new THREE.Vector3()).project(camera)
    const rect = domElement.getBoundingClientRect()
    return [rect.left + (point.x * 0.5 + 0.5) * rect.width, rect.top + (-point.y * 0.5 + 0.5) * rect.height]
  }

  return {
    group,
    setGuides,
    setParticles,
    update,
    project,
    dispose() {
      for (const id of [...nodes.keys()]) removeNode(id)
      for (const child of [...guides.children]) { child.geometry.dispose(); child.material.dispose() }
      glowTexture.dispose()
      group.clear()
    },
  }
}
