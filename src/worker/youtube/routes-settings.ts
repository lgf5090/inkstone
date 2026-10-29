/** Owner-only YouTube API settings; the key is sealed and never returned. */
import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { encryptYoutubeApiKey } from '../lib/crypto'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireOwner } from '../middleware/auth'
import { youtubeApiBase, youtubeDailyLimit } from './config'
import { youtubeImageBase } from './media'
import {
  readStoredYouTubeSettings,
  saveStoredYouTubeSettings,
  type StoredYouTubeSettings,
} from './settings'
import type { YouTubeSettingsView } from '@shared/youtube/settings'

export const youtubeSettingsRoutes = new Hono<AppBindings>()

interface SettingsBody {
  apiKey?: unknown
  regionCode?: unknown
  dailyQuota?: unknown
}

function viewFor(env: AppBindings['Bindings'], stored: StoredYouTubeSettings, role: string): YouTubeSettingsView {
  const hasEnvKey = Boolean((env.YOUTUBE_API_KEY ?? '').trim())
  const hasStoredKey = Boolean(stored.ciphertext)
  const vaultAvailable = Boolean(env.CREDENTIAL_VAULT)
  const configured = (hasStoredKey && vaultAvailable) || hasEnvKey
  let region: string | null = stored.region || (env.YOUTUBE_REGION_CODE ?? '').trim() || null
  if (region && !/^[A-Z]{2}$/.test(region)) region = null
  return {
    canEdit: role === 'owner',
    api: {
      configured,
      source: hasStoredKey && vaultAvailable ? 'stored' : hasEnvKey ? 'env' : 'none',
      hasStoredKey,
      hasEnvKey,
      region,
      dailyQuota: stored.dailyQuota ?? youtubeDailyLimit(env),
      vaultAvailable,
      apiBase: youtubeApiBase(env),
      imageBase: youtubeImageBase(env),
      r2Available: Boolean(env.FILES),
      searchAttemptsPerTenMinutes: 10,
    },
  }
}

async function currentView(env: AppBindings['Bindings'], db: D1Database, role: string): Promise<YouTubeSettingsView> {
  return viewFor(env, await readStoredYouTubeSettings(db), role)
}

youtubeSettingsRoutes.get('/', async (c) => {
  return c.json(await currentView(c.env, c.env.DB, c.get('user').role))
})

youtubeSettingsRoutes.put('/', requireOwner, async (c) => {
  const body = await readJson<SettingsBody>(c, JSON_BODY_LIMITS.youtube)
  const stored = await readStoredYouTubeSettings(c.env.DB)
  let ciphertext = stored.ciphertext
  let region = stored.region
  let dailyQuota = stored.dailyQuota

  if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
    if (body.apiKey === null || body.apiKey === '') {
      ciphertext = ''
    }
    else if (typeof body.apiKey !== 'string') {
      throw ApiError.badRequest('apiKey must be a string or null')
    }
    else {
      if (!c.env.CREDENTIAL_VAULT) {
        throw new ApiError(503, 'server_misconfigured', 'CREDENTIAL_VAULT is not bound, so the API key cannot be stored safely')
      }
      const trimmed = body.apiKey.trim()
      if (trimmed.length < 8 || trimmed.length > 512 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
        throw ApiError.badRequest('apiKey must be 8 to 512 printable characters')
      }
      ciphertext = await encryptYoutubeApiKey(c.env, trimmed)
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'regionCode')) {
    if (body.regionCode === null || body.regionCode === '') {
      region = ''
    }
    else if (typeof body.regionCode === 'string' && /^[A-Za-z]{2}$/.test(body.regionCode.trim())) {
      region = body.regionCode.trim().toUpperCase()
    }
    else {
      throw ApiError.badRequest('regionCode must be two letters or null')
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'dailyQuota')) {
    if (body.dailyQuota === null) {
      dailyQuota = null
    }
    else if (typeof body.dailyQuota === 'number' && Number.isSafeInteger(body.dailyQuota) && body.dailyQuota >= 1 && body.dailyQuota <= 1_000_000) {
      dailyQuota = body.dailyQuota
    }
    else {
      throw ApiError.badRequest('dailyQuota must be an integer between 1 and 1000000 or null')
    }
  }

  await saveStoredYouTubeSettings(c.env.DB, { ciphertext, region, dailyQuota })
  return c.json(await currentView(c.env, c.env.DB, c.get('user').role))
})
