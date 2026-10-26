import { ApiError } from '../../lib/errors'

export type IdPhotoR2Format = 'jpg' | 'png' | 'webp'

export function normalizeIdPhotoFormat(format: string): IdPhotoR2Format {
  const lower = format.toLowerCase().trim().replace(/^\./, '')
  if (lower === 'png') return 'png'
  if (lower === 'webp') return 'webp'
  return 'jpg'
}

export function getIdPhotoContentType(format: string): string {
  const norm = normalizeIdPhotoFormat(format)
  switch (norm) {
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'jpg':
      return 'image/jpeg'
  }
}

export function getIdPhotoR2Key(userId: string, recordId: string, format: string): string {
  const ext = normalizeIdPhotoFormat(format)
  return `tools/id_photo/${ext}/${userId}/${recordId}.${ext}`
}

export function getIdPhotoPrintR2Key(userId: string, recordId: string, format: string): string {
  const ext = normalizeIdPhotoFormat(format)
  return `tools/id_photo/print/${userId}/${recordId}_print.${ext}`
}

export async function uploadIdPhotoToR2(
  r2: R2Bucket | undefined,
  userId: string,
  recordId: string,
  format: string,
  data: Uint8Array | ArrayBuffer | string,
  isPrintSheet = false,
): Promise<{ key: string; size: number }> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const key = isPrintSheet
    ? getIdPhotoPrintR2Key(userId, recordId, format)
    : getIdPhotoR2Key(userId, recordId, format)
  const contentType = getIdPhotoContentType(format)

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

export async function readIdPhotoFromR2(
  r2: R2Bucket | undefined,
  key: string,
): Promise<R2ObjectBody | null> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  const obj = await r2.get(key)
  return obj
}

export async function deleteIdPhotoFromR2(
  r2: R2Bucket | undefined,
  key: string,
): Promise<void> {
  if (!r2 || !key) return
  await r2.delete(key)
}
