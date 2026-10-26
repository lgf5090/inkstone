import { ATTIRE_PRESETS } from '@shared/tools/id-photo/presets'
import type { IdPhotoAdjustOptions, IdPhotoExportFormat, IdPhotoSpec } from '@shared/tools/id-photo/types'
import { applyImageFilters, renderBackground } from './background-matting'
import { calculateOptimalCrop } from './face-align'

export class IdPhotoEngine {
  constructor(
    private readonly spec: IdPhotoSpec,
    private readonly options: IdPhotoAdjustOptions,
  ) {}

  /**
   * Renders the ID photo onto an HTMLCanvasElement with target dimensions and full adjustments.
   */
  async renderCanvas(
    sourceImage: HTMLImageElement | HTMLCanvasElement,
    overrideWidth?: number,
    overrideHeight?: number,
  ): Promise<HTMLCanvasElement> {
    const targetWidth = overrideWidth ?? this.spec.widthPx
    const targetHeight = overrideHeight ?? this.spec.heightPx

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight

    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return canvas

    // 1. Draw Background
    renderBackground(
      ctx,
      targetWidth,
      targetHeight,
      this.options.bgColor,
      this.options.bgType === 'gradient',
      this.options.bgGradientEndColor,
    )

    // 2. Compute Crop Frame
    const sourceWidth = 'naturalWidth' in sourceImage ? sourceImage.naturalWidth : sourceImage.width
    const sourceHeight =
      'naturalHeight' in sourceImage ? sourceImage.naturalHeight : sourceImage.height

    let cropX = this.options.cropX
    let cropY = this.options.cropY
    let cropW = this.options.cropWidth
    let cropH = this.options.cropHeight

    if (cropX === undefined || cropY === undefined || !cropW || !cropH) {
      const optimal = calculateOptimalCrop(
        sourceWidth,
        sourceHeight,
        targetWidth,
        targetHeight,
        undefined,
        (this.spec.faceRatioMin + this.spec.faceRatioMax) / 2,
      )
      cropX = optimal.cropX
      cropY = optimal.cropY
      cropW = optimal.cropWidth
      cropH = optimal.cropHeight
    }

    // 3. Draw Portrait
    ctx.save()
    if (this.options.rotation) {
      ctx.translate(targetWidth / 2, targetHeight / 2)
      ctx.rotate((this.options.rotation * Math.PI) / 180)
      ctx.translate(-targetWidth / 2, -targetHeight / 2)
    }

    ctx.drawImage(sourceImage, cropX, cropY, cropW, cropH, 0, 0, targetWidth, targetHeight)
    ctx.restore()

    // 4. Pixel Filters (brightness, contrast, whitening)
    applyImageFilters(ctx, targetWidth, targetHeight, {
      brightness: this.options.brightness,
      contrast: this.options.contrast,
      whitening: this.options.whitening,
    })

    // 5. Attire Overlay (if selected)
    if (this.options.attireId) {
      await this.drawAttire(ctx, targetWidth, targetHeight)
    }

    return canvas
  }

  private async drawAttire(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): Promise<void> {
    const attire = ATTIRE_PRESETS.find((a) => a.id === this.options.attireId)
    if (!attire) return

    const img = new Image()
    const svgBlob = new Blob([attire.previewSvg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)

    await new Promise<void>((resolve) => {
      img.onload = () => {
        const scale = this.options.attireScale ?? 1.0
        const offsetX = this.options.attireOffsetX ?? 0
        const offsetY = this.options.attireOffsetY ?? 0

        const attireW = width * scale
        const attireH = (height * 0.5) * scale
        const attireX = (width - attireW) / 2 + offsetX
        const attireY = height - attireH + offsetY

        ctx.drawImage(img, attireX, attireY, attireW, attireH)
        URL.revokeObjectURL(url)
        resolve()
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        resolve()
      }
      img.src = url
    })
  }

  /**
   * Exports rendered canvas as data URL with optional adaptive JPEG quality to meet KB limits.
   */
  async exportDataUrl(
    sourceImage: HTMLImageElement | HTMLCanvasElement,
    format: IdPhotoExportFormat = 'jpg',
    targetMaxKb?: number,
  ): Promise<string> {
    const canvas = await this.renderCanvas(sourceImage)
    const mime = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg'

    if (format === 'png' || !targetMaxKb) {
      return canvas.toDataURL(mime, 0.92)
    }

    // Adaptive compression for government portals requiring < MaxKB
    let minQ = 0.3
    let maxQ = 0.95
    let bestUrl = canvas.toDataURL(mime, maxQ)

    for (let i = 0; i < 4; i++) {
      const midQ = (minQ + maxQ) / 2
      const candidate = canvas.toDataURL(mime, midQ)
      const approxKb = Math.round((candidate.length * 3) / 4 / 1024)

      if (approxKb <= targetMaxKb) {
        bestUrl = candidate
        minQ = midQ
      } else {
        maxQ = midQ
      }
    }

    return bestUrl
  }

  /**
   * Exports rendered photo as a downloadable Blob.
   */
  async exportBlob(
    sourceImage: HTMLImageElement | HTMLCanvasElement,
    format: IdPhotoExportFormat = 'jpg',
  ): Promise<Blob> {
    const canvas = await this.renderCanvas(sourceImage)
    const mime = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg'

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob)
          else reject(new Error('Canvas toBlob failed'))
        },
        mime,
        0.92,
      )
    })
  }

  /**
   * Copies the photo to system clipboard.
   */
  async copyToClipboard(sourceImage: HTMLImageElement | HTMLCanvasElement): Promise<boolean> {
    try {
      const blob = await this.exportBlob(sourceImage, 'png')
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob,
        }),
      ])
      return true
    } catch {
      return false
    }
  }
}
