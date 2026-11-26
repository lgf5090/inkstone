import { autoSuffixName, childPath, foldedName } from '@shared/clouddrive/model'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { D1_BATCH_CHUNK, initialsOf, type CloudDriveFileRow } from './lib'
import { storageKeyReferenced } from './store-files'

const SNAPSHOT_MAX_ITEMS = 5000
const NAME_ATTEMPTS = 100
const JSON_CHUNK_BYTES = 128 * 1024

interface RestorePlanItem {
  id: string
  name: string
  name_folded: string
  name_initials: string
  path: string
  update: boolean
}

/** Keep each JSON bound value small while packing many rows into one D1 statement. */
function jsonChunks<T>(values: readonly T[]): string[] {
  const encoder = new TextEncoder()
  const chunks: string[] = []
  let current: T[] = []
  let bytes = 2
  for (const value of values) {
    const json = JSON.stringify(value)
    const size = encoder.encode(json).length
    const separator = current.length > 0 ? 1 : 0
    if (current.length > 0 && bytes + separator + size > JSON_CHUNK_BYTES) {
      chunks.push(JSON.stringify(current))
      current = []
      bytes = 2
    }
    current.push(value)
    bytes += (current.length > 1 ? 1 : 0) + size
  }
  if (current.length > 0) chunks.push(JSON.stringify(current))
  return chunks
}

export interface SnapshotRow {
  id: string
  name: string
  mount_id: string
  item_count: number
  total_bytes: number
  created_at: number
}

interface SnapshotItem {
  file: CloudDriveFileRow
  tags: { tag: string; tag_folded: string; color: string; created_at: number }[]
}

export function snapshotView(row: SnapshotRow) {
  return {
    id: row.id, name: row.name, mountId: row.mount_id, itemCount: row.item_count,
    totalBytes: row.total_bytes, createdAt: row.created_at,
  }
}

export async function createSnapshot(env: Env, userId: string, name: string): Promise<SnapshotRow> {
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw ApiError.badRequest('A snapshot name of 1 to 80 characters is required')
  const { results } = await env.DB.prepare(
    `SELECT * FROM CloudDrive_files
      WHERE user_id = ? AND mount_id = 'primary' AND deleted_at IS NULL
      ORDER BY length(path), path LIMIT ?`,
  ).bind(userId, SNAPSHOT_MAX_ITEMS + 1).all<CloudDriveFileRow>()
  const files = results ?? []
  if (files.length > SNAPSHOT_MAX_ITEMS) throw ApiError.tooLarge(`A snapshot holds at most ${SNAPSHOT_MAX_ITEMS} entries`)
  const ids = files.map((file) => file.id)
  const tags = new Map<string, SnapshotItem['tags']>()
  for (let offset = 0; offset < ids.length; offset += 90) {
    const chunk = ids.slice(offset, offset + 90)
    if (!chunk.length) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = await env.DB.prepare(
      `SELECT file_id, tag, tag_folded, color, created_at FROM CloudDrive_file_tags
        WHERE user_id = ? AND file_id IN (${placeholders})`,
    ).bind(userId, ...chunk).all<SnapshotItem['tags'][number] & { file_id: string }>()
    for (const tag of rows.results ?? []) {
      const list = tags.get(tag.file_id) ?? []
      list.push({ tag: tag.tag, tag_folded: tag.tag_folded, color: tag.color, created_at: tag.created_at })
      tags.set(tag.file_id, list)
    }
  }
  const now = Date.now()
  const snapshot: SnapshotRow = {
    id: newId(), name: name.trim(), mount_id: 'primary', item_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + (file.kind === 'file' ? file.size : 0), 0), created_at: now,
  }
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO CloudDrive_snapshots (id, user_id, name, mount_id, item_count, total_bytes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(snapshot.id, userId, snapshot.name, snapshot.mount_id, snapshot.item_count, snapshot.total_bytes, now)]
  const payloads = files.map((file) => JSON.stringify({ file, tags: tags.get(file.id) ?? [] } satisfies SnapshotItem))
  for (const chunk of jsonChunks(payloads)) statements.push(env.DB.prepare(
    `INSERT INTO CloudDrive_snapshot_items (snapshot_id, user_id, payload)
     SELECT ?1, ?2, value FROM json_each(?3)`,
  ).bind(snapshot.id, userId, chunk))
  if (statements.length > D1_BATCH_CHUNK) throw ApiError.tooLarge('The snapshot metadata is too large to save atomically')
  await env.DB.batch(statements)
  return snapshot
}

export async function listSnapshots(db: D1Database, userId: string): Promise<SnapshotRow[]> {
  const { results } = await db.prepare(
    `SELECT id, name, mount_id, item_count, total_bytes, created_at FROM CloudDrive_snapshots
      WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
  ).bind(userId).all<SnapshotRow>()
  return results ?? []
}

function parseItem(payload: string): SnapshotItem {
  try {
    const value = JSON.parse(payload) as Partial<SnapshotItem>
    const file = value.file
    if (!file || typeof file.id !== 'string' || typeof file.path !== 'string' || typeof file.name !== 'string'
      || typeof file.parent_id !== 'string' || !['file', 'folder'].includes(file.kind)) {
      throw new Error('invalid_snapshot_file')
    }
    if (!Array.isArray(value.tags)) throw new Error('invalid_snapshot_tags')
    return { file, tags: value.tags }
  } catch (error) {
    console.error('[clouddrive] a snapshot item is unreadable:', error)
    throw new ApiError(500, 'internal', 'A snapshot item is unreadable')
  }
}

/**
 * Restore the snapshot's folder metadata and recreate missing rows over their original object references.
 * Existing bytes are never overwritten and files added after the snapshot are left alone.
 */
export async function restoreSnapshot(env: Env, userId: string, snapshotId: string): Promise<{ restored: number; skipped: number; results: { id: string; ok: boolean; error?: string }[] }> {
  const snapshot = await env.DB.prepare(
    `SELECT id FROM CloudDrive_snapshots WHERE user_id = ? AND id = ?`,
  ).bind(userId, snapshotId).first<{ id: string }>()
  if (!snapshot) throw ApiError.notFound('Snapshot not found')
  const { results } = await env.DB.prepare(
    `SELECT payload FROM CloudDrive_snapshot_items WHERE user_id = ? AND snapshot_id = ?`,
  ).bind(userId, snapshotId).all<{ payload: string }>()
  const items = (results ?? []).map((row) => parseItem(row.payload))
  items.sort((left, right) => left.file.path.length - right.file.path.length)
  const existing = await env.DB.prepare(
    `SELECT * FROM CloudDrive_files WHERE user_id = ?`,
  ).bind(userId).all<CloudDriveFileRow>()
  const byId = new Map((existing.results ?? []).map((file) => [file.id, file]))
  const paths = new Set((existing.results ?? []).filter((file) => file.deleted_at === null).map((file) => file.path))
  const siblingNames = new Set((existing.results ?? [])
    .filter((file) => file.deleted_at === null)
    .map((file) => `${file.parent_id}\0${file.name_folded}`))
  const now = Date.now()
  const plan: RestorePlanItem[] = []
  const outcomes: { id: string; ok: boolean; error?: string }[] = []
  for (const item of items) {
    const source = item.file
    const current = byId.get(source.id)
    if (current && current.deleted_at === null && current.path === source.path) {
      plan.push({
        id: source.id, name: current.name, name_folded: current.name_folded,
        name_initials: current.name_initials, path: current.path, update: true,
      })
      outcomes.push({ id: source.id, ok: true })
      continue
    }
    if (current) { outcomes.push({ id: source.id, ok: false, error: 'id_conflict' }); continue }
    if (source.kind === 'file' && source.storage_kind === 'r2' && source.storage_key) {
      const object = env.FILES ? await env.FILES.head(source.storage_key) : null
      if (!object || object.size !== source.size) { outcomes.push({ id: source.id, ok: false, error: 'object_missing' }); continue }
    }
    const parent = source.parent_id ? byId.get(source.parent_id) : null
    if (source.parent_id && (!parent || parent.deleted_at !== null)) {
      outcomes.push({ id: source.id, ok: false, error: 'parent_missing' }); continue
    }
    let name = source.name
    let path = childPath(parent?.path ?? '/', name)
    if (paths.has(path) || siblingNames.has(`${source.parent_id}\0${foldedName(name)}`)) {
      let available = false
      for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt++) {
        name = autoSuffixName(source.name, attempt)
        path = childPath(parent?.path ?? '/', name)
        if (!paths.has(path) && !siblingNames.has(`${source.parent_id}\0${foldedName(name)}`)) { available = true; break }
      }
      if (!available) { outcomes.push({ id: source.id, ok: false, error: 'path_conflict' }); continue }
    }
    paths.add(path)
    const nameFolded = foldedName(name)
    const nameInitials = initialsOf(name)
    siblingNames.add(`${source.parent_id}\0${nameFolded}`)
    plan.push({ id: source.id, name, name_folded: nameFolded, name_initials: nameInitials, path, update: false })
    byId.set(source.id, { ...source, path, name, name_folded: nameFolded, name_initials: nameInitials, deleted_at: null })
    outcomes.push({ id: source.id, ok: true })
  }
  const restored = outcomes.filter((outcome) => outcome.ok).length
  if (plan.length === 0) return { restored, skipped: outcomes.length - restored, results: outcomes }

  const chunks = jsonChunks(plan)
  if (chunks.length * 3 > D1_BATCH_CHUNK) throw ApiError.tooLarge('The snapshot metadata is too large to restore atomically')
  const statements: D1PreparedStatement[] = []
  for (const chunk of chunks) {
    statements.push(env.DB.prepare(
      `WITH plan AS (SELECT value FROM json_each(?1))
       UPDATE CloudDrive_files AS f
          SET metadata = (SELECT json_extract(i.payload, '$.file.metadata') FROM CloudDrive_snapshot_items i
                           WHERE i.user_id = f.user_id AND i.snapshot_id = ?3
                             AND json_extract(i.payload, '$.file.id') = f.id),
              color = (SELECT json_extract(i.payload, '$.file.color') FROM CloudDrive_snapshot_items i
                        WHERE i.user_id = f.user_id AND i.snapshot_id = ?3
                          AND json_extract(i.payload, '$.file.id') = f.id),
              starred_at = (SELECT json_extract(i.payload, '$.file.starred_at') FROM CloudDrive_snapshot_items i
                             WHERE i.user_id = f.user_id AND i.snapshot_id = ?3
                               AND json_extract(i.payload, '$.file.id') = f.id),
              updated_at = ?4
        WHERE f.user_id = ?2 AND f.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM plan p
                       WHERE json_extract(p.value, '$.update') = 1
                         AND json_extract(p.value, '$.id') = f.id
                         AND json_extract(p.value, '$.path') = f.path)`,
    ).bind(chunk, userId, snapshotId, now))
    statements.push(env.DB.prepare(
      `INSERT INTO CloudDrive_files
         (id, user_id, mount_id, parent_id, kind, name, name_folded, name_initials, path, category, mime,
          size, etag, checksum, storage_kind, storage_key, metadata, color, starred_at, last_viewed_at,
          deleted_at, trash_batch, created_at, updated_at, uploaded_at, modified_at)
       SELECT json_extract(p.value, '$.id'), ?2, 'primary', json_extract(i.payload, '$.file.parent_id'),
              json_extract(i.payload, '$.file.kind'), json_extract(p.value, '$.name'),
              json_extract(p.value, '$.name_folded'), json_extract(p.value, '$.name_initials'),
              json_extract(p.value, '$.path'), json_extract(i.payload, '$.file.category'),
              json_extract(i.payload, '$.file.mime'), json_extract(i.payload, '$.file.size'),
              json_extract(i.payload, '$.file.etag'), json_extract(i.payload, '$.file.checksum'),
              json_extract(i.payload, '$.file.storage_kind'), json_extract(i.payload, '$.file.storage_key'),
              json_extract(i.payload, '$.file.metadata'), json_extract(i.payload, '$.file.color'),
              json_extract(i.payload, '$.file.starred_at'), NULL, NULL, NULL,
              json_extract(i.payload, '$.file.created_at'), ?4, json_extract(i.payload, '$.file.uploaded_at'),
              json_extract(i.payload, '$.file.modified_at')
         FROM json_each(?1) AS p
         JOIN CloudDrive_snapshot_items i
           ON i.user_id = ?2 AND i.snapshot_id = ?3
          AND json_extract(i.payload, '$.file.id') = json_extract(p.value, '$.id')
        WHERE json_extract(p.value, '$.update') = 0
        ORDER BY length(json_extract(p.value, '$.path')), json_extract(p.value, '$.path')`,
    ).bind(chunk, userId, snapshotId, now))
    statements.push(env.DB.prepare(
      `INSERT INTO CloudDrive_file_tags (user_id, file_id, tag, tag_folded, color, created_at)
       SELECT ?2, json_extract(p.value, '$.id'), json_extract(tag.value, '$.tag'),
              json_extract(tag.value, '$.tag_folded'), json_extract(tag.value, '$.color'),
              json_extract(tag.value, '$.created_at')
         FROM json_each(?1) AS p
         JOIN CloudDrive_snapshot_items i
           ON i.user_id = ?2 AND i.snapshot_id = ?3
          AND json_extract(i.payload, '$.file.id') = json_extract(p.value, '$.id')
         JOIN json_each(json_extract(i.payload, '$.tags')) AS tag
        WHERE json_extract(p.value, '$.update') = 0`,
    ).bind(chunk, userId, snapshotId))
  }
  await env.DB.batch(statements)
  return { restored, skipped: outcomes.length - restored, results: outcomes }
}

export async function deleteSnapshot(env: Env, userId: string, snapshotId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT json_extract(payload, '$.file.storage_key') AS storage_key FROM CloudDrive_snapshot_items
      WHERE user_id = ? AND snapshot_id = ? AND json_extract(payload, '$.file.storage_key') IS NOT NULL`,
  ).bind(userId, snapshotId).all<{ storage_key: string }>()
  const deleted = await env.DB.batch([
    env.DB.prepare(`DELETE FROM CloudDrive_snapshot_items WHERE user_id = ? AND snapshot_id = ?`).bind(userId, snapshotId),
    env.DB.prepare(`DELETE FROM CloudDrive_snapshots WHERE user_id = ? AND id = ?`).bind(userId, snapshotId),
  ])
  if (!(deleted[1]?.meta.changes ?? 0)) return false
  if (env.FILES) {
    for (const key of new Set((row.results ?? []).map((item) => item.storage_key))) {
      if (await storageKeyReferenced(env.DB, key)) continue
      try { await env.FILES.delete(key) } catch (error) {
        console.warn('[clouddrive] deleting an object released by a snapshot failed:', key, error)
      }
    }
  }
  return true
}
