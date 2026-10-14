


export function readImageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
  try {
    if (!hasExpectedImageSignature(bytes, mime)) return null
    if (mime === 'image/png') return pngSize(bytes)
    if (mime === 'image/jpeg') return jpegSize(bytes)
    if (mime === 'image/gif') return gifSize(bytes)
    if (mime === 'image/webp') return webpSize(bytes)
  } catch {
    // A header that reads as an image but does not survive the walk is a truncated or hostile file,
    // and `null` is the answer the caller was already built for: it fails the dimension check and the
    // attachment is stored as `application/octet-stream`, so the sniffing result is the handling.
  }
  return null
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function pngSize(b: Uint8Array) {
  if (b.length < 24 || ascii(b, 12, 16) !== 'IHDR') return null
  const dv = view(b)
  return { width: dv.getUint32(16), height: dv.getUint32(20) }
}

function gifSize(b: Uint8Array) {
  if (b.length < 10) return null
  const dv = view(b)
  return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) }
}

function jpegSize(b: Uint8Array) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  const dv = view(b)
  let offset = 2
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = b[offset + 1]!

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: dv.getUint16(offset + 5), width: dv.getUint16(offset + 7) }
    }
    offset += 2 + dv.getUint16(offset + 2)
  }
  return null
}

function webpSize(b: Uint8Array) {
  if (b.length < 30) return null
  const dv = view(b)
  const format = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
  if (format === 'VP8 ') {
    return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff }
  }
  if (format === 'VP8L') {
    const bits = dv.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (format === 'VP8X') {
    const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1
    const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1
    return { width: w, height: h }
  }
  return null
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}


export function hasExpectedImageSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/png') {
    return bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      ascii(bytes, 1, 4) === 'PNG' &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
  }
  if (mime === 'image/jpeg') {
    return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (mime === 'image/gif') {
    const header = ascii(bytes, 0, 6)
    return header === 'GIF87a' || header === 'GIF89a'
  }
  if (mime === 'image/webp') {
    return bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP'
  }
  if (mime === 'image/avif') {
    if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return false
    const boxSize = view(bytes).getUint32(0)
    if (boxSize < 16 || boxSize > bytes.length) return false
    for (let offset = 8; offset + 4 <= Math.min(boxSize, 64); offset += 4) {
      const brand = ascii(bytes, offset, offset + 4)
      if (brand === 'avif' || brand === 'avis') return true
    }
    return false
  }
  return false
}

export function hasReasonableImageDimensions(
  dimensions: { width: number; height: number } | null,
): boolean {
  if (!dimensions) return true
  const { width, height } = dimensions
  return Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= 65_535 &&
    height <= 65_535 &&
    width * height <= 100_000_000
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/zip': 'zip',
  'application/json': 'json',
}

export function extensionFor(mime: string, filename: string): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]
  return (fromName || EXT_BY_MIME[mime] || 'bin').toLowerCase()
}


export const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/zip',
  'application/octet-stream',
])


export function safeAttachmentMime(bytes: Uint8Array, reportedMime: string): string {
  const normalized = reportedMime.trim().toLowerCase().split(';', 1)[0] || 'application/octet-stream'
  if (!ALLOWED_MIME.has(normalized)) return 'application/octet-stream'
  if (isInlineSafe(normalized) && !hasExpectedImageSignature(bytes, normalized)) {
    return 'application/octet-stream'
  }
  return normalized
}

export function isInlineSafe(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}
