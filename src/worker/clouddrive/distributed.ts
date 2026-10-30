import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { resolveMount, type CloudDriveMountInfo } from './lib'
import { deleteExternalObject, readExternalObject, writeExternalObject } from './external'

export interface PartMount {
  id: string
  storageId: string
  storageType: string
  weight: number
}

export interface PartAssignment {
  partNumber: number
  mountId: string
  storageKey: string
}

export interface FilePartRow {
  part_number: number
  mount_id: string
  storage_key: string
  size: number
  etag: string | null
}

export async function partMounts(db: D1Database, userId: string): Promise<PartMount[]> {
  const { results } = await db.prepare(
    `SELECT m.id, m.storage_id, m.weight, s.type AS storage_type
       FROM CloudDrive_mounts m
       LEFT JOIN CloudDrive_storages s ON s.user_id = m.user_id AND s.id = m.storage_id
      WHERE m.user_id = ? AND m.enabled = 1 AND m.read_only = 0
        AND (m.id = 'primary' OR (s.type = 's3' AND s.status = 'enabled'))
      ORDER BY m.sort_order, m.created_at, m.id`,
  ).bind(userId).all<{ id: string; storage_id: string; weight: number; storage_type: string | null }>()
  return (results ?? []).map((row) => ({
    id: row.id,
    storageId: row.storage_id,
    storageType: row.storage_id === 'primary' ? 'r2' : row.storage_type ?? 'unknown',
    weight: row.weight,
  }))
}

export function assignParts(sessionId: string, totalParts: number, mounts: readonly PartMount[]): PartAssignment[] {
  if (mounts.length === 0) return []
  const pool = mounts.flatMap((mount) => Array<PartMount>(Math.max(1, Math.min(10, mount.weight))).fill(mount))
  return Array.from({ length: totalParts }, (_, index) => ({
    partNumber: index + 1,
    mountId: pool[index % pool.length]!.id,
    storageKey: `CloudDrive/parts/${sessionId}/${index + 1}`,
  }))
}

async function mountFor(db: D1Database, userId: string, mountId: string): Promise<CloudDriveMountInfo> {
  return await resolveMount(db, userId, mountId)
}

export async function writePartObject(
  env: Env,
  db: D1Database,
  userId: string,
  mountId: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string | null> {
  if (mountId === 'primary') {
    if (!env.FILES) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound')
    const object = await env.FILES.put(key, bytes, { httpMetadata: { contentType } })
    return object?.etag ?? null
  }
  const mount = await mountFor(db, userId, mountId)
  return await writeExternalObject(env, db, mount, key, bytes, contentType)
}

async function readPartObject(
  env: Env,
  db: D1Database,
  userId: string,
  mountId: string,
  key: string,
  range: string | null,
): Promise<Response | null> {
  if (mountId === 'primary') {
    if (!env.FILES) throw new ApiError(503, 'clouddrive_mount_unavailable', 'Object storage is not bound')
    const object = await env.FILES.get(key, range ? { range: headerRange(range) } : undefined)
    if (!object) return null
    return new Response(object.body, {
      headers: { 'Content-Length': String(object.size), 'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream' },
    })
  }
  const mount = await mountFor(db, userId, mountId)
  return await readExternalObject(env, db, mount, key, range)
}

function headerRange(value: string): { offset: number; length: number } | undefined {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value)
  if (!match) return undefined
  const offset = Number(match[1])
  const end = Number(match[2])
  return { offset, length: end - offset + 1 }
}

export async function fileParts(db: D1Database, userId: string, fileId: string): Promise<FilePartRow[]> {
  const { results } = await db.prepare(
    `SELECT part_number, mount_id, storage_key, size, etag FROM CloudDrive_file_parts
      WHERE user_id = ? AND file_id = ? ORDER BY part_number`,
  ).bind(userId, fileId).all<FilePartRow>()
  return results ?? []
}

export async function distributedStream(
  env: Env,
  db: D1Database,
  userId: string,
  parts: readonly FilePartRow[],
  start = 0,
  length = Infinity,
): Promise<ReadableStream> {
  return new ReadableStream({
    async start(controller) {
      let offset = 0
      const end = start + length
      try {
        for (const part of parts) {
          const partStart = offset
          const partEnd = offset + part.size
          offset = partEnd
          if (partEnd <= start || partStart >= end) continue
          const from = Math.max(start, partStart) - partStart
          const to = Math.min(end, partEnd) - partStart - 1
          const range = from === 0 && to === part.size - 1 ? null : `bytes=${from}-${to}`
          const response = await readPartObject(env, db, userId, part.mount_id, part.storage_key, range)
          if (!response?.body) throw new Error(`Distributed part ${part.part_number} is missing`)
          const reader = response.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) controller.enqueue(value)
          }
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

export async function deletePartObject(
  env: Env,
  db: D1Database,
  userId: string,
  mountId: string,
  key: string,
): Promise<void> {
  if (mountId === 'primary') {
    if (env.FILES) await env.FILES.delete(key)
    return
  }
  const mount = await mountFor(db, userId, mountId)
  await deleteExternalObject(env, db, mount, key)
}

export async function deleteFileParts(
  db: D1Database,
  env: Env,
  userId: string,
  fileIds: readonly string[],
): Promise<number> {
  let failed = 0
  for (let offset = 0; offset < fileIds.length; offset += 90) {
    const chunk = fileIds.slice(offset, offset + 90)
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db.prepare(
      `SELECT part_number, mount_id, storage_key, size, etag FROM CloudDrive_file_parts
        WHERE user_id = ? AND file_id IN (${placeholders})`,
    ).bind(userId, ...chunk).all<FilePartRow>()
    if ((results ?? []).length === 0) continue
    await db.prepare(
      `DELETE FROM CloudDrive_file_parts WHERE user_id = ? AND file_id IN (${placeholders})`,
    ).bind(userId, ...chunk).run()
    for (const part of results ?? []) {
      try {
        await deletePartObject(env, db, userId, part.mount_id, part.storage_key)
      } catch (error) {
        console.warn('[clouddrive] deleting a distributed part failed:', part.storage_key, error)
        failed += 1
      }
    }
  }
  return failed
}

export async function deleteUploadPartObjects(
  env: Env,
  db: D1Database,
  userId: string,
  sessionId: string,
): Promise<number> {
  const { results } = await db.prepare(
    `SELECT mount_id, storage_key FROM CloudDrive_upload_part_objects
      WHERE session_id = ? AND uploaded_at IS NOT NULL`,
  ).bind(sessionId).all<{ mount_id: string; storage_key: string }>()
  let failed = 0
  for (const part of results ?? []) {
    try {
      await deletePartObject(env, db, userId, part.mount_id, part.storage_key)
    } catch (error) {
      console.warn('[clouddrive] deleting an unfinished distributed part failed:', part.storage_key, error)
      failed += 1
    }
  }
  await db.prepare(`DELETE FROM CloudDrive_upload_part_objects WHERE session_id = ?`).bind(sessionId).run()
  return failed
}
