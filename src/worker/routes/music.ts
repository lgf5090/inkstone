/**
 * The `/api/music` surface.
 *
 * Everything here needs a session, including the health probe, because music is an account feature:
 * no unauthenticated caller may learn which provider a deployment uses. Content reads go through a
 * provider built per request from the account's stored cookie ciphertext; the plaintext cookie exists
 * only inside that provider instance and is never returned by a route.
 *
 * Static child routers are mounted on the same prefix. Their handlers receive this module's provider
 * factory and error translation by argument instead of importing them back, so routes never form an
 * import cycle and the provider seam stays in one place.
 */
import { Hono, type Context } from 'hono'
import { musicTrackKey } from '@shared/music/model'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { decryptMusicCookie } from '../lib/crypto'
import { requireAuth } from '../middleware/auth'
import { MusicStore } from '../music/store'
import { selectMusicStorage } from '../music/storage'
import { createNeteaseProvider } from '../music/providers/netease/client'
import { spendProviderRead } from '../music/providers/budget'
import { MusicProviderError, type MusicProvider } from '../music/providers/types'
import { createMusicDiscoveryRoutes } from './music-discovery'
import { createMusicCommentsRoutes } from './music-comments'
import { musicDriveRoutes } from './music-drive'
import { musicLibraryRoutes } from './music-library'
import { createMusicAccountRoutes } from './music-account'
import { musicDownloadRoutes } from './music-downloads'
import { musicFileRoutes } from './music-files'
import { musicSettingsRoutes } from './music-settings'
import { musicUploadRoutes } from './music-uploads'

type Ctx = Context<AppBindings>

export interface MusicProviderRequestOptions {
  /** Login flows must start from an empty jar rather than merging the account already stored. */
  anonymous?: boolean
}

/** What a child router may use from this module without importing it at runtime. */
export interface MusicRouteDeps {
  provider(c: Ctx, options?: MusicProviderRequestOptions): Promise<MusicProvider>
  translate(error: unknown): unknown
}

/**
 * Turn a provider refusal into the API's own vocabulary without copying its payload.
 *
 * The upstream response can name a user, a song or a session state; the client only needs a stable
 * code and the provider's own English sentence. Bodies stay in the worker.
 */
export function musicProviderErrorToApiError(error: unknown): unknown {
  if (!(error instanceof MusicProviderError)) return error
  const message = error.message || 'The music provider failed'
  if (error.code === 'source_unavailable') {
    return new ApiError(502, 'music_source_unavailable', message)
  }
  if (error.code === 'auth_required') {
    // A provider session is not the Inkstone session: 401 here would make the client sign the
    // reader out of the app. 409 names the reconnect action without touching the account session.
    return new ApiError(409, 'music_provider_auth_required', message)
  }
  if (error.code === 'not_found' || error.status === 404) {
    return ApiError.notFound(message)
  }
  if (error.code === 'server_misconfigured') {
    return new ApiError(500, 'internal', 'The music provider is not configured correctly')
  }
  if (error.status === 400) return ApiError.badRequest(message)
  if (error.status === 401) {
    return new ApiError(409, 'music_provider_auth_required', message)
  }
  return new ApiError(502, 'music_provider_unavailable', message)
}

/**
 * Build the provider for this request.
 *
 * The stored cookie is ciphertext; a vault that cannot open it degrades to anonymous reads (public
 * catalogue and non-VIP playback still work) and logs why, rather than presenting the account as
 * connected. Login routes ask for `anonymous` because a QR scan or a pasted cookie must not be mixed
 * with whatever session was stored before.
 */
async function providerFor(c: Ctx, options: MusicProviderRequestOptions = {}): Promise<MusicProvider> {
  const userId = c.get('userId')
  spendProviderRead(userId)
  let cookie: string | undefined
  if (!options.anonymous) {
    const stored = await new MusicStore(c.env.DB, userId).getAccountCookie('netease')
    if (stored) {
      try {
        cookie = (await decryptMusicCookie(c.env, userId, stored)) ?? undefined
      } catch (error) {
        // Anonymous fallback is the honest answer: the account row exists but this deployment cannot
        // read it, and failing every read would hide the public catalogue behind a vault problem.
        console.warn('[inkstone] Music account cookie could not be decrypted; reading anonymously:', error)
      }
    }
  }
  return createNeteaseProvider({
    cookie,
    upstreamBaseUrl: c.env.MUSIC_UPSTREAM_API,
  })
}

export const musicRoutes = new Hono<AppBindings>()

musicRoutes.use('*', requireAuth)

musicRoutes.get('/health', async (c) => {
  const account = await new MusicStore(c.env.DB, c.get('userId')).getAccount('netease')
  const upstream = c.env.MUSIC_UPSTREAM_API ? 'external' : 'native'
  return c.json({
    // `MusicHealth` freezes the provider axis as native/external; `account` mirrors its netease flag
    // for readers of the older plan shape. No URL, key or cookie crosses this boundary.
    provider: upstream,
    storage: selectMusicStorage(c.env) ?? 'none',
    netease: Boolean(account),
    upstream: upstream === 'external',
    account: { netease: Boolean(account) },
  })
})

/**
 * One track's lyrics, cached for a month.
 *
 * The cache is keyed by provider identity rather than by the local row id so a re-imported track
 * finds the same lyric. A provider that has no lyric is answered as "no lyrics", not as a failed
 * request: the player keeps playing.
 */
musicRoutes.get('/library/lyrics/:trackId', async (c) => {
  const trackId = c.req.param('trackId') ?? ''
  if (!trackId || trackId.length > 128) throw ApiError.notFound('That track does not exist')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const track = await store.getTrack(trackId) ?? await store.findTrack('netease', trackId)
  if (!track) throw ApiError.notFound('That track does not exist')
  const cached = await store.getLyric(musicTrackKey(track.provider, track.providerId))
  if (cached) return c.json(cached)
  // Only the Netease provider has a lyric endpoint. An upload or a WebDAV reference either carried
  // its lyric at import time or has none; asking Netease with that id would be a different song.
  if (track.provider !== 'netease') {
    throw new ApiError(404, 'music_lyrics_unavailable', 'No lyrics are available for this track')
  }

  const provider = await providerFor(c)
  try {
    const payload = await provider.lyrics(track.providerId)
    if (!payload.lyric) throw new ApiError(404, 'music_lyrics_unavailable', 'No lyrics are available for this track')
    const settings = await store.getSettings()
    if (settings?.cacheLyrics === false) {
      return c.json({ ...payload.lyric, fetchedAt: Date.now() })
    }
    const saved = await store.saveLyric({
      trackKey: payload.lyric.trackKey,
      source: payload.lyric.source,
      lrc: payload.lyric.lrc,
      tlyric: payload.lyric.tlyric,
      yrc: payload.lyric.yrc,
    })
    return c.json(saved)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw musicProviderErrorToApiError(error)
  }
})

const deps: MusicRouteDeps = {
  provider: providerFor,
  translate: musicProviderErrorToApiError,
}

// Each child router carries a `use('*')` guard. Mounted at `/`, any one of them would answer a path
// it does not own with its own 404 before the next router saw the request, so every router gets a
// prefix and discovery is the only app left at the root, registered last.
musicRoutes.route('/library', musicLibraryRoutes)
musicRoutes.route('/account', createMusicAccountRoutes(deps))
musicRoutes.route('/media', musicFileRoutes)
musicRoutes.route('/uploads', musicUploadRoutes)
musicRoutes.route('/downloads', musicDownloadRoutes)
musicRoutes.route('/drive', musicDriveRoutes)
musicRoutes.route('/settings', musicSettingsRoutes)
musicRoutes.route('/', createMusicCommentsRoutes(deps))
musicRoutes.route('/', createMusicDiscoveryRoutes(deps))
