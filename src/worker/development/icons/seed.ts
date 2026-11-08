import type { Env } from '../../env'
import { newId } from '../../lib/id'
import { ICON_SEED_RETRY_MS } from '@shared/development/icons/limits'
import { ICON_BUILTIN_LIBRARIES, seedIconCount } from '@shared/development/icons/builtins'
import { importIconifyCollection } from './import'

/**
 * The first-run seed runs behind `waitUntil`, never inside the request that asked for it, so a cold
 * library still answers `bootstrap` immediately and the UI can draw its skeleton. The ledger row is
 * the lock: a second tab sees a recent running seed and leaves it alone.
 */
export async function seedRunning(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM development_icons_imports
        WHERE user_id = ?1 AND kind = 'seed' AND status = 'running' AND created_at > ?2
        LIMIT 1`,
    )
    .bind(userId, Date.now() - ICON_SEED_RETRY_MS)
    .first<{ id: string }>()
  return Boolean(row)
}

/** Collections that already hold most of their seed are left alone, so a retry resumes instead of duplicating. */
async function collectionReady(db: D1Database, userId: string, prefix: string, limit: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM development_icons_assets a
                WHERE a.user_id = c.user_id AND a.collection_id = c.id) AS n
         FROM development_icons_collections c
        WHERE c.user_id = ?1 AND c.slug = ?2`,
    )
    .bind(userId, prefix)
    .first<{ n: number }>()
  return Boolean(row) && Number(row?.n ?? 0) >= Math.max(20, Math.floor(limit * 0.6))
}

export interface SeedResult {
  started: boolean
  totalItems: number
  processedItems: number
  failedItems: number
}

export async function seedBuiltins(env: Env, userId: string): Promise<SeedResult> {
  const total = seedIconCount()
  if (await seedRunning(env.DB, userId)) {
    return { started: false, totalItems: total, processedItems: 0, failedItems: 0 }
  }
  const id = newId()
  const now = Date.now()
  await env.DB
    .prepare(
      `INSERT INTO development_icons_imports (user_id, id, kind, status, prefix, total_items, created_at, updated_at)
       VALUES (?1, ?2, 'seed', 'running', '', ?3, ?4, ?4)`,
    )
    .bind(userId, id, total, now)
    .run()

  let processed = 0
  let failed = 0
  let bytesTotal = 0
  try {
    for (const library of ICON_BUILTIN_LIBRARIES) {
      if (await collectionReady(env.DB, userId, library.prefix, library.seedLimit)) {
        processed += library.seedLimit
        continue
      }
      try {
        const result = await importIconifyCollection(env, userId, library.prefix, library.seedLimit)
        processed += result.processedItems
        failed += result.failedItems
        bytesTotal += result.bytesTotal
      } catch {
        failed += library.seedLimit
      }
      await env.DB
        .prepare(
          `UPDATE development_icons_imports SET processed_items=?3, failed_items=?4, bytes_total=?5, updated_at=?6
            WHERE user_id=?1 AND id=?2`,
        )
        .bind(userId, id, processed, failed, bytesTotal, Date.now())
        .run()
    }
    const finished = Date.now()
    await env.DB
      .prepare(
        `UPDATE development_icons_imports
            SET status=?3, processed_items=?4, failed_items=?5, bytes_total=?6, updated_at=?7, finished_at=?7
          WHERE user_id=?1 AND id=?2`,
      )
      .bind(userId, id, failed === total ? 'failed' : 'done', processed, failed, bytesTotal, finished)
      .run()
    return { started: true, totalItems: total, processedItems: processed, failedItems: failed }
  } catch (error) {
    await env.DB
      .prepare(
        `UPDATE development_icons_imports SET status='failed', error=?3, updated_at=?4, finished_at=?4
          WHERE user_id=?1 AND id=?2`,
      )
      .bind(userId, id, error instanceof Error ? error.message : 'Seed failed', Date.now())
      .run()
    return { started: true, totalItems: total, processedItems: processed, failedItems: failed }
  }
}
