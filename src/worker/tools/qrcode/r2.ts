/**
 * R2 storage helpers for QR Code generated assets and uploaded logos.
 *
 * Path invariants:
 * - Rendered QR: `tools/qrcode/{png,jpg,svg,webp}/${userId}/${recordId}.${ext}`
 * - Custom Logo: `tools/qrcode/logo/${userId}/${logoId}.${ext}`
 */

import { ApiError } from '../../lib/errors'

export type QrExportFormat = 'png' | 'jpg' | 'jpeg' | 'svg' | 'webp'

/**
 * Normalizes image format extension and directory name.
 * Maps 'jpeg' -> 'jpg', otherwise keeps standard format.
 */
export function normalizeQrFormat(format: string): 'png' | 'jpg' | 'svg' | 'webp' {
  const lower = format.toLowerCase().trim().replace(/^\./, '')
  if (lower === 'jpeg' || lower === 'jpg') return 'jpg'
  if (lower === 'svg') return 'svg'
  if (lower === 'webp') return 'webp'
  return 'png'
}

/**
 * Resolves standard MIME content-type for QR formats.
 */
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

/**
 * Returns the canonical R2 storage key for a generated QR code image.
 * Pattern: `tools/qrcode/{png,jpg,svg,webp}/${userId}/${recordId}.${ext}`
 */
export function getQrCodeR2Key(userId: string, recordId: string, format: string): string {
  const ext = normalizeQrFormat(format)
  return `tools/qrcode/${ext}/${userId}/${recordId}.${ext}`
}

/**
 * Returns the canonical R2 storage key for an uploaded logo image.
 * Pattern: `tools/qrcode/logo/${userId}/${logoId}.${ext}`
 */
export function getLogoR2Key(userId: string, logoId: string, ext: string): string {
  const cleanExt = normalizeQrFormat(ext)
  return `tools/qrcode/logo/${userId}/${logoId}.${cleanExt}`
}

/**
 * Uploads a rendered QR code image or SVG vector to R2.
 */
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

/**
 * Reads an object from R2 storage.
 */
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

/**
 * Deletes an object from R2 storage.
 */
export async function deleteQrCodeFromR2(
  r2: R2Bucket | undefined,
  key: string,
): Promise<void> {
  if (!r2) {
    throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  }

  await r2.delete(key)
}

/**
 * Uploads a user custom logo image to R2 storage.
 */
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
