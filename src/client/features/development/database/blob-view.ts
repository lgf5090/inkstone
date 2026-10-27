import { INKSTONE_BLOB_KEY } from '@shared/development/database/types'

export function blobBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value && typeof value === 'object' && INKSTONE_BLOB_KEY in value) {
    const encoded = (value as Record<string, unknown>)[INKSTONE_BLOB_KEY]
    if (typeof encoded !== 'string') return null
    try {
      const binary = atob(encoded)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      return bytes
    } catch {
      return null
    }
  }
  return null
}

export function isBlobLike(value: unknown): boolean {
  return blobBytes(value) !== null
}

export function hexDump(bytes: Uint8Array, limit = 4096): { text: string; truncated: boolean } {
  const size = Math.min(bytes.length, Math.max(0, limit))
  const lines: string[] = []
  for (let offset = 0; offset < size; offset += 16) {
    const chunk = bytes.subarray(offset, Math.min(offset + 16, size))
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ')
    const ascii = Array.from(chunk, (byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('')
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`)
  }
  return { text: lines.join('\n'), truncated: bytes.length > size }
}

const IMAGE_URL = /^https?:\/\/[^\s]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s]*)?$/i
const IMAGE_DATA = /^data:image\/[a-z0-9.+-]+;base64,/i

export function imageSource(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (IMAGE_DATA.test(text)) return text
  if (IMAGE_URL.test(text)) return text
  return null
}

export function blobFileName(column: string, bytes: Uint8Array): string {
  const base = column.replace(/[\\/:*?"<>|]+/g, '-') || 'blob'
  const extension = bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ? 'png'
    : bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? 'jpg'
      : bytes.length > 3 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
        ? 'pdf'
        : 'bin'
  return `${base}.${extension}`
}
