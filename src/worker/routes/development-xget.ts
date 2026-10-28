import { Hono } from 'hono'
import type { AppBindings } from '../env'

export const developmentXgetRoutes = new Hono<AppBindings>()

developmentXgetRoutes.all('*', (c) => c.json({ error: { code: 'not_found', message: 'Xget is not available yet' } }, 404))
