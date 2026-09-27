import { BEAT, LOOP, clamp, smoothstep, wrap } from './timeline.js'

const COUNT = Math.round(LOOP / BEAT)
let strengths = new Float32Array(COUNT).fill(1)

export function setBeatStrengths(values) {
  strengths = Float32Array.from({ length: COUNT }, (_, i) => clamp(values?.[i] ?? 1, 0.75, 1.2))
}

export function pulseAt(time) {
  const beat = wrap(time) / BEAT
  const phase = beat - Math.floor(beat)
  // A short attack and a smooth release keep scale velocity continuous at every beat.
  const envelope = phase < 0.065
    ? smoothstep(0, 0.065, phase)
    : 1 - smoothstep(0.065, 0.86, phase)
  return envelope * strengths[Math.min(COUNT - 1, Math.floor(beat))]
}

export function analyseBeatStrengths(buffer, start) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  const rate = buffer.sampleRate
  const first = Math.round(start * rate)
  const end = Math.min(buffer.length, first + Math.round(LOOP * rate))
  const energy = new Float64Array(COUNT)
  const samples = new Uint32Array(COUNT)
  const alpha = 1 - Math.exp(-2 * Math.PI * 180 / rate)
  let bass = 0
  for (let i = Math.max(0, first - Math.ceil(rate * 0.05)); i < end; i++) {
    let sample = 0
    for (const channel of channels) sample += channel[i] / channels.length
    bass += alpha * (sample - bass)
    if (i < first) continue
    const beat = (i - first) / rate / BEAT
    const index = Math.floor(beat)
    if (index >= COUNT || (beat - index) * BEAT > 0.18) continue
    energy[index] += bass * bass
    samples[index]++
  }
  const rms = energy.map((sum, i) => Math.sqrt(sum / Math.max(1, samples[i])))
  const reference = [...rms].sort((a, b) => a - b)[Math.floor(COUNT * 0.9)] || Math.max(...rms)
  if (reference < 1e-5) return new Float32Array(COUNT).fill(1)
  return rms.map((value) => 0.75 + 0.45 * clamp(value / reference))
}
