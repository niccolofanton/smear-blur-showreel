import * as THREE from 'three/webgpu'
import { Fn, If, Loop, abs, clamp, dot, float, fract, int, ivec2, length, max, min, mix, perspectiveDepthToViewZ, rtt, screenCoordinate, smoothstep, step, uniform, uv, vec2, vec4 } from 'three/tsl'

// McGuire 2012 reconstruction. TileMax is split in two passes: K×K loops stall the GPU.
const SAMPLE_COUNT = 33
const SOFT_DEPTH = 0.5
const MIN_TILE_SIZE = 8

const range = (start, end) => ({ start: int(start), end, type: 'int', condition: '<' })
const cone = (distance, radius) => clamp(float(1).sub(distance.div(radius)), 0, 1)
const cylinder = (distance, radius) => float(1).sub(smoothstep(radius.mul(0.95), radius.mul(1.05), distance))
const softDepthCompare = (za, zb) => clamp(float(1).sub(za.sub(zb).div(SOFT_DEPTH)), 0, 1)
const keepLongest = (longest, candidate) => If(dot(candidate, candidate).greaterThan(dot(longest, longest)), () => {
  longest.assign(candidate)
})

export function createDirectionalMotionBlur({ color, velocity, depth, near, far, strength, resolution, maxBlurPixels, onsetPixels, frameScale }) {
  const tileSize = uniform(MIN_TILE_SIZE, 'int')
  const tileCount = uniform(new THREE.Vector2(1, 1))
  const toPixel = (point) => ivec2(clamp(point, vec2(0), resolution.sub(1)))

  const blurRadius = (pixel, pixelDepth) => {
    // Keep the reference's 2x NDC span; the background writes no depth, so zero it.
    const foreground = step(float(0.99999), pixelDepth).oneMinus()
    const motion = velocity.load(pixel).xy.mul(vec2(1, -1)).mul(resolution).mul(foreground)
    const onset = smoothstep(float(0), max(onsetPixels, float(0.0001)), length(motion).mul(frameScale))
    const streak = motion.mul(strength).mul(onset)
    const streakLength = length(streak)
    return streak.mul(min(streakLength, maxBlurPixels).div(max(streakLength, float(0.0001))).mul(0.5))
  }

  const rowMax = rtt(Fn(() => {
    const coord = screenCoordinate.xy.floor()
    const longest = vec2(0).toVar()
    Loop(range(0, tileSize), ({ i }) => {
      const pixel = toPixel(vec2(coord.x.mul(float(tileSize)).add(float(i)), coord.y))
      keepLongest(longest, blurRadius(pixel, depth.load(pixel).r))
    })
    return vec4(longest, 0, 1)
  })(), 1, 1)

  const tileMax = rtt(Fn(() => {
    const coord = screenCoordinate.xy.floor()
    const longest = vec2(0).toVar()
    Loop(range(0, tileSize), ({ i }) => {
      keepLongest(longest, rowMax.load(toPixel(vec2(coord.x, coord.y.mul(float(tileSize)).add(float(i))))).xy)
    })
    return vec4(longest, 0, 1)
  })(), 1, 1)

  const neighborMax = rtt(Fn(() => {
    const tile = screenCoordinate.xy.floor()
    const longest = vec2(0).toVar()
    Loop(range(-1, int(2)), range(-1, int(2)), ({ i, j }) => {
      const neighbor = ivec2(clamp(tile.add(vec2(float(i), float(j))), vec2(0), tileCount.sub(1)))
      keepLongest(longest, tileMax.load(neighbor).xy)
    })
    return vec4(longest, 0, 1)
  })(), 1, 1)

  const node = Fn(() => {
    const coords = uv()
    const center = coords.mul(resolution)
    const centerPixel = toPixel(center)
    const dominant = neighborMax.load(ivec2(center.div(float(tileSize)))).xy.toVar()
    const dominantLength = length(dominant).toVar()
    const result = color.sample(coords).toVar()

    If(dominantLength.greaterThan(0.5), () => {
      const centerDepth = depth.load(centerPixel).r.toVar()
      const centerZ = perspectiveDepthToViewZ(centerDepth, near, far).toVar()
      const centerRadius = max(length(blurRadius(centerPixel, centerDepth)), 0.5).toVar()
      const weight = float(1).div(centerRadius).toVar()
      const sum = result.mul(weight).toVar()
      const jitter = fract(float(52.9829189).mul(fract(dot(center, vec2(0.06711056, 0.00583715))))).sub(0.5)
      Loop(range(0, int(SAMPLE_COUNT)), ({ i }) => {
        If(i.notEqual(int((SAMPLE_COUNT - 1) / 2)), () => {
          const t = mix(float(-1), float(1), float(i).add(jitter).add(1).div(SAMPLE_COUNT + 1))
          const point = center.add(dominant.mul(t))
          const pixel = toPixel(point)
          const pixelDepth = depth.load(pixel).r.toVar()
          const z = perspectiveDepthToViewZ(pixelDepth, near, far)
          const radius = max(length(blurRadius(pixel, pixelDepth)), 0.5).toVar()
          const distance = abs(t).mul(dominantLength)
          const sampleWeight = softDepthCompare(centerZ, z).mul(cone(distance, radius))
            .add(softDepthCompare(z, centerZ).mul(cone(distance, centerRadius)))
            .add(cylinder(distance, radius).mul(cylinder(distance, centerRadius)).mul(2))
          weight.addAssign(sampleWeight)
          sum.addAssign(color.sample(point.div(resolution).clamp(0, 1)).mul(sampleWeight))
        })
      })
      result.assign(sum.div(weight))
    })

    return result
  })()

  const updateTiles = () => {
    const size = Math.max(MIN_TILE_SIZE, Math.ceil(maxBlurPixels.value / 2))
    const width = Math.ceil(resolution.value.x / size)
    const height = Math.ceil(resolution.value.y / size)
    if (size === tileSize.value && width === tileCount.value.x && height === tileCount.value.y) return
    tileSize.value = size
    tileCount.value.set(width, height)
    rowMax.setSize(width, resolution.value.y)
    tileMax.setSize(width, height)
    neighborMax.setSize(width, height)
  }

  return { node, updateTiles }
}
