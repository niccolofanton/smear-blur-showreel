import * as THREE from 'three/webgpu'
import { Fn, If, abs, dot, float, fwidth, length, max, mix, screenUV, smoothstep, uniform, vec2 } from 'three/tsl'
import { BACKDROPS } from './reel.js'

const RING_WIDTH = 0.0035

export function createBackdrop() {
  const from = uniform(new THREE.Color())
  const to = uniform(new THREE.Color())
  const mode = uniform(0)
  const point = uniform(new THREE.Vector2())
  const normal = uniform(new THREE.Vector2(1, 0))
  const radius = uniform(0)
  const softness = uniform(0)
  const aspect = uniform(1)
  const ringColor = uniform(new THREE.Color())
  const rings = [0, 1, 2].map(() => uniform(new THREE.Vector4()))
  const pulse = uniform(0)

  const node = Fn(() => {
    const p = vec2(screenUV.x.sub(0.5).mul(aspect), float(0.5).sub(screenUV.y)).toVar()
    const distance = mix(dot(p.sub(point), normal), radius.sub(length(p.sub(point))), mode)
    const edge = max(max(softness, fwidth(distance)), 1e-5)
    const color = mix(from, to, smoothstep(edge.negate(), edge, distance)).toVar()
    for (const ring of rings) {
      If(ring.w.greaterThan(0), () => {
        const band = abs(length(p.sub(ring.xy)).sub(ring.z)).sub(RING_WIDTH)
        color.assign(mix(color, ringColor, float(1).sub(smoothstep(float(0), fwidth(band), band)).mul(ring.w)))
      })
    }
    return color.mul(float(0.98).add(pulse.mul(0.02)))
  })()

  const update = (state, frameAspect, ringHex, beatPulse = 0) => {
    const { wipe } = state
    aspect.value = frameAspect
    pulse.value = beatPulse
    from.value.copy(BACKDROPS[state.active ? wipe.from : state.base].color)
    to.value.copy(BACKDROPS[state.active ? wipe.to : state.base].color)
    mode.value = wipe.mode
    point.value.fromArray(wipe.point)
    normal.value.fromArray(wipe.normal)
    radius.value = wipe.radius
    softness.value = state.active ? wipe.softness : 0
    ringColor.value.set(ringHex)
    state.rings.forEach((ring, i) => rings[i].value.set(ring.x, ring.y, ring.radius, ring.alpha))
  }

  return { node, update }
}
