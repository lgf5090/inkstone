import type { QrTextOptions } from '../../../../../shared/tools/qrcode/types'

export function calculateEffectiveFontSize(baseFontSize: number, canvasWidth: number): number {
  const scaled = Math.round(baseFontSize * (canvasWidth / 1000))
  return Math.max(12, scaled)
}

export function wrapTextLines(
  ctx: CanvasRenderingContext2D | null,
  text: string,
  maxWidth: number,
  fallbackCharWidth = 18
): string[] {
  const rawParagraphs = text.split('\n')
  const lines: string[] = []

  const measure = (str: string): number => {
    if (ctx && typeof ctx.measureText === 'function') {
      return ctx.measureText(str).width
    }
    let len = 0
    for (let i = 0; i < str.length; i++) {
      len += str.charCodeAt(i) > 255 ? fallbackCharWidth : fallbackCharWidth * 0.55
    }
    return len
  }

  for (const paragraph of rawParagraphs) {
    const trimmed = paragraph.trim()
    if (!trimmed) {
      continue
    }

    if (measure(trimmed) <= maxWidth) {
      lines.push(trimmed)
      continue
    }

    let current = ''
    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i]
      const candidate = current + char
      if (measure(candidate) > maxWidth && current.length > 0) {
        lines.push(current.trim())
        current = char
      } else {
        current = candidate
      }
    }
    if (current.trim()) {
      lines.push(current.trim())
    }
  }

  return lines
}

export function applyTextCaption(
  sourceCanvas: HTMLCanvasElement,
  options?: QrTextOptions,
  backgroundColor = '#ffffff'
): HTMLCanvasElement {
  if (!options?.enabled || !options.content || !options.content.trim()) {
    return sourceCanvas
  }

  const width = sourceCanvas.width
  const effectiveFontSize = calculateEffectiveFontSize(options.fontSize || 35, width)
  const lineHeight = Math.round(effectiveFontSize * 1.4)
  const padTop = Math.round(effectiveFontSize * 0.7)
  const padBottom = Math.round(effectiveFontSize * 0.7)
  const maxTextWidth = Math.max(100, width - Math.round(effectiveFontSize * 1.5))

  const measureCanvas = document.createElement('canvas')
  const measureCtx = measureCanvas.getContext('2d')
  if (measureCtx) {
    const fontStyle = options.italic ? 'italic ' : ''
    const fontWeight = options.bold ? 'bold ' : 'normal '
    const fontFamily = options.fontFamily || "'PingFang SC', 'Microsoft YaHei', sans-serif"
    measureCtx.font = `${fontStyle}${fontWeight}${effectiveFontSize}px ${fontFamily}`
  }

  const lines = wrapTextLines(measureCtx, options.content, maxTextWidth, effectiveFontSize)
  if (lines.length === 0) {
    return sourceCanvas
  }

  const textSectionHeight = lines.length * lineHeight + padTop + padBottom

  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = width
  outputCanvas.height = sourceCanvas.height + textSectionHeight

  const ctx = outputCanvas.getContext('2d')
  if (!ctx) {
    return sourceCanvas
  }

  ctx.fillStyle = backgroundColor || '#ffffff'
  ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height)

  const isTop = options.position === 'top'
  const qrY = isTop ? textSectionHeight : 0
  const textStartY = isTop ? padTop + effectiveFontSize : sourceCanvas.height + padTop + effectiveFontSize

  ctx.drawImage(sourceCanvas, 0, qrY)

  const fontStyle = options.italic ? 'italic ' : ''
  const fontWeight = options.bold ? 'bold ' : 'normal '
  const fontFamily = options.fontFamily || "'PingFang SC', 'Microsoft YaHei', sans-serif"
  ctx.font = `${fontStyle}${fontWeight}${effectiveFontSize}px ${fontFamily}`
  ctx.fillStyle = options.color || '#000000'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.strokeStyle = options.color || '#000000'
  ctx.lineWidth = Math.max(1, Math.round(effectiveFontSize * 0.06))

  const centerX = width / 2

  lines.forEach((line, index) => {
    const currentY = textStartY + index * lineHeight
    ctx.fillText(line, centerX, currentY)

    if (options.underline) {
      const textMetrics = ctx.measureText(line)
      const textWidth = textMetrics.width
      const underlineY = currentY + Math.round(effectiveFontSize * 0.15)
      ctx.beginPath()
      ctx.moveTo(centerX - textWidth / 2, underlineY)
      ctx.lineTo(centerX + textWidth / 2, underlineY)
      ctx.stroke()
    }
  })

  return outputCanvas
}

export function applyTextCaptionToSvg(
  svgString: string,
  options?: QrTextOptions,
  backgroundColor = '#ffffff'
): string {
  if (!options?.enabled || !options.content || !options.content.trim()) {
    return svgString
  }

  const widthMatch = svgString.match(/width="([0-9.]+)(?:px)?"/)
  const heightMatch = svgString.match(/height="([0-9.]+)(?:px)?"/)
  const origWidth = widthMatch ? parseFloat(widthMatch[1]) : 1000
  const origHeight = heightMatch ? parseFloat(heightMatch[1]) : 1000

  const effectiveFontSize = calculateEffectiveFontSize(options.fontSize || 35, origWidth)
  const lineHeight = Math.round(effectiveFontSize * 1.4)
  const padTop = Math.round(effectiveFontSize * 0.7)
  const padBottom = Math.round(effectiveFontSize * 0.7)
  const maxTextWidth = Math.max(100, origWidth - Math.round(effectiveFontSize * 1.5))

  const lines = wrapTextLines(null, options.content, maxTextWidth, effectiveFontSize)
  if (lines.length === 0) {
    return svgString
  }

  const textSectionHeight = lines.length * lineHeight + padTop + padBottom
  const newHeight = origHeight + textSectionHeight

  const isTop = options.position === 'top'
  const qrY = isTop ? textSectionHeight : 0
  const textStartY = isTop ? padTop + effectiveFontSize : origHeight + padTop + effectiveFontSize

  const fontWeight = options.bold ? 'bold' : 'normal'
  const fontStyle = options.italic ? 'italic' : 'normal'
  const textDecoration = options.underline ? 'underline' : 'none'
  const fontFamily = options.fontFamily || 'sans-serif'
  const textColor = options.color || '#000000'

  const textNodes = lines
    .map((line, idx) => {
      const y = textStartY + idx * lineHeight
      return `<text x="${origWidth / 2}" y="${y}" text-anchor="middle" font-family="${fontFamily}" font-size="${effectiveFontSize}" font-weight="${fontWeight}" font-style="${fontStyle}" text-decoration="${textDecoration}" fill="${textColor}">${escapeXml(line)}</text>`
    })
    .join('')

  const openTagEnd = svgString.indexOf('>')
  const closeTagStart = svgString.lastIndexOf('</svg>')
  const innerContent =
    openTagEnd !== -1 && closeTagStart !== -1
      ? svgString.slice(openTagEnd + 1, closeTagStart)
      : svgString

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${origWidth}" height="${newHeight}" viewBox="0 0 ${origWidth} ${newHeight}">
    <rect width="${origWidth}" height="${newHeight}" fill="${backgroundColor}"/>
    <g transform="translate(0, ${qrY})">
      ${innerContent}
    </g>
    ${textNodes}
  </svg>`
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
