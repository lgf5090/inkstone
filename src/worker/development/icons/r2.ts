import type { IconFormat } from '@shared/development/icons/types'
import type { Env } from '../../env'
import { sha256Hex } from '../../lib/encoding'

const FORMAT_EXTENSIONS: Record<IconFormat, string> = {
  svg: 'svg',
  png: 'png',
  jpg: 'jpg',
  webp: 'webp',
}

export function userShard(userId: string): Promise<string> {
  return sha256Hex(`inkstone:icons:${userId}`).then((value) => value.slice(0, 8))
}

export function iconObjectKey(format: IconFormat, shard: string, sha256: string): string {
  return `development/icons/${format}/u${shard}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${FORMAT_EXTENSIONS[format]}`
}

export function iconThumbKey(shard: string, sha256: string, width: number): string {
  return `development/icons/webp/u${shard}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}-w${width}.webp`
}

export function iconObjectUrl(format: IconFormat, shard: string, sha256: string): string {
  return `/api/development/icons/objects/${format}/u${shard}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.${FORMAT_EXTENSIONS[format]}`
}

export function iconThumbUrl(shard: string, sha256: string, width = 96): string {
  return `/api/development/icons/objects/webp/u${shard}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}-w${width}.webp`
}

export function stageObjectKey(format: IconFormat, shard: string, sha256: string): string {
  return iconObjectKey(format, shard, sha256)
}

export async function putIconObject(env: Env, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (!env.FILES) throw new Error('File storage is not configured')
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
  })
}

export async function getIconObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  if (!env.FILES) return null
  return env.FILES.get(key)
}

export async function deleteIconObject(env: Env, key: string): Promise<void> {
  if (!env.FILES) return
  await env.FILES.delete(key)
}

export function objectHeaders(contentType: string, etag: string): Headers {
  const headers = new Headers()
  headers.set('Content-Type', contentType)
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('ETag', `"${etag}"`)
  headers.set('X-Content-Type-Options', 'nosniff')
  if (contentType === 'image/svg+xml') {
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  }
  return headers
}
