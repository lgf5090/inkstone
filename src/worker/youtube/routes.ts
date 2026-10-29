/**
 * The YouTube app's API surface. Every route needs a session: the upstream key belongs to the
 * deployment, so an anonymous reader would spend a shared quota.
 *
 * The routers are split by concern so the library, the upstream proxy, the media cache and the
 * quota ledger can be read (and changed) without stepping on each other.
 */
import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth'
import type { AppBindings } from '../env'
import { youtubeMediaRoutes } from './routes-media'
import { youtubeQuotaRoutes } from './routes-quota'
import { youtubeLibraryRoutes } from './routes-library'
import { youtubeUpstreamRoutes } from './routes-upstream'

export const youtubeRoutes = new Hono<AppBindings>()

youtubeRoutes.use('*', requireAuth)
youtubeRoutes.route('/media', youtubeMediaRoutes)
youtubeRoutes.route('/quota', youtubeQuotaRoutes)
youtubeRoutes.route('/library', youtubeLibraryRoutes)
youtubeRoutes.route('/', youtubeUpstreamRoutes)
