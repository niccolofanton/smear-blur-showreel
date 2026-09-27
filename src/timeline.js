// The whole reel sits on a 128 BPM grid: 8 bars of 4/4 last exactly 15 seconds.
const BPM = 128
export const BEAT = 60 / BPM
const BAR = BEAT * 4
export const LOOP = BAR * 8

export const beat = (n) => n * BEAT
export const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))
export const lerp = (a, b, t) => a + (b - a) * t
export const progress = (t, start, end) => clamp((t - start) / (end - start))
export const wrap = (t) => ((t % LOOP) + LOOP) % LOOP
export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export const inCubic = (x) => x * x * x
export const outCubic = (x) => 1 - (1 - x) ** 3
export const inOutCubic = (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2)
export const inQuart = (x) => x ** 4
export const outQuart = (x) => 1 - (1 - x) ** 4
export const inOutQuint = (x) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2)
export const inOutSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2
export const outExpo = (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x))
export const outBack = (x, overshoot = 1.70158) => 1 + (overshoot + 1) * (x - 1) ** 3 + overshoot * (x - 1) ** 2

const linear = (x) => x

export function track(keys) {
  const last = keys.length - 1
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1]
    if (t >= keys[last][0]) return keys[last][1]
    let i = 0
    while (t > keys[i + 1][0]) i++
    const [start, from] = keys[i]
    const [end, to, ease = linear] = keys[i + 1]
    return from + (to - from) * ease((t - start) / (end - start))
  }
}

export const wobble = (time, frequency = 4, decay = 7) => (time <= 0 ? 0 : Math.exp(-decay * time) * Math.sin(2 * Math.PI * frequency * time))
