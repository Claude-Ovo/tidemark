import * as THREE from 'three'
import { POOL_3D_CONFIG, fittedVerticalFov } from './config.mjs'

// Deliberately fixed presentation camera. The pool is a data display, not an
// orbiting 3D toy: pointer, touch, idle time and double-click never mutate it.
export const createCameraRig = ({ aspect }) => {
  const cfg = POOL_3D_CONFIG.camera
  const camera = new THREE.PerspectiveCamera(fittedVerticalFov(aspect, cfg.fov), aspect, cfg.near, cfg.far)
  const homePosition = new THREE.Vector3(...cfg.position)
  const homeTarget = new THREE.Vector3(...cfg.target)
  camera.position.copy(homePosition)
  camera.lookAt(homeTarget)
  let projectionDirty = true

  return {
    camera,
    update() { return false },
    reset() {},
    setReducedMotion() {},
    consumeProjectionDirty() { const dirty = projectionDirty; projectionDirty = false; return dirty },
    resize(nextAspect) {
      camera.aspect = nextAspect
      camera.fov = fittedVerticalFov(nextAspect, cfg.fov)
      camera.position.copy(homePosition)
      camera.lookAt(homeTarget)
      camera.updateProjectionMatrix()
      projectionDirty = true
    },
    dispose() {},
  }
}
