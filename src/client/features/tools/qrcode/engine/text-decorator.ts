/**
 * Canvas and SVG multiline text decorator for QR code caption labels.
 * Supports configurable font family, size (20-60px), weight, style, underline,
 * color, and top/bottom positioning.
 */

import type { QrTextOptions } from '../../../../../shared/tools/qrcode/types'

/**
 * Calculates effective font size proportional to target canvas width
 * (calibrated to 1000px standard reference width).
 */
export function calculateEffectiveFontSize(baseFontSize: number, canvasWidth: number): number {
  const scaled = Math.round(baseFontSize * (canvasWidth / 1000))
  return Math.max(12, scaled)
}

/**
 * Decorates an existing QR Canvas with a styled multi-line text caption.
 */
export function applyTextCaption(
  sourceCanvas: HTMLCanvasElement,
  options?: QrTextOptions,
  backgroundColor = '#ffffff'
): HTMLCanvasElement {
  if (!options?.enabled || !options.content || !options.content.trim()) {
    return sourceCanvas
  }

  const rawLines = options.content.split('\n')
  const lines = rawLines.map((line) => line.trim())
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    return sourceCanvas
  }

  const width = sourceCanvas.width
  const effectiveFontSize = calculateEffectiveFontSize(options.fontSize || 35, width)
  const lineHeight = Math.round(effectiveFontSize * 1.4)
  const padTop = Math.round(effectiveFontSize * 0.7)
  const padBottom = Math.round(effectiveFontSize * 0.7)
  const textSectionHeight = lines.length * lineHeight + padTop + padBottom

  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = width
  outputCanvas.height = sourceCanvas.height + textSectionHeight

  const ctx = outputCanvas.getContext('2d')
  if (!ctx) {
    return sourceCanvas
  }

  // 1. Fill background
  ctx.fillStyle = backgroundColor || '#ffffff'
  ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height)

  const isTop = options.position === 'top'
  const qrY = isTop ? textSectionHeight : 0
  const textStartY = isTop ? padTop + effectiveFontSize : sourceCanvas.height + padTop + effectiveFontSize

  // 2. Draw the QR code
  ctx.drawImage(sourceCanvas, 0, qrY)

  // 3. Configure text typography
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

  // 4. Render each line
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

/**
 * Decorates an SVG QR string with a caption label in SVG format.
 */
export function applyTextCaptionToSvg(
  svgString: string,
  options?: QrTextOptions,
  backgroundColor = '#ffffff'
): string {
  if (!options?.enabled || !options.content || !options.content.trim()) {
    return svgString
  }

  const rawLines = options.content.split('\n')
  const lines = rawLines.map((line) => line.trim())
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    return svgString
  }

  const widthMatch = svgString.match(/width="(\d+)"/)
  const heightMatch = svgString.match(/height="(\d+)"/)
  const origWidth = widthMatch ? parseInt(widthMatch[1], 10) : 1000
  const origHeight = heightMatch ? parseInt(heightMatch[1], 10) : 1000

  const effectiveFontSize = calculateEffectiveFontSize(options.fontSize || 35, origWidth)
  const lineHeight = Math.round(effectiveFontSize * 1.4)
  const padTop = Math.round(effectiveFontSize * 0.7)
  const padBottom = Math.round(effectiveFontSize * 0.7)
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

  // Strip existing <svg ...> tag and replace
  const innerContent = svgString.replace(/<svg[^>]*>|<\/svg>/gi, '')

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
