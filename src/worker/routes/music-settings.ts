/**
 * Music preferences, plus the owner's custom resolver coordinates.
 *
 * Settings are one JSON document per account because they are only ever read as a whole. Every field
 * is rebuilt from `DEFAULT_MUSIC_SETTINGS` on the way in, so a stored document written by an older
 * build (or edited by hand) cannot leave the client with a missing property. `storageQuotaBytes` is
 * display-only and is always the server constant, never a client value.
 *
 * The resolver is configuration, not code: it stores a URL, HTTP method, parameters, a response path
 * and a quality map. Nothing here executes a script, and only the owner may change it because the
 * worker will later make outbound requests on those coordinates.
 */
import { Hono } from 'hono'
import { MUSIC_LIMITS } from '@shared/music/constants'
import type { MusicSettings } from '@shared/music/model'
import type { AppBindings } from '../env'
import { readJson } from '../lib/request'
import { requireOwner } from '../middleware/auth'
import { MusicStore } from '../music/store'
import { normalizeMusicSettings, recordOf } from '../music/settings'

const SETTINGS_BODY_LIMIT = MUSIC_LIMITS.settingsMaxBytes
const SOURCES_BODY_LIMIT = MUSIC_LIMITS.settingsMaxBytes

interface MusicSources {
  enabled: boolean
  url: string
  method: 'GET' | 'POST'
  params: Record<string, string>
  responsePath: string
  qualityMap: Record<string, string>
}

function sourcesOf(settings: MusicSettings): MusicSources {
  return {
    enabled: settings.customResolverEnabled,
    url: settings.customResolverUrl,
    method: settings.customResolverMethod,
    params: settings.customResolverParams,
    responsePath: settings.customResolverResponsePath,
    qualityMap: settings.customResolverQualityMap,
  }
}

async function loadSettings(store: MusicStore): Promise<MusicSettings> {
  const settings = normalizeMusicSettings(await store.getSettings())
  // Display-only, and always the constant this deployment enforces rather than a client value.
  settings.storageQuotaBytes = MUSIC_LIMITS.quotaBytes
  return settings
}

/**
 * Merge the resolver patch onto the stored document, then run the whole thing through the normal
 * settings guard. Patching the subset instead of writing it as its own row keeps one source of truth
 * for the resolver coordinates: `settings` and `sources` can never disagree.
 */
function mergeSources(current: MusicSettings, patchValue: unknown): MusicSettings {
  const patch = recordOf(patchValue, 'Sources')
  return normalizeMusicSettings({
    ...current,
    customResolverEnabled: patch.enabled ?? current.customResolverEnabled,
    customResolverUrl: patch.url ?? current.customResolverUrl,
    customResolverMethod: patch.method ?? current.customResolverMethod,
    customResolverParams: patch.params ?? current.customResolverParams,
    customResolverResponsePath: patch.responsePath ?? current.customResolverResponsePath,
    customResolverQualityMap: patch.qualityMap ?? current.customResolverQualityMap,
  })
}

export const musicSettingsRoutes = new Hono<AppBindings>()

musicSettingsRoutes.get('/', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ settings: await loadSettings(store) })
})

musicSettingsRoutes.put('/', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SETTINGS_BODY_LIMIT)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const current = await loadSettings(store)
  const settings = normalizeMusicSettings(body.settings ?? body)
  // The resolver makes the worker fetch an arbitrary endpoint. The dedicated /sources route is
  // owner-only; this general document must not become the side door around that guard.
  if (c.get('user')?.role !== 'owner') {
    settings.customResolverEnabled = current.customResolverEnabled
    settings.customResolverUrl = current.customResolverUrl
    settings.customResolverMethod = current.customResolverMethod
    settings.customResolverParams = current.customResolverParams
    settings.customResolverResponsePath = current.customResolverResponsePath
    settings.customResolverQualityMap = current.customResolverQualityMap
  }
  const saved = await store.saveSettings(settings)
  return c.json({
    settings: { ...saved, storageQuotaBytes: MUSIC_LIMITS.quotaBytes },
  })
})

musicSettingsRoutes.get('/sources', requireOwner, async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ sources: sourcesOf(await loadSettings(store)) })
})

musicSettingsRoutes.put('/sources', requireOwner, async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SOURCES_BODY_LIMIT)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const current = await loadSettings(store)
  const settings = mergeSources(current, body.sources ?? body)
  return c.json({ sources: sourcesOf(await store.saveSettings(settings)) })
})
