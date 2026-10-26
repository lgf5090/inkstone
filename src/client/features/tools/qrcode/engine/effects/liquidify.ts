function hexToRgb(hex: string): [number, number, number] {
  let c = hex.replace('#', '').trim()
  if (c.length === 3) {
    c = c.split('').map((char) => char + char).join('')
  }
  const num = parseInt(c, 16)
  if (isNaN(num)) return [0, 0, 0]
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

export function liquidify(
  imageData: ImageData,
  radius: number,
  threshold: number,
  lightColorHex: string = '#ffffff',
  darkColorHex: string = '#000000',
): ImageData {
  const { width, height } = imageData
  const lightRgb = hexToRgb(lightColorHex)
  const darkRgb = hexToRgb(darkColorHex)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  ctx.putImageData(imageData, 0, 0)

  const blurredCanvas = document.createElement('canvas')
  blurredCanvas.width = width
  blurredCanvas.height = height
  const bCtx = blurredCanvas.getContext('2d')!

  bCtx.filter = `blur(${Math.max(1, radius)}px)`
  bCtx.drawImage(canvas, 0, 0)
  bCtx.filter = 'none'

  const blurredImageData = bCtx.getImageData(0, 0, width, height)
  const bData = blurredImageData.data
  const outputData = new Uint8ClampedArray(bData.length)

  for (let i = 0; i < bData.length; i += 4) {
    const avgLuminance = (bData[i] * 299 + bData[i + 1] * 587 + bData[i + 2] * 114) / 1000
    const color = avgLuminance > threshold ? lightRgb : darkRgb
    outputData[i] = color[0]
    outputData[i + 1] = color[1]
    outputData[i + 2] = color[2]
    outputData[i + 3] = 255
  }

  return new ImageData(outputData, width, height)
}
