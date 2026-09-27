import { Vector3 } from 'three'
import { CAPTIONS, END_CARD, abReveal, abSplit, projectToFrame } from './reel.js'
import { LOOP, inCubic, outExpo, progress } from './timeline.js'
import { pulseAt } from './rhythm.js'

const anchor = new Vector3()
const HIDDEN = 'polygon(0 0, 0 0, 0 0)'
const TOTAL = String(CAPTIONS.length).padStart(2, '0')
// Masks pad below the glyphs, so a line parked at 110% still shows its cap tops.
const HIDDEN_OFFSET = 130

const parts = (root) => {
  const endcard = root.querySelector('[data-endcard]')
  return {
    timecode: root.querySelector('[data-timecode]'),
    readout: root.querySelector('[data-readout]'),
    track: root.querySelector('[data-track]'),
    beat: root.querySelector('[data-beat]'),
    captionLines: [...root.querySelector('[data-caption]').querySelectorAll('[data-line]')],
    split: root.querySelector('[data-split]'),
    endcard,
    endLines: [...endcard.querySelectorAll('[data-line]')],
  }
}

// Ink vanishes on the dark backdrop, so a lime copy clipped to that region is all the HUD needs.
function darkRegion({ active, base, wipe }, aspect) {
  if (!active) return base === 'dark' ? 'none' : HIDDEN
  if (wipe.mode !== 0 || (wipe.from !== 'dark' && wipe.to !== 'dark')) return HIDDEN
  const side = wipe.to === 'dark' ? 1 : -1
  const distance = ([x, y]) => side * (((x / innerWidth - 0.5) * aspect - wipe.point[0]) * wipe.normal[0] + (0.5 - y / innerHeight - wipe.point[1]) * wipe.normal[1])
  const corners = [[0, 0], [innerWidth, 0], [innerWidth, innerHeight], [0, innerHeight]]
  const points = []
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % 4]
    const da = distance(a)
    const db = distance(b)
    if (da > 0) points.push(a)
    if (da > 0 !== db > 0) points.push(a.map((value, k) => value + (b[k] - value) * da / (da - db)))
  })
  return points.length ? `polygon(${points.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(', ')})` : HIDDEN
}

export function createHud(root) {
  const lime = root.cloneNode(true)
  lime.classList.add('hud--lime')
  root.after(lime)
  const layers = [parts(root), parts(lime)]
  const written = new WeakMap()
  let caption = null
  let shownSeconds = ''
  let shownTrack = ''
  let shownReadout = ''

  // Style writes only on change, so the overlay stays cheap at 120 fps.
  const write = (element, property, value) => {
    let values = written.get(element)
    if (!values) written.set(element, (values = {}))
    if (values[property] === value) return
    values[property] = value
    element.style[property] = value
  }

  const reveal = (lines, t, from, to) => lines.forEach((line, i) => {
    const enter = outExpo(progress(t, from + i * 0.06, from + i * 0.06 + 0.55))
    const leave = inCubic(progress(t, to + i * 0.04, to + i * 0.04 + 0.26))
    write(line, 'transform', `translate3d(0, ${((1 - enter - leave) * HIDDEN_OFFSET).toFixed(1)}%, 0)`)
  })

  return {
    update(t, backdrop, aspect, track, { blur, smear }) {
      const seconds = t.toFixed(2).padStart(5, '0')
      const readout = `Blur ${String(Math.round(blur)).padStart(2, '0')} px · Smear ×${smear.toFixed(2)}`
      const song = track === null ? '' : `♪ ${Math.floor(track / 60)}:${(track % 60).toFixed(2).padStart(5, '0')} · Matroda — About To Lose It`
      const pulse = pulseAt(t)
      const active = CAPTIONS.find((entry) => t >= entry.from - 0.05 && t < entry.to + 0.6) ?? null
      const lines = active && active !== caption ? [`${active.index} / ${TOTAL}`, active.title, active.body] : null
      caption = active
      const splitX = abSplit(t)
      const splitClip = `inset(${((1 - abReveal(t)) * 50).toFixed(2)}% -100vw)`
      projectToFrame(END_CARD.anchor, t, aspect, anchor)
      const endcardAt = `translate3d(${((anchor.x / aspect + 0.5) * innerWidth).toFixed(1)}px, ${((0.5 - anchor.y) * innerHeight).toFixed(1)}px, 0)`

      write(lime, 'clipPath', darkRegion(backdrop, aspect))
      for (const layer of layers) {
        if (seconds !== shownSeconds) layer.timecode.textContent = `${seconds} / ${LOOP.toFixed(2)}`
        if (song !== shownTrack) layer.track.textContent = song
        if (readout !== shownReadout) layer.readout.textContent = readout
        write(layer.beat, 'transform', `scale(${(1 + 0.7 * pulse).toFixed(3)})`)
        write(layer.beat, 'opacity', (0.4 + 0.5 * pulse).toFixed(3))
        lines?.forEach((text, i) => { layer.captionLines[i].textContent = text })
        if (active) reveal(layer.captionLines, t, active.from, active.to)
        else layer.captionLines.forEach((line) => write(line, 'transform', `translate3d(0, ${HIDDEN_OFFSET}%, 0)`))
        write(layer.split, 'opacity', splitX > 0 ? '0.9' : '0')
        write(layer.split, 'clipPath', splitClip)
        write(layer.split, 'transform', `translate3d(${(splitX * innerWidth).toFixed(1)}px, 0, 0)`)
        write(layer.endcard, 'transform', endcardAt)
        reveal(layer.endLines, t, END_CARD.from, END_CARD.to)
      }
      shownSeconds = seconds
      shownTrack = song
      shownReadout = readout
    },
  }
}
