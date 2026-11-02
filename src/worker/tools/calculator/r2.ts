import { ApiError } from '../../lib/errors'
import { ASSET_PNG_MAX_BYTES, ASSET_TEXT_MAX_BYTES, CALCULATOR_R2_PATHS } from '@shared/tools/calculator/contract'

export type CalculatorAssetKind = 'graph_png' | 'history_txt' | 'backup_json'
export type CalculatorAssetFormat = 'png' | 'txt' | 'json'

const MIME: Record<CalculatorAssetFormat, string> = {
  png: 'image/png',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
}

export function getCalculatorContentType(format: CalculatorAssetFormat): string {
  return MIME[format]
}

export function getCalculatorFolder(kind: CalculatorAssetKind): string {
  if (kind === 'graph_png') return CALCULATOR_R2_PATHS.images
  if (kind === 'history_txt') return CALCULATOR_R2_PATHS.text
  return CALCULATOR_R2_PATHS.json
}

export function getCalculatorR2Key(userId: string, assetId: string, kind: CalculatorAssetKind, format: CalculatorAssetFormat): string {
  return `calculator/${getCalculatorFolder(kind)}/${userId}/${assetId}.${format}`
}

export function isCalculatorR2KeyOwnedBy(key: string, userId: string): boolean {
  return key.startsWith(`calculator/${CALCULATOR_R2_PATHS.images}/${userId}/`) ||
    key.startsWith(`calculator/${CALCULATOR_R2_PATHS.text}/${userId}/`) ||
    key.startsWith(`calculator/${CALCULATOR_R2_PATHS.json}/${userId}/`)
}

export function validatePngBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
}

export function decodeAssetPayload(dataBase64: string): Uint8Array {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(dataBase64)
  const raw = (match ? match[1] : dataBase64).trim()
  try {
    const binary = atob(raw)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    throw ApiError.badRequest('Invalid base64 payload')
  }
}

export async function uploadCalculatorAsset(
  r2: R2Bucket | undefined,
  userId: string,
  assetId: string,
  kind: CalculatorAssetKind,
  format: CalculatorAssetFormat,
  bytes: Uint8Array,
): Promise<{ key: string; size: number }> {
  if (!r2) throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  const limit = format === 'png' ? ASSET_PNG_MAX_BYTES : ASSET_TEXT_MAX_BYTES
  if (bytes.byteLength > limit) {
    throw ApiError.tooLarge(`Calculator assets are limited to ${Math.floor(limit / 1024)} KB`)
  }
  if (format === 'png' && !validatePngBytes(bytes)) throw ApiError.badRequest('Invalid PNG payload')
  const key = getCalculatorR2Key(userId, assetId, kind, format)
  await r2.put(key, bytes, { httpMetadata: { contentType: getCalculatorContentType(format) } })
  return { key, size: bytes.byteLength }
}

export async function readCalculatorAsset(r2: R2Bucket | undefined, key: string): Promise<R2ObjectBody | null> {
  if (!r2) throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  return r2.get(key)
}

export async function deleteCalculatorAsset(r2: R2Bucket | undefined, key: string): Promise<void> {
  if (!r2) throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured')
  await r2.delete(key)
}
