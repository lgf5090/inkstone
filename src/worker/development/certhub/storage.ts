import { sha256Hex, utf8 } from '../../lib/encoding'
import { ApiError } from '../../lib/errors'
import { isValidId } from '../../lib/id'
import type { Env } from '../../env'

export type CerthubObjectKind = 'certs' | 'chains' | 'csr' | 'keys' | 'exports'

export interface CerthubObjectRef {
  key: string
  sha256: string
  kind: CerthubObjectKind
}

export function assertUserId(userId: string): void {
  if (!isValidId(userId)) throw ApiError.badRequest('The account id is not valid')
}

function bucket(env: Env): R2Bucket {
  if (!env.FILES) throw new ApiError(503, 'storage_unavailable', 'R2 storage is not configured on this deployment')
  return env.FILES
}

export function certhubObjectKey(
  kind: CerthubObjectKind,
  userId: string,
  orderId: string,
  fileName: string,
): string {
  assertUserId(userId)
  if (!isValidId(orderId)) throw ApiError.badRequest('The order id is not valid')
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '')
  return `development/certhub/${kind}/${userId}/${orderId}/${safe}`
}

export async function putCerthubText(
  env: Env,
  key: string,
  content: string,
  contentType: string,
  metadata: Record<string, string>,
): Promise<CerthubObjectRef> {
  const sha256 = await sha256Hex(content)
  await bucket(env).put(key, utf8(content), {
    httpMetadata: { contentType },
    customMetadata: { ...metadata, sha256 },
  })
  return { key, sha256, kind: key.split('/')[2] as CerthubObjectKind }
}

export async function putCerthubBytes(
  env: Env,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  metadata: Record<string, string>,
): Promise<CerthubObjectRef> {
  const sha256 = await sha256Hex(bytes)
  await bucket(env).put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { ...metadata, sha256 },
  })
  return { key, sha256, kind: key.split('/')[2] as CerthubObjectKind }
}

export async function readCerthubText(env: Env, key: string): Promise<string | null> {
  if (!key) return null
  const object = await bucket(env).get(key)
  if (!object) return null
  return object.text()
}

export async function readCerthubBytes(env: Env, key: string): Promise<Uint8Array | null> {
  if (!key) return null
  const object = await bucket(env).get(key)
  if (!object) return null
  return new Uint8Array(await object.arrayBuffer())
}

export async function deleteCerthubObjects(env: Env, keys: string[]): Promise<void> {
  const unique = [...new Set(keys.filter((key) => key.length > 0))]
  if (unique.length === 0) return
  await bucket(env).delete(unique)
}

export async function verifyCerthubObject(env: Env, key: string, expectedSha256: string): Promise<boolean> {
  const object = await bucket(env).get(key)
  if (!object) return false
  const stored = object.customMetadata?.sha256 ?? ''
  if (stored && stored !== expectedSha256) return false
  return true
}
