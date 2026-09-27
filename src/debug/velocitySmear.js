import * as THREE from 'three/webgpu'
import { Fn, float, positionGeometry, positionPrevious, smoothstep, uniform } from 'three/tsl'

// Keep the leading side of the mesh sharp and pull the trailing vertices back.
// The previous pose is also deformed, so the MRT velocity pass measures the
// visible silhouette rather than comparing it with an undeformed mesh.
export function createVelocitySmear() {
  const direction = uniform(new THREE.Vector3(1, 0, 0))
  const previousDirection = uniform(new THREE.Vector3(1, 0, 0))
  const control1 = uniform(new THREE.Vector3())
  const control2 = uniform(new THREE.Vector3())
  const end = uniform(new THREE.Vector3())
  const previousControl1 = uniform(new THREE.Vector3())
  const previousControl2 = uniform(new THREE.Vector3())
  const previousEnd = uniform(new THREE.Vector3())
  const taper = uniform(0.86)
  const previousTaper = uniform(0.86)
  const taperCurve = uniform(1.5)
  const previousTaperCurve = uniform(1.5)

  const deform = (point, travelDirection, first, second, last, taperAmount, shrinkCurve) => {
    const t = smoothstep(-0.4, 0.7, point.dot(travelDirection).mul(-1)).pow(1.3)
    const inverse = float(1).sub(t)
    const curvedOffset = first.mul(inverse.pow(2).mul(t).mul(3))
      .add(second.mul(inverse.mul(t.pow(2)).mul(3)))
      .add(last.mul(t.pow(3)))
    // Preserve the leading silhouette and narrow the actual extended trail.
    // taperAmount already includes the measured tip-distance activation.
    const scale = float(1).sub(taperAmount.mul(t.pow(shrinkCurve)))
    return point.mul(scale).add(curvedOffset)
  }

  const positionNode = Fn(() => {
    const point = positionGeometry.toVar()
    positionPrevious.assign(deform(point, previousDirection, previousControl1, previousControl2, previousEnd, previousTaper, previousTaperCurve))
    return deform(point, direction, control1, control2, end, taper, taperCurve)
  })()

  return {
    positionNode, direction, previousDirection,
    control1, control2, end, previousControl1, previousControl2, previousEnd,
    taper, previousTaper, taperCurve, previousTaperCurve,
  }
}
