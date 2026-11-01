/**
 * Cloudflare R2 storage driver for the Color Assistant module (`tools/color`).
 *
 * Strict key naming convention:
 * `tools/color/{format}/{userId}/{assetId}.{format}`
 * where format is normalized to png, jpg, svg, or ase.
 */

export function normalizeColorFormat(format: string): 'png' | 'jpg' | 'svg' | 'ase' {
  const clean = format.toLowerCase().trim().replace(/^\./, '')
  if (clean === 'jpeg') return 'jpg'
  if (clean === 'svg' || clean === 'svg+xml') return 'svg'
  if (clean === 'ase') return 'ase'
  if (clean === 'jpg') return 'jpg'
  return 'png'
}

export function getColorContentType(format: string): string {
  const clean = normalizeColorFormat(format)
  switch (clean) {
    case 'jpg':
      return 'image/jpeg'
    case 'svg':
      return 'image/svg+xml'
    case 'ase':
      return 'application/octet-stream'
    case 'png':
    default:
      return 'image/png'
  }
}

/**
 * Does the payload actually contain what its format claims?
 *
 * The route used to trust the MIME the client put in its data URL, which meant the stored object — and the
 * response header handed back on download — could say anything at all, including `text/html` served from
 * the application's own origin. The format is now the only authority, and this is where the two are
 * checked against each other.
 */
export function colorAssetLooksValid(format: string, bytes: Uint8Array): boolean {
  const startsWith = (signature: number[]) =>
    bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte)

  switch (normalizeColorFormat(format)) {
    case 'png':
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpg':
      return startsWith([0xff, 0xd8, 0xff])
    case 'ase':
      return startsWith([0x41, 0x53, 0x45, 0x46])
    case 'svg': {
      const text = new TextDecoder().decode(bytes)
      if (!/^\s*<\?xml[\s\S]*?<svg/i.test(text) && !/^\s*<svg/i.test(text)) return false
      // SVG is served as a document on this origin, so anything that could run there is refused even
      // though the CSP would probably stop it.
      return !/<\s*script|onload\s*=|on\w+\s*=\s*["']|javascript:|<\s*foreignobject/i.test(text)
    }
  }
}

/**
 * Returns canonical R2 key matching user specification:
 * `tools/color/{png,jpg,...}/xxx`
 */
export function getColorR2Key(userId: string, assetId: string, format: string): string {
  const normFormat = normalizeColorFormat(format)
  return `tools/color/${normFormat}/${userId}/${assetId}.${normFormat}`
}

/**
 * Uploads an asset (PNG/JPG/SVG/ASE) to R2 bucket.
 * Returns the stored R2 key.
 */
export async function uploadColorAssetToR2(
  files: R2Bucket | undefined,
  userId: string,
  assetId: string,
  format: string,
  data: Uint8Array | ArrayBuffer | string,
  customContentType?: string,
): Promise<string> {
  const key = getColorR2Key(userId, assetId, format)
  if (!files) {
    // If R2 is not configured in this environment, return key without throwing
    return key
  }

  const contentType = customContentType || getColorContentType(format)
  await files.put(key, data, {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      userId,
      assetId,
      format: normalizeColorFormat(format),
      uploadedAt: String(Date.now()),
    },
  })

  return key
}

/**
 * Reads an asset from R2 by key.
 */
export async function readColorAssetFromR2(
  files: R2Bucket | undefined,
  r2Key: string,
): Promise<{ data: Uint8Array; contentType: string } | null> {
  if (!files) return null

  const obj = await files.get(r2Key)
  if (!obj) return null

  const buffer = await obj.arrayBuffer()
  const contentType = obj.httpMetadata?.contentType || 'application/octet-stream'
  return {
    data: new Uint8Array(buffer),
    contentType,
  }
}

/**
 * Deletes an asset from R2 by key.
 */
export async function deleteColorAssetFromR2(
  files: R2Bucket | undefined,
  r2Key: string,
): Promise<boolean> {
  if (!files) return true
  await files.delete(r2Key)
  return true
}
