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
const clampToPool = (x, z) => {
  const limit = POOL_3D_CONFIG.worldRadius * 0.985
  const length = Math.hypot(x, z)
  if (length <= limit) return { x, z }
  const scale = limit / Math.max(length, 0.0001)
  return { x: x * scale, z: z * scale }
}

const streakAppearance = (hash, depth, strength) => {
  const cfg = POOL_3D_CONFIG.rain
  return {
    opacity: 0.27 + depth * 0.27 + strength * 0.10,
    streakLength: THREE.MathUtils.lerp(
      cfg.minStreakLength,
      cfg.maxStreakLength,
      THREE.MathUtils.clamp(depth * 0.72 + hashUnit(hash, 3) * 0.28, 0, 1),
    ),
    widthRatio: THREE.MathUtils.lerp(
      cfg.minStreakWidthRatio,
      cfg.maxStreakWidthRatio,
      THREE.MathUtils.clamp(depth * 0.68 + hashUnit(hash, 11) * 0.32, 0, 1),
    ),
  }
}

export const buildStrandSpec = (event, target, durationMs) => {
  const cfg = POOL_3D_CONFIG.rain
  const hash = stableEventHash(`${event?.kind}|${event?.event_id}`)
  const unit = hash / 0xffffffff
  const kindStrength = event?.kind === 'outcome'
    ? (event?.items?.some(item => item.applied === true) ? 1 : 0.52)
    : event?.kind === 'remember' ? 0.82 : 0.68
  const depth = THREE.MathUtils.clamp((finite(target?.z) / POOL_3D_CONFIG.worldRadius + 1) * 0.5, 0, 1)
  return {
    key: `${event?.kind}|${event?.event_id}`,
    source: 'event',
    event,
    x: finite(target?.x),
    z: finite(target?.z),
    height: cfg.minHeight + (cfg.maxHeight - cfg.minHeight) * unit,
    duration: Math.max(0.12, finite(durationMs) > 0
      ? finite(durationMs) / 1000
      : (cfg.minFallMs + (cfg.maxFallMs - cfg.minFallMs) * (1 - unit)) / 1000),
    phaseOffset: 0,
    driftX: (hashUnit(hash, 6) * 2 - 1) * cfg.maxDrift,
    driftZ: (hashUnit(hash, 14) * 2 - 1) * cfg.maxDrift,
    strength: kindStrength,
    ...streakAppearance(hash, depth, kindStrength),
  }
}

// One persisted record owns several deterministic render tracks. Lane zero lands
// on the truthful XZ coordinate; auxiliary lanes are small, stable offsets that
// increase rainfall density without inventing additional persisted events.
export const buildMemoryStrandSpec = (particle, lane = 0) => {
  const cfg = POOL_3D_CONFIG.rain
  const point = polarToWorld(particle)
  const safeLane = Math.max(0, Math.min(cfg.trailsPerMemory - 1, Math.trunc(finite(lane))))
  const hash = stableEventHash(`memory|${particle?.memory_id}|${safeLane}`)
  const unit = hash / 0xffffffff
  const depth = THREE.MathUtils.clamp((point.z / POOL_3D_CONFIG.worldRadius + 1) * 0.5, 0, 1)
  const strength = THREE.MathUtils.clamp(finite(particle?.s, 0.5), 0, 1)
  const offsetRadius = safeLane === 0 ? 0 : cfg.maxTrackOffset * (0.48 + hashUnit(hash, 5) * 0.52)
  const offsetAngle = hashUnit(hash, 13) * Math.PI * 2
  const landing = clampToPool(
    point.x + Math.cos(offsetAngle) * offsetRadius,
    point.z + Math.sin(offsetAngle) * offsetRadius,
  )
  const durationMix = THREE.MathUtils.clamp(hashUnit(hash, 9) * 0.72 + (1 - depth) * 0.28, 0, 1)
  const appearance = streakAppearance(hash, depth, strength)
  return {
    key: `memory|${particle?.memory_id}|${safeLane}`,
    source: 'memory',
    event: null,
    particle,
    lane: safeLane,
    x: landing.x,
    z: landing.z,
    height: cfg.minHeight + (cfg.maxHeight - cfg.minHeight) * (0.24 + unit * 0.76),
    duration: (cfg.minMemoryFallMs
      + (cfg.maxMemoryFallMs - cfg.minMemoryFallMs) * durationMix) / 1000,
    phaseOffset: hashUnit(hash, 1),
    driftX: (hashUnit(hash, 4) * 2 - 1) * cfg.maxDrift,
    driftZ: (hashUnit(hash, 12) * 2 - 1) * cfg.maxDrift,
    strength: 0.42 + strength * 0.34,
    ...appearance,
    // Lane zero is the truthful, semantic landing. The five auxiliary lanes
    // are render-only density tied to that same memory and stay deliberately
    // dim; they never emit an impact or pretend to be telemetry.
    opacity: appearance.opacity * (safeLane === 0 ? 1 : 0.46),
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
  attribute vec2 aDrift;
  attribute float aOpacity;
  attribute float aStreakLength;
  attribute float aWidthRatio;
  attribute float aEnabled;
  attribute float aLoop;
  uniform float uTime;
  uniform float uWaterY;
  uniform float uViewportHeight;
  uniform float uDropBloom;
  varying float vOpacity;
  varying float vWidthRatio;

  void main() {
    float rawElapsed = uTime - aBorn;
    float elapsed = max(0.0, rawElapsed);
    float progress = aLoop > 0.5
      ? fract(elapsed / max(aDuration, 0.001))
      : clamp(elapsed / max(aDuration, 0.001), 0.0, 1.0);
    // A short ease-out makes the downward travel read immediately instead of
    // hanging as beads near the top. Full travel remains 0.70-1.05 seconds.
    float fall = 1.0 - pow(1.0 - progress, 1.55);
    float driftFade = 1.0 - progress;
    vec3 worldPosition = vec3(
      aTarget.x + aDrift.x * driftFade * sin(aBorn * 8.7 + progress * 3.1),
      mix(aHeight, uWaterY, fall),
      aTarget.y + aDrift.y * driftFade * cos(aBorn * 7.9 + progress * 2.7)
    );
    vec4 viewPosition = modelViewMatrix * vec4(worldPosition, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    float oneShotLive = step(0.0, rawElapsed) * (1.0 - step(aDuration, rawElapsed));
    float live = aEnabled * mix(oneShotLive, 1.0, step(0.5, aLoop));
    vOpacity = live * aOpacity * uDropBloom;
    vWidthRatio = aWidthRatio;
    gl_PointSize = live * clamp(aStreakLength * uViewportHeight / max(1.0, -viewPosition.z), 2.0, 12.0);
  }
`

const strandFragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vOpacity;
  varying float vWidthRatio;
  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float side = 1.0 - smoothstep(vWidthRatio * 0.28, vWidthRatio, abs(point.x));
    float cap = 1.0 - smoothstep(0.42, 0.5, abs(point.y));
    float head = smoothstep(-0.46, 0.30, point.y);
    float filament = side * cap * mix(0.22, 1.0, head);
    float alpha = filament * vOpacity;
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
    gl_PointSize = clamp(aSize * uViewportHeight / max(1.0, -viewPosition.z), 2.0, 15.0);
    vOpacity = aOpacity;
  }
`

const contactFragmentShader = /* glsl */`
  uniform vec3 uColor;
  varying float vOpacity;
  void main() {
    vec2 point = (gl_PointCoord - 0.5) * vec2(1.0, 1.7);
    float radial = length(point) * 2.0;
    float alpha = (1.0 - smoothstep(0.0, 1.0, radial)) * vOpacity;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <colorspace_fragment>
  }
`

const rippleVertexShader = /* glsl */`
  attribute float aSize;
  attribute float aOpacity;
  attribute float aProgress;
  uniform float uViewportHeight;
  varying float vOpacity;
  varying float vProgress;
  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = clamp(aSize * uViewportHeight / max(1.0, -viewPosition.z), 3.0, 58.0);
    vOpacity = aOpacity;
    vProgress = aProgress;
  }
`

const rippleFragmentShader = /* glsl */`
  uniform vec3 uColor;
  uniform float uSurfaceRatio;
  varying float vOpacity;
  varying float vProgress;
  void main() {
    vec2 point = (gl_PointCoord - 0.5) * 2.0;
    point.y /= max(0.28, uSurfaceRatio);
    float radial = length(point);
    float outer = 1.0 - smoothstep(0.026, 0.072, abs(radial - 0.72));
    float innerLife = smoothstep(0.20, 0.36, vProgress) * (1.0 - smoothstep(0.72, 0.94, vProgress));
    float inner = (1.0 - smoothstep(0.024, 0.070, abs(radial - 0.42))) * innerLife * 0.62;
    float alpha = max(outer, inner) * vOpacity;
    if (alpha < 0.018) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <colorspace_fragment>
  }
`

const createPointPool = (count, material, name, renderOrder) => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(count), 1))
  geometry.setAttribute('aOpacity', new THREE.BufferAttribute(new Float32Array(count), 1))
  geometry.setAttribute('aProgress', new THREE.BufferAttribute(new Float32Array(count), 1))
  geometry.setDrawRange(0, 0)
  const points = new THREE.Points(geometry, material)
  points.name = name
  points.frustumCulled = false
  points.renderOrder = renderOrder
  return points
}

export const createRainSystem = ({ onImpact } = {}) => {
  const cfg = POOL_3D_CONFIG.rain
  const memoryCapacity = cfg.maxMemoryStrands * cfg.trailsPerMemory
  const strandCapacity = memoryCapacity + cfg.maxEventStrands
  const strandGeometry = new THREE.BufferGeometry()
  strandGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(strandCapacity * 3), 3))
  strandGeometry.setAttribute('aTarget', new THREE.BufferAttribute(new Float32Array(strandCapacity * 2), 2))
  for (const name of ['aBorn', 'aDuration', 'aHeight', 'aOpacity', 'aStreakLength', 'aWidthRatio', 'aEnabled', 'aLoop'])
    strandGeometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(strandCapacity), 1))
  strandGeometry.setAttribute('aDrift', new THREE.BufferAttribute(new Float32Array(strandCapacity * 2), 2))
  strandGeometry.setDrawRange(0, strandCapacity)

  const strandUniforms = {
    uTime: { value: 0 },
    uWaterY: { value: 0.06 },
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
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  const strands = new THREE.Points(strandGeometry, strandMaterial)
  strands.name = 'IndependentMemoryRainStreaks'
  strands.frustumCulled = false
  strands.renderOrder = 1

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
  const contacts = createPointPool(cfg.impactSlots, contactMaterial, 'RainContactFlashes', 4)

  const rippleMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uViewportHeight: strandUniforms.uViewportHeight,
      uColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.coldGlint) },
      uSurfaceRatio: { value: 0.4 },
    },
    vertexShader: rippleVertexShader,
    fragmentShader: rippleFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
  const ripples = createPointPool(cfg.impactSlots, rippleMaterial, 'LocalImpactRipples', 3)
  const group = new THREE.Group()
  group.name = 'MemoryRainCurtain'
  group.add(strands, ripples, contacts)

  const memorySlots = Array.from({ length: memoryCapacity }, () => null)
  const memorySlotsById = new Map()
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
  const cameraDirection = new THREE.Vector3()

  const flushStrandAttributes = () => {
    for (const attribute of Object.values(strandGeometry.attributes)) attribute.needsUpdate = true
  }

  const writeSlot = (absoluteSlot, spec, born, enabled, loop) => {
    const attrs = strandGeometry.attributes
    attrs.aTarget.array[absoluteSlot * 2] = spec.x
    attrs.aTarget.array[absoluteSlot * 2 + 1] = spec.z
    attrs.aBorn.array[absoluteSlot] = born
    attrs.aDuration.array[absoluteSlot] = spec.duration
    attrs.aHeight.array[absoluteSlot] = spec.height
    attrs.aDrift.array[absoluteSlot * 2] = spec.driftX
    attrs.aDrift.array[absoluteSlot * 2 + 1] = spec.driftZ
    attrs.aOpacity.array[absoluteSlot] = spec.opacity
    attrs.aStreakLength.array[absoluteSlot] = spec.streakLength
    attrs.aWidthRatio.array[absoluteSlot] = spec.widthRatio
    attrs.aEnabled.array[absoluteSlot] = enabled ? 1 : 0
    attrs.aLoop.array[absoluteSlot] = loop ? 1 : 0
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
    for (const [id, slots] of memorySlotsById) {
      if (live.has(id)) continue
      for (const slot of slots) {
        const state = memorySlots[slot]
        if (state) disableSlot(slot, state.spec)
        memorySlots[slot] = null
      }
      memorySlotsById.delete(id)
    }
    for (const particle of particles) {
      const existingSlots = memorySlotsById.get(particle.memory_id)
      if (existingSlots) {
        for (let lane = 0; lane < existingSlots.length; lane++) {
          const slot = existingSlots[lane]
          const state = memorySlots[slot]
          state.spec = buildMemoryStrandSpec(particle, lane)
          if (state.born != null) writeSlot(slot, state.spec, state.born, true, true)
        }
        continue
      }
      const slots = []
      for (let lane = 0; lane < cfg.trailsPerMemory; lane++) {
        const slot = memorySlots.findIndex(value => value == null)
        if (slot < 0) throw new Error('memory_strand_capacity_exhausted')
        memorySlots[slot] = { slot, spec: buildMemoryStrandSpec(particle, lane), born: null, nextImpactAt: null }
        slots.push(slot)
      }
      memorySlotsById.set(particle.memory_id, slots)
    }
    flushStrandAttributes()
  }

  const startQueued = (seconds) => {
    let dirty = false
    for (let i = 0; i < eventSlots.length && queue.length; i++) {
      if (eventSlots[i]) continue
      const spec = queue.shift()
      eventSlots[i] = { ...spec, born: seconds, landed: false }
      writeSlot(memoryCapacity + i, spec, seconds, true, false)
      dirty = true
    }
    if (dirty) flushStrandAttributes()
  }

  const updateImpactPool = (points, seconds, lifetime, mode) => {
    const attrs = points.geometry.attributes
    let count = 0
    for (const impact of impacts) {
      const progress = (seconds - impact.born) / lifetime
      if (progress < 0 || progress >= 1 || count >= cfg.impactSlots) continue
      attrs.position.array[count * 3] = impact.x
      attrs.position.array[count * 3 + 1] = mode === 'ripple' ? 0.061 : 0.064
      attrs.position.array[count * 3 + 2] = impact.z
      attrs.aSize.array[count] = mode === 'ripple'
        ? 0.14 + progress * (0.68 + impact.strength * 0.14)
        : 0.065 + impact.strength * 0.07 + progress * 0.025
      attrs.aOpacity.array[count] = mode === 'ripple'
        ? ((1 - progress) ** 1.6) * (0.24 + impact.strength * 0.20)
        : ((1 - progress) ** 2.4) * (0.42 + impact.strength * 0.42) * cfg.impactBloom
      attrs.aProgress.array[count] = progress
      count++
    }
    points.geometry.setDrawRange(0, count)
    attrs.position.needsUpdate = true
    attrs.aSize.needsUpdate = true
    attrs.aOpacity.needsUpdate = true
    attrs.aProgress.needsUpdate = true
  }

  return {
    group,
    setContactFeedbackVisible(value) {
      contacts.visible = !!value
      ripples.visible = !!value
    },
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
          if (slot) disableSlot(memoryCapacity + i, slot)
          eventSlots[i] = null
        }
        while (queue.length) pushImpact(queue.shift(), seconds)
        impacts.length = 0
        contacts.geometry.setDrawRange(0, 0)
        ripples.geometry.setDrawRange(0, 0)
        flushStrandAttributes()
      }
    },
    emitStrand(event, target, { durationMs } = {}) {
      if (!event?.kind || !event?.event_id) return false
      const key = `${event.kind}|${event.event_id}`
      if (seen.has(key)) return false
      seen.add(key)
      committedEventCount++
      const spec = buildStrandSpec(event, target, durationMs)
      if (reduced) {
        pushImpact(spec, performance.now() / 1000)
        return true
      }
      if (queue.length >= cfg.maxQueuedStrands) queue.shift()
      queue.push(spec)
      return true
    },
    resize(height) {
      strandUniforms.uViewportHeight.value = Math.max(1, Number(height) || 1)
    },
    update(seconds, camera) {
      const renderSeconds = reduced ? frozenSeconds : seconds
      strandUniforms.uTime.value = renderSeconds
      if (camera) {
        camera.getWorldDirection(cameraDirection)
        rippleMaterial.uniforms.uSurfaceRatio.value = THREE.MathUtils.clamp(
          Math.abs(cameraDirection.y), 0.32, 1,
        )
      }
      if (lastSeconds == null) lastSeconds = seconds
      if (!reduced) {
        let dirty = false
        for (const state of memorySlots) {
          if (!state) continue
          if (state.born == null) {
            initialiseMemorySlot(state, seconds)
            dirty = true
            continue
          }
          if (seconds - lastSeconds > cfg.maxVisibleFrameGap) {
            const elapsed = Math.max(0, seconds - state.born)
            state.nextImpactAt = state.born + (Math.floor(elapsed / state.spec.duration) + 1) * state.spec.duration
            continue
          }
          const crossings = crossingCount(lastSeconds, seconds, state.nextImpactAt, state.spec.duration)
          if (crossings > 0 && state.spec.lane === 0) {
            pushImpact(state.spec, state.nextImpactAt)
          }
          if (crossings > 0) state.nextImpactAt += crossings * state.spec.duration
        }
        if (dirty) flushStrandAttributes()
        startQueued(seconds)
        for (let i = 0; i < eventSlots.length; i++) {
          const state = eventSlots[i]
          if (!state) continue
          const lifecycle = advanceStrandLifecycle(state, seconds)
          if (lifecycle.landsNow) pushImpact(state, state.born + state.duration)
          state.landed = lifecycle.landed
          if (lifecycle.progress >= 1) {
            disableSlot(memoryCapacity + i, state)
            eventSlots[i] = null
            dirty = true
          }
        }
        if (dirty) flushStrandAttributes()
      }
      const maxLifetime = Math.max(cfg.impactLifetime, cfg.rippleLifetime)
      while (impacts.length && seconds - impacts[0].born >= maxLifetime) impacts.shift()
      while (recent.length && seconds - recent[0].born > cfg.recentPickMs / 1000) recent.shift()
      updateImpactPool(contacts, seconds, cfg.impactLifetime, 'flash')
      updateImpactPool(ripples, seconds, cfg.rippleLifetime, 'ripple')
      lastSeconds = seconds
    },
    pick(clientX, clientY, camera, canvas) {
      const bounds = canvas.getBoundingClientRect()
      const candidates = [...recent]
      for (const state of eventSlots) {
        if (!state) continue
        const progress = THREE.MathUtils.clamp((strandUniforms.uTime.value - state.born) / state.duration, 0, 1)
        const fall = 1 - (1 - progress) ** 1.55
        candidates.push({
          x: state.x,
          y: THREE.MathUtils.lerp(state.height, 0.06, fall),
          z: state.z,
          event: state.event,
        })
      }
      let best = null
      let bestDistance = 34
      for (const candidate of candidates) {
        const projected = new THREE.Vector3(candidate.x, candidate.y ?? 0.07, candidate.z).project(camera)
        const x = bounds.left + (projected.x * 0.5 + 0.5) * bounds.width
        const y = bounds.top + (-projected.y * 0.5 + 0.5) * bounds.height
        const distance = Math.hypot(clientX - x, clientY - y)
        if (distance < bestDistance) {
          bestDistance = distance
          best = candidate.event
        }
      }
      return best
    },
    metrics() {
      return {
        memoryRecordCount: memorySlotsById.size,
        memoryRenderTrailCount: memorySlots.filter(Boolean).length,
        activeEventCount: eventSlots.filter(Boolean).length,
        queuedEventCount: queue.length,
        collisionCount,
        committedEventCount,
        eventImpactCount,
        activeLocalRippleCount: ripples.geometry.drawRange.count,
      }
    },
    dispose() {
      strandGeometry.dispose()
      strandMaterial.dispose()
      for (const points of [contacts, ripples]) {
        points.geometry.dispose()
        points.material.dispose()
      }
      group.clear()
    },
  }
}
