/** The instance-level YouTube settings row and the key resolution that reads it. */
import type { Env } from '../env'
import { decryptYoutubeApiKey } from '../lib/crypto'
import { youtubeDailyLimit, youtubeRegion } from './config'

export interface StoredYouTubeSettings {
  ciphertext: string
  region: string
  dailyQuota: number | null
}

const SETTINGS_ID = 'instance'
const KEY_CACHE = new Map<string, string>()

export async function readStoredYouTubeSettings(db: D1Database): Promise<StoredYouTubeSettings> {
  try {
    const row = await db.prepare(
      'SELECT api_key_ciphertext, region_code, daily_quota FROM youtube_settings WHERE id = ?1',
    ).bind(SETTINGS_ID).first<{ api_key_ciphertext: string; region_code: string; daily_quota: number | null }>()
    return {
      ciphertext: row?.api_key_ciphertext ?? '',
      region: row?.region_code ?? '',
      dailyQuota: row?.daily_quota ?? null,
    }
  }
  catch (error) {
    console.warn('[youtube] settings row could not be read; falling back to deployment variables', error)
    return { ciphertext: '', region: '', dailyQuota: null }
  }
}

export async function saveStoredYouTubeSettings(
  db: D1Database,
  settings: StoredYouTubeSettings,
): Promise<void> {
  await db.prepare(
    `INSERT INTO youtube_settings (id, api_key_ciphertext, region_code, daily_quota, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET
       api_key_ciphertext = excluded.api_key_ciphertext,
       region_code = excluded.region_code,
       daily_quota = excluded.daily_quota,
       updated_at = excluded.updated_at`,
  ).bind(SETTINGS_ID, settings.ciphertext, settings.region, settings.dailyQuota, Date.now()).run()
}

/**
 * The key the next upstream call should sign with: the stored key when the vault can open it,
 * otherwise the deployment's secret. A stored key that cannot be opened is reported and skipped,
 * never replaced by pretending the stored one is in force.
 */
export async function resolveYouTubeApiKey(env: Env, db: D1Database): Promise<string | null> {
  const stored = await readStoredYouTubeSettings(db)
  if (stored.ciphertext) {
    const cached = KEY_CACHE.get(stored.ciphertext)
    if (cached) return cached
    try {
      const opened = await decryptYoutubeApiKey(env, stored.ciphertext)
      if (opened) {
        if (KEY_CACHE.size > 4) KEY_CACHE.clear()
        KEY_CACHE.set(stored.ciphertext, opened)
        return opened
      }
    }
    catch (error) {
      console.warn('[youtube] stored API key could not be opened; trying the Worker secret', error)
    }
  }
  const secret = (env.YOUTUBE_API_KEY ?? '').trim()
  return secret || null
}

/** The stored region/quota, with the deployment's values as the fallback. */
export async function resolveYouTubeLimits(env: Env, db: D1Database): Promise<{ region: string | null; limit: number }> {
  const stored = await readStoredYouTubeSettings(db)
  let region: string | null = null
  if (stored.region) {
    try {
      region = youtubeRegion({ ...env, YOUTUBE_REGION_CODE: stored.region })
    }
    catch (error) {
      console.warn('[youtube] stored region code is invalid; using the deployment value', error)
    }
  }
  region ??= youtubeRegion(env)
  let limit: number
  if (stored.dailyQuota !== null) {
    try {
      limit = youtubeDailyLimit({ ...env, YOUTUBE_DAILY_QUOTA: String(stored.dailyQuota) })
    }
    catch (error) {
      console.warn('[youtube] stored daily quota is invalid; using the deployment value', error)
      limit = youtubeDailyLimit(env)
    }
  }
  else {
    limit = youtubeDailyLimit(env)
  }
  return { region, limit }
}
