import { Hono } from 'hono'
import type { AppBindings } from '../env'

/** Placeholder router; the media slice replaces this body. */
export const youtubeMediaRoutes = new Hono<AppBindings>()
