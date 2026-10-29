import type { Env } from '../env'

export type NavStorageKind = 'r2' | 'kv'

export interface NavStoredObject {
  body: ReadableStream<Uint8Array> | ArrayBuffer
  contentType: string
  size: number | null
  etag: string | null
}

export function selectNavStorage(env: Env): NavStorageKind | null {
  if (env.FILES) return 'r2'
  if (env.FILES_KV) return 'kv'
  return null
}

export function navIconObjectKey(id: string, extension: string): string {
  return `nav/icons/${id}.${extension}`
}

export async function putNavObject(
  env: Env,
  kind: NavStorageKind,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  if (kind === 'r2') {
    if (!env.FILES) throw new Error('R2 is not configured')
    await env.FILES.put(key, bytes, { httpMetadata: { contentType, cacheControl: 'private, max-age=31536000, immutable' } })
    return
  }
  if (!env.FILES_KV) throw new Error('KV is not configured')
  await env.FILES_KV.put(key, bytes, { metadata: { contentType } })
}

export async function getNavObject(env: Env, kind: NavStorageKind, key: string): Promise<NavStoredObject | null> {
  if (kind === 'r2') {
    if (!env.FILES) throw new Error('R2 is not configured')
    const object = await env.FILES.get(key)
    if (!object) return null
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      size: object.size,
      etag: object.httpEtag,
    }
  }
  if (!env.FILES_KV) throw new Error('KV is not configured')
  const value = await env.FILES_KV.getWithMetadata<{ contentType?: string }>(key, 'arrayBuffer')
  if (!value.value) return null
  return {
    body: value.value,
    contentType: value.metadata?.contentType ?? 'application/octet-stream',
    size: value.value.byteLength,
    etag: null,
  }
}

export async function deleteNavObject(env: Env, kind: NavStorageKind, key: string): Promise<void> {
  if (kind === 'r2') {
    if (env.FILES) await env.FILES.delete(key)
    return
  }
  if (env.FILES_KV) await env.FILES_KV.delete(key)
}
