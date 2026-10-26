/**
 * `/api/cloudflare/accounts` — one slice of the Cloudflare app.
 *
 * The router is created here and filled by its own task; keeping the file and its export in place
 * means the aggregate router never has to change again while the slices land.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'

export const accountsRouter = new Hono<AppBindings>()
