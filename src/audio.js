import { analyseBeatStrengths } from './rhythm.js'

// The section loops sample-accurately in the audio engine; the reel reads that same clock.
export function createSoundtrack({ url, start, length, muted = false }) {
  const context = new AudioContext()
  const gain = context.createGain()
  gain.gain.value = muted ? 0 : 1
  gain.connect(context.destination)
  let buffer = null
  let beatStrengths = null
  let source = null
  let origin = 0
  let offset = null

  const ready = !url ? Promise.resolve() : fetch(encodeURI(url))
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.arrayBuffer()
    })
    .then((data) => context.decodeAudioData(data))
    .then((decoded) => {
      buffer = decoded
      beatStrengths = analyseBeatStrengths(decoded, start)
    })
    .catch((error) => console.warn('Soundtrack unavailable, the reel plays silent:', error.message))

  const stop = () => {
    source?.stop()
    source?.disconnect()
    source = null
  }

  return {
    ready,
    get available() { return buffer !== null },
    get beatStrengths() { return beatStrengths },
    get state() { return context.state },
    async play(t) {
      const resumed = await Promise.race([context.resume().then(() => true), new Promise((resolve) => setTimeout(resolve, 500, false))])
      if (!resumed || context.state !== 'running') return false
      stop()
      source = context.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.loopStart = start
      source.loopEnd = start + length
      source.connect(gain)
      const when = context.currentTime + 0.05
      source.start(when, start + t)
      origin = when - t
      offset = null
      return true
    },
    pause: () => context.suspend(),
    stop,
    time(rafMs) {
      const { contextTime, performanceTime } = context.getOutputTimestamp()
      const heard = performanceTime > 0 ? contextTime + (rafMs - performanceTime) / 1000 : context.currentTime
      const target = heard - rafMs / 1000
      offset = offset === null ? target : offset + (target - offset) * 0.05
      return rafMs / 1000 + offset - origin
    },
  }
}
