const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const smoothstep = (t) => t * t * (3 - 2 * t)
const point = (x, y) => ({ x, y })
const SAMPLES = 48
const SWEEP_STEP = 0.34
const ZIGZAG_STEP = 0.16
const LOOP_STEPS = 6
// Weave amplitude over squared step: keeps the spline's peak curvature near 1.5.
const WEAVE_CURVATURE = 0.9
const MOTIFS = ['sweep', 'zigzag', 'loop']
const DEFAULT_SPEED = { movementSpeed: 1, speedVariation: 1, acceleration: 1, accelerationVariation: 1, maxSpeed: 8 }
export const LANE_PADDING = 0.15
export const LANE_TRAVEL_Y = 1.05
const LANE_RADIUS_SAFETY = 1.35
const LANE_SMEAR_RESERVE = 0.6

export function requiredViewHalfHeight(radius, aspect) {
  const vertical = 3 * (LANE_RADIUS_SAFETY * radius + LANE_TRAVEL_Y + LANE_SMEAR_RESERVE)
  const horizontal = (LANE_RADIUS_SAFETY * radius + LANE_TRAVEL_Y * 1.6 + LANE_PADDING) / aspect
  return Math.max(vertical, horizontal)
}

// Every visible vertex stays in its own stripe. The radius is the geometry's
// bounding sphere after scaling; the extra space allows perspective and smear.
export function separatedLanes(halfWidth, halfHeight, radius, count = 3) {
  const laneHeight = 2 * halfHeight / count
  return Array.from({ length: count }, (_, index) => {
    const centerY = halfHeight - (index + 0.5) * laneHeight
    const halfLane = laneHeight / 2
    const radiusY = Math.max(0.05, Math.min(LANE_TRAVEL_Y, halfLane - LANE_RADIUS_SAFETY * radius - LANE_SMEAR_RESERVE))
    const radiusX = Math.max(0.05, Math.min(6.5, halfWidth * 0.7, halfWidth - LANE_RADIUS_SAFETY * radius - LANE_PADDING))
    return {
      x: halfWidth, y: halfHeight, centerY, radiusX, radiusY,
      horizontalRadiusX: radiusX,
      minY: centerY - halfLane, maxY: centerY + halfLane,
    }
  })
}

// A cubic Bézier remains inside the convex hull of its controls. Clamp their
// projected offsets to leave room for the full 3D geometry in every stripe.
export function constrainTrailToLane(controls, lane, center, radius, cameraDistance, strength) {
  const perspective = Math.max(0.1, 1 - radius / cameraDistance)
  const halfLane = (lane.maxY - lane.minY) / 2
  const maxY = Math.max(0, (halfLane - Math.abs(center.y - lane.centerY)) * perspective
    - radius - Math.abs(center.y) * radius / cameraDistance - LANE_PADDING)
  const maxX = Math.max(0, (lane.x - Math.abs(center.x)) * perspective
    - radius - Math.abs(center.x) * radius / cameraDistance - LANE_PADDING)
  return controls.map((control) => point(
    clamp(control.x * strength, -maxX, maxX),
    clamp(control.y * strength, -maxY, maxY),
  ))
}

export function cubicBezier(curve, t) {
  const s = 1 - t
  const a = s * s * s
  const b = 3 * s * s * t
  const c = 3 * s * t * t
  const d = t * t * t
  return point(
    a * curve[0].x + b * curve[1].x + c * curve[2].x + d * curve[3].x,
    a * curve[0].y + b * curve[1].y + c * curve[2].y + d * curve[3].y,
  )
}

function cubicDerivative(curve, t) {
  const s = 1 - t
  return point(
    3 * s * s * (curve[1].x - curve[0].x) + 6 * s * t * (curve[2].x - curve[1].x) + 3 * t * t * (curve[3].x - curve[2].x),
    3 * s * s * (curve[1].y - curve[0].y) + 6 * s * t * (curve[2].y - curve[1].y) + 3 * t * t * (curve[3].y - curve[2].y),
  )
}

function cubicSecondDerivative(curve, t) {
  return point(
    6 * (1 - t) * (curve[2].x - 2 * curve[1].x + curve[0].x) + 6 * t * (curve[3].x - 2 * curve[2].x + curve[1].x),
    6 * (1 - t) * (curve[2].y - 2 * curve[1].y + curve[0].y) + 6 * t * (curve[3].y - 2 * curve[2].y + curve[1].y),
  )
}

// A uniform cubic B-spline segment written as a cubic Bézier. Neighbouring
// segments share position, first derivative and second derivative.
export function bezierFromControls([q0, q1, q2, q3]) {
  return [
    point((q0.x + 4 * q1.x + q2.x) / 6, (q0.y + 4 * q1.y + q2.y) / 6),
    point((4 * q1.x + 2 * q2.x) / 6, (4 * q1.y + 2 * q2.y) / 6),
    point((2 * q1.x + 4 * q2.x) / 6, (2 * q1.y + 4 * q2.y) / 6),
    point((q1.x + 4 * q2.x + q3.x) / 6, (q1.y + 4 * q2.y + q3.y) / 6),
  ]
}

function buildSegment(controls) {
  const curve = bezierFromControls(controls)
  const lengths = [0]
  let previous = curve[0]
  let minDerivative = Infinity
  let maxCurvature = 0
  for (let i = 1; i <= SAMPLES; i++) {
    const t = i / SAMPLES
    const current = cubicBezier(curve, t)
    lengths.push(lengths[i - 1] + Math.hypot(current.x - previous.x, current.y - previous.y))
    previous = current
  }
  for (let i = 0; i <= 16; i++) {
    const t = i / 16
    const derivative = cubicDerivative(curve, t)
    const second = cubicSecondDerivative(curve, t)
    const magnitude = Math.hypot(derivative.x, derivative.y)
    minDerivative = Math.min(minDerivative, magnitude)
    maxCurvature = Math.max(maxCurvature,
      Math.abs(derivative.x * second.y - derivative.y * second.x) / Math.max(magnitude ** 3, 1e-9))
  }
  return { curve, lengths, length: lengths.at(-1), minDerivative, maxCurvature }
}

function segmentParameter(segment, distance) {
  const lengths = segment.lengths
  let low = 0
  let high = SAMPLES
  while (low + 1 < high) {
    const mid = (low + high) >> 1
    if (lengths[mid] < distance) low = mid
    else high = mid
  }
  const span = lengths[high] - lengths[low]
  const fraction = span > 0 ? (distance - lengths[low]) / span : 0
  return (low + clamp(fraction, 0, 1)) / SAMPLES
}

function sampleSegment(segment, distance) {
  return cubicBezier(segment.curve, segmentParameter(segment, distance))
}

function curvatureAt(segment, distance) {
  const t = segmentParameter(segment, distance)
  const derivative = cubicDerivative(segment.curve, t)
  const second = cubicSecondDerivative(segment.curve, t)
  const magnitude = Math.hypot(derivative.x, derivative.y)
  return Math.abs(derivative.x * second.y - derivative.y * second.x) / Math.max(magnitude ** 3, 1e-9)
}

function pathRegion(state, bounds) {
  if (bounds.radiusX !== undefined) return bounds
  const radiusX = bounds.x * 0.85
  const radiusY = Math.min(bounds.y * 0.84, radiusX * 1.25)
  return {
    radiusX,
    radiusY,
    centerY: clamp(state.homeY, -bounds.y + radiusY, bounds.y - radiusY),
  }
}

const loopRadius = (region) => Math.min(region.radiusX, region.radiusY) * 0.85

function startMotif(state, region, last) {
  const roomForLoop = Math.abs(last.x + state.heading * loopRadius(region) * 4) < region.radiusX
  const options = MOTIFS.filter((motif) => motif !== state.motif && (motif !== 'loop' || roomForLoop))
  state.motif = options[Math.floor(state.random() * options.length)]
  state.motifStep = 0
  state.motifLength = state.motif === 'loop' ? LOOP_STEPS : 3 + Math.floor(state.random() * 3)
  if (state.motif === 'loop') {
    // Enter and leave at the top or bottom, where the tangent can follow the heading.
    const side = last.y >= region.centerY ? 1 : -1
    state.spin = -state.heading * side
    state.loopCenter = point(last.x + state.heading * loopRadius(region) * 0.8, region.centerY)
    state.loopAngle = side * Math.PI / 2
  }
}

// A half loop pinned to the lane edge: reversing through nearby controls folds the spline into a cusp.
function startTurn(state, region, last) {
  const side = last.y >= region.centerY ? 1 : -1
  state.motif = 'turn'
  state.motifStep = 0
  state.motifLength = LOOP_STEPS / 2
  state.spin = -state.heading * side
  state.loopCenter = point(state.heading * (region.radiusX - loopRadius(region)), region.centerY)
  state.loopAngle = side * Math.PI / 2
  state.heading = -state.heading
  state.weaveSide = -side
}

function motifTarget(state, region, last) {
  const radius = loopRadius(region)
  if (state.motif === 'loop' || state.motif === 'turn') {
    const step = state.motifStep + 1
    const angle = state.loopAngle + state.spin * step * (2 * Math.PI / LOOP_STEPS)
    const drift = state.motif === 'loop' ? state.heading * radius * 0.3 * step : 0
    return {
      target: point(state.loopCenter.x + drift + Math.cos(angle) * radius, state.loopCenter.y + Math.sin(angle) * radius),
      spread: radius * 0.1,
    }
  }
  const stepX = region.radiusX * (state.motif === 'zigzag' ? ZIGZAG_STEP : SWEEP_STEP)
  if (Math.abs(last.x + state.heading * stepX) > region.radiusX - radius) {
    startTurn(state, region, last)
    return motifTarget(state, region, last)
  }
  const reach = state.motif === 'zigzag' ? 0.9 : 0.45 + state.random() * 0.4
  const amplitude = Math.min(region.radiusY * reach, WEAVE_CURVATURE * stepX * stepX)
  state.weaveSide = -state.weaveSide
  return {
    target: point(last.x + state.heading * stepX, region.centerY + state.weaveSide * amplitude),
    spread: Math.min(stepX, amplitude) * 0.25,
  }
}

function chooseNextControl(state, bounds, firstThree) {
  const region = pathRegion(state, bounds)
  const last = firstThree[2]
  if (state.motifStep >= state.motifLength) startMotif(state, region, last)
  const { target, spread } = motifTarget(state, region, last)
  state.motifStep++
  let best = null
  let lowestPenalty = Infinity
  for (let attempt = 0; attempt < 24; attempt++) {
    const jitter = attempt === 0 ? 0 : spread
    const candidate = point(
      clamp(target.x + (state.random() - 0.5) * 2 * jitter, -region.radiusX, region.radiusX),
      clamp(target.y + (state.random() - 0.5) * 2 * jitter, region.centerY - region.radiusY, region.centerY + region.radiusY),
    )
    const segment = buildSegment([...firstThree, candidate])
    const penalty = Math.max(0, 0.45 - segment.minDerivative) * 8
      + Math.max(0, segment.maxCurvature - 1.5) * 3
      + Math.max(0, 0.8 - segment.length) * 4
    if (penalty < lowestPenalty) {
      best = { candidate, segment }
      lowestPenalty = penalty
    }
    if (penalty === 0) break
  }
  return best
}

export function createBezierMotion({ x, y, baseSpeed, random = Math.random }) {
  return {
    x, y, homeY: y, baseSpeed, random,
    speed: baseSpeed * 0.55,
    speedFrom: baseSpeed * 0.55,
    speedTo: baseSpeed * 0.55,
    speedAmplitude: 0,
    appliedVariation: null,
    durationJitter: 0,
    speedTime: 0, speedDuration: 0, fastNext: true,
    controls: null, segment: null, distance: 0,
    heading: random() < 0.5 ? -1 : 1,
    weaveSide: y < 0 ? 1 : -1,
    spin: 1,
    motif: 'sweep', motifStep: 0, motifLength: 2,
    loopCenter: null, loopAngle: 0,
  }
}

export function createHorizontalMotion({ y, baseSpeed, random = Math.random }) {
  const state = createBezierMotion({ x: 0, y, baseSpeed, random })
  state.speed = baseSpeed * 0.85
  state.speedFrom = state.speed
  state.phase = 0
  return state
}

function initialize(state, bounds) {
  const region = pathRegion(state, bounds)
  const stepX = region.radiusX * SWEEP_STEP * state.heading
  const controls = [-1, 0, 1].map((offset) => point(offset * stepX, region.centerY))
  const { candidate, segment } = chooseNextControl(state, bounds, controls)
  state.controls = [...controls, candidate]
  state.segment = segment
  state.distance = 0
  state.x = segment.curve[0].x
  state.y = segment.curve[0].y
}

function advanceSegment(state, bounds) {
  const firstThree = state.controls.slice(1)
  const { candidate, segment } = chooseNextControl(state, bounds, firstThree)
  state.controls = [...firstThree, candidate]
  state.segment = segment
  state.distance = 0
}

function updateSpeed(state, delta, settings) {
  if (state.appliedVariation === null) state.appliedVariation = settings.speedVariation
  else state.appliedVariation += (settings.speedVariation - state.appliedVariation) * (1 - Math.exp(-delta / 0.25))
  if (state.speedTime >= state.speedDuration) {
    state.speedFrom = state.speed
    state.speedAmplitude = state.fastNext
      ? 0.7 + state.random() * 0.85
      : -(0.58 - state.random() * 0.48)
    state.fastNext = !state.fastNext
    state.speedTime = 0
    state.durationJitter = (state.random() - 0.5) * 1.3
    state.speedDuration = 1.9 + state.durationJitter * settings.accelerationVariation
  }
  const duration = 1.9 + state.durationJitter * settings.accelerationVariation
  state.speedTime *= duration / state.speedDuration
  state.speedDuration = duration
  // Advance the current ramp at the live acceleration setting. Tweaking the
  // pane changes the response immediately without resetting path or speed.
  state.speedTime = Math.min(state.speedDuration, state.speedTime + delta * settings.acceleration)
  const t = smoothstep(state.speedTime / state.speedDuration)
  state.speedTo = state.baseSpeed * (1 + state.speedAmplitude * state.appliedVariation)
  state.speed = state.speedFrom + (state.speedTo - state.speedFrom) * t
}

// Distance along the spline is used instead of raw Bézier t. This prevents
// control-point spacing from creating unintended pauses or speed spikes.
export function stepBezierMotion(state, delta, bounds, options = DEFAULT_SPEED) {
  if (!state.segment) initialize(state, bounds)
  if (delta <= 0) return state
  const settings = typeof options === 'number' ? { ...DEFAULT_SPEED, movementSpeed: options } : options
  const steps = Math.ceil(delta / (1 / 120))
  for (let step = 0; step < steps; step++) {
    const duration = delta / steps
    updateSpeed(state, duration, settings)
    // Ease naturally into tighter bends without ever bringing speed to zero.
    let remaining = Math.min(state.speed * settings.movementSpeed, settings.maxSpeed) * duration
      / (1 + 0.55 * curvatureAt(state.segment, state.distance))
    while (remaining > 0) {
      const available = state.segment.length - state.distance
      if (remaining <= available) {
        state.distance += remaining
        break
      }
      remaining -= available
      advanceSegment(state, bounds)
    }
  }
  const current = sampleSegment(state.segment, state.distance)
  state.x = current.x
  state.y = current.y
  return state
}

// A sinusoidal path makes each reversal continuous. The speed envelope varies
// the phase rate, while maxSpeed caps the actual horizontal velocity.
export function stepHorizontalMotion(state, delta, lane, options = DEFAULT_SPEED) {
  state.y = lane.centerY
  if (delta <= 0) return state
  const settings = typeof options === 'number' ? { ...DEFAULT_SPEED, movementSpeed: options } : options
  const radius = lane.horizontalRadiusX
  const steps = Math.ceil(delta / (1 / 120))
  for (let step = 0; step < steps; step++) {
    const duration = delta / steps
    updateSpeed(state, duration, settings)
    state.phase += Math.min(state.speed * settings.movementSpeed, settings.maxSpeed) * duration / radius
  }
  state.x = radius * Math.sin(state.phase)
  return state
}

// The shader's trailing side changes by 180 degrees at a horizontal turn.
// Collapse the smear smoothly before that switch, then let the new trail grow.
export function horizontalSmearEnvelope(phase) {
  return smoothstep(clamp(Math.abs(Math.cos(phase)) / 0.5, 0, 1))
}

// Tip starts at the last reversal and only advances: a speed-sized trail ran backwards.
export function horizontalSmearTrail(state, velocity, exposure, radius) {
  const turn = horizontalTurnIndex(state.phase)
  const turnX = radius * (turn % 2 === 0 ? -1 : 1)
  if (state.smearTurn !== turn) {
    state.smearTurn = turn
    state.smearTipX = turnX
  }
  const direction = Math.sign(state.x - turnX)
  const length = Math.min(Math.abs(velocity) * exposure * horizontalSmearEnvelope(state.phase), Math.abs(state.x - turnX))
  const target = state.x - direction * length
  state.smearTipX = direction > 0 ? Math.max(state.smearTipX, target) : Math.min(state.smearTipX, target)
  const tip = state.smearTipX - state.x
  return [1 / 3, 2 / 3, 1].map((fraction) => point(tip * fraction, 0))
}

// Grow taper proportionally with the same extension as the smear. Its linear
// onset keeps shrink and stretch in the same beat after a reversal.
export function smearTailActivation(distance, radius) {
  if (radius <= 0) return 0
  return clamp(distance / (radius * 1.5), 0, 1)
}

export function horizontalTurnIndex(phase) {
  return Math.floor((phase + Math.PI / 2) / Math.PI)
}

// A cubic Bézier through samples at 1/3, 2/3 and 1 of the exposure window.
// Offsets are past position minus current position.
export function fitTrailBezier([near, middle, far]) {
  return [
    point(3 * near.x - 1.5 * middle.x + far.x / 3, 3 * near.y - 1.5 * middle.y + far.y / 3),
    point(-1.5 * near.x + 3 * middle.x - 5 * far.x / 6, -1.5 * near.y + 3 * middle.y - 5 * far.y / 6),
    far,
  ]
}

// Observed positions only: no future tangent or predicted speed reaches the shader.
export function createTrailHistory() {
  const samples = []
  function sampleAt(time) {
    if (time <= samples[0].time) return samples[0]
    for (let i = 1; i < samples.length; i++) {
      const next = samples[i]
      if (next.time >= time) {
        const previous = samples[i - 1]
        const t = (time - previous.time) / (next.time - previous.time || 1)
        return point(previous.x + (next.x - previous.x) * t, previous.y + (next.y - previous.y) * t)
      }
    }
    return samples.at(-1)
  }
  function sample(time, x, y, exposure) {
    if (samples.length === 0) return [point(0, 0), point(0, 0), point(0, 0)]
    return [1 / 3, 2 / 3, 1].map((fraction) => {
      const past = sampleAt(time - exposure * fraction)
      return point(past.x - x, past.y - y)
    })
  }
  return {
    reset() { samples.length = 0 },
    sample,
    push(time, x, y, exposure) {
      samples.push({ time, x, y })
      const earliest = time - exposure
      while (samples.length > 2 && samples[1].time < earliest) samples.shift()
      return sample(time, x, y, exposure)
    },
  }
}
