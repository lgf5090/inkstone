/**
 * Unified QR code rendering engine.
 * Wraps `qr-code-styling` and coordinates:
 * - Module dot shapes (square, dots, rounded, classy, classy-rounded, diamonds)
 * - Corner eye shapes (square, rounded, circle, leaf, pointed)
 * - Gradients (linear, radial, angle, colorStops)
 * - Logo styling (circle, rounded rect, original, shadow)
 * - Composite framing (dark-green, red-blue, three-color, heart, liquid-stamp, pacman, meme-bubble, mushroom)
 * - Text captions (font size, font family, bold, italic, underline, color, top/bottom)
 */

import QRCodeStyling from 'qr-code-styling'
import { getOnlineLogoDataUrl } from '../../../../../shared/tools/qrcode/online-logos'
import type {
  QrCornerDotType,
  QrCornerSquareType,
  QrDotType,
  QrEyeShape,
  QrLogoOptions,
  QrStylingOptions,
} from '../../../../../shared/tools/qrcode/types'
import { applyFrame, drawRoundRect } from './frame-decorator'
import { applyTextCaption, applyTextCaptionToSvg } from './text-decorator'

export const DEFAULT_QR_OPTIONS: QrStylingOptions = {
  errorCorrectionLevel: 'Q',
  dotsOptions: {
    type: 'square',
    color: '#000000',
  },
  cornersSquareOptions: {
    type: 'square',
    color: '#000000',
  },
  cornersDotOptions: {
    type: 'square',
    color: '#000000',
  },
  backgroundOptions: {
    color: '#ffffff',
  },
  frameOptions: {
    type: 'none',
  },
  textOptions: {
    enabled: false,
    content: '',
    fontSize: 35,
    fontFamily: "'PingFang SC', 'Microsoft YaHei', sans-serif",
    bold: false,
    italic: false,
    underline: false,
    color: '#000000',
    position: 'bottom',
  },
}

/**
 * Maps high-level eye shape to corner square & dot styling.
 */
export function mapEyeShapeToCornerOptions(
  eyeShape: QrEyeShape,
  outerColor?: string,
  innerColor?: string
): {
  cornersSquareOptions: { type: QrCornerSquareType; color?: string }
  cornersDotOptions: { type: QrCornerDotType; color?: string }
} {
  switch (eyeShape) {
    case 'square':
      return {
        cornersSquareOptions: { type: 'square', color: outerColor },
        cornersDotOptions: { type: 'square', color: innerColor || outerColor },
      }
    case 'rounded':
      return {
        cornersSquareOptions: { type: 'extra-rounded', color: outerColor },
        cornersDotOptions: { type: 'square', color: innerColor || outerColor },
      }
    case 'circle':
      return {
        cornersSquareOptions: { type: 'dot', color: outerColor },
        cornersDotOptions: { type: 'dot', color: innerColor || outerColor },
      }
    case 'leaf':
    case 'pointed':
      return {
        cornersSquareOptions: { type: 'extra-rounded', color: outerColor },
        cornersDotOptions: { type: 'dot', color: innerColor || outerColor },
      }
    default:
      return {
        cornersSquareOptions: { type: 'square', color: outerColor },
        cornersDotOptions: { type: 'square', color: innerColor || outerColor },
      }
  }
}

/**
 * Pre-processes logo image into rounded/circular masked Data URL with shadow if requested.
 */
export async function prepareStyledLogo(
  src?: string,
  options?: QrLogoOptions
): Promise<string | undefined> {
  if (!src) return undefined
  if (!options || (options.shape === 'original' && !options.shadow)) {
    return src
  }

  if (typeof document === 'undefined') {
    return src
  }

  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'

    const timeout = setTimeout(() => {
      resolve(src)
    }, 1500)

    img.onload = () => {
      clearTimeout(timeout)
      try {
        const size = 300
        const pad = options.shadow ? 20 : 0
        const canvas = document.createElement('canvas')
        canvas.width = size + pad * 2
        canvas.height = size + pad * 2
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(src)
          return
        }

        const drawX = pad
        const drawY = pad
        const drawW = size
        const drawH = size

        if (options.shadow) {
          ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
          ctx.shadowBlur = 14
          ctx.shadowOffsetX = 0
          ctx.shadowOffsetY = 4
        }

        ctx.save()
        if (options.shape === 'circle') {
          ctx.beginPath()
          ctx.arc(drawX + drawW / 2, drawY + drawH / 2, drawW / 2, 0, Math.PI * 2)
          ctx.closePath()
          ctx.fillStyle = '#ffffff'
          ctx.fill()
          ctx.clip()
        } else if (options.shape === 'rounded') {
          drawRoundRect(ctx, drawX, drawY, drawW, drawH, Math.round(drawW * 0.22))
          ctx.fillStyle = '#ffffff'
          ctx.fill()
          ctx.clip()
        }

        ctx.drawImage(img, drawX, drawY, drawW, drawH)
        ctx.restore()

        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(src)
      }
    }

    img.onerror = () => {
      clearTimeout(timeout)
      resolve(src)
    }

    img.src = src
  })
}

/**
 * Transforms QrStylingOptions into `qr-code-styling` native configuration.
 */
export function buildQrCodeStylingOptions(
  options: QrStylingOptions,
  data: string,
  width: number,
  height: number,
  drawType: 'canvas' | 'svg' = 'canvas',
  processedLogoSrc?: string
): any {
  let dotType: QrDotType = options.dotsOptions?.type || 'square'
  if ((dotType as string) === 'diamonds') {
    dotType = 'classy'
  }

  const dotsOptions: any = {
    type: dotType,
    color: options.dotsOptions?.color || '#000000',
  }
  if (options.dotsOptions?.gradient) {
    const g = options.dotsOptions.gradient
    dotsOptions.gradient = {
      type: g.type,
      rotation: g.rotation != null ? (g.rotation * Math.PI) / 180 : 0,
      colorStops: g.colorStops || [],
    }
  }

  const cornersSquareOptions: any = {
    type: options.cornersSquareOptions?.type || 'square',
    color: options.cornersSquareOptions?.color || dotsOptions.color,
  }
  if (options.cornersSquareOptions?.gradient) {
    const g = options.cornersSquareOptions.gradient
    cornersSquareOptions.gradient = {
      type: g.type,
      rotation: g.rotation != null ? (g.rotation * Math.PI) / 180 : 0,
      colorStops: g.colorStops || [],
    }
  }

  const cornersDotOptions: any = {
    type: options.cornersDotOptions?.type || 'square',
    color: options.cornersDotOptions?.color || dotsOptions.color,
  }
  if (options.cornersDotOptions?.gradient) {
    const g = options.cornersDotOptions.gradient
    cornersDotOptions.gradient = {
      type: g.type,
      rotation: g.rotation != null ? (g.rotation * Math.PI) / 180 : 0,
      colorStops: g.colorStops || [],
    }
  }

  const backgroundOptions: any = {
    color: options.backgroundOptions?.color ?? '#ffffff',
  }
  if (options.backgroundOptions?.gradient) {
    const g = options.backgroundOptions.gradient
    backgroundOptions.gradient = {
      type: g.type,
      rotation: g.rotation != null ? (g.rotation * Math.PI) / 180 : 0,
      colorStops: g.colorStops || [],
    }
  }

  let finalLogo = processedLogoSrc || options.logoOptions?.src
  if (!finalLogo && options.logoOptions?.logoId) {
    finalLogo = getOnlineLogoDataUrl(options.logoOptions.logoId)
  }

  const imageOptions: any = {
    hideBackgroundDots: options.logoOptions?.hideBackgroundDots ?? true,
    imageSize: options.logoOptions?.size ?? 0.2,
    margin: options.logoOptions?.margin ?? 6,
    crossOrigin: 'anonymous',
  }

  return {
    width,
    height,
    type: drawType,
    data: data || ' ',
    image: finalLogo,
    margin: options.margin ?? 10,
    qrOptions: {
      errorCorrectionLevel: options.errorCorrectionLevel || 'Q',
    },
    imageOptions,
    dotsOptions,
    cornersSquareOptions,
    cornersDotOptions,
    backgroundOptions,
  }
}

/**
 * Unified QR code engine managing lifecycle, compositing, and rendering.
 */
export class QrEngine {
  private _options: QrStylingOptions
  private _data: string

  constructor(options?: Partial<QrStylingOptions>, data = 'https://example.com') {
    this._options = {
      ...DEFAULT_QR_OPTIONS,
      ...options,
      dotsOptions: { ...DEFAULT_QR_OPTIONS.dotsOptions, ...options?.dotsOptions },
      cornersSquareOptions: {
        ...DEFAULT_QR_OPTIONS.cornersSquareOptions,
        ...options?.cornersSquareOptions,
      },
      cornersDotOptions: { ...DEFAULT_QR_OPTIONS.cornersDotOptions, ...options?.cornersDotOptions },
      backgroundOptions: {
        ...DEFAULT_QR_OPTIONS.backgroundOptions,
        ...options?.backgroundOptions,
      },
      frameOptions: { ...DEFAULT_QR_OPTIONS.frameOptions, ...options?.frameOptions },
      textOptions: { ...DEFAULT_QR_OPTIONS.textOptions, ...options?.textOptions },
      logoOptions: { ...options?.logoOptions },
    }
    this._data = data
  }

  public getOptions(): QrStylingOptions {
    return this._options
  }

  public setOptions(options: Partial<QrStylingOptions>): void {
    this._options = {
      ...this._options,
      ...options,
      dotsOptions: { ...this._options.dotsOptions, ...options.dotsOptions },
      cornersSquareOptions: {
        ...this._options.cornersSquareOptions,
        ...options.cornersSquareOptions,
      },
      cornersDotOptions: { ...this._options.cornersDotOptions, ...options.cornersDotOptions },
      backgroundOptions: { ...this._options.backgroundOptions, ...options.backgroundOptions },
      frameOptions: { ...this._options.frameOptions, ...options.frameOptions },
      textOptions: { ...this._options.textOptions, ...options.textOptions },
      logoOptions: { ...this._options.logoOptions, ...options.logoOptions },
    }
  }

  public getData(): string {
    return this._data
  }

  public setData(data: string): void {
    this._data = data
  }

  public update(options: Partial<QrStylingOptions>, data?: string): void {
    this.setOptions(options)
    if (data !== undefined) {
      this.setData(data)
    }
  }

  /**
   * Renders the fully composited QR code (with frames and captions) to an HTMLCanvasElement.
   */
  public async renderCanvas(width = 1000, height = 1000): Promise<HTMLCanvasElement> {
    const rawLogoSrc = this._options.logoOptions?.src || (this._options.logoOptions?.logoId ? getOnlineLogoDataUrl(this._options.logoOptions.logoId) : undefined)
    const processedLogo = await prepareStyledLogo(rawLogoSrc, this._options.logoOptions)

    const stylingOpts = buildQrCodeStylingOptions(
      this._options,
      this._data,
      width,
      height,
      'canvas',
      processedLogo
    )

    const qr = new QRCodeStyling(stylingOpts)
    const tempContainer = document.createElement('div')
    qr.append(tempContainer)

    let baseCanvas = tempContainer.querySelector('canvas') as HTMLCanvasElement | null
    if (!baseCanvas) {
      // In environments where qr.append didn't synchronously populate canvas (e.g. testing)
      const rawElem = (qr as any)._domCanvas || (qr as any)._canvas
      if (rawElem) {
        baseCanvas = rawElem as HTMLCanvasElement
      } else {
        baseCanvas = document.createElement('canvas')
        baseCanvas.width = width
        baseCanvas.height = height
      }
    }

    const bgColor = this._options.backgroundOptions?.color || '#ffffff'

    // 1. Apply decorative frame if specified
    let composited = baseCanvas
    if (this._options.frameOptions && this._options.frameOptions.type !== 'none') {
      composited = applyFrame(composited, this._options.frameOptions, bgColor)
    }

    // 2. Apply text caption if enabled
    if (this._options.textOptions?.enabled && this._options.textOptions.content?.trim()) {
      composited = applyTextCaption(composited, this._options.textOptions, bgColor)
    }

    return composited
  }

  /**
   * Renders the QR code to an SVG string.
   */
  public async renderSvg(width = 1000, height = 1000): Promise<string> {
    const rawLogoSrc = this._options.logoOptions?.src || (this._options.logoOptions?.logoId ? getOnlineLogoDataUrl(this._options.logoOptions.logoId) : undefined)
    const processedLogo = await prepareStyledLogo(rawLogoSrc, this._options.logoOptions)

    const stylingOpts = buildQrCodeStylingOptions(
      this._options,
      this._data,
      width,
      height,
      'svg',
      processedLogo
    )

    const qr = new QRCodeStyling(stylingOpts)
    const tempContainer = document.createElement('div')
    qr.append(tempContainer)

    let svgElement = tempContainer.querySelector('svg')
    let svgString = ''
    if (svgElement) {
      svgString = svgElement.outerHTML
    } else {
      const rawSvg = (qr as any)._svg
      if (rawSvg && typeof rawSvg.outerHTML === 'string') {
        svgString = rawSvg.outerHTML
      } else {
        svgString = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${this._options.backgroundOptions?.color || '#ffffff'}"/></svg>`
      }
    }

    const bgColor = this._options.backgroundOptions?.color || '#ffffff'

    // If frame is enabled, render framed canvas and embed in SVG for 100% visual fidelity
    if (this._options.frameOptions && this._options.frameOptions.type !== 'none') {
      const canvas = await this.renderCanvas(width, height)
      const dataUrl = canvas.toDataURL('image/png')
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><image href="${dataUrl}" width="${canvas.width}" height="${canvas.height}"/></svg>`
    }

    // Apply text caption in pure SVG format
    if (this._options.textOptions?.enabled && this._options.textOptions.content?.trim()) {
      svgString = applyTextCaptionToSvg(svgString, this._options.textOptions, bgColor)
    }

    return svgString
  }

  /**
   * Mounts the preview to a container element.
   */
  public async append(container: HTMLElement, width = 300, height = 300): Promise<void> {
    container.innerHTML = ''
    const canvas = await this.renderCanvas(width, height)
    canvas.style.maxWidth = '100%'
    canvas.style.height = 'auto'
    container.appendChild(canvas)
  }
}
