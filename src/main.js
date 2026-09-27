import * as THREE from 'three/webgpu'
import { float, hash, length, mix, mrt, normalView, output, pass, positionGeometry, renderOutput, screenCoordinate, screenUV, step, uniform, uv, vec2, vec3, vec4, velocity } from 'three/tsl'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import { FontLoader } from 'three/addons/loaders/FontLoader.js'
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js'
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { createSoundtrack } from './audio.js'
import { createBackdrop } from './backdrop.js'
import { createDirectionalMotionBlur } from './directionalMotionBlur.js'
import { glyphShapes } from './glyph-outline.js'
import { createHud } from './hud.js'
import { pulseAt, setBeatStrengths } from './rhythm.js'
import {
  LETTER_EM, SMEAR, TRACK, abSplit, actors, backdropAt, blurShutter, cameraPose, contrastInk,
  createBackdropState, fitFov, projectToFrame,
} from './reel.js'
import { LOOP, smoothstep, wrap } from './timeline.js'
import { updateSmear } from './trail.js'
import { createVelocitySmear } from './velocitySmear.js'

const query = new URLSearchParams(location.search)
const forcedSize = query.get('res')?.match(/^(\d+)x(\d+)$/)?.slice(1).map(Number)
// Builds never ship the commercial track (see vite.config.js), so they skip the request.
const soundtrack = createSoundtrack({ url: import.meta.env.DEV ? TRACK.url : null, start: TRACK.start, length: LOOP, muted: query.has('mute') })

const canvas = document.querySelector('#app')
// MSAA on the fullscreen MRT pass blows the 8.3 ms budget at 120 Hz.
const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, trackTimestamp: query.has('perf') })
await renderer.init()
canvas.dataset.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl-fallback'
renderer.toneMapping = THREE.ACESFilmicToneMapping

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 200)
const [font, environment] = await Promise.all([
  new FontLoader().loadAsync('/fonts/big-shoulders-black.typeface.json'),
  new HDRLoader().loadAsync('/hdri/window.hdr'),
  soundtrack.ready,
])
setBeatStrengths(soundtrack.beatStrengths)
environment.mapping = THREE.EquirectangularReflectionMapping
const ENVIRONMENT_BLUR = 0.105
const environmentCapture = new THREE.Scene()
environmentCapture.background = environment
const pmrem = new THREE.PMREMGenerator(renderer)
// Blurring the captured light hides the 640 × 320 HDRI's texels without touching materials.
scene.environment = pmrem.fromScene(environmentCapture, ENVIRONMENT_BLUR, 0.1, 100, { size: 64 }).texture
pmrem.dispose()
scene.environmentIntensity = 1.9
scene.environmentRotation.set(0, THREE.MathUtils.degToRad(245), 0)

// The smear shader expects ~1.15-unit meshes, dense enough to bend along the trail.
const LETTER = { font, size: LETTER_EM, depth: 0.38, curveSegments: 6, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.012, bevelSegments: 2 }
const capBox = new TextGeometry('E', LETTER)
capBox.computeBoundingBox()
const capCenter = (capBox.boundingBox.min.y + capBox.boundingBox.max.y) / 2
capBox.dispose()

const tessellate = (geometry, edge) => new TessellateModifier(edge, 10).modify(geometry)
const gem = (edge) => {
  const geometry = new THREE.OctahedronGeometry(1.2, 1)
  geometry.computeVertexNormals()
  return tessellate(geometry, edge)
}

const SHAPES = {
  sphere: (low) => new THREE.SphereGeometry(1.15, low ? 40 : 96, low ? 28 : 64),
  knot: (low) => new THREE.TorusKnotGeometry(0.68, 0.25, low ? 128 : 192, low ? 16 : 32),
  gem: (low) => gem(low ? 0.3 : 0.16),
  box: () => new RoundedBoxGeometry(1.7, 1.7, 1.7, 3, 0.22),
  capsule: () => new THREE.CapsuleGeometry(0.6, 1.1, 6, 20).rotateZ(Math.PI / 2),
  torus: () => new THREE.TorusGeometry(0.8, 0.36, 20, 64),
  letter: (low, char) => {
    const geometry = new THREE.ExtrudeGeometry(glyphShapes(font, char, LETTER_EM, LETTER.curveSegments), LETTER)
    geometry.computeBoundingBox()
    const { min, max } = geometry.boundingBox
    geometry.translate(-(min.x + max.x) / 2, -capCenter, -(min.z + max.z) / 2)
    return toCreasedNormals(tessellate(geometry, 0.3), Math.PI / 6)
  },
}
const geometries = new Map()
const geometryFor = ({ shape, char, detail }) => {
  const key = `${shape}:${char ?? ''}:${detail ?? ''}`
  if (!geometries.has(key)) {
    const geometry = SHAPES[shape](detail === 'low', char)
    geometry.computeBoundingSphere()
    geometry.userData.radius = geometry.boundingSphere.radius + geometry.boundingSphere.center.length()
    geometry.boundingSphere.radius *= 1 + SMEAR.maxStretch
    geometries.set(key, geometry)
  }
  return geometries.get(key)
}

const FINISHES = {
  metal: { metalness: 1, roughness: 0.16 },
  gloss: { metalness: 0, roughness: 0.3 },
}
// Faces in the exact display colour, returns shaded by a fixed light: vivid, still 3D.
const RETURN_LIGHT = vec3(-0.45, 0.75, 0.5).normalize()
const flatFinish = (hex) => {
  const face = uniform(new THREE.Color(hex))
  const side = face.mul(mix(0.18, 0.5, normalView.dot(RETURN_LIGHT).mul(0.5).add(0.5)))
  return vec4(mix(side, face, normalView.z.smoothstep(0.55, 0.9)), 1)
}

const rigs = actors.map((actor) => {
  const geometry = geometryFor(actor)
  actor.radius = geometry.userData.radius
  const smear = createVelocitySmear()
  const flat = actor.material === 'flat'
  const material = flat ? new THREE.MeshBasicNodeMaterial() : new THREE.MeshStandardNodeMaterial({ color: actor.base, ...FINISHES[actor.material] })
  material.positionNode = smear.positionNode
  // Tone mapped per material, so the blur averages display colours and edges never tint.
  material.outputNode = flat ? flatFinish(actor.base) : output.toneMapping(THREE.ACESFilmicToneMapping)
  const mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)
  return { actor, mesh, smear, material, color: actor.base }
})

const backdrop = createBackdrop()
const backdropMaterial = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
backdropMaterial.vertexNode = vec4(positionGeometry.xy, 1, 1)
backdropMaterial.outputNode = vec4(backdrop.node, 1)
backdropMaterial.mrtNode = mrt({ velocity: vec2(0) })
const backdropMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), backdropMaterial)
backdropMesh.frustumCulled = false
backdropMesh.renderOrder = -1
scene.add(backdropMesh)

const scenePass = pass(scene, camera)
scenePass.setMRT(mrt({ output, velocity }))
scenePass.getTexture('velocity').format = THREE.RGFormat
const color = scenePass.getTextureNode('output')
const blurAmount = uniform(0)
const blurResolution = uniform(new THREE.Vector2(1, 1))
const blurLimit = uniform(48)
const blurOnset = uniform(3.5)
const blurFrameScale = uniform(1)
const motionBlur = createDirectionalMotionBlur({
  color,
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
const splitX = uniform(0)
const grainSeed = uniform(new THREE.Vector2())
const grainSize = uniform(1)
const frameAspect = uniform(1)
const graded = renderOutput(mix(motionBlur.node, color.sample(uv()), step(uv().x, splitX)), THREE.NoToneMapping, THREE.SRGBColorSpace)
const grainCell = screenCoordinate.xy.div(grainSize).floor().add(grainSeed)
const grain = hash(grainCell.x.add(grainCell.y.mul(4099))).sub(0.5).mul(0.032)
const vignette = float(1).sub(length(screenUV.sub(0.5).mul(vec2(frameAspect, 1))).smoothstep(0.45, 1.1).mul(0.06))
const renderPipeline = new THREE.RenderPipeline(renderer)
renderPipeline.outputColorTransform = false
renderPipeline.outputNode = vec4(graded.rgb.mul(vignette).add(grain), 1)
let skipBlurFrames = 2

function applyMotionBlur(t, delta) {
  // Motion vectors span one frame: rescale to a 1/120 s exposure at any refresh rate.
  const frameScale = delta <= 0 || delta > 0.1 ? 0 : Math.min(8, (1 / 120) / Math.max(delta, 1 / 1000))
  blurAmount.value = skipBlurFrames > 0 ? 0 : blurShutter(t) * frameScale
  blurFrameScale.value = frameScale
  motionBlur.updateTiles()
  if (skipBlurFrames > 0) skipBlurFrames--
}

const hud = createHud(document.querySelector('.hud'))
const backdropState = createBackdropState()
const smearSettings = { ...SMEAR, strength: 0 }
const euler = new THREE.Euler()
const frame = new THREE.Vector3()
const earlier = new THREE.Vector3()
const readout = { blur: 0, smear: 1 }

function streakPixels(actor, t) {
  const before = wrap(t - 1 / 120)
  projectToFrame(actor.position(before, earlier), before, camera.aspect, earlier)
  const travel = Math.hypot(frame.x - earlier.x, frame.y - earlier.y) * blurResolution.value.y
  return Math.min(blurLimit.value, travel * blurShutter(t))
}

function pose(t) {
  cameraPose(t, camera.position, camera.quaternion)
  const grainFrame = Math.round(t * 120)
  grainSeed.value.set((grainFrame * 131) % 1021, (grainFrame * 197) % 1031)
  const split = abSplit(t)
  splitX.value = split
  readout.blur = 0
  readout.smear = 1
  for (const rig of rigs) {
    const { actor, mesh, material } = rig
    const scale = actor.scale(t)
    // Drawn two frames before it grows, so the velocity pass never reads a stale matrix.
    mesh.visible = scale > 1e-3 || actor.scale(wrap(t + 2 / 120)) > 1e-3
    if (!mesh.visible) continue
    actor.position(t, mesh.position)
    mesh.quaternion.setFromEuler(actor.rotation(t, euler))
    const size = Math.max(scale, 1e-4)
    const squash = actor.squash?.(t) ?? 1
    mesh.scale.set(size / Math.sqrt(squash), size * squash, size / Math.sqrt(squash))
    const hex = actor.color(t) ?? actor.base
    if (hex !== rig.color) material.color.set((rig.color = hex))
    let strength = actor.smear(t)
    projectToFrame(mesh.position, t, camera.aspect, frame)
    if (split > 0) strength *= smoothstep(split - 0.03, split + 0.03, frame.x / camera.aspect + 0.5)
    smearSettings.strength = strength
    updateSmear(rig.smear, mesh, actor, t, smearSettings, cameraPose)
    if (scale < 1e-3 || Math.abs(frame.x) > camera.aspect / 2 || Math.abs(frame.y) > 0.5) continue
    readout.smear = Math.max(readout.smear, 1 + rig.smear.end.value.length() / (2 * actor.radius))
    if (frame.x / camera.aspect + 0.5 > split) readout.blur = Math.max(readout.blur, streakPixels(actor, t))
  }
  backdrop.update(backdropAt(t, camera.aspect, backdropState), camera.aspect, contrastInk(backdropState.base), pulseAt(t))
}

function resize() {
  const [width, height] = forcedSize ?? [innerWidth, innerHeight]
  renderer.setPixelRatio(forcedSize ? 1 : Math.min(devicePixelRatio, 2))
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.fov = fitFov(camera.aspect)
  camera.updateProjectionMatrix()
  renderer.getDrawingBufferSize(blurResolution.value)
  blurLimit.value = Math.round(blurResolution.value.y * 0.019)
  grainSize.value = Math.max(1, Math.round(blurResolution.value.y / 1200))
  frameAspect.value = camera.aspect
  skipBlurFrames = 2
}
resize()
addEventListener('resize', () => {
  resize()
  if (paused) {
    clock += (pendingSteps - 2) / 120
    pendingSteps = 2
  }
})

let clock = query.has('t') ? Number(query.get('t')) || 0 : 13.1
let started = false
let paused = true
let pendingSteps = 0
let audioDriven = false
const setAudioState = () => { document.body.dataset.audio = audioDriven ? soundtrack.state : 'off' }

async function start() {
  if (started) return
  started = true
  document.body.classList.add('is-playing')
  await soundtrack.ready
  clock = 0
  skipBlurFrames = 2
  audioDriven = soundtrack.available && await soundtrack.play(0)
  paused = false
  setAudioState()
}
document.querySelector('[data-start]').addEventListener('click', start)

async function setPaused(value) {
  paused = value
  if (!audioDriven) return
  clock = wrap(clock)
  if (paused) await soundtrack.pause()
  else audioDriven = await soundtrack.play(clock)
  setAudioState()
}

addEventListener('keydown', (event) => {
  if (!started) return
  if (event.code === 'Space') setPaused(!paused)
  else if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') {
    if (!paused) setPaused(true)
    pendingSteps += event.code === 'ArrowRight' ? 1 : -1
  } else return
  event.preventDefault()
})
addEventListener('hashchange', () => {
  const target = Number(location.hash.match(/t=([\d.]+)/)?.[1])
  if (Number.isNaN(target)) return
  if (!paused) setPaused(true)
  clock = target - 2 / 120
  pendingSteps = 2
})

for (const { mesh } of rigs) Object.assign(mesh, { visible: true, frustumCulled: false })
renderPipeline.render()
for (const { mesh } of rigs) mesh.frustumCulled = true
// Warm the render targets and previous transforms before showing the paused cover.
for (let frame = 2; frame >= 0; frame--) {
  await new Promise(requestAnimationFrame)
  pose(wrap(clock - frame / 120))
  renderPipeline.render()
}
hud.update(wrap(clock), backdropState, camera.aspect, null, readout)
await Promise.all([soundtrack.ready, document.fonts.ready, renderer.backend.device?.queue.onSubmittedWorkDone()])
document.body.classList.toggle('is-still', query.has('still'))
if (!soundtrack.available) document.querySelector('.start__hint').textContent = '15 s loop'
else if (query.has('mute')) document.querySelector('.start__hint').textContent = 'Sound off · 15 s loop'
else document.querySelector('.start__hint').textContent = 'Sound on · 15 s loop'
setAudioState()
document.body.classList.remove('is-loading')

const perf = query.has('perf') ? createPerfMeter() : null
const timer = new THREE.Timer()
timer.connect(document)

renderer.setAnimationLoop((time) => {
  // The rAF timestamp is vsync-aligned; performance.now() here jitters by several ms.
  timer.update(time)
  const elapsed = timer.getDelta()
  let delta = elapsed > 0.1 ? 0 : elapsed
  if (paused) {
    if (pendingSteps === 0) return
    delta = Math.sign(pendingSteps) / 120
    pendingSteps -= Math.sign(pendingSteps)
    clock += delta
  } else if (audioDriven) {
    // One frame ahead, as frames show a vsync later; held until the source is actually heard.
    const heard = Math.max(clock, soundtrack.time(time + 1000 / 120))
    delta = heard - clock
    clock = heard
  } else {
    clock += delta
  }
  const t = wrap(clock)
  pose(t)
  applyMotionBlur(t, Math.abs(delta))
  renderPipeline.render()
  hud.update(t, backdropState, camera.aspect, audioDriven ? TRACK.start + t : null, readout)
  perf?.frame(elapsed)
})

function createPerfMeter() {
  const box = Object.assign(document.createElement('div'), { className: 'perf' })
  document.body.append(box)
  let deltas = []
  let gpu = []
  let resolving = false
  let printed = 0
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0
  const summary = () => {
    const refresh = percentile(deltas, 0.5)
    return {
      frames: deltas.length,
      refreshMs: +refresh.toFixed(2),
      dropped: deltas.filter((ms) => ms > refresh * 1.5).length,
      worstFrameMs: +Math.max(0, ...deltas).toFixed(2),
      gpuMedianMs: +percentile(gpu, 0.5).toFixed(2),
      gpuP99Ms: +percentile(gpu, 0.99).toFixed(2),
      gpuMaxMs: +Math.max(0, ...gpu).toFixed(2),
      drawingBuffer: `${blurResolution.value.x}x${blurResolution.value.y}`,
    }
  }
  window.__perf = { summary, reset: () => { deltas = []; gpu = [] } }
  return {
    frame(elapsed) {
      if (elapsed > 0 && elapsed < 0.1) deltas.push(elapsed * 1000)
      if (!resolving) {
        resolving = true
        renderer.resolveTimestampsAsync('render').then((ms) => {
          if (ms > 0) gpu.push(ms)
          resolving = false
        })
      }
      const now = performance.now()
      if (now - printed < 500) return
      printed = now
      const s = summary()
      box.textContent = `${s.drawingBuffer} · ${(1000 / (s.refreshMs || 1)).toFixed(0)} Hz · dropped ${s.dropped}/${s.frames} · worst ${s.worstFrameMs} ms\nGPU median ${s.gpuMedianMs} ms · p99 ${s.gpuP99Ms} ms · max ${s.gpuMaxMs} ms`
    },
  }
}
