export interface Segment {
  index: number
  x: number
  y: number
  color: [number, number, number, number]
  luminance: number
  value: number
  expected: number
  isMargin: boolean
}

export interface DiffResult {
  segments: Segment[]
  mainSegments: Segment[]
  mismatchDark: Segment[]
  mismatchLight: Segment[]
  mismatchCount: number
  averageLuminance: number
  lightLuminance: number
  darkLuminance: number
  scanabilityScore: number
}

function getAverageColor(data: ImageData): [number, number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  const total = data.data.length / 4

  for (let i = 0; i < data.data.length; i += 4) {
    r += data.data[i]
    g += data.data[i + 1]
    b += data.data[i + 2]
    a += data.data[i + 3]
  }

  return [Math.round(r / total), Math.round(g / total), Math.round(b / total), Math.round(a / total)]
}

export async function segmentImageFromDataUrl(dataUrl: string, gridSize = 25): Promise<Segment[]> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = dataUrl
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = reject
  })

  const canvasSize = 1000
  const canvas = document.createElement('canvas')
  canvas.width = canvasSize
  canvas.height = canvasSize
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  const minSide = Math.min(img.width, img.height)
  ctx.drawImage(
    img,
    (img.width - minSide) / 2,
    (img.height - minSide) / 2,
    minSide,
    minSide,
    0,
    0,
    canvasSize,
    canvasSize
  )

  const cellSize = canvasSize / gridSize
  const cells: Segment[] = []

  for (let i = 0; i < gridSize * gridSize; i++) {
    const x = i % gridSize
    const y = Math.floor(i / gridSize)
    const cellData = ctx.getImageData(x * cellSize, y * cellSize, cellSize, cellSize)
    const color = getAverageColor(cellData)
    const luminance = Math.round(((color[0] * 299 + color[1] * 587 + color[2] * 114) / 1000) * (color[3] / 255))

    cells.push({
      index: i,
      x,
      y,
      color,
      luminance,
      expected: 0,
      value: luminance >= 128 ? 1 : 0,
      isMargin: false,
    })
  }

  return cells
}

export function compareSegments(
  imageSegments: Segment[],
  referenceSegments: Segment[],
  gridSize: number,
  marginSize = 2,
  diffThreshold = 30
): DiffResult {
  for (const seg of imageSegments) {
    seg.expected = referenceSegments[seg.index]?.value ?? 0
    const { x, y } = seg
    seg.isMargin = x < marginSize || y < marginSize || x >= gridSize - marginSize || y >= gridSize - marginSize
  }

  const mainSegments = imageSegments.filter((i) => !i.isMargin)
  const averageLuminance =
    mainSegments.length > 0 ? mainSegments.reduce((sum, s) => sum + s.luminance, 0) / mainSegments.length : 128

  const lightSegments = mainSegments.filter((i) => i.expected === 1)
  const darkSegments = mainSegments.filter((i) => i.expected === 0)

  const lightLuminance =
    lightSegments.length > 0 ? lightSegments.reduce((sum, s) => sum + s.luminance, 0) / lightSegments.length : 255
  const darkLuminance =
    darkSegments.length > 0 ? darkSegments.reduce((sum, s) => sum + s.luminance, 0) / darkSegments.length : 0

  for (const s of imageSegments) {
    const disLight = Math.abs(s.luminance - lightLuminance)
    const disDark = Math.abs(s.luminance - darkLuminance)
    const dis = Math.abs(disLight - disDark)
    s.value = dis < diffThreshold ? -1 : disLight < disDark ? 1 : 0
  }

  const mismatchDark = mainSegments.filter((s) => s.expected === 1 && s.value !== s.expected)
  const mismatchLight = mainSegments.filter((s) => s.expected === 0 && s.value !== s.expected)
  const mismatchCount = mismatchDark.length + mismatchLight.length

  const totalMain = Math.max(1, mainSegments.length)
  const errorRate = mismatchCount / totalMain
  const scanabilityScore = Math.max(0, Math.min(100, Math.round((1 - errorRate * 1.5) * 100)))

  return {
    segments: imageSegments,
    mainSegments,
    mismatchDark,
    mismatchLight,
    mismatchCount,
    averageLuminance,
    lightLuminance,
    darkLuminance,
    scanabilityScore,
  }
}

export function generateControlNetMask(
  diff: DiffResult,
  gridSize: number,
  type: 'mask' | 'correction' = 'mask'
): HTMLCanvasElement {
  const canvasSize = 1024
  const canvas = document.createElement('canvas')
  canvas.width = canvasSize
  canvas.height = canvasSize
  const ctx = canvas.getContext('2d')!

  const cellSize = canvasSize / gridSize

  if (type === 'mask') {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, canvasSize, canvasSize)

    ctx.fillStyle = '#ffffff'
    const mismatches = [...diff.mismatchDark, ...diff.mismatchLight]
    for (const m of mismatches) {
      ctx.fillRect(m.x * cellSize, m.y * cellSize, cellSize, cellSize)
    }
  } else {
    // Correction map
    ctx.fillStyle = '#808080'
    ctx.fillRect(0, 0, canvasSize, canvasSize)

    for (const m of diff.mismatchDark) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(m.x * cellSize, m.y * cellSize, cellSize, cellSize)
    }
    for (const m of diff.mismatchLight) {
      ctx.fillStyle = '#000000'
      ctx.fillRect(m.x * cellSize, m.y * cellSize, cellSize, cellSize)
    }
  }

  return canvas
}
