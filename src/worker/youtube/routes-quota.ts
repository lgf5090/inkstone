import { Hono } from 'hono'
import type { AppBindings } from '../env'

/** Placeholder router; the quota slice replaces this body. */
export const youtubeQuotaRoutes = new Hono<AppBindings>()
