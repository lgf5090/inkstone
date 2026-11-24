import type { Env } from '../env'
import { requireOfficeBucket } from './storage'

/**
 * An Office backup is a plain copy under its own prefix: one `office.json` holding the metadata and the
 * current snapshot of every live file, plus the binary assets those snapshots show.
 *
 * The layout mirrors what the app already stores (`office/txt/*`, `office/asset/*`) rather than
 * inventing a container format: a restore reads `office.json` and puts the objects back under their
 * original keys, and a human can inspect either half without our code.
 */

export const OFFICE_BACKUP_PREFIX = 'office-backup/'

/** How many bytes one backup may copy: a backup that cannot be restored inside a request is not one. */
export const OFFICE_BACKUP_MAX_BYTES = 256 * 1024 * 1024

export interface OfficeBackupManifest {
  version: 1
  stamp: string
  createdAt: number
  files: Array<Record<string, unknown>>
  folders: Array<Record<string, unknown>>
  tags: Array<Record<string, unknown>>
  fileTags: Array<Record<string, unknown>>
  /** The keys copied alongside `office.json`, in the order they were written. */
  objects: Array<{ key: string; bytes: number }>
  bytes: number
}

export interface OfficeBackupResult {
  key: string
  files: number
  objects: number
  bytes: number
}

function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-')
}

/** Every column the restore needs, taken as stored so a backup never has to reinterpret a row. */
async function rowsOf(env: Env, table: string, userId: string, order: string): Promise<Array<Record<string, unknown>>> {
  const result = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?1 ORDER BY ${order}`)
    .bind(userId)
    .all<Record<string, unknown>>()
  return result.results ?? []
}

/**
 * Writes one backup and returns where it landed.
 *
 * Files whose snapshot object is missing are still listed: the manifest says what the account held,
 * and a restore reports the gap instead of silently dropping a file.
 */
export async function writeOfficeBackup(env: Env, userId: string, now: number): Promise<OfficeBackupResult> {
  const bucket = requireOfficeBucket(env)
  const files = await rowsOf(env, 'office_file', userId, 'created_at')
  const folders = await rowsOf(env, 'office_folder', userId, 'created_at')
  const tags = await rowsOf(env, 'office_tag', userId, 'created_at')
  const fileTags = await rowsOf(env, 'office_file_tag', userId, 'file_id')

  const snapshotKeys = files
    .map((file) => String(file.snapshot_key ?? ''))
    .filter((key) => key.startsWith('office/txt/'))

  const snapshots: Array<{ key: string; text: string }> = []
  let bytes = 0
  for (const key of snapshotKeys) {
    const object = await bucket.get(key)
    if (!object) continue
    const text = await object.text()
    bytes += text.length
    if (bytes > OFFICE_BACKUP_MAX_BYTES) throw new Error('The Office backup exceeds its byte ceiling')
    snapshots.push({ key, text })
  }

  const assetKeys = new Set<string>()
  const assetIdRe = /\/api\/office\/assets\/([A-Za-z0-9]{10,64})/g
  for (const snapshot of snapshots) {
    for (const match of snapshot.text.matchAll(assetIdRe)) if (match[1]) assetKeys.add(match[1])
  }
  const assets: Array<{ id: string; key: string; objectKey: string }> = []
  for (const id of assetKeys) {
    const row = await env.DB.prepare(
      `SELECT id, object_key FROM office_asset WHERE user_id = ?1 AND id = ?2`,
    ).bind(userId, id).first<{ id: string; object_key: string }>()
    if (row) assets.push({ id: row.id, key: `assets/${row.id}`, objectKey: row.object_key })
  }

  const stamp = stampOf(now)
  const base = `${OFFICE_BACKUP_PREFIX}${stamp}/`
  const objects: Array<{ key: string; bytes: number }> = []

  await bucket.put(`${base}snapshots.json`, JSON.stringify({ version: 1, snapshots }), {
    httpMetadata: { contentType: 'application/json' },
  })
  objects.push({ key: `${base}snapshots.json`, bytes: snapshots.reduce((sum, entry) => sum + entry.text.length, 0) })

  let copied = 0
  for (const asset of assets) {
    const object = await bucket.get(asset.objectKey)
    if (!object) continue
    if (bytes + object.size > OFFICE_BACKUP_MAX_BYTES) throw new Error('The Office backup exceeds its byte ceiling')
    await bucket.put(`${base}${asset.key}`, object.body, {
      httpMetadata: object.httpMetadata,
    })
    bytes += object.size
    copied += 1
    objects.push({ key: `${base}${asset.key}`, bytes: object.size })
  }

  const manifest: OfficeBackupManifest = {
    version: 1,
    stamp,
    createdAt: now,
    files,
    folders,
    tags,
    fileTags,
    objects,
    bytes,
  }
  const manifestKey = `${base}office.json`
  await bucket.put(manifestKey, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } })

  return { key: manifestKey, files: files.length, objects: copied, bytes }
}

/** The daily sweep: one backup per account that holds Office files, bounded per fire. */
export async function sweepOfficeBackups(env: Env, now: number, limit = 20): Promise<OfficeBackupResult[]> {
  if (!env.FILES) return []
  const users = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM office_file WHERE deleted_at IS NULL LIMIT ?1`,
  ).bind(limit).all<{ user_id: string }>()
  const results: OfficeBackupResult[] = []
  for (const row of users.results ?? []) {
    try {
      results.push(await writeOfficeBackup(env, row.user_id, now))
    } catch (error) {
      // One oversized account must not stop the others; the reason is logged for the operator.
      console.warn('[inkstone] office backup failed for one account:', (error as Error).message)
    }
  }
  return results
}
