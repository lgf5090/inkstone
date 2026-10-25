/**
 * Canvas composite decorator for decorative frames:
 * - 墨绿边框 (dark-green)
 * - 红蓝渐变 (red-blue)
 * - 三色名片 (three-color)
 * - 爱心边框 (heart)
 * - 液态印章 (liquid-stamp)
 * - 吃豆人 (pacman)
 * - 表情包气泡 (meme-bubble)
 * - 蘑菇头表情 (mushroom)
 */

import type { QrFrameOptions } from '../../../../../shared/tools/qrcode/types'

/**
 * Safely draws a rounded rectangle path on any Canvas 2D context.
 */
export function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.arcTo(x + w, y, x + w, y + radius, radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius)
  ctx.lineTo(x + radius, y + h)
  ctx.arcTo(x, y + h, x, y + h - radius, radius)
  ctx.lineTo(x, y + radius)
  ctx.arcTo(x, y, x + radius, y, radius)
  ctx.closePath()
}

/**
 * Draws a filled heart path on canvas context.
 */
function drawHeart(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  ctx.save()
  ctx.fillStyle = color
  ctx.beginPath()
  const topCurveHeight = size * 0.3
  ctx.moveTo(cx, cy + topCurveHeight)
  ctx.bezierCurveTo(
    cx,
    cy,
    cx - size / 2,
    cy,
    cx - size / 2,
    cy + topCurveHeight
  )
  ctx.bezierCurveTo(
    cx - size / 2,
    cy + (size + topCurveHeight) / 2,
    cx,
    cy + (size + topCurveHeight) / 1.5,
    cx,
    cy + size
  )
  ctx.bezierCurveTo(
    cx,
    cy + (size + topCurveHeight) / 1.5,
    cx + size / 2,
    cy + (size + topCurveHeight) / 2,
    cx + size / 2,
    cy + topCurveHeight
  )
  ctx.bezierCurveTo(
    cx + size / 2,
    cy,
    cx,
    cy,
    cx,
    cy + topCurveHeight
  )
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/**
 * Applies decorative frame layout around an existing QR code canvas.
 */
export function applyFrame(
  qrCanvas: HTMLCanvasElement,
  frameOptions?: QrFrameOptions,
  backgroundColor = '#ffffff'
): HTMLCanvasElement {
  if (!frameOptions || frameOptions.type === 'none') {
    return qrCanvas
  }

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return qrCanvas

  switch (frameOptions.type) {
    case 'dark-green':
      return renderDarkGreenFrame(canvas, ctx, qrCanvas, frameOptions, backgroundColor)
    case 'red-blue':
      return renderRedBlueFrame(canvas, ctx, qrCanvas, frameOptions, backgroundColor)
    case 'three-color':
      return renderThreeColorFrame(canvas, ctx, qrCanvas, frameOptions, backgroundColor)
    case 'heart':
      return renderHeartFrame(canvas, ctx, qrCanvas, frameOptions, backgroundColor)
    case 'liquid-stamp':
      return renderLiquidStampFrame(canvas, ctx, qrCanvas, frameOptions, backgroundColor)
    case 'pacman':
      return renderPacmanFrame(canvas, ctx, qrCanvas, frameOptions)
    case 'meme-bubble':
      return renderMemeBubbleFrame(canvas, ctx, qrCanvas, frameOptions, backgroundColor)
    case 'mushroom':
      return renderMushroomFrame(canvas, ctx, qrCanvas, frameOptions, backgroundColor)
    default:
      return qrCanvas
  }
}

// 1. 墨绿边框 (Dark Green Classic)
function renderDarkGreenFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  qrCanvas: HTMLCanvasElement,
  options: QrFrameOptions,
  bg: string
): HTMLCanvasElement {
  const qrSize = qrCanvas.width
  const pad = Math.round(qrSize * 0.08)
  const footerH = Math.round(qrSize * 0.16)
  const totalW = qrSize + pad * 2
  const totalH = qrSize + pad * 2 + footerH

  canvas.width = totalW
  canvas.height = totalH

  const green = options.color || '#1b4332'
  const gold = options.secondaryColor || '#d4af37'

  // Outer container
  ctx.fillStyle = bg || '#fcfdfa'
  ctx.fillRect(0, 0, totalW, totalH)

  // Double border
  const borderPad = Math.round(pad * 0.3)
  ctx.strokeStyle = green
  ctx.lineWidth = Math.max(3, Math.round(qrSize * 0.008))
  drawRoundRect(ctx, borderPad, borderPad, totalW - borderPad * 2, totalH - borderPad * 2, 12)
  ctx.stroke()

  ctx.strokeStyle = gold
  ctx.lineWidth = Math.max(1, Math.round(qrSize * 0.003))
  const innerBorderPad = borderPad + Math.round(pad * 0.2)
  drawRoundRect(ctx, innerBorderPad, innerBorderPad, totalW - innerBorderPad * 2, totalH - innerBorderPad * 2, 8)
  ctx.stroke()

  // Draw QR
  ctx.drawImage(qrCanvas, pad, pad)

  // Bottom Badge
  const badgeW = Math.round(totalW * 0.65)
  const badgeH = Math.round(footerH * 0.6)
  const badgeX = (totalW - badgeW) / 2
  const badgeY = pad + qrSize + Math.round((footerH - badgeH) / 2)

  ctx.fillStyle = green
  drawRoundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2)
  ctx.fill()

  // Label text
  const label = options.label || '扫一扫 了解更多'
  const fontSize = Math.max(12, Math.round(badgeH * 0.48))
  ctx.font = `600 ${fontSize}px 'PingFang SC', sans-serif`
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, totalW / 2, badgeY + badgeH / 2)

  return canvas
}

// 2. 红蓝渐变 (Red-Blue Gradient Modern)
function renderRedBlueFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  qrCanvas: HTMLCanvasElement,
  options: QrFrameOptions,
  bg: string
): HTMLCanvasElement {
  const qrSize = qrCanvas.width
  const pad = Math.round(qrSize * 0.09)
  const footerH = Math.round(qrSize * 0.16)
  const totalW = qrSize + pad * 2
  const totalH = qrSize + pad * 2 + footerH

  canvas.width = totalW
  canvas.height = totalH

  const color1 = options.color || '#ef4444'
  const color2 = options.secondaryColor || '#3b82f6'

  // Outer gradient card
  const grad = ctx.createLinearGradient(0, 0, totalW, totalH)
  grad.addColorStop(0, color1)
  grad.addColorStop(1, color2)

  ctx.fillStyle = grad
  drawRoundRect(ctx, 4, 4, totalW - 8, totalH - 8, 20)
  ctx.fill()

  // Inner QR card container
  const innerMargin = Math.round(pad * 0.4)
  const innerCardW = totalW - innerMargin * 2
  const innerCardH = qrSize + Math.round(pad * 1.2)
  ctx.fillStyle = bg || '#ffffff'
  drawRoundRect(ctx, innerMargin, innerMargin, innerCardW, innerCardH, 14)
  ctx.fill()

  // Draw QR
  ctx.drawImage(qrCanvas, pad, pad)

  // Bottom Label
  const label = options.label || '扫一扫 查看内容'
  const fontSize = Math.max(13, Math.round(footerH * 0.32))
  ctx.font = `bold ${fontSize}px 'PingFang SC', sans-serif`
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, totalW / 2, pad + qrSize + footerH * 0.6)

  return canvas
}

// 3. 三色名片 (Three-Color Memphis Card)
function renderThreeColorFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  qrCanvas: HTMLCanvasElement,
  options: QrFrameOptions,
  bg: string
): HTMLCanvasElement {
  const qrSize = qrCanvas.width
  const pad = Math.round(qrSize * 0.1)
  const footerH = Math.round(qrSize * 0.18)
  const headerH = Math.round(qrSize * 0.08)
  const totalW = qrSize + pad * 2
  const totalH = qrSize + pad * 2 + footerH + headerH

  canvas.width = totalW
  canvas.height = totalH

  const coral = options.color || '#ff6b6b'
  const yellow = options.secondaryColor || '#ffd93d'
  const cyan = '#48dbfb'
  const dark = '#1e293b'

  // Card background
  ctx.fillStyle = bg || '#ffffff'
  drawRoundRect(ctx, 6, 6, totalW - 12, totalH - 12, 16)
  ctx.fill()

  // Dark outline
  ctx.strokeStyle = dark
  ctx.lineWidth = Math.max(3, Math.round(qrSize * 0.007))
  drawRoundRect(ctx, 6, 6, totalW - 12, totalH - 12, 16)
  ctx.stroke()

  // Top decorative color tabs
  ctx.fillStyle = coral
  drawRoundRect(ctx, 20, 16, 24, 10, 4)
  ctx.fill()
  ctx.fillStyle = yellow
  drawRoundRect(ctx, 52, 16, 24, 10, 4)
  ctx.fill()
  ctx.fillStyle = cyan
  drawRoundRect(ctx, 84, 16, 24, 10, 4)
  ctx.fill()

  // Draw QR
  ctx.drawImage(qrCanvas, pad, pad + headerH)

  // Bottom Label Button
  const btnW = Math.round(totalW * 0.6)
  const btnH = Math.round(footerH * 0.58)
  const btnX = (totalW - btnW) / 2
  const btnY = pad + headerH + qrSize + Math.round((footerH - btnH) / 2)

  // Button shadow
  ctx.fillStyle = dark
  drawRoundRect(ctx, btnX + 3, btnY + 3, btnW, btnH, 8)
  ctx.fill()

  // Button fill
  ctx.fillStyle = yellow
  drawRoundRect(ctx, btnX, btnY, btnW, btnH, 8)
  ctx.fill()
  ctx.strokeStyle = dark
  ctx.lineWidth = 2
  ctx.stroke()

  const label = options.label || 'SCAN ME'
  const fontSize = Math.max(12, Math.round(btnH * 0.48))
  ctx.font = `bold ${fontSize}px sans-serif`
  ctx.fillStyle = dark
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, totalW / 2, btnY + btnH / 2)

  return canvas
}

// 4. 爱心边框 (Heart Border)
function renderHeartFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  qrCanvas: HTMLCanvasElement,
  options: QrFrameOptions,
  bg: string
): HTMLCanvasElement {
  const qrSize = qrCanvas.width
  const pad = Math.round(qrSize * 0.1)
  const footerH = Math.round(qrSize * 0.16)
  const headerH = Math.round(qrSize * 0.06)
  const totalW = qrSize + pad * 2
  const totalH = qrSize + pad * 2 + footerH + headerH

  canvas.width = totalW
  canvas.height = totalH

  const pink = options.color || '#f43f5e'
  const lightPink = options.secondaryColor || '#ffe4e6'

  // Outer blush card
  ctx.fillStyle = lightPink
  drawRoundRect(ctx, 4, 4, totalW - 8, totalH - 8, 20)
  ctx.fill()

  // Pink border
  ctx.strokeStyle = pink
  ctx.lineWidth = Math.max(2, Math.round(qrSize * 0.005))
  drawRoundRect(ctx, 4, 4, totalW - 8, totalH - 8, 20)
  ctx.stroke()

  // Draw decorative hearts
  const heartSize = Math.round(pad * 0.5)
  drawHeart(ctx, pad * 0.6, pad * 0.4, heartSize, pink)
  drawHeart(ctx, totalW - pad * 0.6, pad * 0.4, heartSize, pink)

  // Inner card for QR
  ctx.fillStyle = bg || '#ffffff'
  drawRoundRect(ctx, pad - 8, pad + headerH - 8, qrSize + 16, qrSize + 16, 12)
  ctx.fill()

  // Draw QR
  ctx.drawImage(qrCanvas, pad, pad + headerH)

  // Bottom Heart Badge
  const badgeW = Math.round(totalW * 0.6)
  const badgeH = Math.round(footerH * 0.6)
  const badgeX = (totalW - badgeW) / 2
  const badgeY = pad + headerH + qrSize + Math.round((footerH - badgeH) / 2)

  ctx.fillStyle = pink
  drawRoundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2)
  ctx.fill()

  const label = options.label || 'LOVE & SCAN'
  const fontSize = Math.max(12, Math.round(badgeH * 0.46))
  ctx.font = `bold ${fontSize}px sans-serif`
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(`♥ ${label} ♥`, totalW / 2, badgeY + badgeH / 2)

  return canvas
}

// 5. 液态印章 (Liquid Stamp Seal)
function renderLiquidStampFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  qrCanvas: HTMLCanvasElement,
  options: QrFrameOptions,
  bg: string
): HTMLCanvasElement {
  const qrSize = qrCanvas.width
  const pad = Math.round(qrSize * 0.12)
  const totalW = qrSize + pad * 2
  const totalH = totalW

  canvas.width = totalW
  canvas.height = totalH

  const carmine = options.color || '#be123c'

  // Outer stamp card
  ctx.fillStyle = bg || '#ffffff'
  ctx.fillRect(0, 0, totalW, totalH)

  // Stamp circle border
  const cx = totalW / 2
  const cy = totalH / 2
  const radius = totalW / 2 - 10

  ctx.strokeStyle = carmine
  ctx.lineWidth = Math.max(4, Math.round(qrSize * 0.01))
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()

  // Inner dotted ring
  ctx.save()
  ctx.setLineDash([8, 6])
  ctx.lineWidth = Math.max(2, Math.round(qrSize * 0.004))
  ctx.beginPath()
  ctx.arc(cx, cy, radius - 10, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  // Inner QR background
  ctx.fillStyle = '#ffffff'
  drawRoundRect(ctx, pad - 6, pad - 6, qrSize + 12, qrSize + 12, 10)
  ctx.fill()

  // Draw QR
  ctx.drawImage(qrCanvas, pad, pad)

  // Label bottom ribbon
  const label = options.label || '★ 专属认证 ★'
  const fontSize = Math.max(11, Math.round(pad * 0.32))
  ctx.font = `bold ${fontSize}px 'PingFang SC', sans-serif`
  ctx.fillStyle = carmine
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, cx, totalH - pad * 0.4)

  return canvas
}

// 6. 吃豆人 (Pac-man Retro Arcade)
function renderPacmanFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  qrCanvas: HTMLCanvasElement,
  options: QrFrameOptions
): HTMLCanvasElement {
  const qrSize = qrCanvas.width
  const pad = Math.round(qrSize * 0.1)
  const headerH = Math.round(qrSize * 0.1)
  const footerH = Math.round(qrSize * 0.14)
  const totalW = qrSize + pad * 2
  const totalH = qrSize + pad * 2 + headerH + footerH

  canvas.width = totalW
  canvas.height = totalH

  const mazeBlue = options.color || '#3b82f6'
  const yellow = options.secondaryColor || '#facc15'

  // Dark arcade background
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, 0, totalW, totalH)

  // Maze borders
  ctx.strokeStyle = mazeBlue
  ctx.lineWidth = Math.max(3, Math.round(qrSize * 0.008))
  drawRoundRect(ctx, 8, 8, totalW - 16, totalH - 16, 12)
  ctx.stroke()

  // Top Track: Pacman eating dots
  const trackY = Math.round(headerH * 0.6)
  const pacX = pad + 15
  const pacRadius = Math.round(headerH * 0.28)

  // Draw Pacman
  ctx.fillStyle = yellow
  ctx.beginPath()
  ctx.arc(pacX, trackY, pacRadius, 0.25 * Math.PI, 1.75 * Math.PI)
  ctx.lineTo(pacX, trackY)
  ctx.closePath()
  ctx.fill()

  // Draw food dots
  const dotCount = 6
  const dotSpacing = (totalW - pacX - pad - 20) / dotCount
  ctx.fillStyle = yellow
  for (let i = 1; i <= dotCount; i++) {
    ctx.beginPath()
    ctx.arc(pacX + i * dotSpacing, trackY, 3, 0, Math.PI * 2)
    ctx.fill()
  }

  // Draw QR
  ctx.drawImage(qrCanvas, pad, pad + headerH)

  // Bottom Label
  const label = options.label || 'READY! 1UP'
  const fontSize = Math.max(12, Math.round(footerH * 0.35))
  ctx.font = `bold ${fontSize}px monospace, 'Courier New', sans-serif`
  ctx.fillStyle = yellow
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, totalW / 2, pad + headerH + qrSize + footerH * 0.55)

  return canvas
}

// 7. 表情包气泡 (Meme Speech Bubble)
function renderMemeBubbleFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  qrCanvas: HTMLCanvasElement,
  options: QrFrameOptions,
  bg: string
): HTMLCanvasElement {
  const qrSize = qrCanvas.width
  const pad = Math.round(qrSize * 0.08)
  const bubbleH = Math.round(qrSize * 0.16)
  const totalW = qrSize + pad * 2
  const totalH = qrSize + pad * 2 + bubbleH

  canvas.width = totalW
  canvas.height = totalH

  const dark = options.color || '#18181b'
  const yellow = options.secondaryColor || '#facc15'

  ctx.fillStyle = bg || '#ffffff'
  ctx.fillRect(0, 0, totalW, totalH)

  // Top speech bubble
  const bW = Math.round(totalW * 0.68)
  const bH = Math.round(bubbleH * 0.65)
  const bX = (totalW - bW) / 2
  const bY = Math.round(pad * 0.5)

  // Bubble background
  ctx.fillStyle = yellow
  drawRoundRect(ctx, bX, bY, bW, bH, 12)
  ctx.fill()
  ctx.strokeStyle = dark
  ctx.lineWidth = 3
  ctx.stroke()

  // Pointer triangle
  ctx.fillStyle = yellow
  ctx.beginPath()
  ctx.moveTo(totalW / 2 - 8, bY + bH)
  ctx.lineTo(totalW / 2, bY + bH + 10)
  ctx.lineTo(totalW / 2 + 8, bY + bH)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(totalW / 2 - 8, bY + bH)
  ctx.lineTo(totalW / 2, bY + bH + 10)
  ctx.lineTo(totalW / 2 + 8, bY + bH)
  ctx.stroke()

  // Label
  const label = options.label || '快去扫码！'
  const fontSize = Math.max(13, Math.round(bH * 0.5))
  ctx.font = `bold ${fontSize}px 'PingFang SC', sans-serif`
  ctx.fillStyle = dark
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, totalW / 2, bY + bH / 2)

  // Outer container border
  ctx.strokeStyle = dark
  ctx.lineWidth = 3
  drawRoundRect(ctx, pad - 6, pad + bubbleH - 6, qrSize + 12, qrSize + 12, 10)
  ctx.stroke()

  // Draw QR
  ctx.drawImage(qrCanvas, pad, pad + bubbleH)

  return canvas
}

// 8. 蘑菇头表情 (Mushroom Head Cartoon Frame)
function renderMushroomFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  qrCanvas: HTMLCanvasElement,
  options: QrFrameOptions,
  bg: string
): HTMLCanvasElement {
  const qrSize = qrCanvas.width
  const pad = Math.round(qrSize * 0.09)
  const footerH = Math.round(qrSize * 0.16)
  const totalW = qrSize + pad * 2
  const totalH = qrSize + pad * 2 + footerH

  canvas.width = totalW
  canvas.height = totalH

  const dark = options.color || '#09090b'

  ctx.fillStyle = bg || '#ffffff'
  ctx.fillRect(0, 0, totalW, totalH)

  // Bold cartoon card outline
  ctx.strokeStyle = dark
  ctx.lineWidth = Math.max(4, Math.round(qrSize * 0.008))
  drawRoundRect(ctx, 6, 6, totalW - 12, totalH - 12, 16)
  ctx.stroke()

  // Inner QR
  ctx.drawImage(qrCanvas, pad, pad)

  // Bottom playful caption
  const label = options.label || '扫一扫嘛'
  const fontSize = Math.max(14, Math.round(footerH * 0.42))
  ctx.font = `bold ${fontSize}px 'PingFang SC', sans-serif`
  ctx.fillStyle = dark
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, totalW / 2, pad + qrSize + footerH * 0.5)

  return canvas
}
