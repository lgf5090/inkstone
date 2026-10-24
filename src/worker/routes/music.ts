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
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { decryptMusicCookie } from '../lib/crypto'
import { requireAuth } from '../middleware/auth'
import { MusicStore } from '../music/store'
import { selectMusicStorage } from '../music/storage'
import { createNeteaseProvider } from '../music/providers/netease/client'
import { MusicProviderError, type MusicProvider } from '../music/providers/types'
import { createMusicDiscoveryRoutes } from './music-discovery'
import { musicLibraryRoutes } from './music-library'
import { createMusicAccountRoutes } from './music-account'
import { musicSettingsRoutes } from './music-settings'

type Ctx = Context<AppBindings>

/** One provider read costs one spend; a runaway client is stopped before it hammers the upstream. */
const PROVIDER_READ_BUDGET = 120
const PROVIDER_READ_MESSAGE = 'Too many music requests. Try again in a minute.'

export interface MusicProviderRequestOptions {
  /** Login flows must start from an empty jar rather than merging the account already stored. */
  anonymous?: boolean
}

/** What a child router may use from this module without importing it at runtime. */
export interface MusicRouteDeps {
  provider(c: Ctx, options?: MusicProviderRequestOptions): Promise<MusicProvider>
  spendBudget(userId: string): void
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
    return new ApiError(401, 'music_provider_auth_required', message)
  }
  if (error.code === 'not_found' || error.status === 404) {
    return ApiError.notFound(message)
  }
  if (error.code === 'server_misconfigured') {
    return new ApiError(500, 'internal', 'The music provider is not configured correctly')
  }
  if (error.status === 400) return ApiError.badRequest(message)
  if (error.status === 401) {
    return new ApiError(401, 'music_provider_auth_required', message)
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

const providerReadBudget = createMinuteBudget(PROVIDER_READ_BUDGET, PROVIDER_READ_MESSAGE)

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

const deps: MusicRouteDeps = {
  provider: providerFor,
  spendBudget: providerReadBudget,
  translate: musicProviderErrorToApiError,
}

musicRoutes.route('/', createMusicDiscoveryRoutes(deps))
musicRoutes.route('/library', musicLibraryRoutes)
musicRoutes.route('/account', createMusicAccountRoutes(deps))
musicRoutes.route('/', musicSettingsRoutes)
