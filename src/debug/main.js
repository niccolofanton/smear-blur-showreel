import * as THREE from 'three/webgpu'
import { float, mix, mrt, output, pass, positionLocal, screenUV, smoothstep, uniform, vec2, vec3, velocity } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createDirectionalMotionBlur } from './directionalMotionBlur.js'
import { createVelocitySmear } from './velocitySmear.js'
import { constrainTrailToLane, createBezierMotion, createHorizontalMotion, createTrailHistory, fitTrailBezier, horizontalSmearTrail, requiredViewHalfHeight, separatedLanes, smearTailActivation, stepBezierMotion, stepHorizontalMotion } from './motion.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import { FontLoader } from 'three/addons/loaders/FontLoader.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { Pane } from 'tweakpane'
import { createDriftpane } from '@niccolofanton/driftpane'
import '@niccolofanton/driftpane/theme.css'
import Stats from 'stats-gl'

// ── config ──────────────────────────────────────────────────────────────────
const SHAPES = ['sphere', 'gem', 'capsule', 'torus', 'knot', 'box', 'letter']
const ROWS = [
  { y: 2.15, baseSpeed: 1.15, spin: 0.7 },
  { y: 0, baseSpeed: 4.5, spin: -1 },
  { y: -2.15, baseSpeed: 2.5, spin: 1.35 },
]

// Shortcuts that write into the sliders below: it is the same material either way.
const PRESETS = {
  plastic: { metalness: 0, roughness: 0.3, transmission: 0, thickness: 0, ior: 1.5, clearcoat: 1, iridescence: 0 },
  metal: { metalness: 1, roughness: 0.12, transmission: 0, thickness: 0, ior: 1.5, clearcoat: 0, iridescence: 0 },
  glass: { metalness: 0, roughness: 0.05, transmission: 1, thickness: 1.4, ior: 1.5, clearcoat: 0, iridescence: 0 },
  rubber: { metalness: 0, roughness: 0.95, transmission: 0, thickness: 0, ior: 1.5, clearcoat: 0, iridescence: 0 },
  bubble: { metalness: 0, roughness: 0.02, transmission: 1, thickness: 0.15, ior: 1.33, clearcoat: 0, iridescence: 1 },
}

// A null url means three's built-in RoomEnvironment, generated at runtime.
const ENVIRONMENTS = {
  room: null,
  softbox: '/hdri/softbox.hdr',
  window: '/hdri/window.hdr',
  sunrise: '/hdri/sunrise.hdr',
  street: '/hdri/street.hdr',
}

const params = {
  shape: 'knot',
  middleShape: 'sphere',
  bottomShape: 'gem',
  letter: 'A',
  size: 0.85,
  topColor: '#306DFF',
  middleColor: '#FF624A',
  bottomColor: '#B7EB42',
  preset: 'metal',
  ...PRESETS.metal,
  environment: 'window',
  lightAngle: 245,
  envIntensity: 1.9,
  background: 'solid',
  bgBlur: 1,
  bgTop: '#f0f0f0',
  bgBottom: '#63656d',
  vignette: 0.5,
  groundShadow: false,
  autoRotate: false,
  rotateSpeed: 0.8,
  objectSpin: true,
  spinSpeed: 2,
  travelSpeed: 5.7,
  speedVariation: 0.85,
  acceleration: 4.35,
  accelerationVariation: 0.65,
  maxSpeed: 24,
  smearFrames: true,
  smearStrength: 1,
  smearTaper: 0.76,
  smearTaperCurve: 1.3,
  smearExposure: 0.12,
  motionBlur: true,
  blurStrength: 0.5,
  blurFadeIn: 0.18,
  blurOnsetPixels: 3.5,
  maxBlurPixels: 25,
}
const blurAmount = uniform(0)
const blurResolution = uniform(new THREE.Vector2(1, 1))
const blurLimit = uniform(params.maxBlurPixels)
const blurOnset = uniform(params.blurOnsetPixels)
const blurFrameScale = uniform(1)
let skipBlurFrames = 0
let blurFadeProgress = 0
let pausedRenderDirty = true

// ── renderer ────────────────────────────────────────────────────────────────
const canvas = document.querySelector('#app')
// MSAA on the fullscreen MRT pass pushed the GPU tail past the 8.3 ms budget at 120 Hz.
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false })
await renderer.init() // falls back to the WebGL backend on its own
canvas.dataset.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl-fallback'
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 2000)
const cameraHalfAngle = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
let geometryRadius = 1.4
const minimumCameraDistance = () => {
  const radius = geometryRadius * params.size
  return Math.max(15, requiredViewHalfHeight(radius, camera.aspect) / cameraHalfAngle)
}
const initialCameraDistance = minimumCameraDistance()
camera.position.set(0.2, 0.45, initialCameraDistance)

const controls = new OrbitControls(camera, canvas)
Object.assign(controls, {
  enableDamping: true,
  dampingFactor: 0.08,
  enableRotate: true,
  enableZoom: true,
  enablePan: true,
})

// ── shapes ──────────────────────────────────────────────────────────────────
const font = await new FontLoader().loadAsync('/fonts/helvetiker_bold.typeface.json')

function createGeometry(shape) {
  switch (shape) {
    case 'gem': {
      const g = new THREE.OctahedronGeometry(1.2, 1).toNonIndexed()
      g.computeVertexNormals() // faceted look
      return g
    }
    case 'capsule':
      return new THREE.CapsuleGeometry(0.7, 1.2, 12, 48).rotateZ(Math.PI / 2)
    case 'torus':
      return new THREE.TorusGeometry(0.82, 0.4, 64, 128)
    case 'knot':
      return new THREE.TorusKnotGeometry(0.68, 0.25, 256, 48)
    case 'box':
      return new RoundedBoxGeometry(1.75, 1.75, 1.75, 5, 0.18)
    case 'letter': {
      const g = new TextGeometry((params.letter || 'A').slice(0, 6), {
        font,
        size: 1.6,
        depth: 0.5,
        curveSegments: 18,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.035,
        bevelSegments: 5,
      })
      g.center()
      g.computeBoundingBox()
      const box = new THREE.Vector3()
      g.boundingBox.getSize(box)
      const k = 2.3 / Math.max(box.x, box.y, box.z) // normalize the bounding size
      return g.scale(k, k, k).center()
    }
    default:
      return new THREE.SphereGeometry(1.15, 96, 64)
  }
}

// ── material ────────────────────────────────────────────────────────────────
const smear = ROWS.map(() => createVelocitySmear())
const meshColors = () => [params.topColor, params.middleColor, params.bottomColor]
const materials = smear.map(({ positionNode }, i) => {
  const material = new THREE.MeshPhysicalNodeMaterial()
  material.iridescenceIOR = 1.6
  material.positionNode = positionNode
  material.color.set(meshColors()[i])
  return material
})

let features = ''

function applyMaterial() {
  const colors = meshColors()
  materials.forEach((material, i) => {
    material.color.set(colors[i])
    for (const key of ['metalness', 'roughness', 'transmission', 'thickness', 'ior', 'clearcoat', 'iridescence']) {
      material[key] = params[key]
    }
  })
  // These physical-material features change the compiled node graph when
  // crossing zero; other value changes only update uniforms.
  const next = `${params.transmission > 0}/${params.clearcoat > 0}/${params.iridescence > 0}`
  if (next !== features) materials.forEach((material) => { material.needsUpdate = true })
  features = next
}

// ── object + fake contact shadow ────────────────────────────────────────────
const selectedShapes = () => [params.shape, params.middleShape, params.bottomShape]
let geometries = selectedShapes().map(createGeometry)
let geometryRadii = geometries.map((geometry) => {
  geometry.computeBoundingSphere()
  return geometry.boundingSphere.radius + geometry.boundingSphere.center.length()
})
geometryRadius = Math.max(...geometryRadii)
let motionLayoutDirty = true
let appliedShapes = selectedShapes().join('/')
let appliedLetter = params.letter
let appliedSize = params.size
const meshes = materials.map((material, i) => {
  const mesh = new THREE.Mesh(geometries[i], material)
  mesh.position.y = ROWS[i].y
  // Shader displacement can extend beyond the undeformed geometry bounds.
  mesh.frustumCulled = false
  scene.add(mesh)
  return mesh
})

const shadowMaterial = new THREE.MeshBasicNodeMaterial()
shadowMaterial.transparent = true
shadowMaterial.depthWrite = true // retain its velocity in the depth-masked blur pass
shadowMaterial.alphaTest = 0.01 // do not write depth for the invisible outer disc
shadowMaterial.colorNode = vec3(0.02, 0.02, 0.025)
shadowMaterial.opacityNode = smoothstep(float(0.12), float(1.55), positionLocal.xy.length()).oneMinus().pow(1.6).mul(0.42)

const shadowGeometry = new THREE.CircleGeometry(1.6, 64)
const shadows = ROWS.map((row) => {
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial)
  shadow.rotation.x = -Math.PI / 2
  shadow.renderOrder = -1
  shadow.position.y = row.y - 1.15 * params.size
  scene.add(shadow)
  return shadow
})

function applySize() {
  meshes.forEach((mesh) => mesh.scale.setScalar(params.size))
  shadows.forEach((shadow, i) => {
    shadow.scale.setScalar(params.size)
    shadow.position.y = ROWS[i].y - 1.15 * params.size
  })
  motionLayoutDirty = true
  appliedSize = params.size
  skipBlurFrames = 1
}

// ── backdrop ────────────────────────────────────────────────────────────────
// The only light in the scene is the environment map.
const uTop = uniform(new THREE.Color())
const uBottom = uniform(new THREE.Color())
const uVignette = uniform(0)
const uGradient = uniform(0) // 0 keeps the top colour everywhere, 1 fades to the bottom one
const envCache = new Map()
let envMap = null
let activeEnvironment = null

// screenUV.y is 0 at the top of the screen, hence top -> bottom.
const edge = smoothstep(float(0.3), float(0.95), screenUV.sub(vec2(0.5, 0.42)).length())
const backgroundNode = mix(uTop, uBottom, screenUV.y.mul(uGradient)).mul(float(1).sub(edge.mul(uVignette.mul(0.55))))

function applyBackdrop() {
  const angle = THREE.MathUtils.degToRad(params.lightAngle)
  scene.environmentIntensity = params.envIntensity
  scene.environmentRotation.set(0, angle, 0)
  scene.backgroundRotation.set(0, angle, 0)

  uTop.value.set(params.bgTop)
  uBottom.value.set(params.bgBottom)
  uVignette.value = params.vignette
  uGradient.value = params.background === 'gradient' ? 1 : 0

  // The generated room environment is a cubemap: usable as lighting, not as a background.
  const showHdri = params.background === 'hdri' && ENVIRONMENTS[params.environment] !== null
  scene.background = showHdri ? envMap : null
  scene.backgroundBlurriness = showHdri ? params.bgBlur : 0
  scene.backgroundNode = showHdri ? null : backgroundNode

  shadows.forEach((shadow) => { shadow.visible = params.groundShadow })
}

function loadEnvironment(url) {
  if (url === null) {
    const pmrem = new THREE.PMREMGenerator(renderer)
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    return Promise.resolve(texture)
  }
  return new HDRLoader().loadAsync(url).then((texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping
    return texture
  })
}

function getEnvironment(name) {
  if (!envCache.has(name)) {
    const loading = Promise.resolve()
      .then(() => loadEnvironment(ENVIRONMENTS[name]))
      .catch((error) => {
        envCache.delete(name) // let a later selection retry a failed download
        throw error
      })
    envCache.set(name, loading)
  }
  return envCache.get(name)
}

async function setEnvironment() {
  const environment = params.environment
  try {
    const nextMap = await getEnvironment(environment)
    if (environment !== params.environment) return
    envMap = nextMap
    activeEnvironment = environment
  } catch (error) {
    console.warn(`Could not load the ${environment} environment`, error)
    if (environment !== params.environment) return
    if (activeEnvironment !== null) {
      params.environment = activeEnvironment
      pane.refresh()
    } else if (environment !== 'room') {
      params.environment = 'room'
      pane.refresh()
      await setEnvironment()
      return
    }
  }
  scene.environment = envMap
  applyBackdrop()
  pausedRenderDirty = true
}

applyMaterial()
applySize()

// ── panel ───────────────────────────────────────────────────────────────────
const options = (values) => ({ options: Object.fromEntries(values.map((v) => [v, v])) })
const pane = new Pane({ title: 'Smear Frames' })
pane.on('change', () => { pausedRenderDirty = true })

const rebuild = () => {
  letterInput.hidden = !selectedShapes().includes('letter')
  const previous = geometries
  geometries = selectedShapes().map(createGeometry)
  geometryRadii = geometries.map((geometry) => {
    geometry.computeBoundingSphere()
    return geometry.boundingSphere.radius + geometry.boundingSphere.center.length()
  })
  geometryRadius = Math.max(...geometryRadii)
  meshes.forEach((mesh, i) => { mesh.geometry = geometries[i] })
  previous.forEach((geometry) => geometry.dispose())
  motionLayoutDirty = true
  appliedShapes = selectedShapes().join('/')
  appliedLetter = params.letter
  skipBlurFrames = 1
}

pane.addBinding(params, 'shape', { label: 'top shape', ...options(SHAPES) }).on('change', rebuild)
pane.addBinding(params, 'middleShape', { label: 'middle shape', ...options(SHAPES) }).on('change', rebuild)
pane.addBinding(params, 'bottomShape', { label: 'bottom shape', ...options(SHAPES) }).on('change', rebuild)
const letterInput = pane.addBinding(params, 'letter', { label: 'text' }).on('change', rebuild)
letterInput.hidden = !selectedShapes().includes('letter')
pane.addBinding(params, 'size', { min: 0.6, max: 1.5, step: 0.05 }).on('change', applySize)

// One MeshPhysicalNodeMaterial: glass, metal and plastic are just different settings.
const surface = pane.addFolder({ title: 'Material' })
surface.addBinding(params, 'preset', options(Object.keys(PRESETS))).on('change', () => {
  Object.assign(params, PRESETS[params.preset])
  applyMaterial()
  pane.refresh()
})
surface.addBinding(params, 'topColor', { label: 'top color' }).on('change', applyMaterial)
surface.addBinding(params, 'middleColor', { label: 'middle color' }).on('change', applyMaterial)
surface.addBinding(params, 'bottomColor', { label: 'bottom color' }).on('change', applyMaterial)
surface.addBinding(params, 'metalness', { min: 0, max: 1, step: 0.01 }).on('change', applyMaterial)
surface.addBinding(params, 'roughness', { min: 0, max: 1, step: 0.01 }).on('change', applyMaterial)
surface.addBinding(params, 'transmission', { min: 0, max: 1, step: 0.01 }).on('change', applyMaterial)
surface.addBinding(params, 'thickness', { min: 0, max: 5, step: 0.05 }).on('change', applyMaterial)
surface.addBinding(params, 'ior', { min: 1, max: 2.4, step: 0.01 }).on('change', applyMaterial)
surface.addBinding(params, 'clearcoat', { min: 0, max: 1, step: 0.01 }).on('change', applyMaterial)
surface.addBinding(params, 'iridescence', { min: 0, max: 1, step: 0.05 }).on('change', applyMaterial)

const backdrop = pane.addFolder({ title: 'Backdrop' })
backdrop.addBinding(params, 'environment', { label: 'lighting', ...options(Object.keys(ENVIRONMENTS)) }).on('change', setEnvironment)
backdrop.addBinding(params, 'lightAngle', { label: 'angle', min: 0, max: 360, step: 5 }).on('change', applyBackdrop)
backdrop.addBinding(params, 'envIntensity', { label: 'intensity', min: 0, max: 3, step: 0.05 }).on('change', applyBackdrop)
backdrop.addBinding(params, 'background', options(['solid', 'gradient', 'hdri'])).on('change', () => {
  blurInput.hidden = params.background !== 'hdri'
  applyBackdrop()
})
const blurInput = backdrop.addBinding(params, 'bgBlur', { label: 'blur', min: 0, max: 1, step: 0.05 }).on('change', applyBackdrop)
blurInput.hidden = params.background !== 'hdri'
backdrop.addBinding(params, 'bgTop', { label: 'top' }).on('change', applyBackdrop)
backdrop.addBinding(params, 'bgBottom', { label: 'bottom' }).on('change', applyBackdrop)
backdrop.addBinding(params, 'vignette', { min: 0, max: 1, step: 0.05 }).on('change', applyBackdrop)
backdrop.addBinding(params, 'groundShadow', { label: 'shadow' }).on('change', applyBackdrop)

const motion = pane.addFolder({ title: 'Motion' })
let simulationPaused = false
let pendingSteps = 0
const pauseButton = motion.addButton({ title: 'Pause' })
const nextButton = motion.addButton({ title: 'Next frame' })
nextButton.disabled = true
pauseButton.on('click', () => {
  simulationPaused = !simulationPaused
  pendingSteps = 0
  pauseButton.title = simulationPaused ? 'Resume' : 'Pause'
  nextButton.disabled = !simulationPaused
})
nextButton.on('click', () => { pendingSteps++ })
let motionInputState = ''
const currentMotionInputState = () => [params.autoRotate, params.objectSpin, params.smearFrames, params.motionBlur].join('/')
const syncMotionInputs = () => {
  rotateSpeedInput.disabled = !params.autoRotate
  spinSpeedInput.disabled = !params.objectSpin
  smearStrengthInput.disabled = !params.smearFrames
  smearTaperInput.disabled = !params.smearFrames
  smearTaperCurveInput.disabled = !params.smearFrames
  smearExposureInput.disabled = !params.smearFrames
  blurStrengthInput.disabled = !params.motionBlur
  blurFadeInInput.disabled = !params.motionBlur
  blurOnsetInput.disabled = !params.motionBlur
  blurLimitInput.disabled = !params.motionBlur
  motionInputState = currentMotionInputState()
}
motion.addBinding(params, 'autoRotate', { label: 'auto-rotate' }).on('change', syncMotionInputs)
const rotateSpeedInput = motion.addBinding(params, 'rotateSpeed', { label: 'speed', min: 0, max: 2, step: 0.05 })
motion.addBinding(params, 'objectSpin', { label: 'object spin' }).on('change', syncMotionInputs)
const spinSpeedInput = motion.addBinding(params, 'spinSpeed', { label: 'spin speed', min: 0, max: 3, step: 0.05 })
motion.addBinding(params, 'travelSpeed', { label: 'move speed', min: 0.25, max: 7.5, step: 0.05 })
motion.addBinding(params, 'speedVariation', { label: 'speed variation', min: 0, max: 1, step: 0.05 })
motion.addBinding(params, 'acceleration', { label: 'acceleration', min: 0.4, max: 7.5, step: 0.05 })
motion.addBinding(params, 'accelerationVariation', { label: 'accel variation', min: 0, max: 1, step: 0.05 })
motion.addBinding(params, 'maxSpeed', { label: 'max speed', min: 1, max: 48, step: 0.25 })
motion.addBinding(params, 'smearFrames', { label: 'smear frames' }).on('change', () => {
  syncMotionInputs()
  skipBlurFrames = 1
})
const smearStrengthInput = motion.addBinding(params, 'smearStrength', { label: 'smear amount', min: 0, max: 2, step: 0.05 })
const smearTaperInput = motion.addBinding(params, 'smearTaper', { label: 'shrink amount', min: 0, max: 0.98, step: 0.02 })
const smearTaperCurveInput = motion.addBinding(params, 'smearTaperCurve', { label: 'shrink curve', min: 0.5, max: 3, step: 0.1 })
const smearExposureInput = motion.addBinding(params, 'smearExposure', { label: 'smear exposure', min: 0.02, max: 0.35, step: 0.005 })
motion.addBinding(params, 'motionBlur', { label: 'motion blur' }).on('change', () => {
  blurFadeProgress = 0
  syncMotionInputs()
  applyMotionBlur()
})
const blurStrengthInput = motion.addBinding(params, 'blurStrength', { label: 'blur amount', min: 0, max: 5, step: 0.1 }).on('change', () => applyMotionBlur())
const blurFadeInInput = motion.addBinding(params, 'blurFadeIn', { label: 'blur fade-in', min: 0, max: 0.5, step: 0.01 })
const blurOnsetInput = motion.addBinding(params, 'blurOnsetPixels', { label: 'blur onset px', min: 0, max: 15, step: 0.5 }).on('change', () => applyMotionBlur())
const blurLimitInput = motion.addBinding(params, 'maxBlurPixels', { label: 'streak cap', min: 0, max: 160, step: 5 }).on('change', () => applyMotionBlur())

surface.expanded = false
backdrop.expanded = false
createDriftpane(pane, { storageNamespace: 'three-starter-smear-frames-v1', width: 300 })
pane.expanded = true
params.maxBlurPixels = THREE.MathUtils.clamp(params.maxBlurPixels, 0, 160)
params.size = THREE.MathUtils.clamp(params.size, 0.6, 1.5)
params.travelSpeed = THREE.MathUtils.clamp(params.travelSpeed, 0.25, 7.5)
params.speedVariation = THREE.MathUtils.clamp(params.speedVariation, 0, 1)
params.acceleration = THREE.MathUtils.clamp(params.acceleration, 0.4, 7.5)
params.accelerationVariation = THREE.MathUtils.clamp(params.accelerationVariation, 0, 1)
params.maxSpeed = THREE.MathUtils.clamp(params.maxSpeed, 1, 48)
params.smearStrength = THREE.MathUtils.clamp(params.smearStrength, 0, 2)
params.smearTaper = THREE.MathUtils.clamp(params.smearTaper, 0, 0.98)
params.smearTaperCurve = THREE.MathUtils.clamp(params.smearTaperCurve, 0.5, 3)
params.smearExposure = THREE.MathUtils.clamp(params.smearExposure, 0.02, 0.35)
params.blurFadeIn = THREE.MathUtils.clamp(params.blurFadeIn, 0, 0.5)
params.blurOnsetPixels = THREE.MathUtils.clamp(params.blurOnsetPixels, 0, 15)
letterInput.hidden = !selectedShapes().includes('letter')
rebuild()
applyMaterial()
applySize()
pane.refresh()
syncMotionInputs()

// Only now are the params final: createDriftpane restores the saved state
// synchronously, so loading the environment here downloads the restored HDRI
// and not the factory default first. Awaited, so the environment — the only
// light in the scene — is in place before the first frame.
await setEnvironment()

// ── velocity-based motion blur ───────────────────────────────────────────────
// The reference redraws its particles into a separate velocity target. MRT
// writes the same motion vectors alongside the scene color in one WebGPU pass.
const scenePass = pass(scene, camera)
scenePass.setMRT(mrt({ output, velocity }))
const motionBlur = createDirectionalMotionBlur({
  color: scenePass.getTextureNode('output'),
  velocity: scenePass.getTextureNode('velocity'),
  depth: scenePass.getTextureNode('depth'),
  near: camera.near,
  far: camera.far,
  strength: blurAmount,
  resolution: blurResolution,
  maxBlurPixels: blurLimit,
  onsetPixels: blurOnset,
  frameScale: blurFrameScale,
})
const renderPipeline = new THREE.RenderPipeline(renderer)
renderPipeline.outputNode = motionBlur.node

function applyMotionBlur(delta = 1 / 120) {
  // The motion vector covers one rendered frame. Rescale it to a 1/120 s
  // exposure, as in the reference, so refresh rate does not change the look.
  const fpsScale = delta > 0.1 ? 0 : Math.min(8, (1 / 120) / Math.max(delta, 1 / 1000))
  const fade = blurFadeProgress * blurFadeProgress * (3 - 2 * blurFadeProgress)
  blurAmount.value = params.motionBlur && skipBlurFrames === 0 ? params.blurStrength * fpsScale * fade : 0
  blurLimit.value = params.maxBlurPixels
  blurOnset.value = params.blurOnsetPixels
  blurFrameScale.value = fpsScale
  motionBlur.updateTiles()
}

applyMotionBlur()
blurResolution.value.copy(renderer.getDrawingBufferSize(new THREE.Vector2()))

// ── stats + loop ────────────────────────────────────────────────────────────
const stats = new Stats({ trackGPU: true })
document.body.appendChild(stats.dom)
await stats.init(renderer)
// The container is zero-width (its canvases are absolutely positioned), hence the width.
stats.dom.style.cssText += ';left:auto;right:0;width:90px;'

const timer = new THREE.Timer()
timer.connect(document)
let motionTime = 0
const createTrajectory = (row, i) => i === 1
  ? createHorizontalMotion({ y: row.y, baseSpeed: row.baseSpeed })
  : createBezierMotion({ x: 0, y: row.y, baseSpeed: row.baseSpeed })
const trajectories = ROWS.map(createTrajectory)
const motionSettings = {
  movementSpeed: params.travelSpeed,
  speedVariation: params.speedVariation,
  acceleration: params.acceleration,
  accelerationVariation: params.accelerationVariation,
  maxSpeed: params.maxSpeed,
}
const histories = ROWS.map(() => createTrailHistory())
// Preserve the last measured velocity when a paused frame is redrawn for a pane or camera change.
let horizontalVelocity = 0
const worldDirection = new THREE.Vector3()
const localDirection = new THREE.Vector3()
const inverseRotation = new THREE.Quaternion()
const screenRight = new THREE.Vector3()
const screenUp = new THREE.Vector3()
const screenForward = new THREE.Vector3()

function motionBounds() {
  const halfHeight = cameraHalfAngle * minimumCameraDistance()
  return separatedLanes(halfHeight * camera.aspect, halfHeight, geometryRadius * params.size, ROWS.length)
}

renderer.setAnimationLoop((time) => {
  // The rAF timestamp is vsync-aligned; performance.now() here jitters by several ms.
  timer.update(time)
  const elapsed = timer.getDelta()
  const delta = simulationPaused
    ? (pendingSteps > 0 ? 1 / 120 : 0)
    : (elapsed > 0.1 ? 0 : elapsed)
  if (simulationPaused && pendingSteps > 0) pendingSteps--
  motionTime += delta
  if (selectedShapes().join('/') !== appliedShapes || params.letter !== appliedLetter) rebuild()
  if (params.size !== appliedSize) applySize()
  if (currentMotionInputState() !== motionInputState) syncMotionInputs()
  if (!simulationPaused && elapsed > 0.1) histories.forEach((history) => history.reset())
  controls.autoRotate = params.autoRotate
  controls.autoRotateSpeed = params.rotateSpeed * 2
  const cameraChanged = controls.update(delta)
  if (simulationPaused && delta === 0 && !cameraChanged && !pausedRenderDirty && !motionLayoutDirty) return
  pausedRenderDirty = false
  if (motionLayoutDirty) {
    ROWS.forEach((row, i) => {
      trajectories[i] = createTrajectory(row, i)
      histories[i].reset()
    })
    horizontalVelocity = 0
    motionLayoutDirty = false
    skipBlurFrames = 1
  }
  const lanes = motionBounds()
  motionSettings.movementSpeed = params.travelSpeed
  motionSettings.speedVariation = params.speedVariation
  motionSettings.acceleration = params.acceleration
  motionSettings.accelerationVariation = params.accelerationVariation
  motionSettings.maxSpeed = params.maxSpeed
  screenRight.set(1, 0, 0).applyQuaternion(camera.quaternion)
  screenUp.set(0, 1, 0).applyQuaternion(camera.quaternion)
  screenForward.set(0, 0, -1).applyQuaternion(camera.quaternion)
  const cameraDistance = Math.max(geometryRadius * params.size * 1.1, -camera.position.dot(screenForward))
  meshes.forEach((mesh, i) => {
    const row = ROWS[i]
    const previousX = trajectories[i].x
    const previousY = trajectories[i].y
    const lane = lanes[i]
    const movement = i === 1
      ? stepHorizontalMotion(trajectories[i], delta, lane, motionSettings)
      : stepBezierMotion(trajectories[i], delta, lane, motionSettings)
    const frameDx = movement.x - previousX
    const frameDy = movement.y - previousY
    if (i === 1 && delta > 0) horizontalVelocity = frameDx / delta
    mesh.position.set(0, 0, 0)
      .addScaledVector(screenRight, movement.x)
      .addScaledVector(screenUp, movement.y)
    if (params.objectSpin) mesh.rotation.y += delta * params.spinSpeed * row.spin
    shadows[i].position.copy(mesh.position).addScaledVector(screenUp, -1.15 * params.size)

    const shader = smear[i]
    shader.previousDirection.value.copy(shader.direction.value)
    shader.previousControl1.value.copy(shader.control1.value)
    shader.previousControl2.value.copy(shader.control2.value)
    shader.previousEnd.value.copy(shader.end.value)
    shader.previousTaper.value = shader.taper.value
    shader.previousTaperCurve.value = shader.taperCurve.value
    const trail = i === 1
      ? horizontalSmearTrail(movement, horizontalVelocity, params.smearExposure, lane.horizontalRadiusX)
      : delta > 0
        ? histories[i].push(motionTime, movement.x, movement.y, params.smearExposure)
        : histories[i].sample(motionTime, movement.x, movement.y, params.smearExposure)
    let forwardX = frameDx
    let forwardY = frameDy
    if (Math.hypot(forwardX, forwardY) <= 1e-6) {
      const recent = trail.find((offset) => Math.hypot(offset.x, offset.y) > 1e-6)
      if (recent) {
        forwardX = -recent.x
        forwardY = -recent.y
      }
    }
    mesh.getWorldQuaternion(inverseRotation).invert()
    const observedDistance = Math.hypot(forwardX, forwardY)
    if (observedDistance > 1e-6) {
      worldDirection.set(forwardX / observedDistance, forwardY / observedDistance, 0).applyQuaternion(camera.quaternion)
      localDirection.copy(worldDirection).applyQuaternion(inverseRotation)
      shader.direction.value.copy(localDirection)
    }
    const [first, second, last] = constrainTrailToLane(
      fitTrailBezier(trail), lane, movement, geometryRadii[i] * params.size, cameraDistance,
      params.smearFrames ? params.smearStrength : 0,
    )
    shader.control1.value.set(first.x, first.y, 0).applyQuaternion(camera.quaternion).applyQuaternion(inverseRotation).divideScalar(params.size)
    shader.control2.value.set(second.x, second.y, 0).applyQuaternion(camera.quaternion).applyQuaternion(inverseRotation).divideScalar(params.size)
    shader.end.value.set(last.x, last.y, 0).applyQuaternion(camera.quaternion).applyQuaternion(inverseRotation).divideScalar(params.size)
    shader.taper.value = params.smearFrames
      ? params.smearTaper * smearTailActivation(Math.hypot(last.x, last.y), geometryRadii[i] * params.size)
      : 0
    shader.taperCurve.value = params.smearTaperCurve
  })
  const blurDelta = simulationPaused && delta > 0 ? delta : elapsed
  if (!params.motionBlur || skipBlurFrames > 0 || elapsed > 0.1) {
    blurFadeProgress = 0
  } else {
    blurFadeProgress = params.blurFadeIn === 0
      ? 1
      : Math.min(1, blurFadeProgress + blurDelta / params.blurFadeIn)
  }
  applyMotionBlur(blurDelta)
  renderPipeline.render()
  if (skipBlurFrames > 0) skipBlurFrames--
  stats.update()
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  blurResolution.value.copy(renderer.getDrawingBufferSize(new THREE.Vector2()))
  histories.forEach((history) => history.reset())
  motionLayoutDirty = true
  pausedRenderDirty = true
  skipBlurFrames = 1
})
