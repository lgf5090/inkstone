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
import { isBuiltinProvider } from '@shared/webssh/providers'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { JSON_BODY_LIMITS, readFormDataWithinLimit, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { credentialStore } from './credentials'
import {
  clampPage,
  clampPageSize,
  normalizeHostAddress,
  normalizeHostColor,
  normalizeEncoding,
  normalizeHostIconKind,
  normalizeHostIconValue,
  normalizeHostName,
  normalizeHostNotes,
  normalizeHostPort,
  normalizeHostProvider,
  normalizeHostTags,
  normalizeHostUsername,
  normalizeInitialCommand,
  normalizeTermType,
  parseHostSort,
  WebsshHostsStore,
  type WebsshHostInput,
  type WebsshHostListOptions,
} from './hosts'
import { normalizeProviderColor, normalizeProviderLabel, WebsshProvidersStore } from './providers'
import { normalizeHostEgressInput } from './egress'
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

function providersStore(c: Context<AppBindings>): WebsshProvidersStore {
  return new WebsshProvidersStore(c.env.DB, c.get('userId'))
}

websshHostRoutes.get('/providers', async (c) => c.json({ providers: await providersStore(c).list() }))

websshHostRoutes.post('/providers', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const provider = await providersStore(c).create({
    label: normalizeProviderLabel(body.label, true),
    color: normalizeProviderColor(body.color),
  })
  return c.json({ provider }, 201)
})

websshHostRoutes.patch('/providers/:id', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const patch: { label?: string; color?: string } = {}
  if (body.label !== undefined) patch.label = normalizeProviderLabel(body.label, true)
  if (body.color !== undefined) patch.color = normalizeProviderColor(body.color)
  return c.json({ provider: await providersStore(c).update(c.req.param('id'), patch) })
})

websshHostRoutes.delete('/providers/:id', async (c) => {
  const removed = await providersStore(c).remove(c.req.param('id'))
  if (!removed) throw ApiError.notFound('Provider not found')
  return c.json({ ok: true })
})

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
  const options = hostListOptions(c)
  return c.json(await hostsStore(c).list(options))
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
  const store = hostsStore(c)
  const base = hostListOptions(c)
  const hosts: WebsshHost[] = []
  for (let page = 1; page <= 100; page += 1) {
    const chunk = await store.list({ ...base, page, pageSize: 100 })
    hosts.push(...chunk.items)
    if (hosts.length >= chunk.total) break
  }
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
  const input: { action: WebsshHostBatchAction; ids: string[]; groupId?: string; tags?: string[]; provider?: string } = { action, ids }
  if (action === 'move') input.groupId = readOptionalId(body.groupId, 'groupId')
  if (action === 'tag') {
    const tags = normalizeHostTags(body.tags)
    if (tags.length === 0) throw ApiError.badRequest('Choose at least one tag')
    input.tags = tags
  }
  if (action === 'provider') input.provider = normalizeHostProvider(body.provider)
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
  const id = c.req.param('id')
  const host = await hostsStore(c).get(id)
  if (!host) throw ApiError.notFound('Host not found')
  const removed = await hostsStore(c).softDelete(id)
  if (!removed) throw ApiError.notFound('Host not found')
  if (c.env.FILES && host.iconUrl) {
    await c.env.FILES.delete(`webssh/icons/${c.get('userId')}/${id}`).catch((error: unknown) => {
      console.warn('[inkstone] WebSSH icon cleanup failed:', error instanceof Error ? error.message : error)
    })
  }
  return c.json({ ok: true })
})

const ICON_MAX_BYTES = 1024 * 1024
const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function iconSignatureMatches(bytes: Uint8Array, type: string): boolean {
  if (type === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/webp') {
    return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  }
  return false
}

websshHostRoutes.post('/hosts/:id/icon', async (c) => {
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'Icon storage is not configured')
  const hostId = await requireHost(c)
  const form = await readFormDataWithinLimit({ raw: c.req.raw }, ICON_MAX_BYTES + 512 * 1024)
  const upload = form.get('icon')
  if (!(upload instanceof File)) throw ApiError.badRequest('An image is expected in the "icon" field')
  const type = upload.type || 'application/octet-stream'
  if (!ICON_TYPES.has(type)) throw new ApiError(415, 'bad_request', 'Only PNG, JPEG and WebP icons are supported')
  if (upload.size > ICON_MAX_BYTES) throw ApiError.tooLarge('An icon may hold at most 1 MB')
  const bytes = new Uint8Array(await upload.arrayBuffer())
  if (!iconSignatureMatches(bytes, type)) throw ApiError.badRequest('The icon bytes do not match its declared type')
  const key = `webssh/icons/${c.get('userId')}/${hostId}`
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType: type } })
  await hostsStore(c).setIcon(hostId, key, 'image')
  return c.json({ host: await hostsStore(c).get(hostId) })
})

websshHostRoutes.delete('/hosts/:id/icon', async (c) => {
  const hostId = await requireHost(c)
  if (c.env.FILES) await c.env.FILES.delete(`webssh/icons/${c.get('userId')}/${hostId}`)
  await hostsStore(c).setIcon(hostId, '', '')
  return c.json({ host: await hostsStore(c).get(hostId) })
})

websshHostRoutes.get('/icons/:id', async (c) => {
  if (!c.env.FILES) throw new ApiError(503, 'storage_unavailable', 'Icon storage is not configured')
  const hostId = c.req.param('id')
  if (!isValidId(hostId)) throw ApiError.notFound('Icon not found')
  const row = await hostsStore(c).row(hostId)
  if (!row?.icon_key) throw ApiError.notFound('Icon not found')
  const object = await c.env.FILES.get(row.icon_key)
  if (!object) throw ApiError.notFound('Icon not found')
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  })
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
  const iconKind = normalizeHostIconKind(body.iconKind, existing?.iconKind ?? '')
  const iconValue = normalizeHostIconValue(body.iconValue ?? existing?.iconValue)
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
    pinned: readBoolean(body.pinned, existing?.pinned ?? false),
    provider: normalizeHostProvider(body.provider, existing?.provider ?? 'other'),
    iconKind,
    iconValue,
    iconKey: '',
    egress: normalizeHostEgressInput(body.egress, existing?.egress),
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
  if (value === 'favorites' || value === 'pinned' || value === 'recent') return value
  return favorite ? 'favorites' : 'all'
}

function readBatchAction(value: unknown): WebsshHostBatchAction {
  if (value === 'move' || value === 'tag' || value === 'favorite' || value === 'unfavorite' || value === 'delete' || value === 'provider') return value
  throw ApiError.badRequest('Unknown batch action')
}

/** The list and export share one filter parser so a filtered export cannot drift from the screen. */
function hostListOptions(c: Context<AppBindings>): WebsshHostListOptions {
  const groupId = c.req.query('groupId') ?? ''
  if (groupId && !isValidId(groupId)) throw ApiError.badRequest('groupId must be a valid group id')
  const provider = c.req.query('provider') ?? ''
  return {
    query: c.req.query('q') ?? '',
    groupId,
    quick: readQuickView(c.req.query('quick'), c.req.query('favorite') === '1'),
    tag: (c.req.query('tag') ?? '').trim().slice(0, 64),
    sort: parseHostSort(c.req.query('sort')),
    filters: {
      provider: isBuiltinProvider(provider) || /^custom:[A-Za-z0-9]{20,32}$/.test(provider) ? provider : '',
      pinned: c.req.query('pinned') === '1',
      status: c.req.query('status') === 'connected' || c.req.query('status') === 'never' ? c.req.query('status') as 'connected' | 'never' : '',
      connected: { from: dateQuery(c.req.query('connectedFrom')), to: dateQuery(c.req.query('connectedTo')) },
      created: { from: dateQuery(c.req.query('createdFrom')), to: dateQuery(c.req.query('createdTo')) },
    },
    page: clampPage(c.req.query('page'), 1),
    pageSize: clampPageSize(c.req.query('pageSize')),
  }
}

function dateQuery(value: string | undefined): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
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
    return `# provider: ${host.provider}\n${tags}Host ${alias}\n  HostName ${host.host}\n  Port ${host.port}\n  User ${host.username}\n`
  }).join('\n')
}

function hostsAsCsv(hosts: readonly WebsshHost[]): string {
  const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`
  const lines = hosts.map((host) => [host.name, host.host, host.port, host.username, host.tags.join(','), host.provider].map(cell).join(','))
  return ['name,host,port,username,tags,provider', ...lines].join('\r\n') + '\r\n'
}
