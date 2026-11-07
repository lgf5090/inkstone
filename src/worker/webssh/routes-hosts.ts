import { Hono, type Context } from 'hono'
import type {
  WebsshAuthMethod,
  WebsshHost,
  WebsshHostBatchAction,
  WebsshHostExportFormat,
  WebsshHostFolder,
  WebsshHostPreflight,
  WebsshHostQuickView,
  WebsshHostsOverview,
} from '@shared/webssh/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { credentialStore } from './credentials'
import {
  clampPage,
  clampPageSize,
  normalizeHostAddress,
  normalizeHostColor,
  normalizeEncoding,
  normalizeHostName,
  normalizeHostNotes,
  normalizeHostPort,
  normalizeHostTags,
  normalizeHostUsername,
  normalizeInitialCommand,
  normalizeTermType,
  parseHostSort,
  WebsshHostsStore,
  type WebsshHostInput,
} from './hosts'
import { WebsshHostKeysStore, normalizeFingerprint, normalizeHostKeyAlgorithm } from './host-keys'
import { groupStore, normalizeGroupColor, normalizeGroupIcon, normalizeGroupName, type WebsshGroupsStore } from './groups'
import { keyStore } from './keys'
import { recordAudit } from './audit'

export const websshHostRoutes = new Hono<AppBindings>()

websshHostRoutes.use('*', requireAuth)

function hostsStore(c: Context<AppBindings>): WebsshHostsStore {
  return new WebsshHostsStore(c.env.DB, c.get('userId'))
}

function groupsStore(c: Context<AppBindings>): WebsshGroupsStore {
  return groupStore(c.env.DB, c.get('userId'))
}

websshHostRoutes.get('/groups', async (c) => c.json({ groups: await groupsStore(c).list() }))

websshHostRoutes.post('/groups', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const parentId = readOptionalId(body.parentId, 'parentId')
  const group = await groupsStore(c).create({
    parentId,
    name: normalizeGroupName(body.name, true),
    color: normalizeGroupColor(body.color),
    icon: normalizeGroupIcon(body.icon),
  })
  return c.json({ group }, 201)
})

websshHostRoutes.patch('/groups/:id', async (c) => {
  const id = c.req.param('id')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const patch: { name?: string; parentId?: string; color?: string; icon?: string; position?: number } = {}
  if (body.name !== undefined) patch.name = normalizeGroupName(body.name, true)
  if (body.parentId !== undefined) patch.parentId = readOptionalId(body.parentId, 'parentId')
  if (body.color !== undefined) patch.color = normalizeGroupColor(body.color)
  if (body.icon !== undefined) patch.icon = normalizeGroupIcon(body.icon)
  if (body.position !== undefined) {
    if (typeof body.position !== 'number' || !Number.isFinite(body.position)) throw ApiError.badRequest('position must be a number')
    patch.position = body.position
  }
  return c.json({ group: await groupsStore(c).update(id, patch) })
})

websshHostRoutes.delete('/groups/:id', async (c) => {
  const removed = await groupsStore(c).remove(c.req.param('id'))
  if (!removed) throw ApiError.notFound('Group not found')
  return c.json({ ok: true })
})

websshHostRoutes.get('/hosts', async (c) => {
  const groupId = c.req.query('groupId') ?? ''
  if (groupId && !isValidId(groupId)) throw ApiError.badRequest('groupId must be a valid group id')
  return c.json(await hostsStore(c).list({
    query: c.req.query('q') ?? '',
    groupId,
    quick: readQuickView(c.req.query('quick'), c.req.query('favorite') === '1'),
    tag: (c.req.query('tag') ?? '').trim().slice(0, 64),
    sort: parseHostSort(c.req.query('sort')),
    page: clampPage(c.req.query('page'), 1),
    pageSize: clampPageSize(c.req.query('pageSize')),
  }))
})

websshHostRoutes.get('/hosts/overview', async (c) => {
  const [groups, counts, overview] = await Promise.all([
    groupsStore(c).list(),
    hostsStore(c).groupCounts(),
    hostsStore(c).overview(),
  ])
  const folders: WebsshHostFolder[] = groups.map((group) => ({ ...group, hostCount: counts.get(group.id) ?? 0 }))
  return c.json<WebsshHostsOverview>({ ...overview, folders })
})

websshHostRoutes.get('/hosts/export', async (c) => {
  const format: WebsshHostExportFormat = c.req.query('format') === 'csv' ? 'csv' : 'ssh-config'
  const hosts = await hostsStore(c).allForExport()
  const body = format === 'csv' ? hostsAsCsv(hosts) : hostsAsSshConfig(hosts)
  return new Response(body, {
    headers: {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="webssh-hosts.${format === 'csv' ? 'csv' : 'conf'}"`,
      'Cache-Control': 'no-store',
    },
  })
})

websshHostRoutes.post('/hosts/batch', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const action = readBatchAction(body.action)
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string' && isValidId(id)) : []
  if (ids.length === 0) throw ApiError.badRequest('Choose at least one host')
  if (ids.length > 100) throw ApiError.badRequest('At most 100 hosts can be changed at once')
  const input: { action: WebsshHostBatchAction; ids: string[]; groupId?: string; tags?: string[] } = { action, ids }
  if (action === 'move') input.groupId = readOptionalId(body.groupId, 'groupId')
  if (action === 'tag') {
    const tags = normalizeHostTags(body.tags)
    if (tags.length === 0) throw ApiError.badRequest('Choose at least one tag')
    input.tags = tags
  }
  return c.json(await hostsStore(c).batch(input))
})

websshHostRoutes.post('/hosts/:id/duplicate', async (c) => {
  const host = await hostsStore(c).duplicate(c.req.param('id'))
  return c.json({ host }, 201)
})

websshHostRoutes.post('/hosts/:id/move', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const groupId = readOptionalId(body.groupId, 'groupId')
  const beforeId = readOptionalId(body.beforeId, 'beforeId')
  return c.json({ host: await hostsStore(c).move(c.req.param('id'), groupId, beforeId) })
})

websshHostRoutes.get('/hosts/:id/sessions', async (c) => {
  const hostId = await requireHost(c)
  const parsed = Number(c.req.query('limit') ?? 10)
  const limit = Number.isFinite(parsed) ? Math.min(50, Math.max(1, Math.trunc(parsed))) : 10
  return c.json({ sessions: await hostsStore(c).sessionHistory(hostId, limit) })
})

websshHostRoutes.post('/hosts', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const input = parseHostBody(body)
  const host = await hostsStore(c).create(input)
  return c.json({ host }, 201)
})

websshHostRoutes.get('/hosts/:id', async (c) => {
  const host = await hostsStore(c).get(c.req.param('id'))
  if (!host) throw ApiError.notFound('Host not found')
  return c.json({ host })
})

websshHostRoutes.patch('/hosts/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await hostsStore(c).get(id)
  if (!existing) throw ApiError.notFound('Host not found')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const input = parseHostBody(body, existing)
  return c.json({ host: await hostsStore(c).update(id, input) })
})

websshHostRoutes.delete('/hosts/:id', async (c) => {
  const removed = await hostsStore(c).softDelete(c.req.param('id'))
  if (!removed) throw ApiError.notFound('Host not found')
  return c.json({ ok: true })
})

websshHostRoutes.get('/hosts/:id/fingerprints', async (c) => {
  const hostId = await requireHost(c)
  return c.json({ fingerprints: await new WebsshHostKeysStore(c.env.DB, c.get('userId')).list(hostId) })
})

websshHostRoutes.post('/hosts/:id/fingerprint/check', async (c) => {
  const hostId = await requireHost(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const check = await new WebsshHostKeysStore(c.env.DB, c.get('userId')).check(
    hostId,
    normalizeHostKeyAlgorithm(body.algorithm),
    normalizeFingerprint(body.fingerprint),
  )
  return c.json({ check })
})

websshHostRoutes.post('/hosts/:id/fingerprints/trust', async (c) => {
  const hostId = await requireHost(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const algorithm = normalizeHostKeyAlgorithm(body.algorithm)
  const fingerprint = normalizeFingerprint(body.fingerprint)
  const check = await new WebsshHostKeysStore(c.env.DB, c.get('userId')).trust(hostId, algorithm, fingerprint)
  await recordAudit(c.env.DB, {
    userId: c.get('userId'),
    hostId,
    eventType: 'host_key_trusted',
    metadata: { algorithm, fingerprint, mode: 'manual' },
  })
  return c.json({ check })
})

websshHostRoutes.post('/hosts/:id/fingerprints/revoke', async (c) => {
  const hostId = await requireHost(c)
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const check = await new WebsshHostKeysStore(c.env.DB, c.get('userId')).revoke(
    hostId,
    normalizeFingerprint(body.fingerprint),
  )
  return c.json({ check })
})

websshHostRoutes.post('/hosts/:id/preflight', async (c) => {
  const hostId = await requireHost(c)
  const host = (await hostsStore(c).get(hostId))!
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const preflight = await buildPreflight(c, host, body)
  return c.json(preflight)
})

async function requireHost(c: Context<AppBindings>): Promise<string> {
  const id = c.req.param('id') ?? ''
  if (!isValidId(id)) throw ApiError.notFound('Host not found')
  const host = await hostsStore(c).get(id)
  if (!host) throw ApiError.notFound('Host not found')
  return id
}

async function buildPreflight(c: Context<AppBindings>, host: WebsshHost, body: Record<string, unknown>): Promise<WebsshHostPreflight> {
  const userId = c.get('userId')
  const issues: string[] = []
  let credentialLabel: string | null = null
  let keyLabel: string | null = null

  if (host.authMethod === 'password') {
    const credential = await credentialStore(c.env.DB, userId).get(host.credentialId)
    credentialLabel = credential?.label ?? null
    if (!credential) {
      issues.push('credential_missing')
    } else if (!c.env.CREDENTIAL_VAULT) {
      issues.push('vault_unavailable')
    } else {
      try {
        await credentialStore(c.env.DB, userId).openSecret(c.env, host.credentialId)
      } catch {
        issues.push('credential_unreadable')
      }
    }
  } else {
    const key = await keyStore(c.env.DB, userId).get(host.keyId)
    keyLabel = key?.label ?? null
    if (!key) {
      issues.push('key_missing')
    } else if (!c.env.CREDENTIAL_VAULT) {
      issues.push('vault_unavailable')
    } else {
      try {
        await keyStore(c.env.DB, userId).openSecret(c.env, host.keyId)
      } catch {
        issues.push('key_unreadable')
      }
    }
  }

  let hostKey = null
  if (typeof body.fingerprint === 'string' && body.fingerprint.trim()) {
    hostKey = await new WebsshHostKeysStore(c.env.DB, userId).check(
      host.id,
      normalizeHostKeyAlgorithm(body.algorithm),
      normalizeFingerprint(body.fingerprint),
    )
  }

  return {
    hostId: host.id,
    host: host.host,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod,
    ready: issues.length === 0,
    issues,
    credentialLabel,
    keyLabel,
    hostKey,
  }
}

function readOptionalId(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !isValidId(value)) throw ApiError.badRequest(`${field} must be a valid id`)
  return value
}

function parseHostBody(body: Record<string, unknown>, existing?: WebsshHost): WebsshHostInput {
  const authMethod = readAuthMethod(body.authMethod, existing?.authMethod ?? 'password')
  const credentialId = readOptionalId(body.credentialId, 'credentialId')
  const keyId = readOptionalId(body.keyId, 'keyId')
  const switchingAuth = body.authMethod !== undefined && existing !== undefined && authMethod !== existing.authMethod
  return {
    name: normalizeHostName(body.name ?? existing?.name, true),
    host: normalizeHostAddress(body.host ?? existing?.host),
    port: normalizeHostPort(body.port ?? existing?.port),
    username: normalizeHostUsername(body.username ?? existing?.username),
    groupId: body.groupId === undefined ? (existing?.groupId ?? '') : readOptionalId(body.groupId, 'groupId'),
    authMethod,
    credentialId: switchingAuth ? credentialId : (credentialId || existing?.credentialId || ''),
    keyId: switchingAuth ? keyId : (keyId || existing?.keyId || ''),
    encoding: normalizeEncoding(body.encoding ?? existing?.encoding),
    termType: normalizeTermType(body.termType ?? existing?.termType),
    initialCommand: normalizeInitialCommand(body.initialCommand ?? existing?.initialCommand),
    color: normalizeHostColor(body.color ?? existing?.color),
    tags: normalizeHostTags(body.tags ?? existing?.tags),
    notes: normalizeHostNotes(body.notes ?? existing?.notes),
    favorite: readBoolean(body.favorite, existing?.favorite ?? false),
    sortOrder: readSortOrder(body.sortOrder, existing?.sortOrder),
  }
}

function readAuthMethod(value: unknown, fallback: WebsshAuthMethod): WebsshAuthMethod {
  if (value === undefined || value === null || value === '') return fallback
  if (value !== 'password' && value !== 'publickey') throw ApiError.badRequest('authMethod must be password or publickey')
  return value
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  throw ApiError.badRequest('favorite must be a boolean')
}

function readSortOrder(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw ApiError.badRequest('sortOrder must be a number')
  return value
}

function readQuickView(value: string | undefined, favorite: boolean): WebsshHostQuickView {
  if (value === 'favorites' || value === 'recent') return value
  return favorite ? 'favorites' : 'all'
}

function readBatchAction(value: unknown): WebsshHostBatchAction {
  if (value === 'move' || value === 'tag' || value === 'favorite' || value === 'unfavorite' || value === 'delete') return value
  throw ApiError.badRequest('Unknown batch action')
}

/** A valid OpenSSH block per host; the alias is derived from the display name and de-duplicated. */
function hostsAsSshConfig(hosts: readonly WebsshHost[]): string {
  const used = new Set<string>()
  const aliasFor = (name: string, index: number): string => {
    const base = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || `host-${index + 1}`
    let alias = base
    let suffix = 2
    while (used.has(alias.toLowerCase())) {
      alias = `${base}-${suffix}`
      suffix += 1
    }
    used.add(alias.toLowerCase())
    return alias
  }
  return hosts.map((host, index) => {
    const alias = aliasFor(host.name, index)
    const tags = host.tags.length ? `# tags: ${host.tags.join(', ')}\n` : ''
    return `${tags}Host ${alias}\n  HostName ${host.host}\n  Port ${host.port}\n  User ${host.username}\n`
  }).join('\n')
}

function hostsAsCsv(hosts: readonly WebsshHost[]): string {
  const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`
  const lines = hosts.map((host) => [host.name, host.host, host.port, host.username, host.tags.join(',')].map(cell).join(','))
  return ['name,host,port,username,tags', ...lines].join('\r\n') + '\r\n'
}
