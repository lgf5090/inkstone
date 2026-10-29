import { Hono } from 'hono'
import type { AppBindings } from '../env'

/** Placeholder router; the upstream slice replaces this body. */
export const youtubeUpstreamRoutes = new Hono<AppBindings>()
