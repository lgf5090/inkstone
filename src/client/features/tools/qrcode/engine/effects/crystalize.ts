import Delaunator from 'delaunator'

type FlatPoint = [number, number]

function createPseudoRandom(seed: number) {
  let s = Math.sin(seed || 1) * 10000
  return () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
}

function isPointInTriangle(x: number, y: number, p1: FlatPoint, p2: FlatPoint, p3: FlatPoint): boolean {
  const denominator = (p2[1] - p3[1]) * (p1[0] - p3[0]) + (p3[0] - p2[0]) * (p1[1] - p3[1])
  if (Math.abs(denominator) < 1e-7) return false
  const a = ((p2[1] - p3[1]) * (x - p3[0]) + (p3[0] - p2[0]) * (y - p3[1])) / denominator
  const b = ((p3[1] - p1[1]) * (x - p3[0]) + (p1[0] - p3[0]) * (y - p3[1])) / denominator
  const c = 1 - a - b
  return a >= 0 && a <= 1 && b >= 0 && b <= 1 && c >= 0 && c <= 1
}

export function crystalize(imageData: ImageData, radius: number, seed: number = 42): ImageData {
  const { width, height, data } = imageData
  const outputData = new Uint8ClampedArray(data.length)
  const rng = createPseudoRandom(seed)

  const triangleHeight = (radius * Math.sqrt(3)) / 2
  const xCount = Math.ceil(width / radius + 1)
  const yCount = Math.ceil(height / triangleHeight + 1)
  const distortion = 1.2

  const points: FlatPoint[] = []
  for (let xi = 0; xi < xCount; xi++) {
    for (let yi = 0; yi < yCount; yi++) {
      let x = xi * radius + (yi % 2 ? radius / 2 : 0)
      let y = yi * triangleHeight
      x += (rng() - 0.5) * radius * distortion
      y += (rng() - 0.5) * triangleHeight * distortion
      points.push([x, y])
    }
  }

  const coords: number[] = []
  for (const p of points) {
    coords.push(p[0], p[1])
  }
  const delaunay = new Delaunator(coords)

  for (let idx = 0; idx < delaunay.triangles.length; idx += 3) {
    const p1 = points[delaunay.triangles[idx]]
    const p2 = points[delaunay.triangles[idx + 1]]
    const p3 = points[delaunay.triangles[idx + 2]]

    if (!p1 || !p2 || !p3) continue

    const minX = Math.max(0, Math.floor(Math.min(p1[0], p2[0], p3[0])))
    const minY = Math.max(0, Math.floor(Math.min(p1[1], p2[1], p3[1])))
    const maxX = Math.min(width - 1, Math.ceil(Math.max(p1[0], p2[0], p3[0])))
    const maxY = Math.min(height - 1, Math.ceil(Math.max(p1[1], p2[1], p3[1])))

    let rSum = 0
    let gSum = 0
    let bSum = 0
    let aSum = 0
    let count = 0

    const trianglePixelIndices: number[] = []

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (isPointInTriangle(x, y, p1, p2, p3)) {
          const pixelIndex = (y * width + x) * 4
          trianglePixelIndices.push(pixelIndex)
          rSum += data[pixelIndex]
          gSum += data[pixelIndex + 1]
          bSum += data[pixelIndex + 2]
          aSum += data[pixelIndex + 3]
          count++
        }
      }
    }

    if (count === 0) continue

    const avgR = Math.round(rSum / count)
    const avgG = Math.round(gSum / count)
    const avgB = Math.round(bSum / count)
    const avgA = Math.round(aSum / count)

    for (const pixelIndex of trianglePixelIndices) {
      outputData[pixelIndex] = avgR
      outputData[pixelIndex + 1] = avgG
      outputData[pixelIndex + 2] = avgB
      outputData[pixelIndex + 3] = avgA
    }
  }

  return new ImageData(outputData, width, height)
}
