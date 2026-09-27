import assert from 'node:assert/strict'
import test from 'node:test'
import { actors } from './reel.js'
import { analyseBeatStrengths, pulseAt, setBeatStrengths } from './rhythm.js'
import { BEAT, LOOP } from './timeline.js'

test('the pulse repeats on every beat with continuous joins, including the loop', () => {
  setBeatStrengths()
  for (let i = 0; i <= 32; i++) {
    const t = i * BEAT
    assert.ok(pulseAt(t + 0.03) > 0.95, `no attack at beat ${i}`)
    assert.ok(pulseAt(t + 0.42) < 0.01, `no release at beat ${i}`)
    assert.ok(Math.abs(pulseAt(t - 1e-6) - pulseAt(t + 1e-6)) < 1e-6)
    assert.ok(Math.abs(pulseAt(t + 0.1) - pulseAt(t + LOOP + 0.1)) < 1e-9)
  }
})

test('bass accents are measured at the soundtrack offset and silence stays rhythmic', () => {
  const sampleRate = 4000
  const start = 0.3
  const data = new Float32Array(Math.ceil((start + LOOP) * sampleRate))
  for (let i = Math.ceil(start * sampleRate); i < data.length; i++) {
    const t = i / sampleRate - start
    const beat = Math.floor(t / BEAT)
    const age = t - beat * BEAT
    data[i] = age < 0.14 ? (beat % 2 ? 0.2 : 0.8) * Math.sin(2 * Math.PI * 80 * age) * (1 - age / 0.14) : 0
  }
  const buffer = { sampleRate, length: data.length, numberOfChannels: 1, getChannelData: () => data }
  const strengths = analyseBeatStrengths(buffer, start)
  for (let i = 0; i < 32; i += 2) assert.ok(strengths[i] > strengths[i + 1] + 0.15)
  data.fill(0)
  assert.ok(analyseBeatStrengths(buffer, start).every((value) => value === 1))
})

test('every visible actor responds to music strength without reviving hidden actors', () => {
  try {
    for (const actor of actors) {
      let reacted = false
      for (let i = 0; i < 32; i++) {
        const t = i * BEAT + 0.03
        setBeatStrengths(new Array(32).fill(0.75))
        const soft = actor.scale(t)
        setBeatStrengths(new Array(32).fill(1.2))
        const loud = actor.scale(t)
        if (soft === 0) assert.equal(loud, 0)
        else if (soft > 0.001) {
          assert.ok(loud > soft, `${actor.name} does not pulse`)
          reacted = true
        }
      }
      assert.ok(reacted, `${actor.name} was never verified`)
    }
  } finally {
    setBeatStrengths()
  }
})
