export type PreviewMode = 'stroke' | 'fill' | 'multi'

function escapeAttribute(value: string): string {
  return value.replace(/"/g, '&quot;')
}

/**
 * Stroke libraries paint through the wrapper, fill libraries through their own paths, and brand sets
 * keep their own colours. The body is already sanitized on the way in, so the only rewrite here is
 * the colour a reader is previewing.
 */
export function buildPreviewSvg(
  body: string,
  viewBox: string,
  options: { size: number; stroke: number; color: string; mode: PreviewMode },
): string {
  const { size, stroke, color, mode } = options
  const safeColor = color === 'currentColor' || /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : 'currentColor'
  const safeViewBox = /^-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)?$/.test(viewBox) ? viewBox : '0 0 24 24'
  let inner = body
  if (mode === 'stroke') {
    inner = inner
      .replace(/\bstroke-width="[^"]*"/gi, `stroke-width="${stroke}"`)
      .replace(/\bstroke="(?!none)[^"]*"/gi, 'stroke="currentColor"')
      .replace(/\bfill="(?!none)[^"]*"/gi, 'fill="currentColor"')
  } else if (mode === 'fill') {
    inner = inner
      .replace(/\bfill="(?!none)[^"]*"/gi, 'fill="currentColor"')
      .replace(/\bstroke="(?!none)[^"]*"/gi, 'stroke="none"')
  }
  const paint = mode === 'stroke'
    ? `fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"`
    : mode === 'fill'
      ? 'fill="currentColor" stroke="none"'
      : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${escapeAttribute(safeViewBox)}" ${paint} style="color:${safeColor}">${inner}</svg>`
}

export function pngBlobFromSvg(svg: string, size: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const source = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(source)
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')
      if (!context) {
        URL.revokeObjectURL(url)
        reject(new Error('Canvas is unavailable'))
        return
      }
      context.drawImage(image, 0, 0, size, size)
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url)
        if (blob) resolve(blob)
        else reject(new Error('PNG encoding failed'))
      }, 'image/png')
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('SVG decoding failed'))
    }
    image.src = url
  })
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function inferPreviewMode(body: string, collectionStyle?: 'line' | 'fill' | 'mixed' | 'brand'): PreviewMode {
  if (collectionStyle === 'brand') return 'multi'
  if (collectionStyle === 'line') return 'stroke'
  if (collectionStyle === 'fill') return 'fill'
  return /\bstroke=/.test(body) ? 'stroke' : 'fill'
}
