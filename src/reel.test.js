import assert from 'node:assert/strict'
import test from 'node:test'
import { Euler, Quaternion, Vector3 } from 'three'
import { LOOP, beat } from './timeline.js'
import { LETTER_EM, abSplit, actors, backdropAt, cameraPose, createBackdropState, fitFov, projectToFrame } from './reel.js'
import { GLYPHS } from './glyph-metrics.js'
import { setBeatStrengths } from './rhythm.js'

const STEP = 1 / 240
const ASPECTS = [16 / 10, 16 / 9, 21 / 9]
const REACH = 1.2 * 4.2
const position = new Vector3()
const next = new Vector3()
const frame = new Vector3()

const onScreen = (point, scale, t, aspect) => {
  if (scale < 1e-3) return false
  projectToFrame(point, t, aspect, frame)
  const halfHeight = Math.tan(fitFov(aspect) * Math.PI / 360)
  const reach = (REACH * scale) / (frame.z * halfHeight * 2)
  return Math.abs(frame.x) < aspect / 2 + reach && Math.abs(frame.y) < 0.5 + reach
}

// A teleport is one step far longer than both of its neighbours; a whip is fast but smooth.
const spike = (before, step, after) => step > 0.5 && step > 4 * Math.max(before, after, 1e-3)

const stepAt = (sample, t, out, other) => sample(((t % LOOP) + LOOP) % LOOP, out).distanceTo(sample((((t + STEP) % LOOP) + LOOP) % LOOP, other))

const local = new Vector3()
const center = new Vector3()
const rotation = new Quaternion()
const angles = new Euler()
const clearance = (point, radius, letter, t) => {
  const [, left, right] = GLYPHS[letter.char]
  const scale = letter.scale(t)
  rotation.setFromEuler(letter.rotation(t, angles)).invert()
  local.copy(point).sub(letter.position(t, center)).applyQuaternion(rotation)
  const dx = Math.max(0, Math.abs(local.x) - ((right - left) / 2000 * LETTER_EM + 0.02) * scale)
  const dy = Math.max(0, Math.abs(local.y) - (LETTER_EM / 2 + 0.05) * scale)
  const dz = Math.max(0, Math.abs(local.z) - 0.22 * scale)
  return Math.hypot(dx, dy, dz) - radius
}

test('every actor jumps only at a declared cut, and only while nobody can see it', () => {
  const a = new Vector3()
  const b = new Vector3()
  for (const actor of actors) {
    const sample = (t, out) => actor.position(t, out)
    for (let t = 0; t < LOOP; t += STEP) {
      const t1 = (t + STEP) % LOOP
      const moved = spike(stepAt(sample, t - STEP, a, b), stepAt(sample, t, a, b), stepAt(sample, t + STEP, a, b))
      const scale = actor.scale(t)
      const scaleNext = actor.scale(t1)
      if (!moved && Math.abs(scale - scaleNext) < 0.25) continue
      actor.position(t, position)
      actor.position(t1, next)
      const cut = actor.cuts.find((time) => Math.abs(((time - t1 + LOOP / 2) % LOOP + LOOP) % LOOP - LOOP / 2) <= STEP * 1.01)
      assert.ok(cut !== undefined, `${actor.name} jumps at ${t.toFixed(3)} s without a cut`)
      for (const aspect of ASPECTS) {
        assert.ok(!onScreen(position, scale, t, aspect), `${actor.name} visible before its cut at ${t.toFixed(3)} s (aspect ${aspect.toFixed(2)})`)
        assert.ok(!onScreen(next, scaleNext, t1, aspect), `${actor.name} visible after its cut at ${t1.toFixed(3)} s (aspect ${aspect.toFixed(2)})`)
      }
    }
  }
})

test('the reel wraps without a seam', () => {
  const a = new Vector3()
  const b = new Vector3()
  for (const actor of actors) {
    const sample = (t, out) => actor.position(t, out)
    const seam = stepAt(sample, LOOP - STEP, a, b)
    const around = Math.max(stepAt(sample, LOOP - 2 * STEP, a, b), stepAt(sample, 0, a, b))
    assert.ok(seam <= 2 * around + 0.01, `${actor.name} moves ${seam.toFixed(2)} across the seam`)
    assert.ok(Math.abs(actor.scale(LOOP - STEP) - actor.scale(0)) < 0.05, `${actor.name} rescales across the seam`)
  }
})

test('the camera never teleports', () => {
  const quaternion = new Quaternion()
  const sample = (t, out) => {
    cameraPose(t, out, quaternion)
    return out
  }
  const a = new Vector3()
  const b = new Vector3()
  for (let t = 0; t < LOOP; t += STEP) {
    assert.ok(!spike(stepAt(sample, t - STEP, a, b), stepAt(sample, t, a, b), stepAt(sample, t + STEP, a, b)), `camera jumps at ${t.toFixed(3)} s`)
  }
})

test('the camera never snaps its rotation, banking included', () => {
  const position = new Vector3()
  const a = new Quaternion()
  const b = new Quaternion()
  for (let t = 0; t < LOOP; t += STEP) {
    cameraPose(t, position, a)
    cameraPose((t + STEP) % LOOP, position, b)
    assert.ok(a.angleTo(b) < 0.02, `camera rotation jumps at ${t.toFixed(3)} s`)
  }
})

const trio = ['knot', 'sphere', 'gem'].map((name) => actors.find((actor) => actor.name === name))

test('the trio slams into its row on the drop and sweeps back through it on beats 2 and 4', () => {
  const at = trio.map(() => new Vector3())
  const later = new Vector3()
  for (const k of [0, 2, 4]) {
    trio.forEach((actor, i) => actor.position(beat(k), at[i]))
    const xs = at.map((point) => point.x).sort((x, y) => x - y)
    assert.ok(Math.abs(xs[1] - xs[0] - (xs[2] - xs[1])) < 1e-6 && xs[1] - xs[0] > 3, `no even row on beat ${k}`)
    assert.ok(at.every((point) => Math.abs(point.y - at[0].y) < 0.01 && Math.abs(point.z) < 1e-6), `row is not level on beat ${k}`)
    if (k === 0) continue
    trio.forEach((actor, i) => {
      if (actor.name === 'sphere') return
      actor.position(beat(k) + STEP, later)
      assert.ok(later.distanceTo(at[i]) / STEP > 5, `${actor.name} stops in the row on beat ${k}`)
    })
  }
  for (const actor of trio) {
    const before = actor.position(LOOP - 2 * STEP, new Vector3())
    const landing = actor.position(LOOP - STEP, new Vector3())
    assert.ok((before.y - landing.y) / STEP > 20, `${actor.name} does not slam into the downbeat`)
  }
})

const screen = new Vector3()
const wrap = (t) => ((t % LOOP) + LOOP) % LOOP
const screenTrack = (actor, from, to, aspect = 16 / 9) => {
  const samples = []
  for (let t = from; t <= to; t += STEP) {
    projectToFrame(actor.position(wrap(t), position), wrap(t), aspect, screen)
    const visible = actor.scale(wrap(t)) > 0.05 && Math.abs(screen.x) < aspect / 2 + 0.1 && Math.abs(screen.y) < 0.6
    samples.push({ t, x: screen.x, y: screen.y, visible })
  }
  return samples
}
// Frame heights per s²: the kicks, flips and splits this replaces peaked at 1,000–2,100.
const SMOOTH = 400
const peakAcceleration = (samples, skip = () => false) => {
  let peak = { value: 0, t: 0 }
  for (let i = 1; i < samples.length - 1; i++) {
    const [a, b, c] = [samples[i - 1], samples[i], samples[i + 1]]
    if (!a.visible || !b.visible || !c.visible || skip(b.t)) continue
    const value = Math.hypot(a.x - 2 * b.x + c.x, a.y - 2 * b.y + c.y) / STEP / STEP
    if (value > peak.value) peak = { value, t: b.t }
  }
  return peak
}
const spin = new Quaternion()
const spinNext = new Quaternion()
const peakSpinChange = (actor, from, to, skip = () => false) => {
  let peak = { value: 0, t: 0 }
  let previous = null
  const samples = screenTrack(actor, from, to + STEP)
  samples.forEach(({ t, visible }, i) => {
    spin.setFromEuler(actor.rotation(wrap(t), angles))
    spinNext.setFromEuler(actor.rotation(wrap(t + STEP), angles))
    const rate = spin.angleTo(spinNext) / STEP
    if (previous !== null && visible && samples[i + 1]?.visible && !skip(t)) {
      const value = Math.abs(rate - previous) / STEP
      if (value > peak.value) peak = { value, t }
    }
    previous = rate
  })
  return peak
}
const smoothSections = [
  { name: 'opening', from: -beat(0.5), to: beat(5.5), pattern: /^(sphere|knot|gem)$/, skip: (t) => Math.abs(t) < 2.5 * STEP },
  { name: 'stop and before / after', from: beat(15.5), to: beat(19.9), pattern: /^(sphere|knot|gem)(-twin)?$/ },
  { name: 'swarm', from: beat(20), to: beat(24), pattern: /^swarm-/ },
  { name: 'SMEAR landing and exit', from: beat(5.5), to: beat(12), pattern: /^letter-[SMEAR][0-4]$/ },
]

test('the reworked sections move without velocity jumps, apart from the slam on the drop', () => {
  for (const section of smoothSections) {
    for (const actor of actors.filter((candidate) => section.pattern.test(candidate.name))) {
      const peak = peakAcceleration(screenTrack(actor, section.from, section.to), section.skip)
      assert.ok(peak.value < SMOOTH, `${actor.name} jerks in the ${section.name} at ${peak.t.toFixed(3)} s (${peak.value.toFixed(0)})`)
      const turn = peakSpinChange(actor, section.from, section.to, section.skip)
      assert.ok(turn.value < 600, `${actor.name} snaps its spin in the ${section.name} at ${turn.t.toFixed(3)} s (${turn.value.toFixed(0)})`)
    }
  }
})

// 430 px at 1080p, in frame heights, so the clearance scales with the frame.
const CURTAIN_GAP = 430 / 1080

test('the curtain stays 430 px behind the SMEAR letters and ahead of the rising B', () => {
  const letters = actors.filter((actor) => /^letter-[SMEAR][0-4]$/.test(actor.name))
  const riser = actors.find((actor) => actor.name === 'blur-B')
  const corner = new Vector3()
  for (const aspect of ASPECTS) {
    const state = createBackdropState()
    let previous = null
    let previousSpeed = 0
    for (let t = beat(10); t < beat(12.1); t += STEP) {
      backdropAt(t, aspect, state)
      if (!state.active || state.wipe.to !== 'dark') continue
      const { point, normal, softness } = state.wipe
      if (previous !== null) {
        const speed = (previous - point[0]) / STEP
        assert.ok(speed >= previousSpeed - 1e-9, `curtain stalls at ${t.toFixed(3)} s (aspect ${aspect.toFixed(2)})`)
        previousSpeed = speed
      }
      previous = point[0]
      for (const letter of [...letters, riser]) {
        const scale = letter.scale(t)
        if (scale < 0.05) continue
        const [, left, right] = GLYPHS[letter.char]
        const half = ((right - left) / 2000) * LETTER_EM * scale
        letter.position(t, center)
        for (const [dx, dy] of [[half, LETTER_EM / 2 * scale], [half, -LETTER_EM / 2 * scale], [-half, LETTER_EM / 2 * scale], [-half, -LETTER_EM / 2 * scale]]) {
          projectToFrame(corner.set(center.x + dx, center.y + dy, center.z), t, aspect, frame)
          if (Math.abs(frame.x) > aspect / 2 || Math.abs(frame.y) > 0.5) continue
          const side = (frame.x - point[0]) * normal[0] + (frame.y - point[1]) * normal[1]
          if (letter === riser) assert.ok(side > softness, `the B rises on paper at ${t.toFixed(3)} s (aspect ${aspect.toFixed(2)})`)
          else assert.ok(side < -softness - CURTAIN_GAP, `${letter.name} within 430 px of the curtain at ${t.toFixed(3)} s (aspect ${aspect.toFixed(2)})`)
        }
      }
    }
  }
})

test('the before / after twins mirror the trio, raw beside treated', () => {
  const original = new Vector3()
  const twin = new Vector3()
  for (const actor of trio) {
    const copy = actors.find((candidate) => candidate.name === `${actor.name}-twin`)
    let axis = null
    for (let t = 0; t < LOOP; t += STEP) {
      const scale = copy.scale(t)
      if (abSplit(t) === 0) {
        assert.ok(scale === 0 || abSplit(t + 0.05) > 0, `${copy.name} visible outside the split at ${t.toFixed(3)} s`)
        continue
      }
      actor.position(t, original)
      copy.position(t, twin)
      axis ??= (original.x + twin.x) / 2
      assert.ok(Math.abs((original.x + twin.x) / 2 - axis) < 1e-6, `${copy.name} leaves the mirror at ${t.toFixed(3)} s`)
      assert.ok(Math.abs(original.y - twin.y) < 1e-6 && Math.abs(original.z - twin.z) < 1e-6, `${copy.name} drifts at ${t.toFixed(3)} s`)
      assert.ok(Math.abs(scale - actor.scale(t)) < 1e-6, `${copy.name} rescales at ${t.toFixed(3)} s`)
      assert.ok(copy.smear(t) === 0 && actor.smear(t) > 0, `wrong treatment at ${t.toFixed(3)} s`)
    }
    assert.ok(axis !== null, `${copy.name} never splits`)
  }
})

test('the spring passes in front and behind SMEAR with clearance on the strongest beats', () => {
  const sphere = actors.find((actor) => actor.name === 'sphere')
  const letters = actors.filter((actor) => /^letter-[SMEAR][0-4]$/.test(actor.name))
  const point = new Vector3()
  let inFront = false
  let behind = false
  setBeatStrengths(new Array(32).fill(1.2))
  try {
    for (let t = beat(6.5); t < beat(9.5); t += STEP) {
      sphere.position(t, point)
      if (Math.abs(point.x) > 7) continue
      inFront ||= point.z > 2.5
      behind ||= point.z < -2.5
      const radius = 1.15 * sphere.scale(t)
      for (const letter of letters) {
        assert.ok(clearance(point, radius, letter, t) > 0.4, `sphere too close to ${letter.name} at ${t.toFixed(3)} s`)
      }
    }
    assert.ok(inFront && behind, 'the spring must wrap around the depth of the word')
  } finally {
    setBeatStrengths()
  }
})

test('the orbit passes above and below BLUR without touching it on the strongest beats', () => {
  const orbiters = actors.filter((actor) => actor.name === 'sphere' || actor.name === 'gem')
  const letters = actors.filter((actor) => /^blur-/.test(actor.name))
  const point = new Vector3()
  let above = false
  let below = false
  setBeatStrengths(new Array(32).fill(1.2))
  try {
    // Starts once the R has landed: a rising letter sweeps through the orbit by design.
    for (let t = beat(13.5) + 0.12; t < beat(16.25); t += STEP) {
      for (const orbiter of orbiters) {
        orbiter.position(t, point)
        if (Math.abs(point.x) < 3) {
          above ||= point.y > 2
          below ||= point.y < -1.3
        }
        const radius = (orbiter.name === 'sphere' ? 1.15 : 1.2) * orbiter.scale(t)
        for (const letter of letters) {
          assert.ok(clearance(point, radius, letter, t) > 0.1, `${orbiter.name} too close to ${letter.name} at ${t.toFixed(3)} s`)
        }
      }
    }
    assert.ok(above && below, 'the orbit must frame the word from above and below')
  } finally {
    setBeatStrengths()
  }
})
