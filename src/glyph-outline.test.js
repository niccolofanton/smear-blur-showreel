import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ExtrudeGeometry, Vector3 } from 'three'
import { FontLoader } from 'three/addons/loaders/FontLoader.js'
import { glyphShapes } from './glyph-outline.js'

const font = new FontLoader().parse(JSON.parse(readFileSync(new URL('../public/fonts/big-shoulders-black.typeface.json', import.meta.url), 'utf8')))
const EXTRUDE = { depth: 0.38, curveSegments: 6, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.012, bevelSegments: 2 }
const area = (points) => points.reduce((sum, p, i) => {
  const q = points[(i + 1) % points.length]
  return sum + p.x * q.y - q.x * p.y
}, 0) / 2

test('glyph outlines keep their shape and every extruded face gets a normal', () => {
  const normal = new Vector3()
  for (const char of 'SMEAR+BLU') {
    const cleaned = glyphShapes(font, char, 2.8, EXTRUDE.curveSegments)
    font.generateShapes(char, 2.8).forEach((shape, i) => {
      const before = shape.extractPoints(EXTRUDE.curveSegments)
      const after = cleaned[i].extractPoints(EXTRUDE.curveSegments)
      ;[before.shape, ...before.holes].forEach((contour, k) => {
        const kept = k ? after.holes[k - 1] : after.shape
        assert.ok(Math.abs(area(kept) - area(contour)) < 1e-6, `${char} contour ${k} changes shape`)
      })
    })
    const normals = new ExtrudeGeometry(cleaned, EXTRUDE).attributes.normal
    for (let i = 0; i < normals.count; i++) {
      normal.fromBufferAttribute(normals, i)
      assert.ok(Number.isFinite(normal.x) && normal.length() > 0.5, `${char} has a broken wall normal`)
    }
  }
})
