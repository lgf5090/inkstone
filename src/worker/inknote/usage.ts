/** The account usage summary the settings panel draws. */
import { attachmentQuotaBytesForEnv } from '../attachments/backend'
import type { Env } from '../env'

export interface InknoteUsage {
  notes: number
  pages: number
  assets: number
  assetsBytes: number
  snapshotsBytes: number
  quotaBytes: number
}

export async function inknoteUsage(env: Env, userId: string): Promise<InknoteUsage> {
  const [notes, pages, assets] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM inknote_notes WHERE user_id = ?1 AND deleted_at IS NULL`).bind(userId).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM inknote_pages WHERE user_id = ?1`).bind(userId).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM inknote_assets WHERE user_id = ?1`).bind(userId).first<{ n: number, bytes: number }>(),
  ])
  return {
    notes: Number(notes?.n ?? 0),
    pages: Number(pages?.n ?? 0),
    assets: Number(assets?.n ?? 0),
    assetsBytes: Number(assets?.bytes ?? 0),
    snapshotsBytes: 0,
    quotaBytes: attachmentQuotaBytesForEnv(env),
  }
}
