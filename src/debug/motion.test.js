import assert from 'node:assert/strict'
import test from 'node:test'
import { bezierFromControls, constrainTrailToLane, createBezierMotion, createHorizontalMotion, createTrailHistory, cubicBezier, fitTrailBezier, horizontalSmearEnvelope, horizontalSmearTrail, horizontalTurnIndex, requiredViewHalfHeight, separatedLanes, smearTailActivation, stepBezierMotion, stepHorizontalMotion } from './motion.js'

function seededRandom(seed) {
  return () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32)
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

test('adjacent cubic Bézier segments join with continuous direction and curvature', () => {
  const points = [
    { x: -3, y: 0.5 }, { x: -1, y: 1.5 }, { x: 0.4, y: -0.6 },
    { x: 2, y: -1.5 }, { x: 3, y: 0.8 },
  ]
  const left = bezierFromControls(points.slice(0, 4))
  const right = bezierFromControls(points.slice(1, 5))
  assert.ok(distance(left[3], right[0]) < 1e-12)
  const h = 1e-4
  const leftVelocity = {
    x: (left[3].x - cubicBezier(left, 1 - h).x) / h,
    y: (left[3].y - cubicBezier(left, 1 - h).y) / h,
  }
  const rightVelocity = {
    x: (cubicBezier(right, h).x - right[0].x) / h,
    y: (cubicBezier(right, h).y - right[0].y) / h,
  }
  assert.ok(distance(leftVelocity, rightVelocity) < 0.001)
  const leftAcceleration = {
    x: (left[3].x - 2 * cubicBezier(left, 1 - h).x + cubicBezier(left, 1 - 2 * h).x) / h ** 2,
    y: (left[3].y - 2 * cubicBezier(left, 1 - h).y + cubicBezier(left, 1 - 2 * h).y) / h ** 2,
  }
  const rightAcceleration = {
    x: (cubicBezier(right, 2 * h).x - 2 * cubicBezier(right, h).x + right[0].x) / h ** 2,
    y: (cubicBezier(right, 2 * h).y - 2 * cubicBezier(right, h).y + right[0].y) / h ** 2,
  }
  assert.ok(distance(leftAcceleration, rightAcceleration) < 0.01)
})

test('random Bézier travel stays on screen without stops or abrupt turns', () => {
  const bounds = { x: 5.1, y: 2.5 }
  for (const [i, baseSpeed] of [1.15, 1.75, 2.5].entries()) {
    const state = createBezierMotion({ x: 0, y: 2.15 - i * 2.15, baseSpeed, random: seededRandom(i + 1) })
    stepBezierMotion(state, 0, bounds)
    const xs = []
    const ys = []
    const speeds = []
    let previous = { x: state.x, y: state.y }
    let previousDirection = null
    let largestTurn = 0
    for (let frame = 0; frame < 60 * 30; frame++) {
      stepBezierMotion(state, 1 / 60, bounds)
      const dx = state.x - previous.x
      const dy = state.y - previous.y
      const step = Math.hypot(dx, dy)
      assert.ok(Number.isFinite(step))
      assert.ok(step > 0.0001, 'the mesh stopped')
      assert.ok(Math.abs(state.x) <= bounds.x + 1e-6 && Math.abs(state.y) <= bounds.y + 1e-6)
      if (previousDirection) {
        const dot = (dx * previousDirection.x + dy * previousDirection.y) / step
        largestTurn = Math.max(largestTurn, Math.acos(clamp(dot, -1, 1)))
      }
      previousDirection = { x: dx / step, y: dy / step }
      previous = { x: state.x, y: state.y }
      xs.push(state.x)
      ys.push(state.y)
      speeds.push(step * 60)
    }
    assert.ok(Math.max(...xs) - Math.min(...xs) > 2)
    assert.ok(Math.max(...ys) - Math.min(...ys) > 1.2)
    assert.ok(Math.max(...speeds) > Math.min(...speeds.slice(60)) * 2)
    assert.ok(largestTurn < 0.25, `abrupt turn: ${largestTurn}`)
  }
})

test('narrow screens and maximum tempo still produce rounded turns', () => {
  const bounds = { x: 1.28, y: 4.54 }
  for (let seed = 1; seed <= 6; seed++) {
    const state = createBezierMotion({
      x: 0, y: [2.15, 0, -2.15][seed % 3], baseSpeed: 2.5, random: seededRandom(seed),
    })
    stepBezierMotion(state, 0, bounds)
    let previous = { x: state.x, y: state.y }
    let previousDirection = null
    for (let frame = 0; frame < 60 * 20; frame++) {
      stepBezierMotion(state, 1 / 60, bounds, 2.5)
      const dx = state.x - previous.x
      const dy = state.y - previous.y
      const length = Math.hypot(dx, dy)
      assert.ok(length > 0.0001)
      assert.ok(Math.abs(state.x) <= bounds.x + 1e-6 && Math.abs(state.y) <= bounds.y + 1e-6)
      if (previousDirection) {
        const turn = Math.acos(clamp((dx * previousDirection.x + dy * previousDirection.y) / length, -1, 1))
        assert.ok(turn < 0.25, `sharp mobile turn: ${turn}`)
      }
      previousDirection = { x: dx / length, y: dy / length }
      previous = { x: state.x, y: state.y }
    }
  }
})

test('motion knobs change speed smoothly and enforce the travel cap', () => {
  const bounds = { x: 5.1, y: 2.5 }
  const settings = { movementSpeed: 2.5, speedVariation: 1, acceleration: 1, accelerationVariation: 1, maxSpeed: 1 }
  const state = createBezierMotion({ x: 0, y: 0, baseSpeed: 2.5, random: seededRandom(72) })
  stepBezierMotion(state, 0, bounds)
  for (let frame = 0; frame < 60 * 5; frame++) {
    const previous = { x: state.x, y: state.y }
    stepBezierMotion(state, 1 / 60, bounds, settings)
    assert.ok(distance(state, previous) <= settings.maxSpeed / 60 + 1e-6)
  }
  const before = { x: state.x, y: state.y }
  settings.maxSpeed = 16
  stepBezierMotion(state, 1 / 60, bounds, settings)
  assert.ok(distance(state, before) > 1 / 60, 'raising the cap must affect the next frame')

  const slow = createBezierMotion({ x: 0, y: 0, baseSpeed: 2.5, random: seededRandom(91) })
  const fast = createBezierMotion({ x: 0, y: 0, baseSpeed: 2.5, random: seededRandom(91) })
  const ramp = { ...settings, movementSpeed: 1, speedVariation: 1, accelerationVariation: 0 }
  stepBezierMotion(slow, 0, bounds)
  stepBezierMotion(fast, 0, bounds)
  stepBezierMotion(slow, 0.3, bounds, { ...ramp, acceleration: 0.4 })
  stepBezierMotion(fast, 0.3, bounds, { ...ramp, acceleration: 2.5 })
  assert.ok(fast.speed > slow.speed, 'acceleration must change the current ramp')
  assert.equal(fast.speedDuration, slow.speedDuration)

  const changing = createBezierMotion({ x: 0, y: 0, baseSpeed: 2.5, random: seededRandom(91) })
  stepBezierMotion(changing, 0, bounds)
  stepBezierMotion(changing, 0.3, bounds, ramp)
  const variationBefore = changing.appliedVariation
  const progressBefore = changing.speedTime / changing.speedDuration
  stepBezierMotion(changing, 1 / 60, bounds, { ...ramp, speedVariation: 0, accelerationVariation: 1 })
  assert.ok(changing.appliedVariation < variationBefore, 'speed variation must respond in the current phase')
  assert.notEqual(changing.speedDuration, 1.9, 'acceleration variation must update the current phase')
  assert.ok(changing.speedTime / changing.speedDuration > progressBefore, 'changing ramp length must preserve progress')

  const steady = createBezierMotion({ x: 0, y: 0, baseSpeed: 2.5, random: seededRandom(101) })
  stepBezierMotion(steady, 0, bounds)
  for (let frame = 0; frame < 60 * 8; frame++) {
    stepBezierMotion(steady, 1 / 60, bounds, { ...ramp, speedVariation: 0, acceleration: 2.5 })
    assert.equal(steady.speedDuration, 1.9, 'zero acceleration variation must use fixed ramp time')
  }
  assert.ok(Math.abs(steady.speed - steady.baseSpeed) < 1e-9, 'zero speed variation must settle at base speed')
})

test('middle mesh travels only horizontally and reverses smoothly at variable speed', () => {
  const radius = 1.1
  const halfHeight = requiredViewHalfHeight(radius, 16 / 9)
  const lane = separatedLanes(halfHeight * 16 / 9, halfHeight, radius)[1]
  const settings = { movementSpeed: 1, speedVariation: 1, acceleration: 1, accelerationVariation: 1, maxSpeed: 8 }
  const state = createHorizontalMotion({ y: 0, baseSpeed: 4.5, random: seededRandom(47) })
  let previousX = state.x
  let previousDx = 0
  let reversals = 0
  let leftmost = Infinity
  let rightmost = -Infinity
  let slowestEnvelope = Infinity
  let fastestEnvelope = 0
  for (let frame = 0; frame < 60 * 40; frame++) {
    stepHorizontalMotion(state, 1 / 60, lane, settings)
    const dx = state.x - previousX
    assert.equal(state.y, lane.centerY)
    assert.ok(Math.abs(state.x) <= lane.horizontalRadiusX + 1e-6)
    assert.ok(Math.abs(dx) <= settings.maxSpeed / 60 + 1e-6)
    if (dx * previousDx < 0) {
      reversals++
      assert.ok(Math.abs(state.x) > lane.horizontalRadiusX * 0.99, 'reversal must occur at an edge')
    }
    if (Math.abs(dx) > 1e-6) previousDx = dx
    previousX = state.x
    leftmost = Math.min(leftmost, state.x)
    rightmost = Math.max(rightmost, state.x)
    slowestEnvelope = Math.min(slowestEnvelope, state.speed)
    fastestEnvelope = Math.max(fastestEnvelope, state.speed)
  }
  assert.ok(reversals >= 4)
  assert.ok(leftmost < -lane.horizontalRadiusX * 0.99)
  assert.ok(rightmost > lane.horizontalRadiusX * 0.99)
  assert.ok(fastestEnvelope > slowestEnvelope * 1.8)
})

test('middle smear fades before reversal and regrows behind the new direction', () => {
  const radius = 1.1
  const aspect = 16 / 9
  const halfHeight = requiredViewHalfHeight(radius, aspect)
  const lane = separatedLanes(halfHeight * aspect, halfHeight, radius)[1]
  const state = createHorizontalMotion({ y: 0, baseSpeed: 4.5, random: seededRandom(47) })
  const settings = { movementSpeed: 2.5, speedVariation: 1, acceleration: 1, accelerationVariation: 1, maxSpeed: 16 }
  let previousTip = 0
  let reversals = 0
  for (let frame = 0; frame < 60 * 20; frame++) {
    const previousX = state.x
    const previousTurn = horizontalTurnIndex(state.phase)
    stepHorizontalMotion(state, 1 / 60, lane, settings)
    const turned = horizontalTurnIndex(state.phase) !== previousTurn
    const trail = horizontalSmearTrail(state, (state.x - previousX) * 60, 0.18, lane.horizontalRadiusX)
    const tip = fitTrailBezier(trail)[2].x * 2
    if (turned) {
      reversals++
      assert.ok(Math.abs(previousTip) < 0.05, 'old smear must have faded before the side flips')
      assert.ok(Math.abs(tip) < 0.05, 'the new side must start without a lingering trail')
    }
    if (!turned) assert.ok(trail[2].x * (state.x - previousX) <= 1e-9, 'the sampled trail must stay behind the sphere')
    assert.ok(Math.abs(fitTrailBezier(trail)[0].x - trail[0].x) < 1e-9, 'horizontal smear must remain straight')
    previousTip = tip
  }
  assert.ok(reversals >= 4)
  assert.ok(horizontalSmearEnvelope(Math.PI / 2) < 1e-12)
  assert.equal(horizontalSmearEnvelope(0), 1)
  assert.ok(horizontalSmearTrail({ x: 1, phase: Math.PI / 2 }, 0, 0.18, 1).every((offset) => offset.x === 0 && offset.y === 0))
})

test('taper stays negligible around a sphere reversal and grows with its trail', () => {
  const size = 1.5
  const sphereRadius = 1.15 * size
  const aspect = 1.12
  const halfHeight = requiredViewHalfHeight(2.1, aspect)
  const lane = separatedLanes(halfHeight * aspect, halfHeight, 2.1)[1]
  const cameraDistance = halfHeight / Math.tan(Math.PI / 12)
  const state = createHorizontalMotion({ y: 0, baseSpeed: 4.5, random: seededRandom(47) })
  const settings = { movementSpeed: 2.5, speedVariation: 1, acceleration: 1, accelerationVariation: 1, maxSpeed: 8 }
  let maxTurnTaper = 0
  let maxFastTaper = 0
  let turnSamples = 0
  let fastSamples = 0
  for (let frame = 0; frame < 1200; frame++) {
    const previousX = state.x
    stepHorizontalMotion(state, 1 / 120, lane, settings)
    const trail = horizontalSmearTrail(state, (state.x - previousX) * 120, 0.18, lane.horizontalRadiusX)
    const tip = constrainTrailToLane(fitTrailBezier(trail), lane, state, sphereRadius, cameraDistance, 2)[2]
    const taper = smearTailActivation(Math.hypot(tip.x, tip.y), sphereRadius)
    const speed = Math.abs(state.x - previousX) * 120
    if (speed < 0.5 && Math.abs(Math.cos(state.phase)) < 0.1) {
      turnSamples++
      maxTurnTaper = Math.max(maxTurnTaper, taper)
    }
    if (speed > 6 && Math.abs(Math.cos(state.phase)) > 0.8) {
      fastSamples++
      maxFastTaper = Math.max(maxFastTaper, taper)
    }
  }
  assert.ok(turnSamples > 0 && fastSamples > 0)
  assert.ok(maxTurnTaper < 0.01, `sphere is squeezed while stopped: ${maxTurnTaper}`)
  assert.ok(maxFastTaper > 0.95, 'a full-speed trail should still narrow')
  assert.ok(smearTailActivation(0.05, sphereRadius) > 0, 'taper must begin with the trail, without a delayed threshold')
})

test('sphere smear tip only advances and never passes its last reversal', () => {
  const radius = 1.19
  const halfHeight = requiredViewHalfHeight(radius, 16 / 9)
  const lane = separatedLanes(halfHeight * 16 / 9, halfHeight, radius)[1]
  const settings = { movementSpeed: 5.7, speedVariation: 0.85, acceleration: 4.35, accelerationVariation: 0.65, maxSpeed: 24 }
  const state = createHorizontalMotion({ y: 0, baseSpeed: 4.5, random: seededRandom(5) })
  let previousX = state.x
  let previousTip = null
  let reversals = 0
  for (let frame = 0; frame < 120 * 20; frame++) {
    const previousTurn = horizontalTurnIndex(state.phase)
    stepHorizontalMotion(state, 1 / 120, lane, settings)
    const dx = state.x - previousX
    const trail = horizontalSmearTrail(state, dx * 120, 0.18, lane.horizontalRadiusX)
    const tip = state.x + trail[2].x
    if (horizontalTurnIndex(state.phase) !== previousTurn) {
      reversals++
      previousTip = null
    }
    if (previousTip !== null) assert.ok((tip - previousTip) * Math.sign(dx) >= -1e-9, 'the smear tip moved backwards')
    assert.ok((-Math.sign(dx) * lane.horizontalRadiusX - tip) * Math.sign(dx) <= 1e-9, 'the smear tip passed the reversal')
    previousTip = tip
    previousX = state.x
  }
  assert.ok(reversals >= 4)
})

test('trail Bézier follows measured curved positions and fades after stopping', () => {
  const history = createTrailHistory()
  const initial = history.push(0, 0, 0, 0.15)
  assert.deepEqual(initial, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }])
  history.push(0.05, 0.05, 0.01, 0.15)
  history.push(0.1, 0.18, 0.08, 0.15)
  const offsets = history.push(0.15, 0.35, 0.24, 0.15)
  assert.deepEqual(history.sample(0.15, 0.35, 0.24, 0.15), offsets)
  history.sample(0.2, 10, 10, 0.15)
  assert.deepEqual(history.sample(0.15, 0.35, 0.24, 0.15), offsets, 'inspecting a paused frame must not add a sample')
  const controls = fitTrailBezier(offsets)
  const curve = [{ x: 0, y: 0 }, ...controls]
  for (let i = 0; i < 3; i++) {
    assert.ok(distance(cubicBezier(curve, (i + 1) / 3), offsets[i]) < 1e-9)
  }
  const cross = offsets[0].x * offsets[2].y - offsets[0].y * offsets[2].x
  assert.ok(Math.abs(cross) > 0.001, 'the trail should bend with the path')
  history.push(0.2, 0.35, 0.24, 0.15)
  history.push(0.3, 0.35, 0.24, 0.15)
  assert.deepEqual(history.push(0.4, 0.35, 0.24, 0.15), initial)
})

test('three meshes and their curved smears stay in separate screen bands', () => {
  for (const { aspect, radius } of [
    { aspect: 16 / 9, radius: 1.04 },
    { aspect: 390 / 844, radius: 1.04 },
    { aspect: 390 / 844, radius: 2.55 },
  ]) {
    const halfHeight = requiredViewHalfHeight(radius, aspect)
    const cameraDistance = halfHeight / Math.tan(Math.PI / 12)
    const lanes = separatedLanes(halfHeight * aspect, halfHeight, radius)
    const states = [1.15, 4.5, 2.5].map((baseSpeed, i) => i === 1
      ? createHorizontalMotion({ y: 0, baseSpeed, random: seededRandom(i + 20) })
      : createBezierMotion({ x: 0, y: 2.15 - i * 2.15, baseSpeed, random: seededRandom(i + 20) }))
    const histories = states.map(() => createTrailHistory())
    for (let frame = 0; frame < 60 * 20; frame++) {
      for (let i = 0; i < states.length; i++) {
        const step = i === 1 ? stepHorizontalMotion : stepBezierMotion
        const state = step(states[i], 1 / 60, lanes[i], {
          movementSpeed: 2.5, speedVariation: 1, acceleration: 2.5,
          accelerationVariation: 1, maxSpeed: 16,
        })
        const trail = histories[i].push(frame / 60, state.x, state.y, 0.35)
        const controls = constrainTrailToLane(fitTrailBezier(trail), lanes[i], state, radius, cameraDistance, 2)
        const curve = [{ x: 0, y: 0 }, ...controls]
        // The entire Bézier stays in the convex hull of these four controls.
        for (const offset of curve) {
          const projectedExtent = (Math.abs(offset.y) + radius + Math.abs(state.y) * radius / cameraDistance)
            / (1 - radius / cameraDistance)
          assert.ok(state.y - projectedExtent >= lanes[i].minY - 1e-6, 'overlaps the lane below')
          assert.ok(state.y + projectedExtent <= lanes[i].maxY + 1e-6, 'overlaps the lane above')
        }
      }
    }
  }
})

test('upper and lower meshes roam the lane width and turn both ways', () => {
  const radius = 1.04
  const halfHeight = requiredViewHalfHeight(radius, 16 / 9)
  const lanes = separatedLanes(halfHeight * 16 / 9, halfHeight, radius)
  const settings = { movementSpeed: 5.7, speedVariation: 0.85, acceleration: 4.35, accelerationVariation: 0.65, maxSpeed: 24 }
  for (const [i, baseSpeed] of [[0, 1.15], [2, 2.5]]) {
    const state = createBezierMotion({ x: 0, y: 2.15 - i * 2.15, baseSpeed, random: seededRandom(i + 40) })
    stepBezierMotion(state, 0, lanes[i], settings)
    let minX = Infinity
    let maxX = -Infinity
    let left = 0
    let right = 0
    let previous = { x: state.x, y: state.y }
    let previousDirection = null
    for (let frame = 0; frame < 120 * 30; frame++) {
      stepBezierMotion(state, 1 / 120, lanes[i], settings)
      const dx = state.x - previous.x
      const dy = state.y - previous.y
      const step = Math.hypot(dx, dy)
      if (previousDirection) {
        const turn = Math.asin(clamp((previousDirection.x * dy - previousDirection.y * dx) / step, -1, 1))
        if (turn > 0) left += turn
        else right -= turn
      }
      previousDirection = { x: dx / step, y: dy / step }
      previous = { x: state.x, y: state.y }
      minX = Math.min(minX, state.x)
      maxX = Math.max(maxX, state.x)
    }
    assert.ok(maxX - minX > lanes[i].radiusX * 1.2, 'the path must use most of the lane width')
    assert.ok(left > 4 * Math.PI && right > 4 * Math.PI, 'the path must turn both ways')
  }
})

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
