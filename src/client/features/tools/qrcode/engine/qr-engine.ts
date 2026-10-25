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
    case 'leaf-diagonal':
    case 'pointed':
    case 'leaf-pointed':
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

export async function prepareStyledLogo(
  src?: string,
  options?: QrLogoOptions
): Promise<string | undefined> {
  const finalSrc =
    src ||
    options?.src ||
    options?.url ||
    options?.dataUrl ||
    (options?.logoId ? getOnlineLogoDataUrl(options.logoId) : undefined)

  if (!finalSrc) return undefined

  const shape = options?.shape || 'original'
  const hasShadow = Boolean(options?.shadow || options?.hasShadow)

  if (shape === 'original' && !hasShadow) {
    return finalSrc
  }

  if (typeof document === 'undefined') {
    return finalSrc
  }

  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'

    const timeout = setTimeout(() => {
      resolve(finalSrc)
    }, 800)

    img.onload = () => {
      clearTimeout(timeout)
      try {
        const size = 300
        const pad = hasShadow ? 24 : 0
        const canvas = document.createElement('canvas')
        canvas.width = size + pad * 2
        canvas.height = size + pad * 2
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(finalSrc)
          return
        }

        const drawX = pad
        const drawY = pad
        const drawW = size
        const drawH = size

        if (hasShadow) {
          ctx.save()
          ctx.shadowColor = 'rgba(0, 0, 0, 0.28)'
          ctx.shadowBlur = 16
          ctx.shadowOffsetX = 0
          ctx.shadowOffsetY = 4
          ctx.fillStyle = '#ffffff'

          if (shape === 'circle') {
            ctx.beginPath()
            ctx.arc(drawX + drawW / 2, drawY + drawH / 2, drawW / 2, 0, Math.PI * 2)
            ctx.closePath()
            ctx.fill()
          } else if (shape === 'rounded') {
            drawRoundRect(ctx, drawX, drawY, drawW, drawH, Math.round(drawW * 0.22))
            ctx.fill()
          } else {
            drawRoundRect(ctx, drawX, drawY, drawW, drawH, 8)
            ctx.fill()
          }
          ctx.restore()
        }

        ctx.save()
        if (shape === 'circle') {
          ctx.beginPath()
          ctx.arc(drawX + drawW / 2, drawY + drawH / 2, drawW / 2, 0, Math.PI * 2)
          ctx.closePath()
          if (!hasShadow) {
            ctx.fillStyle = '#ffffff'
            ctx.fill()
          }
          ctx.clip()
        } else if (shape === 'rounded') {
          drawRoundRect(ctx, drawX, drawY, drawW, drawH, Math.round(drawW * 0.22))
          if (!hasShadow) {
            ctx.fillStyle = '#ffffff'
            ctx.fill()
          }
          ctx.clip()
        }

        ctx.drawImage(img, drawX, drawY, drawW, drawH)
        ctx.restore()

        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(finalSrc)
      }
    }

    img.onerror = () => {
      clearTimeout(timeout)
      resolve(finalSrc)
    }

    img.src = finalSrc
  })
}

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
  } else if ((dotType as string) === 'circle') {
    dotType = 'dots'
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

  let cornerSquareType = options.cornersSquareOptions?.type
  let cornerDotType = options.cornersDotOptions?.type
  if (options.eyeShape && (!cornerSquareType || cornerSquareType === 'square')) {
    const mapped = mapEyeShapeToCornerOptions(options.eyeShape)
    if (options.eyeShape !== 'square') {
      cornerSquareType = mapped.cornersSquareOptions.type
      cornerDotType = mapped.cornersDotOptions.type
    }
  }

  const cornersSquareOptions: any = {
    type: cornerSquareType || 'square',
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
    type: cornerDotType || 'square',
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

  const logoOpts = options.logoOptions || options.imageOptions
  let finalLogo =
    processedLogoSrc ||
    logoOpts?.src ||
    logoOpts?.url ||
    logoOpts?.dataUrl

  if (!finalLogo && logoOpts?.logoId) {
    finalLogo = getOnlineLogoDataUrl(logoOpts.logoId)
  }

  const imageOptions: any = {
    hideBackgroundDots: logoOpts?.hideBackgroundDots ?? logoOpts?.clearBackground ?? true,
    imageSize: logoOpts?.size ?? logoOpts?.sizeRatio ?? 0.2,
    margin: logoOpts?.margin ?? 6,
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

export class QrEngine {
  private _options: QrStylingOptions
  private _data: string

  constructor(options?: Partial<QrStylingOptions>, data = 'https://example.com') {
    let initialCornersSquare = options?.cornersSquareOptions
    let initialCornersDot = options?.cornersDotOptions
    if (options?.eyeShape && !options.cornersSquareOptions?.type) {
      const mapped = mapEyeShapeToCornerOptions(
        options.eyeShape,
        options.cornersSquareOptions?.color,
        options.cornersDotOptions?.color
      )
      initialCornersSquare = { ...mapped.cornersSquareOptions, ...options.cornersSquareOptions }
      initialCornersDot = { ...mapped.cornersDotOptions, ...options.cornersDotOptions }
    }

    this._options = {
      ...DEFAULT_QR_OPTIONS,
      ...options,
      dotsOptions: { ...DEFAULT_QR_OPTIONS.dotsOptions, ...options?.dotsOptions },
      cornersSquareOptions: {
        ...DEFAULT_QR_OPTIONS.cornersSquareOptions,
        ...initialCornersSquare,
      },
      cornersDotOptions: {
        ...DEFAULT_QR_OPTIONS.cornersDotOptions,
        ...initialCornersDot,
      },
      backgroundOptions: {
        ...DEFAULT_QR_OPTIONS.backgroundOptions,
        ...options?.backgroundOptions,
      },
      frameOptions: { ...DEFAULT_QR_OPTIONS.frameOptions, ...options?.frameOptions },
      textOptions: {
        ...DEFAULT_QR_OPTIONS.textOptions,
        ...options?.textOptions,
        ...(options?.caption || {}),
      },
      logoOptions: {
        ...options?.logoOptions,
        ...(options?.imageOptions || {}),
      },
    }
    this._data = data
  }

  public getOptions(): QrStylingOptions {
    return this._options
  }

  public setOptions(options: Partial<QrStylingOptions>): void {
    let cornersSquare = options.cornersSquareOptions
    let cornersDot = options.cornersDotOptions
    if (options.eyeShape && !options.cornersSquareOptions?.type) {
      const mapped = mapEyeShapeToCornerOptions(
        options.eyeShape,
        options.cornersSquareOptions?.color ?? this._options.cornersSquareOptions?.color,
        options.cornersDotOptions?.color ?? this._options.cornersDotOptions?.color
      )
      cornersSquare = { ...mapped.cornersSquareOptions, ...options.cornersSquareOptions }
      cornersDot = { ...mapped.cornersDotOptions, ...options.cornersDotOptions }
    }

    this._options = {
      ...this._options,
      ...options,
      dotsOptions: { ...this._options.dotsOptions, ...options.dotsOptions },
      cornersSquareOptions: {
        ...this._options.cornersSquareOptions,
        ...cornersSquare,
      },
      cornersDotOptions: { ...this._options.cornersDotOptions, ...cornersDot },
      backgroundOptions: { ...this._options.backgroundOptions, ...options.backgroundOptions },
      frameOptions: { ...this._options.frameOptions, ...options.frameOptions },
      textOptions: {
        ...this._options.textOptions,
        ...options.textOptions,
        ...(options.caption || {}),
      },
      logoOptions: {
        ...this._options.logoOptions,
        ...options.logoOptions,
        ...(options.imageOptions || {}),
      },
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

  public async renderCanvas(width = 1000, height = 1000): Promise<HTMLCanvasElement> {
    const logoOpts = this._options.logoOptions || this._options.imageOptions
    const rawLogoSrc =
      logoOpts?.src ||
      logoOpts?.url ||
      logoOpts?.dataUrl ||
      (logoOpts?.logoId ? getOnlineLogoDataUrl(logoOpts.logoId) : undefined)
    const processedLogo = await prepareStyledLogo(rawLogoSrc, logoOpts)

    const stylingOpts = buildQrCodeStylingOptions(
      this._options,
      this._data,
      width,
      height,
      'canvas',
      processedLogo
    )

    const qr = new QRCodeStyling(stylingOpts)
    let baseCanvas: HTMLCanvasElement | null = null

    try {
      if (typeof (qr as any)._getElement === 'function') {
        const elem = await (qr as any)._getElement('canvas')
        if (elem && elem.getContext) {
          baseCanvas = elem as HTMLCanvasElement
        }
      }
    } catch {
      baseCanvas = null
    }

    if (!baseCanvas) {
      const tempContainer = document.createElement('div')
      qr.append(tempContainer)
      baseCanvas = tempContainer.querySelector('canvas') as HTMLCanvasElement | null
    }

    if (!baseCanvas) {
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

    let composited = baseCanvas
    if (this._options.frameOptions && this._options.frameOptions.type !== 'none') {
      composited = applyFrame(composited, this._options.frameOptions, bgColor)
    }

    const textOpts = this._options.textOptions || this._options.caption
    if (textOpts?.enabled && textOpts.content?.trim()) {
      composited = applyTextCaption(composited, textOpts, bgColor)
    }

    return composited
  }

  public async renderSvg(width = 1000, height = 1000): Promise<string> {
    const logoOpts = this._options.logoOptions || this._options.imageOptions
    const rawLogoSrc =
      logoOpts?.src ||
      logoOpts?.url ||
      logoOpts?.dataUrl ||
      (logoOpts?.logoId ? getOnlineLogoDataUrl(logoOpts.logoId) : undefined)
    const processedLogo = await prepareStyledLogo(rawLogoSrc, logoOpts)

    const stylingOpts = buildQrCodeStylingOptions(
      this._options,
      this._data,
      width,
      height,
      'svg',
      processedLogo
    )

    const qr = new QRCodeStyling(stylingOpts)
    let svgElement: SVGElement | null = null

    try {
      if (typeof (qr as any)._getElement === 'function') {
        const elem = await (qr as any)._getElement('svg')
        if (elem && elem.outerHTML) {
          svgElement = elem as SVGElement
        }
      }
    } catch {
      svgElement = null
    }

    if (!svgElement) {
      const tempContainer = document.createElement('div')
      qr.append(tempContainer)
      svgElement = tempContainer.querySelector('svg')
    }

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

    if (this._options.frameOptions && this._options.frameOptions.type !== 'none') {
      const canvas = await this.renderCanvas(width, height)
      const dataUrl = canvas.toDataURL('image/png')
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><image href="${dataUrl}" width="${canvas.width}" height="${canvas.height}"/></svg>`
    }

    const textOpts = this._options.textOptions || this._options.caption
    if (textOpts?.enabled && textOpts.content?.trim()) {
      svgString = applyTextCaptionToSvg(svgString, textOpts, bgColor)
    }

    return svgString
  }

  public async append(container: HTMLElement, width = 300, height = 300): Promise<void> {
    if (!container) return
    container.innerHTML = ''
    const canvas = await this.renderCanvas(width, height)
    canvas.style.maxWidth = '100%'
    canvas.style.height = 'auto'
    container.appendChild(canvas)
  }
}
