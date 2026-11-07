import { Hono, type Context } from 'hono'
import type { WebsshAuthMethod, WebsshHost, WebsshHostPreflight } from '@shared/webssh/types'
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
    favoriteOnly: c.req.query('favorite') === '1',
    sort: parseHostSort(c.req.query('sort')),
    page: clampPage(c.req.query('page'), 1),
    pageSize: clampPageSize(c.req.query('pageSize')),
  }))
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
  const check = await new WebsshHostKeysStore(c.env.DB, c.get('userId')).trust(
    hostId,
    normalizeHostKeyAlgorithm(body.algorithm),
    normalizeFingerprint(body.fingerprint),
  )
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
