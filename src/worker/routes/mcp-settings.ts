import { Hono, type Context } from 'hono'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import {
  clearAiIndex,
  drainAiIndexQueue,
  enqueueAllNotesForIndex,
  getAiSearchStatus,
  isAiSearchAvailable,
  isAiSearchEnabled,
  setAiSearchEnabled,
} from '../mcp/ai-search'
import {
  createMcpApiKey,
  listMcpApiKeys,
  revokeMcpApiKey,
} from '../mcp/api-keys'
import { collectGrantIds } from '../mcp/credentials'
import { mcpServerToolCatalog } from '../mcp/server'
import {
  getMcpPreferences,
  isMcpEnabled,
  MCP_SUPPORTED_SCOPES,
  setMcpEnabled,
  updateMcpPreferences,
} from '../mcp/settings'

export const mcpSettingsRoutes = new Hono<AppBindings>()

mcpSettingsRoutes.use('*', requireAuth)

mcpSettingsRoutes.get('/', async (c) => {
  const user = c.get('user')
  const [preferences, apiKeys, aiSearch] = await Promise.all([
    getMcpPreferences(c.env.DB, user.id),
    listMcpApiKeys(c.env.DB, user.id),
    getAiSearchStatus(c.env.DB, c.env, user.id),
  ])
  const grants = c.env.OAUTH_PROVIDER
    ? await collectGrants(c.env.OAUTH_PROVIDER, user.id)
    : []
  const origin = configuredOrigin(c.req.raw, c.env.PUBLIC_URL)
  return c.json({
    enabled: await isMcpEnabled(c.env.DB),
    canManageGlobal: user.role === 'owner',
    endpoint: `${origin}/mcp`,
    oauth: true,
    preferences,
    // A list of names and titles: whether the keyword index is on cannot change it, and the catalog is
    // read without a request context because nothing in it runs.
    tools: mcpServerToolCatalog({ env: c.env, origin, ftsEnabled: false }),
    apiKeys,
    aiSearch,
    grants,
    privacy: {
      publicEndpoint: false,
      perUserIndex: true,
      externalClientReceivesSelectedContent: true,
    },
  })
})

mcpSettingsRoutes.put('/', async (c) => {
  const user = c.get('user')
  const body = await readJson<{
    enabled?: boolean
    writeEnabled?: boolean
    trashEnabled?: boolean
    disabledTools?: unknown
  }>(c, JSON_BODY_LIMITS.settings)

  for (const key of ['enabled', 'writeEnabled', 'trashEnabled'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') {
      throw ApiError.badRequest(`${key} must be a boolean`)
    }
  }
  if (body.enabled !== undefined) {
    if (user.role !== 'owner') throw ApiError.forbidden('Only the owner can enable or disable MCP')
    await setMcpEnabled(c.env.DB, body.enabled)
  }

  const preferences = await updateMcpPreferences(c.env.DB, user.id, {
    ...(body.writeEnabled !== undefined ? { writeEnabled: body.writeEnabled } : {}),
    ...(body.trashEnabled !== undefined ? { trashEnabled: body.trashEnabled } : {}),
    ...(body.disabledTools !== undefined ? { disabledTools: disabledToolsFrom(c, body.disabledTools) } : {}),
  })
  return c.json({
    enabled: await isMcpEnabled(c.env.DB),
    preferences,
    reconnectRequired: body.writeEnabled !== undefined || body.trashEnabled !== undefined,
  })
})

/**
 * The switched-off list, checked against the tools this server actually registers.
 *
 * A name that matches nothing is refused rather than stored: it would be a switch the reader cannot see the
 * effect of, and it would survive a rename in the code as a rule that quietly governs nothing. The catalog
 * is read here rather than trusted from the body for the same reason.
 */
function disabledToolsFrom(c: Context<AppBindings>, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    throw ApiError.badRequest('disabledTools must be an array of tool names')
  }
  const known = new Set(mcpServerToolCatalog({
    env: c.env,
    origin: configuredOrigin(c.req.raw, c.env.PUBLIC_URL),
    ftsEnabled: false,
  }).map((tool) => tool.name))
  const names = value as string[]
  const unknown = names.find((name) => !known.has(name))
  if (unknown !== undefined) throw ApiError.badRequest(`No such MCP tool: ${unknown}`)
  return names
}

mcpSettingsRoutes.post('/keys', async (c) => {
  const user = c.get('user')
  if (!await isMcpEnabled(c.env.DB)) throw ApiError.conflict('MCP is disabled')
  const body = await readJson<{ name?: unknown, scopes?: unknown }>(c, JSON_BODY_LIMITS.small)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 80) throw ApiError.badRequest('name must be 1-80 characters')
  const created = await createMcpApiKey(c.env.DB, user.id, name, scopesFrom(body.scopes))
  return c.json({ key: created.record, token: created.token }, 201)
})

/** What a new key should carry, checked against the scopes this server understands. */
function scopesFrom(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== 'string')) {
    throw ApiError.badRequest('scopes must be an array of scope names')
  }
  const names = value as string[]
  const unknown = names.find((scope) => !(MCP_SUPPORTED_SCOPES as readonly string[]).includes(scope))
  if (unknown !== undefined) throw ApiError.badRequest(`Unknown MCP scope: ${unknown}`)
  return names
}

mcpSettingsRoutes.delete('/keys/:id', async (c) => {
  const revoked = await revokeMcpApiKey(c.env.DB, c.get('userId'), c.req.param('id'))
  if (!revoked) throw ApiError.notFound('API key not found')
  return c.json({ ok: true })
})

mcpSettingsRoutes.get('/ai-search', async (c) => {
  return c.json(await getAiSearchStatus(c.env.DB, c.env, c.get('userId')))
})

mcpSettingsRoutes.put('/ai-search', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{ enabled?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('enabled must be a boolean')
  if (body.enabled && !await isMcpEnabled(c.env.DB)) throw ApiError.conflict('MCP is disabled')
  if (body.enabled && !isAiSearchAvailable(c.env)) {
    throw ApiError.conflict('Workers AI is not configured')
  }
  await setAiSearchEnabled(c.env.DB, userId, body.enabled)
  if (body.enabled) {
    const enqueued = await enqueueAllNotesForIndex(c.env.DB, userId)
    // Kick off the first batch immediately; the rest is drained by the cron.
    c.executionCtx.waitUntil(drainAiIndexQueue(c.env, 30).catch(() => {}))
    return c.json({ ...await getAiSearchStatus(c.env.DB, c.env, userId), enqueued })
  }
  return c.json(await getAiSearchStatus(c.env.DB, c.env, userId))
})

mcpSettingsRoutes.post('/ai-search/reindex', async (c) => {
  const userId = c.get('userId')
  if (!await isMcpEnabled(c.env.DB)) throw ApiError.conflict('MCP is disabled')
  if (!isAiSearchAvailable(c.env)) throw ApiError.conflict('Workers AI is not configured')
  if (!await isAiSearchEnabled(c.env.DB, userId)) throw ApiError.conflict('AI search is disabled')
  const enqueued = await enqueueAllNotesForIndex(c.env.DB, userId)
  const status = await getAiSearchStatus(c.env.DB, c.env, userId)
  c.executionCtx.waitUntil(drainAiIndexQueue(c.env, 30).catch(() => {}))
  return c.json({ ok: true, enqueued, ...status })
})

mcpSettingsRoutes.post('/ai-search/clear', async (c) => {
  const removed = await clearAiIndex(c.env.DB, c.get('userId'))
  return c.json({ ok: true, removed })
})

mcpSettingsRoutes.delete('/grants/:id', async (c) => {
  if (!c.env.OAUTH_PROVIDER) throw new ApiError(503, 'internal', 'OAuth is unavailable')
  await c.env.OAUTH_PROVIDER.revokeGrant(c.req.param('id'), c.get('userId'))
  return c.json({ ok: true })
})

mcpSettingsRoutes.post('/grants/revoke-all', async (c) => {
  if (!c.env.OAUTH_PROVIDER) throw new ApiError(503, 'internal', 'OAuth is unavailable')
  const grants = await collectGrantIds(c.env.OAUTH_PROVIDER, c.get('userId'))
  for (let offset = 0; offset < grants.length; offset += 25) {
    await Promise.all(
      grants.slice(offset, offset + 25)
        .map((id) => c.env.OAUTH_PROVIDER!.revokeGrant(id, c.get('userId'))),
    )
  }
  return c.json({ ok: true, revoked: grants.length })
})

async function collectGrants(
  oauth: NonNullable<AppBindings['Bindings']['OAUTH_PROVIDER']>,
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const output: Array<Record<string, unknown>> = []
  let cursor: string | undefined
  do {
    const page = await oauth.listUserGrants(userId, { limit: 100, cursor })
    output.push(...page.items.map((grant) => ({
      id: grant.id,
      clientId: grant.clientId,
      clientName: typeof grant.metadata?.clientName === 'string' ? grant.metadata.clientName : 'MCP client',
      clientUri: typeof grant.metadata?.clientUri === 'string' ? grant.metadata.clientUri : null,
      scopes: grant.scope,
      createdAt: grant.createdAt * 1000,
      expiresAt: grant.expiresAt ? grant.expiresAt * 1000 : null,
    })))
    cursor = page.cursor
  } while (cursor && output.length < 500)
  return output
}

function configuredOrigin(request: Request, configured?: string): string {
  if (!configured) return new URL(request.url).origin
  try {
    return new URL(configured).origin
  } catch {
    return new URL(request.url).origin
  }
}
