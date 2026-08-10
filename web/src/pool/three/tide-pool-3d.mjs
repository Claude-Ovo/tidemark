import * as THREE from 'three'
import { createCameraRig } from './camera-rig.mjs'
import { POOL_3D_CONFIG, cappedPixelRatio, polarToWorld } from './config.mjs'
import { createDataModelGroup } from './data-model-group.mjs'
import { createWaterDisk } from './water-disk.mjs'

export const webglAvailable = () => {
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch { return false }
}
export const createTidePool3D = ({ host, reducedMotion = false, onProjectionFrame, onContextState }) => {
  if (!host || !webglAvailable()) throw new Error('webgl_unavailable')

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(cappedPixelRatio(window.devicePixelRatio))
  renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.06
  renderer.domElement.setAttribute('aria-hidden', 'true')
  renderer.domElement.dataset.poolRenderer = 'three-tier1'
  host.append(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(POOL_3D_CONFIG.palette.abyss)
  scene.fog = new THREE.FogExp2(POOL_3D_CONFIG.palette.abyss, POOL_3D_CONFIG.fogDensity)

  const water = createWaterDisk()
  const dataModel = createDataModelGroup()
  const lighting = new THREE.Group()
  lighting.name = 'Lighting'
  lighting.add(
    new THREE.HemisphereLight(0xa9c9dc, 0x030508, 0.42),
    new THREE.DirectionalLight(0xdceaf3, 1.15),
  )
  lighting.children[1].position.set(-4, 7, 2)
  scene.add(water.mesh, dataModel.group, lighting)

  let reduce = reducedMotion
  let contextLost = false
  let disposed = false
  let frame = 0
  let particles = []
  let rippleKeys = new Set()

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const cameraRig = createCameraRig({
    domElement: renderer.domElement,
    aspect: Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight),
    reducedMotion: reduce,
    onProjectionChange: () => requestFrame(),
    onTap: (clientX, clientY) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(pointer, cameraRig.camera)
      const hit = raycaster.intersectObject(water.mesh, false)[0]
      if (hit) water.addImpact(hit.point.x, hit.point.z, performance.now() / 1000, 0.72)
      requestFrame()
    },
  })

  const resize = () => {
    const width = Math.max(1, host.clientWidth)
    const height = Math.max(1, host.clientHeight)
    renderer.setPixelRatio(cappedPixelRatio(window.devicePixelRatio))
    renderer.setSize(width, height, false)
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
    setReducedMotion(value) { reduce = !!value; cameraRig.setReducedMotion(reduce); requestFrame() },
    setParticles(nextParticles, guideRadii) {
      particles = nextParticles
      dataModel.setParticles(particles)
      if (guideRadii) dataModel.setGuides(guideRadii)
      requestFrame()
    },
    syncRipples(ripples) {
      const nextKeys = new Set()
      for (const ripple of ripples) {
        const key = `${ripple.t0}|${ripple.theta}|${ripple.r}`
        nextKeys.add(key)
        if (rippleKeys.has(key)) continue
        const point = polarToWorld({ pr: ripple.r, theta: ripple.theta })
        water.addImpact(point.x, point.z, ripple.t0 / 1000, ripple.small ? 0.42 : 0.9)
      }
      rippleKeys = nextKeys
      requestFrame()
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
      water.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      scene.clear()
    },
  }
}
