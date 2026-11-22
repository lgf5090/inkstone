/**
 * R2 storage for the office app.
 *
 * Every key is derived from the account id and either a file id or a content hash; the worker never
 * accepts a key from a caller. Snapshots live under `office/txt` and are immutable (`<rev>.json`),
 * assets under `office/images` and `office/files` and are immutable by construction — the id is the
 * sha256 of the bytes — so both may be cached for as long as the account exists.
 *
 * What an upload *is* is decided from its bytes, never from the declared `Content-Type`: the
 * declared type only gets to choose between the two text flavours once the bytes have proven they
 * are text at all. SVG, HTML/XML and scripts are refused outright, because an attachment surface
 * that serves markup from the application origin is an XSS surface.
 */
import {
  OFFICE_ASSET_MIMES,
  isOfficeAssetMime,
  officeAssetExtension,
} from '@shared/office/constants'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { hasExpectedImageSignature } from '../lib/image'
import { utf8 } from '../lib/encoding'

/** The stored subset of MIME types: the shared allow-list is the single source. */
export type OfficeAssetMime = (typeof OFFICE_ASSET_MIMES)[number]

/** Snapshots are private JSON that changes under a stable URL; nothing may cache them. */
export const OFFICE_SNAPSHOT_CACHE_CONTROL = 'private, no-store'
/** Assets are content-addressed, so the bytes behind an id can never change. */
export const OFFICE_ASSET_CACHE_CONTROL = 'private, max-age=31536000, immutable'
/** The longest display name an asset download may claim. */
export const OFFICE_ASSET_NAME_MAX = 120

/** Extensions a text upload may not carry, whatever its bytes look like. */
const BLOCKED_ASSET_EXTENSIONS = new Set([
  'svg', 'svgz', 'html', 'htm', 'xhtml', 'xml', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'wasm',
])

export function requireOfficeBucket(env: Env): R2Bucket {
  if (!env.FILES) {
    throw new ApiError(
      503,
      'storage_unavailable',
      'Office content requires the R2 binding (FILES). This deployment cannot store office files.',
    )
  }
  return env.FILES
}

function assertKeyPrefix(key: string, prefix: string): void {
  if (!key.startsWith(prefix)) {
    throw new Error(`office object keys must live under the ${prefix} prefix`)
  }
}

/** Write one immutable snapshot revision. */
export async function putOfficeSnapshot(env: Env, key: string, text: string): Promise<void> {
  assertKeyPrefix(key, 'office/txt/')
  const bucket = requireOfficeBucket(env)
  await bucket.put(key, utf8(text), {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: OFFICE_SNAPSHOT_CACHE_CONTROL,
    },
    customMetadata: { kind: 'snapshot' },
  })
}

/** Read one snapshot revision as text; `null` means the object is gone. */
export async function readOfficeSnapshot(env: Env, key: string): Promise<string | null> {
  assertKeyPrefix(key, 'office/txt/')
  const bucket = requireOfficeBucket(env)
  const object = await bucket.get(key)
  return object ? await object.text() : null
}

/** Whether one revision object already exists; used to refuse a stale write before it overwrites. */
export async function officeSnapshotExists(env: Env, key: string): Promise<boolean> {
  assertKeyPrefix(key, 'office/txt/')
  const bucket = requireOfficeBucket(env)
  return (await bucket.head(key)) !== null
}

/** Copy an object byte-for-byte onto a new key, keeping its metadata. */
export async function copyOfficeObject(env: Env, fromKey: string, toKey: string): Promise<boolean> {
  assertKeyPrefix(fromKey, 'office/')
  assertKeyPrefix(toKey, 'office/')
  const bucket = requireOfficeBucket(env)
  const object = await bucket.get(fromKey)
  if (!object) return false
  const bytes = new Uint8Array(await object.arrayBuffer())
  await bucket.put(toKey, bytes, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
  })
  return true
}

/** Write one content-addressed asset. */
export async function putOfficeAsset(
  env: Env,
  key: string,
  bytes: Uint8Array,
  mime: OfficeAssetMime,
): Promise<void> {
  if (!key.startsWith('office/images/') && !key.startsWith('office/files/')) {
    throw new Error('office asset keys must live under the office/images or office/files prefix')
  }
  const bucket = requireOfficeBucket(env)
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: OFFICE_ASSET_CACHE_CONTROL },
    customMetadata: { kind: 'asset' },
  })
}

export async function readOfficeAsset(env: Env, key: string): Promise<R2ObjectBody | null> {
  if (!key.startsWith('office/images/') && !key.startsWith('office/files/')) {
    throw new Error('office asset keys must live under the office/images or office/files prefix')
  }
  const bucket = requireOfficeBucket(env)
  return await bucket.get(key)
}

/**
 * Delete objects after their rows are gone.
 *
 * Strict on purpose: the caller that purges a file has already decided the bytes must not exist,
 * and a silent failure would leave them reachable by anyone who kept the URL.
 */
export async function deleteOfficeObjects(env: Env, keys: readonly string[]): Promise<void> {
  const unique = [...new Set(keys.filter((key) => key.length > 0))]
  if (!unique.length) return
  for (const key of unique) assertKeyPrefix(key, 'office/')
  const bucket = requireOfficeBucket(env)
  await bucket.delete(unique)
}

/**
 * Best-effort variant for paths where the user-visible operation already succeeded (a losing
 * snapshot write, a version trim). The object is unreachable from D1, so a leftover is garbage for
 * the P2 sweep rather than a correctness problem.
 */
export async function discardOfficeObjects(env: Env, keys: readonly string[]): Promise<void> {
  try {
    await deleteOfficeObjects(env, keys)
  } catch (error) {
    // The row that named these keys is already gone or never existed; log and let the sweep retry.
    console.warn('[inkstone] Office object cleanup failed; the bytes are unreferenced:', error)
  }
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false
  for (let index = 0; index < text.length; index++) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

/**
 * Text that is safe to serve back as a download: valid UTF-8, no NUL, no markup or script source.
 *
 * `<` as the first non-space character is refused because that is where SVG, HTML and XML all
 * begin; the name check below refuses script extensions that no byte signature can identify.
 */
function isPlainText(bytes: Uint8Array): boolean {
  if (!bytes.length) return false
  for (const byte of bytes) if (byte === 0) return false
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return false
  }
  const head = text.replace(/^\uFEFF/, '').trimStart()
  if (!head) return true
  return !head.startsWith('<')
}

/**
 * What these bytes are, from their own signature.
 *
 * Images and PDF answer with their exact type; anything else must prove it is text and is then
 * reported as `text/plain` — the caller decides whether the declared `text/csv` label may stand.
 * `null` means the upload is refused.
 */
export function sniffOfficeAssetMime(bytes: Uint8Array): OfficeAssetMime | null {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const) {
    if (hasExpectedImageSignature(bytes, mime)) return mime
  }
  if (asciiAt(bytes, 0, '%PDF-')) return 'application/pdf'
  if (isPlainText(bytes)) return 'text/plain'
  return null
}

/**
 * Resolve the declared type against what the bytes are.
 *
 * Returns the type the asset will be stored and served as, or `null` when the declaration does not
 * describe the bytes (a PNG announced as text, a `text/csv` that is really a markup document).
 */
export function resolveOfficeAssetMime(
  declared: string | null,
  sniffed: OfficeAssetMime,
): OfficeAssetMime | null {
  if (!declared) return null
  const mime = declared.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!isOfficeAssetMime(mime)) return null
  if (sniffed === 'text/plain') {
    return mime === 'text/plain' || mime === 'text/csv' ? mime : null
  }
  return mime === sniffed ? sniffed : null
}

/**
 * A display/download name: control characters and path separators cannot survive, because the name
 * ends up in a `Content-Disposition` header and, for attachments, in the reader's file system.
 */
export function sanitizeOfficeAssetName(raw: string | null | undefined, mime: string): string {
  const cleaned = (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, OFFICE_ASSET_NAME_MAX)
  if (cleaned) return cleaned
  return `asset.${officeAssetExtension(mime) ?? 'bin'}`
}

/** Whether a name's extension is one this app refuses to store at all. */
export function isOfficeAssetNameAllowed(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return true
  return !BLOCKED_ASSET_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** `inline` for the two previewable families, `attachment` for everything else. */
export function officeAssetDisposition(mime: string, name: string): string {
  const inline = mime.startsWith('image/') || mime === 'application/pdf'
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`
}