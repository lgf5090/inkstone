import { ApiError } from '../../lib/errors'

export type QrExportFormat = 'png' | 'jpg' | 'jpeg' | 'svg' | 'webp'

export function normalizeQrFormat(format: string): 'png' | 'jpg' | 'svg' | 'webp' {
  const lower = format.toLowerCase().trim().replace(/^\./, '')
  if (lower === 'jpeg' || lower === 'jpg') return 'jpg'
  if (lower === 'svg') return 'svg'
  if (lower === 'webp') return 'webp'
  return 'png'
}

export function getQrContentType(format: string): string {
  const norm = normalizeQrFormat(format)
  switch (norm) {
    case 'png':
      return 'image/png'
    case 'jpg':
      return 'image/jpeg'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
  }
}

export function getQrCodeR2Key(userId: string, recordId: string, format: string): string {
  const ext = normalizeQrFormat(format)
  return `tools/qrcode/${ext}/${userId}/${recordId}.${ext}`
}

export function getLogoR2Key(userId: string, logoId: string, ext: string): string {
  const cleanExt = normalizeQrFormat(ext)
  return `tools/qrcode/logo/${userId}/${logoId}.${cleanExt}`
}

export async function uploadQrCodeToR2(
  r2: R2Bucket | undefined,
  userId: string,
  recordId: string,
  format: string,
  data: Uint8Array | ArrayBuffer | string,
): Promise<{ key: string; size: number }> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const key = getQrCodeR2Key(userId, recordId, format)
  const contentType = getQrContentType(format)

  let bytes: Uint8Array
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data)
  } else if (data instanceof Uint8Array) {
    bytes = data
  } else {
    bytes = new Uint8Array(data)
  }

  await r2.put(key, bytes, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  return { key, size: bytes.byteLength }
}

export async function readQrCodeFromR2(
  r2: R2Bucket | undefined,
  key: string,
): Promise<R2ObjectBody | null> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const obj = await r2.get(key)
  return obj
}

export async function deleteQrCodeFromR2(
  r2: R2Bucket | undefined,
  key: string,
): Promise<void> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  await r2.delete(key)
}

export async function uploadLogoToR2(
  r2: R2Bucket | undefined,
  userId: string,
  logoId: string,
  ext: string,
  data: Uint8Array | ArrayBuffer,
  contentType?: string,
): Promise<{ key: string; size: number }> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const key = getLogoR2Key(userId, logoId, ext)
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const resolvedContentType = contentType || getQrContentType(ext)

  await r2.put(key, bytes, {
    httpMetadata: {
      contentType: resolvedContentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  return { key, size: bytes.byteLength }
}
