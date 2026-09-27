import { Path, Shape } from 'three'

// The font draws stems as flat curves; their collinear samples flip the extrusion bevel.
const cleanOutline = (points) => {
  const unique = points.filter((point, i) => point.distanceTo(points[(i + 1) % points.length]) > 1e-6)
  return unique.filter((point, i) => {
    const before = unique[(i + unique.length - 1) % unique.length]
    const after = unique[(i + 1) % unique.length]
    const ax = point.x - before.x
    const ay = point.y - before.y
    const bx = after.x - point.x
    const by = after.y - point.y
    return Math.abs(ax * by - ay * bx) > 1e-4 * Math.hypot(ax, ay) * Math.hypot(bx, by) || ax * bx + ay * by < 0
  })
}

export const glyphShapes = (font, char, size, curveSegments) => font.generateShapes(char, size).map((shape) => {
  const { shape: outline, holes } = shape.extractPoints(curveSegments)
  const cleaned = new Shape(cleanOutline(outline))
  cleaned.holes = holes.map((hole) => new Path(cleanOutline(hole)))
  return cleaned
})
