import { Hono } from 'hono'
import type { AppBindings } from '../env'

/** Placeholder router; the library slice replaces this body. */
export const youtubeLibraryRoutes = new Hono<AppBindings>()
