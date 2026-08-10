import * as THREE from 'three'
import { POOL_3D_CONFIG } from './config.mjs'

const MAX_IMPACTS = 24

const vertexShader = /* glsl */`
  uniform float uTime;
  uniform float uRadius;
  uniform vec2 uImpactCenters[${MAX_IMPACTS}];
  uniform float uImpactTimes[${MAX_IMPACTS}];
  uniform float uImpactStrengths[${MAX_IMPACTS}];
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vRippleEnergy;

  float waterHeight(vec2 p) {
    float edge = 1.0 - smoothstep(uRadius * 0.78, uRadius, length(p));
    float h = (sin(p.x * 1.55 + uTime * 0.34) + sin(p.y * 1.18 - uTime * 0.27)) * 0.009;
    float energy = 0.0;
    for (int i = 0; i < ${MAX_IMPACTS}; i++) {
      float age = uTime - uImpactTimes[i];
      float alive = step(0.0, age) * step(age, 4.6);
      float d = distance(p, uImpactCenters[i]);
      float pulse = sin(d * 17.0 - age * 7.5) * exp(-d * 1.35) * exp(-age * 0.72);
      h += pulse * uImpactStrengths[i] * alive * edge;
      energy += abs(pulse) * uImpactStrengths[i] * alive;
    }
    vRippleEnergy = energy;
    return h * edge;
  }

  void main() {
    vec3 displaced = position;
    float eps = 0.035;
    float h = waterHeight(position.xz);
    float hx = waterHeight(position.xz + vec2(eps, 0.0));
    float hz = waterHeight(position.xz + vec2(0.0, eps));
    displaced.y += h;
    vec3 localNormal = normalize(vec3(h - hx, eps, h - hz));
    vec4 world = modelMatrix * vec4(displaced, 1.0);
    vWorldPosition = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * localNormal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragmentShader = /* glsl */`
  uniform float uTime;
  uniform vec3 uAbyss;
  uniform vec3 uDeepBlue;
  uniform vec3 uSteel;
  uniform vec3 uPearl;
  uniform vec3 uColdGlint;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying float vRippleEnergy;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 lightDir = normalize(vec3(-0.46, 0.86, 0.22));
    float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 3.2);
    float specular = pow(max(dot(reflect(-lightDir, normal), viewDir), 0.0), 86.0);
    float movingBand = vWorldPosition.x * 0.16 + vWorldPosition.z * 0.045
      + sin(vWorldPosition.z * 0.42 + uTime * 0.08) * 0.16 - sin(uTime * 0.075) * 0.52;
    float pearlBand = exp(-movingBand * movingBand * 7.8)
      * (0.22 + fresnel * 0.78) * (0.82 + 0.18 * sin(vWorldPosition.z * 0.7 + uTime * 0.12));
    float quietVariation = 0.5 + 0.5 * sin(vWorldPosition.x * 0.31 - vWorldPosition.z * 0.27 + uTime * 0.11);

    vec3 color = mix(uAbyss, uDeepBlue, 0.48 + quietVariation * 0.10);
    color = mix(color, uSteel, fresnel * 0.20);
    color += uPearl * pearlBand * 0.24;
    color += uColdGlint * specular * 0.70;
    color += uColdGlint * min(vRippleEnergy, 1.0) * 0.055;

    float distanceToCamera = length(cameraPosition - vWorldPosition);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    color = mix(color, uFogColor, clamp(fog, 0.0, 0.82));
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

export const createWaterDisk = ({ radius = POOL_3D_CONFIG.worldRadius * POOL_3D_CONFIG.waterRadiusScale } = {}) => {
  const centers = Array.from({ length: MAX_IMPACTS }, () => new THREE.Vector2(999, 999))
  const times = Array.from({ length: MAX_IMPACTS }, () => -999)
  const strengths = Array.from({ length: MAX_IMPACTS }, () => 0)
  const uniforms = {
    uTime: { value: 0 },
    uRadius: { value: radius },
    uImpactCenters: { value: centers },
    uImpactTimes: { value: times },
    uImpactStrengths: { value: strengths },
    uAbyss: { value: new THREE.Color(POOL_3D_CONFIG.palette.abyss) },
    uDeepBlue: { value: new THREE.Color(POOL_3D_CONFIG.palette.deepBlue) },
    uSteel: { value: new THREE.Color(POOL_3D_CONFIG.palette.steel) },
    uPearl: { value: new THREE.Color(POOL_3D_CONFIG.palette.pearl) },
    uColdGlint: { value: new THREE.Color(POOL_3D_CONFIG.palette.coldGlint) },
    uFogColor: { value: new THREE.Color(POOL_3D_CONFIG.palette.abyss) },
    uFogDensity: { value: POOL_3D_CONFIG.fogDensity },
  }
  const geometry = new THREE.CircleGeometry(radius, POOL_3D_CONFIG.waterSegments)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    toneMapped: true,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'WaterDisk'
  mesh.renderOrder = 0

  let cursor = 0
  return {
    mesh,
    radius,
    update(seconds, reducedMotion = false) { uniforms.uTime.value = reducedMotion ? 0 : seconds },
    addImpact(x, z, seconds, strength = 1) {
      const slot = cursor++ % MAX_IMPACTS
      centers[slot].set(x, z)
      times[slot] = seconds
      strengths[slot] = Math.max(0, Math.min(1, strength)) * POOL_3D_CONFIG.water.impactAmplitude
    },
    dispose() { geometry.dispose(); material.dispose() },
  }
}
