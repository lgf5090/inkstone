/**
 * `/api/cloudflare/toolbox` — read-only DNS, RDAP, HTTP probe and Cloudflare trace helpers.
 *
 * There is no Cloudflare product API behind these tools; they call public endpoints. No writes, no
 * audit rows, and no reader credentials leave this deployment.
 */
import { Hono } from 'hono'
import type { AppBindings } from '../../env'
import { readJson } from '../../lib/request'
import { lookupDns, lookupRdap, probeHttp, readCloudflareTrace } from '../../cloudflare/toolbox'

export const toolboxRouter = new Hono<AppBindings>()

toolboxRouter.get('/dns', async (c) => {
  const name = c.req.query('name') ?? ''
  const type = c.req.query('type') ?? 'A'
  return c.json(await lookupDns(name, type))
})

toolboxRouter.get('/rdap', async (c) => {
  const domain = c.req.query('domain') ?? ''
  return c.json(await lookupRdap(domain))
})

toolboxRouter.post('/probe', async (c) => {
  const body = await readJson<Record<string, unknown>>(c)
  const url = typeof body.url === 'string' ? body.url : ''
  const method = body.method === 'HEAD' ? 'HEAD' : 'GET'
  return c.json(await probeHttp(url, method))
})

toolboxRouter.get('/trace', async (c) => {
  return c.json({ trace: await readCloudflareTrace() })
})
