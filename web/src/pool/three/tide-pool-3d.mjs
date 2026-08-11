import * as THREE from 'three'
import { createCameraRig } from './camera-rig.mjs'
import { POOL_3D_CONFIG, cappedPixelRatio, polarToWorld } from './config.mjs'
import { createDataModelGroup } from './data-model-group.mjs'
import { createHeightField } from './height-field.mjs'
import { createRainSystem } from './rain-system.mjs'
import { createWaterDisk } from './water-disk.mjs'

export const webglAvailable = () => {
  try {
    const canvas = document.createElement('canvas')
    return !!canvas.getContext('webgl2')
  } catch { return false }
}
export const createTidePool3D = ({
  host,
  reducedMotion = false,
  onProjectionFrame,
  onContextState,
  onSelectEvent,
}) => {
  if (!host || !webglAvailable()) throw new Error('webgl_unavailable')

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(cappedPixelRatio(window.devicePixelRatio))
  renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.25
  renderer.domElement.setAttribute('aria-hidden', 'true')
  renderer.domElement.dataset.poolRenderer = 'three-heightfield'
  host.append(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(POOL_3D_CONFIG.palette.abyss)
  scene.fog = new THREE.FogExp2(POOL_3D_CONFIG.palette.abyss, POOL_3D_CONFIG.fogDensity)

  const waterRadius = POOL_3D_CONFIG.worldRadius * POOL_3D_CONFIG.waterRadiusScale
  const heightField = createHeightField({ renderer, radius: waterRadius })
  const water = createWaterDisk({ radius: waterRadius, heightField })
  const dataModel = createDataModelGroup()
  const rain = createRainSystem({
    onImpact: ({ x, z, strength, seconds, source }) =>
      water.addImpact(x, z, seconds, strength, source === 'event' ? 'semantic' : 'ambient'),
  })
  rain.setReducedMotion(reducedMotion)
  const lighting = new THREE.Group()
  lighting.name = 'Lighting'
  lighting.add(
    new THREE.HemisphereLight(POOL_3D_CONFIG.palette.coldGlint, 0x05080b, 0.56),
    new THREE.DirectionalLight(POOL_3D_CONFIG.palette.pearl, 1.35),
  )
  lighting.children[1].position.set(-4, 7, 2)
  scene.add(water.mesh, dataModel.group, rain.group, lighting)

  let reduce = reducedMotion
  let contextLost = false
  let disposed = false
  let frame = 0
  let particles = []
  let rippleKeys = new Set()

  const cameraRig = createCameraRig({
    domElement: renderer.domElement,
    aspect: Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight),
    reducedMotion: reduce,
    onProjectionChange: () => requestFrame(),
    onTap: (clientX, clientY) => {
      const selected = rain.pick(clientX, clientY, cameraRig.camera, renderer.domElement)
      if (selected) onSelectEvent?.(selected)
      requestFrame()
    },
  })

  const resize = () => {
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    renderer.setPixelRatio(cappedPixelRatio(window.devicePixelRatio))
    renderer.setSize(width, height, false)
    rain.resize(height)
    cameraRig.resize(width / height)
    requestFrame()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host)

  const render = (now = performance.now()) => {
    frame = 0
    if (disposed || contextLost) return
    const seconds = now / 1000
    const cameraMoved = cameraRig.update(now)
    const dataMoved = dataModel.update(seconds, reduce)
    rain.update(seconds)
    heightField.update(seconds, reduce)
    water.update(seconds, reduce)
    renderer.render(scene, cameraRig.camera)
    if (cameraMoved || dataMoved || cameraRig.consumeProjectionDirty()) onProjectionFrame?.()
    if (!reduce || cameraRig.controls.autoRotate) requestFrame()
  }
  function requestFrame() {
    if (frame || disposed || contextLost) return
    frame = requestAnimationFrame(render)
  }

  const lost = (event) => {
    event.preventDefault()
    contextLost = true
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    onContextState?.('lost')
  }
  const restored = () => {
    contextLost = false
    renderer.resetState()
    onContextState?.('restored')
    requestFrame()
  }
  renderer.domElement.addEventListener('webglcontextlost', lost)
  renderer.domElement.addEventListener('webglcontextrestored', restored)

  requestFrame()
  return {
    get active() { return !disposed && !contextLost },
    renderer,
    scene,
    camera: cameraRig.camera,
    setReducedMotion(value) {
      reduce = !!value
      cameraRig.setReducedMotion(reduce)
      rain.setReducedMotion(reduce)
      requestFrame()
    },
    setParticles(nextParticles, guideRadii) {
      particles = nextParticles
      dataModel.setParticles(particles)
      rain.setMemoryStrands(particles)
      if (guideRadii) dataModel.setGuides(guideRadii)
      requestFrame()
    },
    syncRipples(ripples) {
      rippleKeys = new Set(ripples.map(ripple => `${ripple.t0}|${ripple.theta}|${ripple.r}`))
      requestFrame()
    },
    syncDrops(drops) {
      for (const drop of drops) {
        if (!drop.spawn?.memory_id) continue
        const event = {
          kind: 'remember',
          event_id: drop.spawn.memory_id,
          occurred_at: new Date(drop.t0).toISOString(),
          memory_ids: [drop.spawn.memory_id],
        }
        rain.emitStrand(event, polarToWorld(drop.spawn), { durationMs: POOL_3D_CONFIG.rain.rememberFallMs })
      }
      requestFrame()
    },
    syncRings(rings) {
      water.syncTideMarks(rings)
      requestFrame()
    },
    emitLifecycleEvent(event, targetParticles = []) {
      const points = targetParticles.map(particle => polarToWorld(particle))
      const target = points.length
        ? {
            x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
            z: points.reduce((sum, point) => sum + point.z, 0) / points.length,
          }
        : { x: 0, z: 0 }
      const emitted = rain.emitStrand(event, target)
      if (emitted) requestFrame()
      return emitted
    },
    metrics() { return { strands: rain.metrics(), heightField: heightField.metrics() } },
    projectParticle(particle) { return dataModel.project(particle, cameraRig.camera, renderer.domElement) },
    requestRender: requestFrame,
    resize,
    dispose() {
      if (disposed) return
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('webglcontextlost', lost)
      renderer.domElement.removeEventListener('webglcontextrestored', restored)
      cameraRig.dispose()
      dataModel.dispose()
      rain.dispose()
      water.dispose()
      heightField.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      scene.clear()
    },
  }
}
