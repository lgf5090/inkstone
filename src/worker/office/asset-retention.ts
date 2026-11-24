import type { Env } from '../env'
import { deleteOfficeObjects } from './storage'

/**
 * How long an unused asset is kept before it is a GC candidate.
 *
 * The sweep only deletes what no current snapshot mentions, so the grace is about a file the reader
 * has not opened in months — not about avoiding a race with an editor that is open right now.
 */
export const OFFICE_ASSET_GRACE_MS = 90 * 24 * 60 * 60 * 1000

const ASSET_URL_RE = /\/api\/office\/assets\/([A-Za-z0-9]{10,64})/g

/** Every asset id a stored snapshot points at: images, PDFs and boards attachments share the shape. */
export function collectAssetIds(snapshotText: string): Set<string> {
  const ids = new Set<string>()
  for (const match of snapshotText.matchAll(ASSET_URL_RE)) {
    if (match[1]) ids.add(match[1])
  }
  return ids
}

export interface OfficeAssetRetentionResult {
  candidates: number
  deleted: number
}

/**
 * Deletes assets no live file refers to.
 *
 * Candidates are assets untouched for the grace period, bounded per run so an hour of the cron does
 * bounded work. References are read from the live snapshots of the owners involved, because the asset
 * table deliberately carries no back-reference — a snapshot is the only thing that knows what it shows.
 */
export async function runOfficeAssetRetention(
  env: Env,
  now: number,
  limit = 100,
): Promise<OfficeAssetRetentionResult> {
  if (!env.FILES) return { candidates: 0, deleted: 0 }
  const cutoff = now - OFFICE_ASSET_GRACE_MS
  const rows = await env.DB.prepare(
    `SELECT user_id, id, object_key FROM office_asset WHERE last_used_at < ?1 ORDER BY last_used_at ASC LIMIT ?2`,
  ).bind(cutoff, limit).all<{ user_id: string; id: string; object_key: string }>()
  const candidates = rows.results ?? []
  if (candidates.length === 0) return { candidates: 0, deleted: 0 }

  const referenced = new Map<string, Set<string>>()
  for (const userId of new Set(candidates.map((row) => row.user_id))) {
    const files = await env.DB.prepare(
      `SELECT snapshot_key FROM office_file
        WHERE user_id = ?1 AND deleted_at IS NULL AND snapshot_key <> ''`,
    ).bind(userId).all<{ snapshot_key: string }>()
    const ids = new Set<string>()
    for (const file of files.results ?? []) {
      const object = await env.FILES.get(file.snapshot_key)
      if (!object) continue
      for (const id of collectAssetIds(await object.text())) ids.add(id)
    }
    referenced.set(userId, ids)
  }

  const orphans = candidates.filter((row) => !referenced.get(row.user_id)?.has(row.id))
  if (orphans.length === 0) return { candidates: candidates.length, deleted: 0 }

  await deleteOfficeObjects(env, orphans.map((row) => row.object_key))
  for (const row of orphans) {
    await env.DB.prepare(`DELETE FROM office_asset WHERE user_id = ?1 AND id = ?2`).bind(row.user_id, row.id).run()
  }
  return { candidates: candidates.length, deleted: orphans.length }
}
