import * as THREE from 'three'
import { createCameraRig } from './camera-rig.mjs'
import { POOL_3D_CONFIG, cappedPixelRatio, polarToWorld } from './config.mjs'
import { createDataModelGroup } from './data-model-group.mjs'
import { createFountainSystem } from './fountain-system.mjs'
import { createHeightField } from './height-field.mjs'
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
}) => {
  if (!host || !webglAvailable()) throw new Error('webgl_unavailable')

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(cappedPixelRatio(window.devicePixelRatio))
  renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.14
  renderer.info.autoReset = false
  renderer.domElement.setAttribute('aria-hidden', 'true')
  renderer.domElement.dataset.poolRenderer = 'three-fountain-heightfield'
  renderer.domElement.style.pointerEvents = 'none'
  host.append(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(POOL_3D_CONFIG.palette.abyss)
  scene.fog = new THREE.FogExp2(POOL_3D_CONFIG.palette.abyss, POOL_3D_CONFIG.fogDensity)

  const waterRadius = POOL_3D_CONFIG.worldRadius * POOL_3D_CONFIG.waterRadiusScale
  const simulationRadius = POOL_3D_CONFIG.worldRadius * 1.25
  const heightField = createHeightField({ renderer, radius: simulationRadius })
  const water = createWaterDisk({ radius: waterRadius, heightField, fieldRadius: simulationRadius })
  const fountain = createFountainSystem({
    onNozzlePulse: ({ x, z, strength }) => water.addImpact(x, z, performance.now() / 1000, strength, 'ambient'),
  })
  const dataModel = createDataModelGroup()
  const lighting = new THREE.Group()
  lighting.name = 'QuietSceneLighting'
  lighting.add(
    new THREE.HemisphereLight(POOL_3D_CONFIG.palette.coldGlint, 0x05080b, 0.34),
    new THREE.DirectionalLight(POOL_3D_CONFIG.palette.pearl, 0.72),
  )
  lighting.children[1].position.set(-4, 7, 2)
  scene.add(water.mesh, fountain.group, dataModel.group, lighting)
  water.mesh.renderOrder = 0
  fountain.group.renderOrder = 4
  dataModel.group.renderOrder = 20

  let reduce = reducedMotion
  let contextLost = false
  let disposed = false
  let frame = 0
  let measuredFps = 0
  let measuredDrawCalls = 0
  let measuredTriangles = 0
  let sampleStartedAt = performance.now()
  let sampleFrames = 0
  let rippleKeys = new Set()

  const cameraRig = createCameraRig({
    aspect: Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight),
  })
  renderer.domElement.dataset.cameraView = 'fixed-three-quarter'

  const resize = () => {
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    const pixelRatio = cappedPixelRatio(window.devicePixelRatio)
    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height, false)
    fountain.resize(pixelRatio)
    dataModel.resize(height, pixelRatio)
    cameraRig.resize(width / height)
    requestFrame()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host)

  const render = (now = performance.now()) => {
    frame = 0
    if (disposed || contextLost) return
    const seconds = now / 1000
    renderer.info.reset()
    fountain.update(seconds, reduce)
    heightField.update(seconds, reduce)
    water.update(seconds, reduce)
    const dataMoved = dataModel.update(seconds, reduce)
    renderer.render(scene, cameraRig.camera)
    measuredDrawCalls = renderer.info.render.calls
    measuredTriangles = renderer.info.render.triangles
    sampleFrames++
    if (now - sampleStartedAt >= 1000) {
      measuredFps = sampleFrames * 1000 / Math.max(1, now - sampleStartedAt)
      sampleStartedAt = now
      sampleFrames = 0
    }
    renderer.domElement.dataset.fps = measuredFps.toFixed(1)
    renderer.domElement.dataset.drawCalls = String(measuredDrawCalls)
    if (dataMoved || cameraRig.consumeProjectionDirty()) onProjectionFrame?.()
    if (!reduce) requestFrame()
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

  resize()
  requestFrame()
  return {
    get active() { return !disposed && !contextLost },
    renderer,
    scene,
    camera: cameraRig.camera,
    setReducedMotion(value) {
      reduce = !!value
      requestFrame()
    },
    setParticles(nextParticles, guideRadii) {
      dataModel.setParticles(nextParticles)
      if (guideRadii) dataModel.setGuides(guideRadii)
      requestFrame()
    },
    setPointInteraction(state) {
      dataModel.setInteractionState(state)
      requestFrame()
    },
    syncRipples(ripples) {
      // Recall remains a semantic, local impulse. The persistent fountain
      // apparatus never manufactures lifecycle events or telemetry.
      const nextKeys = new Set()
      for (const ripple of ripples) {
        const key = `${ripple.t0}|${ripple.theta}|${ripple.r}`
        nextKeys.add(key)
        if (rippleKeys.has(key)) continue
        const point = polarToWorld({ r: ripple.r, theta: ripple.theta })
        water.addImpact(point.x, point.z, Number(ripple.t0) / 1000, ripple.small ? 0.62 : 1, 'semantic')
      }
      rippleKeys = nextKeys
      requestFrame()
    },
    syncRings(rings) {
      water.syncTideMarks(rings)
      requestFrame()
    },
    emitLifecycleEvent() { return false },
    metrics() {
      return {
        fountain: fountain.metrics(),
        heightField: heightField.metrics(),
        water: water.metrics(),
        underwater: dataModel.metrics(),
        render: { fps: measuredFps, drawCalls: measuredDrawCalls, triangles: measuredTriangles },
        camera: 'fixed-three-quarter',
      }
    },
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
      fountain.dispose()
      water.dispose()
      heightField.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      scene.clear()
    },
  }
}
