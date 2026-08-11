import * as THREE from 'three'
import { POOL_3D_CONFIG, polarToWorld } from './config.mjs'

export const stableEventHash = (value) => {
  let hash = 2166136261
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const hashUnit = (hash, shift = 0) => ((hash >>> shift) & 0xffff) / 0xffff

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
    source: 'event',
    event,
    x: finite(target?.x),
    z: finite(target?.z),
    segments: cfg.minSegments + (hash % segmentRange),
    height: cfg.minHeight + (cfg.maxHeight - cfg.minHeight) * unit,
    duration: Math.max(0.12, finite(durationMs) > 0
      ? finite(durationMs) / 1000
      : (cfg.minFallMs + (cfg.maxFallMs - cfg.minFallMs) * (1 - unit)) / 1000),
    phaseOffset: 0,
    driftX: (hashUnit(hash, 6) * 2 - 1) * cfg.maxDrift,
    driftZ: (hashUnit(hash, 14) * 2 - 1) * cfg.maxDrift,
    strength: kindStrength,
    opacity: 0.72 + kindStrength * 0.24,
    size: 0.052 + kindStrength * 0.038,
  }
}

export const buildMemoryStrandSpec = (particle) => {
  const cfg = POOL_3D_CONFIG.rain
  const point = polarToWorld(particle)
  const hash = stableEventHash(`memory|${particle?.memory_id}`)
  const unit = hash / 0xffffffff
  const segmentRange = cfg.maxSegments - cfg.minSegments + 1
  const depth = THREE.MathUtils.clamp((point.z / POOL_3D_CONFIG.worldRadius + 1) * 0.5, 0, 1)
  const strength = THREE.MathUtils.clamp(finite(particle?.s, 0.5), 0, 1)
  const durationFactor = THREE.MathUtils.clamp(1 - depth * 0.45 + unit * 0.22, 0, 1)
  return {
    key: `memory|${particle?.memory_id}`,
    source: 'memory',
    event: null,
    particle,
    x: point.x,
    z: point.z,
    segments: cfg.minSegments + (hash % segmentRange),
    height: cfg.minHeight + (cfg.maxHeight - cfg.minHeight) * (0.28 + unit * 0.72),
    duration: (cfg.minMemoryFallMs
      + (cfg.maxMemoryFallMs - cfg.minMemoryFallMs) * durationFactor) / 1000,
    phaseOffset: hashUnit(hash, 8),
    driftX: (hashUnit(hash, 4) * 2 - 1) * cfg.maxDrift,
    driftZ: (hashUnit(hash, 12) * 2 - 1) * cfg.maxDrift,
    strength: 0.42 + strength * 0.34,
    opacity: 0.42 + depth * 0.34 + strength * 0.14,
    size: 0.040 + depth * 0.040 + strength * 0.012,
  }
}

export const advanceStrandLifecycle = ({ born, duration, landed = false }, seconds) => {
  const progress = Math.max(0, Math.min(1, (Number(seconds) - Number(born)) / Number(duration)))
  const landsNow = !landed && progress >= 1
  return { progress, landed: landed || landsNow, landsNow }
}

export const crossingCount = (previousSeconds, seconds, nextImpactAt, duration) => {
  if (!(seconds >= previousSeconds) || !(duration > 0) || !(nextImpactAt > previousSeconds)) return 0
  return nextImpactAt <= seconds ? 1 + Math.floor((seconds - nextImpactAt) / duration) : 0
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
  attribute float aLoop;
  uniform float uTime;
  uniform float uWaterY;
  uniform float uTrailLength;
  uniform float uViewportHeight;
  uniform float uDropBloom;
  varying float vOpacity;

  void main() {
    float rawElapsed = uTime - aBorn;
    float elapsed = max(0.0, rawElapsed);
    float progress = aLoop > 0.5
      ? fract(elapsed / max(aDuration, 0.001))
      : clamp(elapsed / max(aDuration, 0.001), 0.0, 1.0);
    float fall = progress * progress;
    float tailLength = uTrailLength * mix(1.0, 0.72, progress);
    float driftFade = 1.0 - progress;
    vec3 worldPosition = vec3(
      aTarget.x + aDrift.x * driftFade * sin(aPhase * 18.0 + progress * 3.2),
      mix(aHeight, uWaterY, fall) + aPhase * tailLength,
      aTarget.y + aDrift.y * driftFade * cos(aPhase * 16.0 + progress * 2.8)
    );
    vec4 viewPosition = modelViewMatrix * vec4(worldPosition, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    float oneShotLive = step(0.0, rawElapsed) * (1.0 - step(aDuration, rawElapsed));
    float live = aEnabled * mix(oneShotLive, 1.0, step(0.5, aLoop));
    float tip = 1.0 - smoothstep(0.0, 0.16, aPhase);
    float tailFade = 1.0 - smoothstep(0.62, 1.0, aPhase) * 0.64;
    vOpacity = live * aOpacity * tailFade * mix(0.56, 1.0, tip) * uDropBloom;
    gl_PointSize = live * clamp(aSize * uViewportHeight / max(1.0, -viewPosition.z), 1.25, 8.5);
  }
`

const strandFragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vOpacity;
  void main() {
    vec2 point = (gl_PointCoord - 0.5) * vec2(2.05, 0.82);
    float core = 1.0 - smoothstep(0.18, 0.54, length(point));
    float alpha = core * vOpacity;
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
    gl_PointSize = clamp(aSize * uViewportHeight / max(1.0, -viewPosition.z), 3.0, 22.0);
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
  const strandCapacity = cfg.maxMemoryStrands + cfg.maxEventStrands
  const totalPoints = strandCapacity * cfg.maxSegments
  const strandGeometry = new THREE.BufferGeometry()
  strandGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(totalPoints * 3), 3))
  strandGeometry.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(totalPoints * 2), 2))
  for (const name of ['aBorn', 'aDuration', 'aHeight', 'aPhase', 'aOpacity', 'aSize', 'aEnabled', 'aLoop'])
    strandGeometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(totalPoints), 1))
  strandGeometry.setAttribute('aDrift', new THREE.BufferAttribute(new Float32Array(totalPoints * 2), 2))

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
  strands.name = 'MemoryAndLifecycleRainStrands'
  strands.frustumCulled = false
  strands.renderOrder = 5

  const contactMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uViewportHeight: strandUniforms.uViewportHeight,
      uColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.coldGlint) },
    },
    vertexShader: contactVertexShader,
    fragmentShader: contactFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  const contacts = createPointPool(cfg.impactSlots, contactMaterial, 'RainContactFlashes', 6)

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
  const crowns = createPointPool(cfg.impactSlots, crownMaterial, 'RainImpactCrowns', 7)
  const group = new THREE.Group()
  group.name = 'MemoryRainCurtain'
  group.add(strands, contacts, crowns)

  const memorySlots = Array.from({ length: cfg.maxMemoryStrands }, () => null)
  const memorySlotById = new Map()
  const eventSlots = Array.from({ length: cfg.maxEventStrands }, () => null)
  const queue = []
  const seen = new Set()
  const impacts = []
  const recent = []
  let reduced = false
  let frozenSeconds = 0
  let lastSeconds = null
  let collisionCount = 0
  let committedEventCount = 0
  let eventImpactCount = 0

  const writeSlot = (absoluteSlot, spec, born, enabled, loop) => {
    const attrs = strandGeometry.attributes
    const start = absoluteSlot * cfg.maxSegments
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
      attrs.aOpacity.array[index] = spec.opacity
      attrs.aSize.array[index] = spec.size
      attrs.aEnabled.array[index] = active
      attrs.aLoop.array[index] = loop ? 1 : 0
    }
    for (const attribute of Object.values(attrs)) attribute.needsUpdate = true
  }

  const disableSlot = (absoluteSlot, spec) => writeSlot(absoluteSlot, spec, 0, false, false)

  const pushImpact = (spec, seconds) => {
    collisionCount++
    if (spec.source === 'event') eventImpactCount++
    impacts.push({ x: spec.x, z: spec.z, born: seconds, strength: spec.strength, event: spec.event })
    while (impacts.length > cfg.impactSlots) impacts.shift()
    if (spec.event) {
      recent.push({ x: spec.x, z: spec.z, born: seconds, event: spec.event })
      while (recent.length > cfg.impactSlots) recent.shift()
    }
    onImpact?.({
      x: spec.x,
      z: spec.z,
      strength: spec.strength,
      seconds,
      event: spec.event,
      source: spec.source,
    })
  }

  const initialiseMemorySlot = (state, seconds) => {
    state.born = seconds - state.spec.phaseOffset * state.spec.duration
    const elapsed = Math.max(0, seconds - state.born)
    state.nextImpactAt = state.born + (Math.floor(elapsed / state.spec.duration) + 1) * state.spec.duration
    writeSlot(state.slot, state.spec, state.born, true, true)
  }

  const syncMemoryStrands = (particles) => {
    if (particles.length > cfg.maxMemoryStrands)
      throw new Error(`memory_strand_capacity_exceeded:${particles.length}>${cfg.maxMemoryStrands}`)
    const live = new Set(particles.map(particle => particle.memory_id))
    for (const [id, slot] of memorySlotById) {
      if (live.has(id)) continue
      const state = memorySlots[slot]
      if (state) disableSlot(slot, state.spec)
      memorySlots[slot] = null
      memorySlotById.delete(id)
    }
    for (const particle of particles) {
      const spec = buildMemoryStrandSpec(particle)
      const existingSlot = memorySlotById.get(particle.memory_id)
      if (existingSlot != null) {
        const state = memorySlots[existingSlot]
        state.spec = spec
        if (state.born != null) writeSlot(existingSlot, spec, state.born, true, true)
        continue
      }
      const slot = memorySlots.findIndex(value => value == null)
      if (slot < 0) throw new Error('memory_strand_capacity_exhausted')
      memorySlots[slot] = { slot, spec, born: null, nextImpactAt: null }
      memorySlotById.set(particle.memory_id, slot)
    }
  }

  const startQueued = (seconds) => {
    for (let i = 0; i < eventSlots.length && queue.length; i++) {
      if (eventSlots[i]) continue
      const spec = queue.shift()
      eventSlots[i] = { ...spec, born: seconds, landed: false }
      writeSlot(cfg.maxMemoryStrands + i, spec, seconds, true, false)
    }
  }

  const updateImpactPool = (points, seconds, lifetime, crown = false) => {
    const attrs = points.geometry.attributes
    let count = 0
    for (const impact of impacts) {
      const progress = (seconds - impact.born) / lifetime
      if (progress < 0 || progress >= 1) continue
      attrs.position.array[count * 3] = impact.x
      attrs.position.array[count * 3 + 1] = crown ? 0.07 + progress * 0.10 : 0.065
      attrs.position.array[count * 3 + 2] = impact.z
      attrs.aSize.array[count] = crown
        ? 0.18 + impact.strength * 0.14
        : 0.10 + impact.strength * 0.11 + progress * 0.05
      attrs.aOpacity.array[count] = ((1 - progress) ** (crown ? 2.45 : 1.7))
        * (0.52 + impact.strength * 0.48) * (crown ? cfg.crownBloom : cfg.impactBloom)
      count++
    }
    points.geometry.setDrawRange(0, count)
    attrs.position.needsUpdate = true
    attrs.aSize.needsUpdate = true
    attrs.aOpacity.needsUpdate = true
  }

  return {
    group,
    setMemoryStrands: syncMemoryStrands,
    setReducedMotion(value) {
      const next = !!value
      if (next === reduced) return
      reduced = next
      if (reduced) {
        frozenSeconds = strandUniforms.uTime.value
        const seconds = performance.now() / 1000
        for (let i = 0; i < eventSlots.length; i++) {
          const slot = eventSlots[i]
          if (slot && !slot.landed) pushImpact(slot, seconds)
          if (slot) disableSlot(cfg.maxMemoryStrands + i, slot)
          eventSlots[i] = null
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
        pushImpact(spec, performance.now() / 1000)
        return true
      }
      if (queue.length >= cfg.maxQueuedStrands) throw new Error('lifecycle_strand_queue_overflow')
      queue.push(spec)
      return true
    },
    resize(height) { strandUniforms.uViewportHeight.value = Math.max(1, finite(height, 1)) },
    update(seconds) {
      if (!reduced) strandUniforms.uTime.value = seconds
      else strandUniforms.uTime.value = frozenSeconds

      for (const state of memorySlots) if (state && state.born == null) initialiseMemorySlot(state, seconds)
      const frameGap = lastSeconds == null ? 0 : Math.max(0, seconds - lastSeconds)
      if (!reduced && lastSeconds != null) {
        for (const state of memorySlots) {
          if (!state) continue
          if (state.nextImpactAt <= lastSeconds) {
            const skipped = 1 + Math.floor((lastSeconds - state.nextImpactAt) / state.spec.duration)
            state.nextImpactAt += skipped * state.spec.duration
          }
          const count = crossingCount(lastSeconds, seconds, state.nextImpactAt, state.spec.duration)
          if (frameGap <= cfg.maxVisibleFrameGap && count > 0) pushImpact(state.spec, seconds)
          if (count > 0) state.nextImpactAt += count * state.spec.duration
        }
      }
      lastSeconds = seconds
      if (reduced) return

      startQueued(seconds)
      for (let i = 0; i < eventSlots.length; i++) {
        const slot = eventSlots[i]
        if (!slot) continue
        const next = advanceStrandLifecycle(slot, seconds)
        if (next.landsNow) pushImpact(slot, seconds)
        slot.landed = next.landed
        if (seconds < slot.born + slot.duration + 0.04) continue
        disableSlot(cfg.maxMemoryStrands + i, slot)
        eventSlots[i] = null
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
      for (const slot of eventSlots) {
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
        collisionCount,
        committedEventCount,
        eventImpactCount,
        queuedEventCount: queue.length,
        activeEventStrandCount: eventSlots.filter(Boolean).length,
        memoryStrandCount: memorySlotById.size,
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
      memorySlotById.clear()
    },
  }
}
