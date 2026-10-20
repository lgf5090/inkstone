/**
 * Turning a reader's picture into a mark a row can carry.
 *
 * The file is cropped to a square and scaled to 96 px in the browser, then encoded as WebP (or PNG when
 * the browser cannot write WebP). That keeps the row small enough for D1 and avoids storing a whole
 * photograph for a 20 px icon. SVG is deliberately not accepted: it is a document that can carry script,
 * and this path only needs pixels.
 */
import { t } from '../../lib/i18n'
import { MAX_ASSISTANT_ICON_CHARS } from '@shared/assistant-icons'

const MAX_FILE_BYTES = 4 * 1024 * 1024
const ICON_SIZE = 96
const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp'])

async function loadImage(file: File): Promise<{ width: number, height: number, draw: CanvasImageSource, close?: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: bitmap,
      close: () => bitmap.close(),
    }
  }
  const url = URL.createObjectURL(file)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
        draw: image,
        close: () => URL.revokeObjectURL(url),
      })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(t('assistant.icon.upload_failed')))
    }
    image.src = url
  })
}

export async function iconFromFile(file: File): Promise<string> {
  if (!ACCEPTED.has(file.type)) throw new Error(t('assistant.icon.upload_type'))
  if (file.size > MAX_FILE_BYTES) throw new Error(t('assistant.icon.upload_large'))
  const image = await loadImage(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = ICON_SIZE
    canvas.height = ICON_SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error(t('assistant.icon.upload_failed'))
    const scale = Math.max(ICON_SIZE / image.width, ICON_SIZE / image.height)
    const width = image.width * scale
    const height = image.height * scale
    context.drawImage(image.draw, (ICON_SIZE - width) / 2, (ICON_SIZE - height) / 2, width, height)
    const webp = canvas.toDataURL('image/webp', 0.85)
    const data = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png')
    if (data.length > MAX_ASSISTANT_ICON_CHARS) throw new Error(t('assistant.icon.upload_large'))
    return data
  } finally {
    image.close?.()
  }
}
