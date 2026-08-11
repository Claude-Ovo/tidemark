import * as THREE from 'three'
import { POOL_3D_CONFIG } from './config.mjs'

export const stableEventHash = (value) => {
  let hash = 2166136261
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export const buildStrandSpec = (event, target, durationMs) => {
  const cfg = POOL_3D_CONFIG.rain
  const hash = stableEventHash(`${event?.kind}|${event?.event_id}`)
  const unit = hash / 0xffffffff
  const segmentRange = cfg.maxSegments - cfg.minSegments + 1
  const kindStrength = event?.kind === 'outcome'
    ? (event?.items?.some(item => item.applied === true) ? 1 : 0.52)
    : event?.kind === 'remember' ? 0.82 : 0.68
  return {
    key: `${event?.kind}|${event?.event_id}`,
    event,
    x: Number(target?.x) || 0,
    z: Number(target?.z) || 0,
    segments: cfg.minSegments + (hash % segmentRange),
    height: cfg.minHeight + (cfg.maxHeight - cfg.minHeight) * unit,
    duration: Math.max(0.12, Number(durationMs) > 0
      ? Number(durationMs) / 1000
      : (cfg.minFallMs + (cfg.maxFallMs - cfg.minFallMs) * (1 - unit)) / 1000),
    driftX: (((hash >>> 8) & 255) / 255 * 2 - 1) * cfg.maxDrift,
    driftZ: (((hash >>> 16) & 255) / 255 * 2 - 1) * cfg.maxDrift,
    strength: kindStrength,
  }
}

export const advanceStrandLifecycle = ({ born, duration, landed = false }, seconds) => {
  const progress = Math.max(0, Math.min(1, (Number(seconds) - Number(born)) / Number(duration)))
  const landsNow = !landed && progress >= 1
  return { progress, landed: landed || landsNow, landsNow }
}

const strandVertexShader = /* glsl */`
  attribute vec2 aTarget;
  attribute float aBorn;
  attribute float aDuration;
  attribute float aHeight;
  attribute float aPhase;
  attribute vec2 aDrift;
  attribute float aOpacity;
  attribute float aSize;
  attribute float aEnabled;
  uniform float uTime;
  uniform float uWaterY;
  uniform float uTrailLength;
  uniform float uViewportHeight;
  uniform float uDropBloom;
  varying float vOpacity;

  void main() {
    float elapsed = uTime - aBorn;
    float progress = clamp(elapsed / max(aDuration, 0.001), 0.0, 1.0);
    float beadProgress = clamp(progress - aPhase * 0.24, 0.0, 1.0);
    float fall = beadProgress * beadProgress;
    float driftFade = 1.0 - beadProgress;
    vec3 worldPosition = vec3(
      aTarget.x + aDrift.x * driftFade * sin(aPhase * 19.0 + progress * 3.1),
      mix(aHeight, uWaterY, fall) + aPhase * uTrailLength * 0.10,
      aTarget.y + aDrift.y * driftFade * cos(aPhase * 17.0 + progress * 2.7)
    );
    vec4 viewPosition = modelViewMatrix * vec4(worldPosition, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    float live = aEnabled * step(0.0, elapsed) * (1.0 - step(aDuration, elapsed));
    float tip = 1.0 - smoothstep(0.0, 0.18, aPhase);
    vOpacity = live * aOpacity * mix(0.38, 1.0, tip) * uDropBloom;
    gl_PointSize = live * clamp(aSize * uViewportHeight / max(1.0, -viewPosition.z), 1.4, 8.5);
  }
`

const strandFragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vOpacity;
  void main() {
    vec2 point = (gl_PointCoord - 0.5) * vec2(1.7, 1.0);
    float alpha = (1.0 - smoothstep(0.18, 0.52, length(point))) * vOpacity;
    if (alpha < 0.012) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <colorspace_fragment>
  }
`

const contactVertexShader = /* glsl */`
  attribute float aSize;
  attribute float aOpacity;
  uniform float uViewportHeight;
  varying float vOpacity;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(aSize * uViewportHeight / max(1.0, -viewPosition.z), 3.0, 20.0);
    vOpacity = aOpacity;
  }
`

const contactFragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vOpacity;
  void main() {
    float radial = length(gl_PointCoord - 0.5) * 2.0;
    float alpha = (1.0 - smoothstep(0.0, 1.0, radial)) * vOpacity;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <colorspace_fragment>
  }
`

const crownFragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vOpacity;
  float segmentDistance(vec2 point, vec2 start, vec2 end) {
    vec2 line = end - start;
    float projection = clamp(dot(point - start, line) / dot(line, line), 0.0, 1.0);
    return length(point - start - line * projection);
  }
  void main() {
    vec2 point = (gl_PointCoord - 0.5) * 2.0;
    float jets = min(
      segmentDistance(point, vec2(-0.28, -0.34), vec2(-0.52, 0.34)),
      min(segmentDistance(point, vec2(0.0, -0.40), vec2(0.0, 0.62)),
        segmentDistance(point, vec2(0.28, -0.34), vec2(0.52, 0.34)))
    );
    float bowlDistance = abs(length(vec2(point.x, (point.y + 0.38) * 1.7)) - 0.48);
    float bowl = (1.0 - smoothstep(0.04, 0.11, bowlDistance)) * (1.0 - smoothstep(-0.18, 0.14, point.y));
    float alpha = max(1.0 - smoothstep(0.035, 0.105, jets), bowl * 0.72) * vOpacity;
    if (alpha < 0.025) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <colorspace_fragment>
  }
`

const createPointPool = (count, material, name, renderOrder) => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(count), 1))
  geometry.setAttribute('aOpacity', new THREE.BufferAttribute(new Float32Array(count), 1))
  geometry.setDrawRange(0, 0)
  const points = new THREE.Points(geometry, material)
  points.name = name
  points.frustumCulled = false
  points.renderOrder = renderOrder
  return points
}

export const createRainSystem = ({ onImpact } = {}) => {
  const cfg = POOL_3D_CONFIG.rain
  const totalPoints = cfg.maxStrands * cfg.maxSegments
  const strandGeometry = new THREE.BufferGeometry()
  strandGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(totalPoints * 3), 3))
  strandGeometry.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(totalPoints * 2), 2))
  strandGeometry.setAttribute('aBorn', new THREE.BufferAttribute(new Float32Array(totalPoints), 1))
  strandGeometry.setAttribute('aDuration', new THREE.BufferAttribute(new Float32Array(totalPoints), 1))
  strandGeometry.setAttribute('aHeight', new THREE.BufferAttribute(new Float32Array(totalPoints), 1))
  strandGeometry.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(totalPoints), 1))
  strandGeometry.setAttribute('aDrift', new THREE.BufferAttribute(new Float32Array(totalPoints * 2), 2))
  strandGeometry.setAttribute('aOpacity', new THREE.BufferAttribute(new Float32Array(totalPoints), 1))
  strandGeometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(totalPoints), 1))
  strandGeometry.setAttribute('aEnabled', new THREE.BufferAttribute(new Float32Array(totalPoints), 1))
  const strandUniforms = {
    uTime: { value: 0 },
    uWaterY: { value: 0.06 },
    uTrailLength: { value: cfg.trailLength },
    uViewportHeight: { value: Math.max(1, window.innerHeight) },
    uDropBloom: { value: cfg.dropBloom },
    uColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.pearl) },
  }
  const strandMaterial = new THREE.ShaderMaterial({
    uniforms: strandUniforms,
    vertexShader: strandVertexShader,
    fragmentShader: strandFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  const strands = new THREE.Points(strandGeometry, strandMaterial)
  strands.name = 'LifecycleRainStrands'
  strands.frustumCulled = false
  strands.renderOrder = 5

  const contactUniforms = {
    uViewportHeight: strandUniforms.uViewportHeight,
    uColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.coldGlint) },
  }
  const contactMaterial = new THREE.ShaderMaterial({
    uniforms: contactUniforms,
    vertexShader: contactVertexShader,
    fragmentShader: contactFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  const contacts = createPointPool(cfg.impactSlots, contactMaterial, 'LifecycleImpactFlashes', 6)

  const crownMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uViewportHeight: strandUniforms.uViewportHeight,
      uColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.pearl) },
    },
    vertexShader: contactVertexShader,
    fragmentShader: crownFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  const crowns = createPointPool(cfg.impactSlots, crownMaterial, 'LifecycleImpactCrowns', 7)
  const group = new THREE.Group()
  group.name = 'LifecycleRainSystem'
  group.add(strands, contacts, crowns)

  const slots = Array.from({ length: cfg.maxStrands }, () => null)
  const queue = []
  const seen = new Set()
  const impacts = []
  const recent = []
  let reduced = false
  let committedEventCount = 0
  let visualImpactCount = 0

  const updateSlotAttributes = (slotIndex, spec, born, enabled) => {
    const attrs = strandGeometry.attributes
    const start = slotIndex * cfg.maxSegments
    for (let i = 0; i < cfg.maxSegments; i++) {
      const index = start + i
      const active = enabled && i < spec.segments ? 1 : 0
      attrs.aTarget.array[index * 2] = spec.x
      attrs.aTarget.array[index * 2 + 1] = spec.z
      attrs.aBorn.array[index] = born
      attrs.aDuration.array[index] = spec.duration
      attrs.aHeight.array[index] = spec.height
      attrs.aPhase.array[index] = i / Math.max(1, spec.segments - 1)
      attrs.aDrift.array[index * 2] = spec.driftX
      attrs.aDrift.array[index * 2 + 1] = spec.driftZ
      attrs.aOpacity.array[index] = 0.70 + spec.strength * 0.28
      attrs.aSize.array[index] = 0.050 + spec.strength * 0.040
      attrs.aEnabled.array[index] = active
    }
    for (const attribute of Object.values(attrs)) attribute.needsUpdate = true
  }

  const startQueued = (seconds) => {
    for (let i = 0; i < slots.length && queue.length; i++) {
      if (slots[i]) continue
      const spec = queue.shift()
      slots[i] = { ...spec, born: seconds, landed: false }
      updateSlotAttributes(i, spec, seconds, true)
    }
  }

  const pushImpact = (slot, seconds) => {
    visualImpactCount++
    impacts.push({ x: slot.x, z: slot.z, born: seconds, strength: slot.strength, event: slot.event })
    while (impacts.length > cfg.impactSlots) impacts.shift()
    recent.push({ x: slot.x, z: slot.z, born: seconds, event: slot.event })
    onImpact?.({ x: slot.x, z: slot.z, strength: slot.strength, seconds, event: slot.event })
  }

  const updateImpactPool = (points, seconds, lifetime, crown = false) => {
    const attrs = points.geometry.attributes
    let count = 0
    for (const impact of impacts) {
      const progress = (seconds - impact.born) / lifetime
      if (progress < 0 || progress >= 1) continue
      attrs.position.array[count * 3] = impact.x
      attrs.position.array[count * 3 + 1] = crown ? 0.07 + progress * 0.09 : 0.065
      attrs.position.array[count * 3 + 2] = impact.z
      attrs.aSize.array[count] = crown
        ? 0.16 + impact.strength * 0.12
        : 0.08 + impact.strength * 0.09 + progress * 0.05
      attrs.aOpacity.array[count] = ((1 - progress) ** (crown ? 2.6 : 1.8))
        * (0.48 + impact.strength * 0.52) * (crown ? cfg.crownBloom : cfg.impactBloom)
      count++
    }
    points.geometry.setDrawRange(0, count)
    attrs.position.needsUpdate = true
    attrs.aSize.needsUpdate = true
    attrs.aOpacity.needsUpdate = true
  }

  return {
    group,
    setReducedMotion(value) {
      reduced = !!value
      if (reduced) {
        const seconds = performance.now() / 1000
        for (let i = 0; i < slots.length; i++) {
          if (slots[i] && !slots[i].landed) pushImpact(slots[i], seconds)
          if (slots[i]) updateSlotAttributes(i, slots[i], slots[i].born, false)
          slots[i] = null
        }
        while (queue.length) pushImpact(queue.shift(), seconds)
        impacts.length = 0
        contacts.geometry.setDrawRange(0, 0)
        crowns.geometry.setDrawRange(0, 0)
      }
    },
    emitStrand(event, target, { durationMs } = {}) {
      if (!event?.kind || !event?.event_id) return false
      const spec = buildStrandSpec(event, target, durationMs)
      if (seen.has(spec.key)) return false
      seen.add(spec.key)
      committedEventCount++
      if (seen.size > 2048) seen.delete(seen.values().next().value)
      if (reduced) {
        visualImpactCount++
        onImpact?.({ x: spec.x, z: spec.z, strength: spec.strength, seconds: performance.now() / 1000, event })
        return true
      }
      if (queue.length >= cfg.maxQueuedStrands) throw new Error('lifecycle_strand_queue_overflow')
      queue.push(spec)
      return true
    },
    resize(height) { strandUniforms.uViewportHeight.value = Math.max(1, Number(height) || 1) },
    update(seconds) {
      strandUniforms.uTime.value = seconds
      if (reduced) return
      startQueued(seconds)
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]
        if (!slot) continue
        const next = advanceStrandLifecycle(slot, seconds)
        if (next.landsNow) pushImpact(slot, seconds)
        slot.landed = next.landed
        if (seconds < slot.born + slot.duration + 0.035) continue
        updateSlotAttributes(i, slot, slot.born, false)
        slots[i] = null
      }
      startQueued(seconds)
      while (impacts.length && seconds - impacts[0].born >= cfg.impactLifetime) impacts.shift()
      while (recent.length && (seconds - recent[0].born) * 1000 >= cfg.recentPickMs) recent.shift()
      updateImpactPool(contacts, seconds, cfg.impactLifetime, false)
      updateImpactPool(crowns, seconds, cfg.crownLifetime, true)
    },
    pick(clientX, clientY, camera, domElement) {
      const rect = domElement.getBoundingClientRect()
      const candidates = []
      for (const slot of slots) {
        if (!slot) continue
        const state = advanceStrandLifecycle(slot, strandUniforms.uTime.value)
        const y = THREE.MathUtils.lerp(slot.height, 0.06, state.progress * state.progress)
        candidates.push({ x: slot.x, y, z: slot.z, event: slot.event })
      }
      for (const impact of recent) candidates.push({ x: impact.x, y: 0.06, z: impact.z, event: impact.event })
      let best = null
      for (const candidate of candidates) {
        const projected = new THREE.Vector3(candidate.x, candidate.y, candidate.z).project(camera)
        const px = rect.left + (projected.x * 0.5 + 0.5) * rect.width
        const py = rect.top + (-projected.y * 0.5 + 0.5) * rect.height
        const distance = Math.hypot(px - clientX, py - clientY)
        if (distance <= 24 && (!best || distance < best.distance)) best = { ...candidate, distance }
      }
      return best ? { event: best.event, clientX, clientY } : null
    },
    metrics() {
      return {
        committedEventCount,
        visualImpactCount,
        queuedEventCount: queue.length,
        activeStrandCount: slots.filter(Boolean).length,
      }
    },
    dispose() {
      strandGeometry.dispose()
      strandMaterial.dispose()
      contacts.geometry.dispose()
      contactMaterial.dispose()
      crowns.geometry.dispose()
      crownMaterial.dispose()
      group.clear()
      queue.length = 0
      impacts.length = 0
      recent.length = 0
    },
  }
}
