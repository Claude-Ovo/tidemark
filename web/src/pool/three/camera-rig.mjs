import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { POOL_3D_CONFIG, fittedVerticalFov } from './config.mjs'

const easeOutQuart = (t) => 1 - (1 - t) ** 4

export const createCameraRig = ({ domElement, aspect, reducedMotion = false, onTap, onProjectionChange }) => {
  const cfg = POOL_3D_CONFIG.camera
  const camera = new THREE.PerspectiveCamera(fittedVerticalFov(aspect, cfg.fov), aspect, cfg.near, cfg.far)
  const homePosition = new THREE.Vector3(...cfg.position)
  const homeTarget = new THREE.Vector3(...cfg.target)
  camera.position.copy(homePosition)

  const controls = new OrbitControls(camera, domElement)
  controls.target.copy(homeTarget)
  controls.enableDamping = true
  controls.dampingFactor = cfg.dampingFactor
  controls.enablePan = false
  controls.rotateSpeed = cfg.rotateSpeed
  controls.zoomSpeed = cfg.zoomSpeed
  controls.minDistance = cfg.minDistance
  controls.maxDistance = cfg.maxDistance
  controls.minPolarAngle = cfg.minPolarAngle
  controls.maxPolarAngle = cfg.maxPolarAngle
  controls.minAzimuthAngle = cfg.minAzimuthAngle
  controls.maxAzimuthAngle = cfg.maxAzimuthAngle
  controls.autoRotateSpeed = cfg.autoRotateSpeed
  controls.update()

  let reduce = reducedMotion
  let pointer = null
  let interacting = false
  let resetTween = null
  let lastInteraction = performance.now()
  let projectionDirty = true

  const noteInteraction = () => {
    lastInteraction = performance.now()
    controls.autoRotate = false
    resetTween = null
    projectionDirty = true
  }
  const onStart = () => { interacting = true; noteInteraction() }
  const onEnd = () => { interacting = false; lastInteraction = performance.now(); projectionDirty = true }
  const onChange = () => { projectionDirty = true; onProjectionChange?.() }
  controls.addEventListener('start', onStart)
  controls.addEventListener('end', onEnd)
  controls.addEventListener('change', onChange)

  const pointerDown = (event) => {
    if (event.button !== 0) return
    noteInteraction()
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }
    try { domElement.setPointerCapture(event.pointerId) } catch {}
  }
  const pointerUp = (event) => {
    if (!pointer || pointer.id !== event.pointerId) return
    const dx = event.clientX - pointer.x
    const dy = event.clientY - pointer.y
    const isTap = dx * dx + dy * dy <= cfg.dragThresholdPx ** 2
    pointer = null
    try { domElement.releasePointerCapture(event.pointerId) } catch {}
    if (isTap) onTap?.(event.clientX, event.clientY)
  }
  const pointerCancel = () => { pointer = null }
  domElement.addEventListener('pointerdown', pointerDown)
  domElement.addEventListener('pointerup', pointerUp)
  domElement.addEventListener('pointercancel', pointerCancel)

  const reset = () => {
    noteInteraction()
    if (reduce) {
      camera.position.copy(homePosition)
      controls.target.copy(homeTarget)
      controls.update()
      projectionDirty = true
      return
    }
    resetTween = {
      t0: performance.now(),
      fromPosition: camera.position.clone(),
      fromTarget: controls.target.clone(),
    }
  }
  const doubleClick = (event) => { event.preventDefault(); reset() }
  domElement.addEventListener('dblclick', doubleClick)

  const update = (now) => {
    if (resetTween) {
      const k = Math.min(1, (now - resetTween.t0) / cfg.resetMs)
      const eased = easeOutQuart(k)
      camera.position.lerpVectors(resetTween.fromPosition, homePosition, eased)
      controls.target.lerpVectors(resetTween.fromTarget, homeTarget, eased)
      projectionDirty = true
      if (k >= 1) resetTween = null
    }
    controls.autoRotate = !reduce && !interacting && !resetTween && now - lastInteraction >= cfg.idleBeforeDriftMs
    const changed = controls.update()
    if (changed) projectionDirty = true
    return changed || !!resetTween || controls.autoRotate
  }

  return {
    camera,
    controls,
    update,
    reset,
    setReducedMotion(value) { reduce = !!value; if (reduce) controls.autoRotate = false },
    consumeProjectionDirty() { const dirty = projectionDirty; projectionDirty = false; return dirty },
    resize(nextAspect) {
      camera.aspect = nextAspect
      camera.fov = fittedVerticalFov(nextAspect, cfg.fov)
      camera.updateProjectionMatrix()
      projectionDirty = true
    },
    dispose() {
      controls.removeEventListener('start', onStart)
      controls.removeEventListener('end', onEnd)
      controls.removeEventListener('change', onChange)
      domElement.removeEventListener('pointerdown', pointerDown)
      domElement.removeEventListener('pointerup', pointerUp)
      domElement.removeEventListener('pointercancel', pointerCancel)
      domElement.removeEventListener('dblclick', doubleClick)
      controls.dispose()
    },
  }
}
