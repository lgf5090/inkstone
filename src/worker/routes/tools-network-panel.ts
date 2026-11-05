/**
 * Network panel API (`/api/tools/network-panel/*`).
 *
 * The speed test's payload is generated here rather than fetched from a CDN: the browser stays inside
 * the page's `connect-src`, the measurement is the reader's own downlink to this deployment, and no
 * request carries a URL the server would have to trust. The only network metadata this file reads is
 * the one Cloudflare already attached to the request, so there is no SSRF surface at all.
 */
import { Hono, type Context } from 'hono'
import type { z } from 'zod'
import {
  NodeInputSchema,
  RunInputSchema,
  RunsQuerySchema,
  SettingsPatchSchema,
} from '@shared/tools/network-panel/schemas'
import {
  NETWORK_PANEL_LIMITS,
  type NetworkPanelInfo,
} from '@shared/tools/network-panel/types'
import { clampDownloadBytes } from '@shared/tools/network-panel/engine'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { createMinuteBudget } from '../lib/rate-limit'
import { newId } from '../lib/id'
import { requireAuth } from '../middleware/auth'
import { NetworkPanelStore } from '../tools/network-panel/store'

export const toolsNetworkPanelRoutes = new Hono<AppBindings>()

toolsNetworkPanelRoutes.use('*', requireAuth)

function getUserId(c: Context<AppBindings>): string {
  const user = c.get('user')
  const userId = user?.id || c.get('userId')
  if (!userId) throw ApiError.unauthenticated()
  return userId
}

function getStore(c: Context<AppBindings>): NetworkPanelStore {
  return new NetworkPanelStore(c.env.DB, getUserId(c))
}

async function parseBody<T>(c: Context<AppBindings>, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw ApiError.badRequest(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Validation failed')
  }
  return result.data
}

function parseQuery<T>(c: Context<AppBindings>, schema: z.ZodType<T>): T {
  const raw: Record<string, string> = {}
  for (const [key, value] of new URL(c.req.url).searchParams) raw[key] = value
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw ApiError.badRequest(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid query')
  }
  return result.data
}

const settingsBudget = createMinuteBudget(120, 'Too many settings changes in one minute, try again shortly')
const nodeBudget = createMinuteBudget(30, 'Too many node changes in one minute, try again shortly')
const runBudget = createMinuteBudget(60, 'Too many recorded tests in one minute, try again shortly')

toolsNetworkPanelRoutes.get('/settings', async (c) => {
  const settings = await getStore(c).getSettings()
  return c.json({ data: settings })
})

toolsNetworkPanelRoutes.put('/settings', async (c) => {
  settingsBudget(getUserId(c))
  const patch = await parseBody(c, SettingsPatchSchema)
  const settings = await getStore(c).saveSettings(patch)
  return c.json({ data: settings })
})

toolsNetworkPanelRoutes.get('/nodes', async (c) => {
  const nodes = await getStore(c).listNodes()
  return c.json({ data: nodes })
})

toolsNetworkPanelRoutes.post('/nodes', async (c) => {
  const userId = getUserId(c)
  nodeBudget(userId)
  const input = await parseBody(c, NodeInputSchema)
  try {
    const node = await getStore(c).createNode({ id: newId(), label: input.label, url: input.url })
    return c.json({ data: node }, 201)
  } catch (error) {
    if (error instanceof Error && error.message === 'node_limit') {
      throw ApiError.badRequest(`At most ${NETWORK_PANEL_LIMITS.maxNodes} custom addresses can be saved`)
    }
    throw error
  }
})

toolsNetworkPanelRoutes.delete('/nodes/:id', async (c) => {
  nodeBudget(getUserId(c))
  const removed = await getStore(c).deleteNode(c.req.param('id'))
  if (!removed) throw ApiError.notFound('That address is not saved')
  return c.json({ data: { removed: true } })
})

toolsNetworkPanelRoutes.get('/runs', async (c) => {
  const query = parseQuery(c, RunsQuerySchema)
  const history = await getStore(c).listRuns(
    query.limit ?? NETWORK_PANEL_LIMITS.runPageDefault,
    query.offset ?? 0,
  )
  c.header('Cache-Control', 'no-store')
  return c.json({ data: history })
})

toolsNetworkPanelRoutes.post('/runs', async (c) => {
  runBudget(getUserId(c))
  const input = await parseBody(c, RunInputSchema)
  const run = await getStore(c).recordRun(input)
  return c.json({ data: run }, 201)
})

toolsNetworkPanelRoutes.delete('/runs', async (c) => {
  runBudget(getUserId(c))
  const removed = await getStore(c).clearRuns()
  return c.json({ data: { removed } })
})

toolsNetworkPanelRoutes.delete('/runs/:id', async (c) => {
  runBudget(getUserId(c))
  const id = c.req.param('id')
  if (!id) throw ApiError.badRequest('Unknown history row')
  const removed = await getStore(c).deleteRun(id)
  if (!removed) throw ApiError.notFound('That history row is gone')
  return c.json({ data: { removed: true } })
})

/** Cloudflare's own reading of the request. A local run has none, which the screen says out loud. */
toolsNetworkPanelRoutes.get('/info', async (c) => {
  const request = c.req.raw as Request & { cf?: Record<string, unknown> }
  const cf = request.cf
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  const info: NetworkPanelInfo = {
    ip: c.req.header('cf-connecting-ip') ?? forwarded ?? null,
    country: typeof cf?.country === 'string' ? cf.country : null,
    region: typeof cf?.region === 'string' ? cf.region : null,
    city: typeof cf?.city === 'string' ? cf.city : null,
    isp: typeof cf?.asOrganization === 'string' ? cf.asOrganization : null,
    asn: typeof cf?.asn === 'number' ? cf.asn : null,
    colo: typeof cf?.colo === 'string' ? cf.colo : null,
    edge_geo: Boolean(cf && typeof cf.country === 'string'),
    observed_at: Date.now(),
  }
  c.header('Cache-Control', 'no-store')
  return c.json({ data: info })
})

/** A clock the browser measures round-trip against; the body carries no data of its own. */
toolsNetworkPanelRoutes.get('/ping', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ t: Date.now() })
})

/**
 * The measured payload.
 *
 * One block is generated once per isolate and streamed until the requested byte count is reached, so
 * a request costs no randomness per chunk and no allocation per read. The block is incompressible
 * (random bytes) and the response forbids caching and compression, or a CDN would answer the second
 * thread from its cache and the test would measure the network that is not there.
 */
toolsNetworkPanelRoutes.get('/download', (c) => {
  getUserId(c)
  const requested = Number.parseInt(c.req.query('bytes') ?? '', 10)
  const bytes = clampDownloadBytes(Number.isFinite(requested) ? requested : null)
  let sent = 0
  let block: Uint8Array | null = null
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      block ??= measurementBlock()
      const remaining = bytes - sent
      if (remaining <= 0) {
        controller.close()
        return
      }
      const size = Math.min(block.length, remaining)
      controller.enqueue(size === block.length ? block : block.subarray(0, size))
      sent += size
    },
  })
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Length', String(bytes))
  c.header('Content-Encoding', 'identity')
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('X-Content-Type-Options', 'nosniff')
  return c.body(body)
})

/** One incompressible block per isolate, reused by every chunk and every reader of this isolate. */
let cachedBlock: Uint8Array | null = null

function measurementBlock(): Uint8Array {
  if (!cachedBlock) {
    cachedBlock = new Uint8Array(64 * 1024)
    crypto.getRandomValues(cachedBlock)
  }
  return cachedBlock
}
