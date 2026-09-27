import { Quaternion, Vector3 } from 'three'
import { LOOP, clamp } from './timeline.js'

const FRACTIONS = [1 / 3, 2 / 3, 1]

export function fitTrailBezier(near, middle, far, first, second) {
  first.set(
    3 * near.x - 1.5 * middle.x + far.x / 3,
    3 * near.y - 1.5 * middle.y + far.y / 3,
    3 * near.z - 1.5 * middle.z + far.z / 3,
  )
  second.set(
    -1.5 * near.x + 3 * middle.x - 5 * far.x / 6,
    -1.5 * near.y + 3 * middle.y - 5 * far.y / 6,
    -1.5 * near.z + 3 * middle.z - 5 * far.z / 6,
  )
}

export const smearTailActivation = (distance, radius) => (radius <= 0 ? 0 : clamp(distance / (radius * 1.5)))

export function sampleTime(t, back, cuts) {
  const start = t - back
  let latest = null
  let latestAge = Infinity
  for (const cut of cuts) {
    const age = (t - cut + LOOP) % LOOP
    if (age <= back && age < latestAge) {
      latest = cut
      latestAge = age
    }
  }
  return ((latest ?? start) % LOOP + LOOP) % LOOP
}

const now = new Vector3()
const offsets = [new Vector3(), new Vector3(), new Vector3()]
const first = new Vector3()
const second = new Vector3()
const end = new Vector3()
const direction = new Vector3()
const cameraPosition = new Vector3()
const cameraRotation = new Quaternion()
const toLocal = new Quaternion()

function viewPosition(actor, camera, time, out) {
  actor.position(time, out)
  camera(time, cameraPosition, cameraRotation)
  return out.sub(cameraPosition).applyQuaternion(cameraRotation.invert())
}

// Trails follow past positions as the camera saw them: a whip smears, a tracked subject not.
export function updateSmear(smear, mesh, actor, t, settings, camera) {
  smear.previousDirection.value.copy(smear.direction.value)
  smear.previousControl1.value.copy(smear.control1.value)
  smear.previousControl2.value.copy(smear.control2.value)
  smear.previousEnd.value.copy(smear.end.value)
  smear.previousTaper.value = smear.taper.value
  smear.previousTaperCurve.value = smear.taperCurve.value

  const scale = Math.cbrt(mesh.scale.x * mesh.scale.y * mesh.scale.z)
  const strength = settings.strength
  if (scale < 1e-3 || strength <= 0) {
    smear.control1.value.set(0, 0, 0)
    smear.control2.value.set(0, 0, 0)
    smear.end.value.set(0, 0, 0)
    smear.taper.value = 0
    return
  }

  viewPosition(actor, camera, t, now)
  FRACTIONS.forEach((fraction, i) => {
    viewPosition(actor, camera, sampleTime(t, settings.exposure * fraction, actor.cuts), offsets[i]).sub(now)
  })
  fitTrailBezier(offsets[0], offsets[1], offsets[2], first, second)
  end.copy(offsets[2])

  camera(t, cameraPosition, cameraRotation)
  first.applyQuaternion(cameraRotation)
  second.applyQuaternion(cameraRotation)
  end.applyQuaternion(cameraRotation)

  const radius = actor.radius * scale
  const limit = settings.maxStretch * radius
  const length = end.length()
  const gain = strength * (length > 1e-6 ? limit * Math.tanh(length / limit) / length : 1)
  first.multiplyScalar(gain)
  second.multiplyScalar(gain)
  end.multiplyScalar(gain)

  // The chord to the tail picks the trailing side, so it cannot flip while the tail is long.
  if (end.lengthSq() > 1e-10) direction.copy(end).negate().normalize()
  else if (offsets[0].lengthSq() > 1e-12) direction.copy(offsets[0]).applyQuaternion(cameraRotation).negate().normalize()
  else direction.set(0, 0, 0)

  toLocal.copy(mesh.quaternion).invert()
  if (direction.lengthSq() > 0) smear.direction.value.copy(direction).applyQuaternion(toLocal)
  smear.control1.value.copy(first).applyQuaternion(toLocal).divide(mesh.scale)
  smear.control2.value.copy(second).applyQuaternion(toLocal).divide(mesh.scale)
  smear.end.value.copy(end).applyQuaternion(toLocal).divide(mesh.scale)
  smear.taper.value = settings.taper * smearTailActivation(end.length(), radius)
  smear.taperCurve.value = settings.taperCurve
}
