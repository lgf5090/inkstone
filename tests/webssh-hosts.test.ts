// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ExecutionContext } from 'hono'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  WebsshCredential,
  WebsshHost,
  WebsshHostGroup,
  WebsshHostKey,
  WebsshHostKeyCheck,
  WebsshHostListResponse,
  WebsshHostPreflight,
  WebsshHostSessionSummary,
  WebsshHostsOverview,
  WebsshKey,
  WebsshProvider,
} from '../src/shared/webssh/types'
import { createApp } from '../src/worker/app'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import type { Env } from '../src/worker/env'
import { newId } from '../src/worker/lib/id'
import { hashToken } from '../src/worker/lib/session-store'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const FIXTURES = fileURLToPath(new URL('./fixtures/webssh/', import.meta.url))
const PASSPHRASE = 'w3-passphrase'

const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'
const OWNER_TOKEN = 'a'.repeat(64)
const OTHER_TOKEN = 'b'.repeat(64)

const app = createApp()
const pending: Promise<unknown>[] = []
const ctx: ExecutionContext = {
  waitUntil(promise) {
    pending.push(promise)
  },
  passThroughOnException() {},
  props: {},
}

const vaultStorage = new Map<string, unknown>()

function vaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) {
        return vaultStorage.get(key)
      },
      async put(key: string, value: unknown) {
        vaultStorage.set(key, value)
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

let sqlite: DatabaseSync
let env: Env

function insertUser(id: string, username: string): void {
  const now = Date.now()
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, ?, '', 'owner', '{}', ?, ?)`,
  ).run(id, username, username, username, now, now)
}

async function insertSession(token: string, userId: string): Promise<void> {
  const now = Date.now()
  sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(await hashToken(token), userId, now + 3_600_000, now)
}

interface CallOptions {
  session?: string | null
  body?: unknown
  targetEnv?: Env
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const token = options.session === undefined ? OWNER_TOKEN : options.session
  const headers: Record<string, string> = {}
  if (token) headers.Cookie = `inkstone_session=${token}`
  if (method !== 'GET') headers['X-Inkstone-Client'] = '1'
  let body: string | undefined
  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), options.targetEnv ?? env, ctx)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function createCredential(label = 'root password', password = 'correct-horse'): Promise<WebsshCredential> {
  const response = await call('POST', '/api/webssh/credentials', { body: { label, password } })
  expect(response.status, await response.clone().text()).toBe(201)
  return (await json<{ credential: WebsshCredential }>(response)).credential
}

async function createHost(overrides: Record<string, unknown> = {}): Promise<WebsshHost> {
  const credential = await createCredential()
  const body = {
    name: 'web-01',
    host: 'ssh.example.com',
    port: 22,
    username: 'deploy',
    groupId: '',
    authMethod: 'password',
    credentialId: credential.id,
    encoding: 'utf-8',
    termType: 'xterm-256color',
    initialCommand: '',
    color: '',
    tags: ['prod', 'web'],
    notes: 'primary web host',
    favorite: false,
    ...overrides,
  }
  const response = await call('POST', '/api/webssh/hosts', { body })
  if (response.status !== 201) throw new Error(`createHost failed: ${response.status} ${await response.text()}`)
  return (await json<{ host: WebsshHost }>(response)).host
}

async function importKey(fixture: string, passphrase?: string, label = 'deploy key'): Promise<{ key: WebsshKey; encrypted: boolean }> {
  const privateKey = readFileSync(`${FIXTURES}${fixture}`, 'utf8')
  const response = await call('POST', '/api/webssh/keys', {
    body: { label, privateKey, ...(passphrase ? { passphrase } : {}) },
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return await json<{ key: WebsshKey; encrypted: boolean }>(response)
}

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  const vault = testDurableObjectNamespace((request) => new CredentialVault(vaultState()).fetch(request))
  env = testBindings(makeD1(sqlite), { CREDENTIAL_VAULT: vault })
  await call('GET', '/api/health')
})

beforeEach(async () => {
  vaultStorage.clear()
  for (const table of [
    'webssh_host_keys', 'webssh_hosts', 'webssh_host_groups', 'webssh_credentials', 'webssh_keys',
    'webssh_sessions', 'webssh_session_tickets', 'webssh_recordings', 'webssh_shares',
    'webssh_snippets', 'webssh_audit_events', 'webssh_settings',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`)
  }
  sqlite.exec('DELETE FROM sessions')
  sqlite.exec('DELETE FROM users')
  insertUser(OWNER_ID, 'owner')
  insertUser(OTHER_ID, 'other')
  await insertSession(OWNER_TOKEN, OWNER_ID)
  await insertSession(OTHER_TOKEN, OTHER_ID)
  pending.length = 0
})

describe('webssh authorization', () => {
  it('refuses every host and key endpoint without a session', async () => {
    const id = 'a'.repeat(26)
    const paths: Array<[string, string]> = [
      ['GET', '/api/webssh/groups'],
      ['POST', '/api/webssh/groups'],
      ['GET', '/api/webssh/hosts'],
      ['GET', '/api/webssh/hosts/overview'],
      ['GET', '/api/webssh/hosts/export'],
      ['POST', '/api/webssh/hosts/batch'],
      ['POST', '/api/webssh/hosts'],
      ['GET', `/api/webssh/hosts/${id}`],
      ['PATCH', `/api/webssh/hosts/${id}`],
      ['DELETE', `/api/webssh/hosts/${id}`],
      ['POST', `/api/webssh/hosts/${id}/preflight`],
      ['POST', `/api/webssh/hosts/${id}/duplicate`],
      ['POST', `/api/webssh/hosts/${id}/move`],
      ['GET', `/api/webssh/hosts/${id}/sessions`],
      ['GET', `/api/webssh/hosts/${id}/fingerprints`],
      ['POST', `/api/webssh/hosts/${id}/fingerprints/trust`],
      ['GET', '/api/webssh/credentials'],
      ['POST', '/api/webssh/credentials'],
      ['GET', '/api/webssh/keys'],
      ['POST', '/api/webssh/keys'],
      ['GET', `/api/webssh/keys/${id}/public`],
    ]
    for (const [method, path] of paths) {
      const response = await call(method, path, { session: null, body: {} })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })
})

describe('host groups', () => {
  it('creates, renames and refuses a duplicate name at the same level', async () => {
    const first = await json<{ group: WebsshHostGroup }>(await call('POST', '/api/webssh/groups', { body: { name: 'Prod' } }))
    expect(first.group.name).toBe('Prod')
    const duplicate = await call('POST', '/api/webssh/groups', { body: { name: 'prod' } })
    expect(duplicate.status).toBe(409)
    const renamed = await call('PATCH', `/api/webssh/groups/${first.group.id}`, { body: { name: 'Production' } })
    expect(renamed.status).toBe(200)
    expect((await json<{ group: WebsshHostGroup }>(renamed)).group.name).toBe('Production')
  })

  it('refuses to move a group under its own descendant', async () => {
    const parent = (await json<{ group: WebsshHostGroup }>(await call('POST', '/api/webssh/groups', { body: { name: 'Parent' } }))).group
    const child = (await json<{ group: WebsshHostGroup }>(await call('POST', '/api/webssh/groups', { body: { name: 'Child', parentId: parent.id } }))).group
    const response = await call('PATCH', `/api/webssh/groups/${parent.id}`, { body: { parentId: child.id } })
    expect(response.status).toBe(400)
  })

  it('keeps hosts and promotes children when a group is deleted', async () => {
    const parent = (await json<{ group: WebsshHostGroup }>(await call('POST', '/api/webssh/groups', { body: { name: 'Parent' } }))).group
    const child = (await json<{ group: WebsshHostGroup }>(await call('POST', '/api/webssh/groups', { body: { name: 'Child', parentId: parent.id } }))).group
    const host = await createHost({ groupId: parent.id })
    const removed = await call('DELETE', `/api/webssh/groups/${parent.id}`)
    expect(removed.status).toBe(200)
    const groups = await json<{ groups: WebsshHostGroup[] }>(await call('GET', '/api/webssh/groups'))
    const moved = groups.groups.find((group) => group.id === child.id)
    expect(moved?.parentId).toBe('')
    const loaded = await json<{ host: WebsshHost }>(await call('GET', `/api/webssh/hosts/${host.id}`))
    expect(loaded.host.groupId).toBe('')
  })
})

describe('host CRUD, search and pagination', () => {
  it('creates, reads, updates and soft-deletes a host', async () => {
    const host = await createHost()
    expect(host.name).toBe('web-01')
    expect(host.tags).toEqual(['prod', 'web'])
    expect(host.favorite).toBe(false)

    const renamed = await call('PATCH', `/api/webssh/hosts/${host.id}`, { body: { name: 'web-02', favorite: true } })
    expect(renamed.status).toBe(200)
    const updated = (await json<{ host: WebsshHost }>(renamed)).host
    expect(updated.name).toBe('web-02')
    expect(updated.favorite).toBe(true)
    expect(updated.groupId, 'a PATCH that omits groupId must keep the group').toBe(host.groupId)

    const removed = await call('DELETE', `/api/webssh/hosts/${host.id}`)
    expect(removed.status).toBe(200)
    expect((await call('GET', `/api/webssh/hosts/${host.id}`)).status).toBe(404)
    const listed = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts'))
    expect(listed.total).toBe(0)
    const row = sqlite.prepare('SELECT deleted_at FROM webssh_hosts WHERE user_id = ? AND id = ?').get(OWNER_ID, host.id) as { deleted_at: number | null } | undefined
    expect(row?.deleted_at).toBeTruthy()
  })

  it('rejects malformed addresses, ports and auth references', async () => {
    const credential = await createCredential()
    const invalid: Array<Record<string, unknown>> = [
      { host: 'ssh example.com' },
      { host: 'ssh://example.com' },
      { port: 0 },
      { port: 70000 },
      { username: '' },
      { authMethod: 'password', credentialId: '' },
      { authMethod: 'password', credentialId: 'a'.repeat(26) },
      { authMethod: 'publickey', keyId: '' },
    ]
    for (const overrides of invalid) {
      const response = await call('POST', '/api/webssh/hosts', {
        body: {
          name: 'bad',
          host: 'example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialId: credential.id,
          ...overrides,
        },
      })
      expect(response.status, JSON.stringify(overrides)).toBe(400)
    }
  })

  it('paginates and searches past one hundred rows without the search escaping wildcards', async () => {
    const now = Date.now()
    const insert = sqlite.prepare(
      `INSERT INTO webssh_hosts (user_id, id, name, name_folded, host, port, username, group_id, auth_method,
         credential_id, key_id, encoding, term_type, initial_command, color, tags, notes, favorite, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 22, 'root', '', 'password', 'x', '', 'utf-8', 'xterm-256color', '', '', '[]', '', 0, ?, ?, ?)`,
    )
    for (let index = 0; index < 130; index += 1) {
      const name = `node-${String(index).padStart(3, '0')}`
      insert.run(OWNER_ID, newId(), name, name, 'host.example.com', index, now, now)
    }
    const first = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?pageSize=100'))
    expect(first.total).toBe(130)
    expect(first.items).toHaveLength(100)
    expect(first.page).toBe(1)
    const second = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?pageSize=100&page=2'))
    expect(second.items).toHaveLength(30)
    const clamped = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?pageSize=500&page=99'))
    expect(clamped.pageSize).toBe(100)
    expect(clamped.page).toBe(2)
    expect(clamped.items).toHaveLength(30)
    const searched = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?q=node-01'))
    expect(searched.total).toBe(10)
    const wildcard = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?q=%25'))
    expect(wildcard.total, 'a literal percent sign must not act as a LIKE wildcard').toBe(0)
  })
})

describe('host organization and list tools', () => {
  it('counts folders and tags, filters by tag and view, and sorts by creation time', async () => {
    const group = (await json<{ group: WebsshHostGroup }>(await call('POST', '/api/webssh/groups', { body: { name: 'Prod' } }))).group
    const alpha = await createHost({ name: 'alpha', tags: ['prod', 'web'], favorite: true, groupId: group.id })
    const beta = await createHost({ name: 'beta', tags: ['prod'], groupId: group.id })
    await createHost({ name: 'gamma', tags: ['lab'] })
    sqlite.prepare('UPDATE webssh_hosts SET last_connected_at = 1000, created_at = 1000 WHERE id = ?').run(alpha.id)
    sqlite.prepare('UPDATE webssh_hosts SET created_at = 2000 WHERE id = ?').run(beta.id)
    sqlite.prepare('UPDATE webssh_hosts SET created_at = 3000 WHERE name_folded = ?').run('gamma')

    const overview = await json<WebsshHostsOverview>(await call('GET', '/api/webssh/hosts/overview'))
    expect(overview.total).toBe(3)
    expect(overview.favorites).toBe(1)
    expect(overview.connected).toBe(1)
    expect(overview.folders.find((folder) => folder.id === group.id)?.hostCount).toBe(2)
    expect(overview.folders.find((folder) => folder.id === group.id)?.name).toBe('Prod')
    expect(overview.tags).toEqual([
      { name: 'prod', count: 2 },
      { name: 'lab', count: 1 },
      { name: 'web', count: 1 },
    ])

    const tagged = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?tag=prod'))
    expect(tagged.total).toBe(2)
    expect(tagged.items.map((host) => host.name).sort()).toEqual(['alpha', 'beta'])
    const favorite = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?quick=favorites'))
    expect(favorite.total).toBe(1)
    expect(favorite.items[0]?.name).toBe('alpha')
    const recent = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?quick=recent'))
    expect(recent.total).toBe(1)
    const created = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?sort=created'))
    expect(created.items.map((host) => host.name)).toEqual(['gamma', 'beta', 'alpha'])
    const named = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts?sort=name'))
    expect(named.items.map((host) => host.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('moves, tags, stars and deletes many hosts with one call', async () => {
    const group = (await json<{ group: WebsshHostGroup }>(await call('POST', '/api/webssh/groups', { body: { name: 'Batch' } }))).group
    const first = await createHost({ name: 'batch-a' })
    const second = await createHost({ name: 'batch-b' })
    sqlite.prepare(
      `INSERT INTO webssh_host_keys (user_id, host_id, algorithm, fingerprint, first_seen_at, last_seen_at, trusted_at)
       VALUES (?, ?, 'ssh-ed25519', 'SHA256:batch', 1, 1, 1)`,
    ).run(OWNER_ID, first.id)

    const moved = await call('POST', '/api/webssh/hosts/batch', {
      body: { action: 'move', ids: [first.id, second.id], groupId: group.id },
    })
    expect(moved.status).toBe(200)
    expect(await json<{ affected: number; skipped: number }>(moved)).toEqual({ affected: 2, skipped: 0 })
    for (const id of [first.id, second.id]) {
      expect((await json<{ host: WebsshHost }>(await call('GET', `/api/webssh/hosts/${id}`))).host.groupId).toBe(group.id)
    }

    const tagged = await call('POST', '/api/webssh/hosts/batch', {
      body: { action: 'tag', ids: [first.id, second.id], tags: ['edge'] },
    })
    expect(tagged.status).toBe(200)
    const firstAfterTag = await json<{ host: WebsshHost }>(await call('GET', `/api/webssh/hosts/${first.id}`))
    expect(firstAfterTag.host.tags).toEqual(['prod', 'web', 'edge'])

    const starred = await call('POST', '/api/webssh/hosts/batch', {
      body: { action: 'favorite', ids: [first.id, second.id] },
    })
    expect(starred.status).toBe(200)
    expect((await json<{ host: WebsshHost }>(await call('GET', `/api/webssh/hosts/${second.id}`))).host.favorite).toBe(true)

    const removed = await call('POST', '/api/webssh/hosts/batch', {
      body: { action: 'delete', ids: [first.id, second.id] },
    })
    expect(removed.status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM webssh_host_keys WHERE host_id = ?').get(first.id)).toEqual({ count: 0 })
    expect((await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts'))).total).toBe(0)

    const invalidAction = await call('POST', '/api/webssh/hosts/batch', { body: { action: 'archive', ids: [first.id] } })
    expect(invalidAction.status).toBe(400)
    const empty = await call('POST', '/api/webssh/hosts/batch', { body: { action: 'delete', ids: [] } })
    expect(empty.status).toBe(400)
    const crossAccount = await call('POST', '/api/webssh/hosts/batch', {
      session: OTHER_TOKEN,
      body: { action: 'delete', ids: [first.id, second.id] },
    })
    expect(await json<{ affected: number; skipped: number }>(crossAccount)).toEqual({ affected: 0, skipped: 2 })
  })

  it('duplicates a host without carrying its star or history', async () => {
    const original = await createHost({ favorite: true })
    const first = await json<{ host: WebsshHost }>(await call('POST', `/api/webssh/hosts/${original.id}/duplicate`))
    expect(first.host.name).toBe('web-01 (copy)')
    expect(first.host.favorite).toBe(false)
    expect(first.host.tags).toEqual(['prod', 'web'])
    expect(first.host.credentialId).toBe(original.credentialId)
    const second = await json<{ host: WebsshHost }>(await call('POST', `/api/webssh/hosts/${original.id}/duplicate`))
    expect(second.host.name).toBe('web-01 (copy 2)')
  })

  it('places a dragged host just before its target row', async () => {
    const group = (await json<{ group: WebsshHostGroup }>(await call('POST', '/api/webssh/groups', { body: { name: 'Ordered' } }))).group
    const first = await createHost({ name: 'one', groupId: group.id, sortOrder: 1000 })
    const second = await createHost({ name: 'two', groupId: group.id, sortOrder: 2000 })
    const last = await createHost({ name: 'three', groupId: group.id, sortOrder: 3000 })
    const moved = await call('POST', `/api/webssh/hosts/${last.id}/move`, { body: { groupId: group.id, beforeId: first.id } })
    expect(moved.status).toBe(200)
    expect((await json<{ host: WebsshHost }>(moved)).host.sortOrder).toBeLessThan(first.sortOrder)
    const listed = await json<WebsshHostListResponse>(await call('GET', `/api/webssh/hosts?groupId=${group.id}&sort=manual`))
    expect(listed.items.map((host) => host.name)).toEqual(['three', 'one', 'two'])
    const missingTarget = await call('POST', `/api/webssh/hosts/${last.id}/move`, { body: { groupId: 'missing' } })
    expect(missingTarget.status).toBe(400)
  })

  it('exports connection facts as ssh-config and csv without any secret', async () => {
    await createHost({ name: 'Alpine Box', host: '10.0.0.5', tags: ['prod', 'ops,edge'] })
    const config = await call('GET', '/api/webssh/hosts/export')
    expect(config.headers.get('content-type')).toContain('text/plain')
    const configText = await config.text()
    expect(configText).toContain('Host Alpine-Box')
    expect(configText).toContain('HostName 10.0.0.5')
    expect(configText).toContain('User deploy')
    expect(configText).toContain('# tags: prod, ops,edge')
    expect(configText).not.toContain('correct-horse')
    const csv = await call('GET', '/api/webssh/hosts/export?format=csv')
    expect(csv.headers.get('content-type')).toContain('text/csv')
    const csvText = await csv.text()
    expect(csvText.split('\r\n')[0]).toBe('name,host,port,username,tags,provider')
    expect(csvText).toContain('"Alpine Box","10.0.0.5","22","deploy","prod,ops,edge","other"')
    expect(csvText).not.toContain('correct-horse')
  })

  it('creates a custom provider, filters by it, batches it and demotes on delete', async () => {
    const created = await json<{ provider: WebsshProvider }>(await call('POST', '/api/webssh/providers', {
      body: { label: 'Lab Cloud', color: '#123456' },
    }))
    expect(created.provider.id.startsWith('custom:')).toBe(true)
    const host = await createHost({ name: 'provider-host', provider: created.provider.id })
    expect(host.provider).toBe(created.provider.id)
    const filtered = await json<WebsshHostListResponse>(await call('GET', `/api/webssh/hosts?provider=${encodeURIComponent(created.provider.id)}`))
    expect(filtered.total).toBe(1)
    const overview = await json<WebsshHostsOverview>(await call('GET', '/api/webssh/hosts/overview'))
    expect(overview.providers.find((provider) => provider.id === created.provider.id)?.hostCount).toBe(1)
    const other = await createHost({ name: 'provider-other', provider: 'aws' })
    const batch = await call('POST', '/api/webssh/hosts/batch', {
      body: { action: 'provider', ids: [other.id], provider: created.provider.id },
    })
    expect(batch.status).toBe(200)
    expect((await json<{ host: WebsshHost }>(await call('GET', `/api/webssh/hosts/${other.id}`))).host.provider).toBe(created.provider.id)
    const removed = await call('DELETE', `/api/webssh/providers/${created.provider.id}`)
    expect(removed.status).toBe(200)
    expect((await json<{ host: WebsshHost }>(await call('GET', `/api/webssh/hosts/${host.id}`))).host.provider).toBe('other')
  })

  it('lists the recent sessions of one host', async () => {
    const host = await createHost()
    const sessionId = newId()
    sqlite.prepare(
      `INSERT INTO webssh_sessions (id, user_id, host_id, status, started_at, connected_at, ended_at, close_reason)
       VALUES (?, ?, ?, 'closed', 500, 600, 700, 'eof')`,
    ).run(sessionId, OWNER_ID, host.id)
    const history = await json<{ sessions: WebsshHostSessionSummary[] }>(await call('GET', `/api/webssh/hosts/${host.id}/sessions`))
    expect(history.sessions).toHaveLength(1)
    expect(history.sessions[0]).toMatchObject({ id: sessionId, status: 'closed', closeReason: 'eof' })
  })
})

describe('cross-account isolation', () => {
  it('answers 404 for another account host on every by-id route', async () => {
    const host = await createHost()
    const checks: Array<[string, string, unknown?]> = [
      ['GET', `/api/webssh/hosts/${host.id}`],
      ['PATCH', `/api/webssh/hosts/${host.id}`, { name: 'stolen' }],
      ['DELETE', `/api/webssh/hosts/${host.id}`],
      ['POST', `/api/webssh/hosts/${host.id}/preflight`, {}],
      ['GET', `/api/webssh/hosts/${host.id}/fingerprints`],
      ['POST', `/api/webssh/hosts/${host.id}/fingerprint/check`, { algorithm: 'ssh-ed25519', fingerprint: `SHA256:${'A'.repeat(43)}` }],
      ['POST', `/api/webssh/hosts/${host.id}/fingerprints/trust`, { algorithm: 'ssh-ed25519', fingerprint: `SHA256:${'A'.repeat(43)}` }],
      ['POST', `/api/webssh/hosts/${host.id}/fingerprints/revoke`, { fingerprint: `SHA256:${'A'.repeat(43)}` }],
      ['POST', `/api/webssh/hosts/${host.id}/duplicate`],
      ['POST', `/api/webssh/hosts/${host.id}/move`, { groupId: '' }],
      ['GET', `/api/webssh/hosts/${host.id}/sessions`],
    ]
    for (const [method, path, body] of checks) {
      const response = await call(method, path, { session: OTHER_TOKEN, body })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    const otherList = await json<WebsshHostListResponse>(await call('GET', '/api/webssh/hosts', { session: OTHER_TOKEN }))
    expect(otherList.total).toBe(0)
    const otherGroups = await json<{ groups: WebsshHostGroup[] }>(await call('GET', '/api/webssh/groups', { session: OTHER_TOKEN }))
    expect(otherGroups.groups).toHaveLength(0)
  })

  it('refuses a host that points at another account credential or key', async () => {
    const credential = await createCredential()
    const created = await importKey('throwaway-ed25519')
    for (const overrides of [
      { authMethod: 'password', credentialId: credential.id },
      { authMethod: 'publickey', keyId: created.key.id },
    ]) {
      const response = await call('POST', '/api/webssh/hosts', {
        session: OTHER_TOKEN,
        body: { name: 'leak', host: 'example.com', username: 'root', ...overrides },
      })
      expect(response.status).toBe(400)
    }
    const otherCredentials = await json<{ credentials: WebsshCredential[] }>(await call('GET', '/api/webssh/credentials', { session: OTHER_TOKEN }))
    expect(otherCredentials.credentials).toHaveLength(0)
    const otherKeys = await json<{ keys: WebsshKey[] }>(await call('GET', '/api/webssh/keys', { session: OTHER_TOKEN }))
    expect(otherKeys.keys).toHaveLength(0)
  })

  it('answers 404 when another account deletes a credential or key by id', async () => {
    const credential = await createCredential()
    const key = (await importKey('throwaway-ed25519')).key
    expect((await call('DELETE', `/api/webssh/credentials/${credential.id}`, { session: OTHER_TOKEN })).status).toBe(404)
    expect((await call('DELETE', `/api/webssh/keys/${key.id}`, { session: OTHER_TOKEN })).status).toBe(404)
    expect((await call('GET', `/api/webssh/keys/${key.id}/public`, { session: OTHER_TOKEN })).status).toBe(404)
  })
})

describe('password credentials', () => {
  it('stores ciphertext only and never returns the password', async () => {
    const credential = await createCredential('ops', 'sup3r-secret')
    const row = sqlite.prepare('SELECT password_ciphertext FROM webssh_credentials WHERE user_id = ? AND id = ?')
      .get(OWNER_ID, credential.id) as { password_ciphertext: string }
    expect(row.password_ciphertext.startsWith('v1.')).toBe(true)
    expect(row.password_ciphertext).not.toContain('sup3r-secret')
    const listed = await call('GET', '/api/webssh/credentials')
    expect(await listed.text()).not.toContain('sup3r-secret')
    expect(JSON.stringify(credential)).not.toContain('ciphertext')
  })

  it('refuses to delete a credential still used by a live host', async () => {
    const host = await createHost()
    const response = await call('DELETE', `/api/webssh/credentials/${host.credentialId}`)
    expect(response.status).toBe(409)
    const body = await json<{ error: { details: { hostCount: number } } }>(response.clone())
    expect(body.error.details.hostCount).toBe(1)
    await call('DELETE', `/api/webssh/hosts/${host.id}`)
    expect((await call('DELETE', `/api/webssh/credentials/${host.credentialId}`)).status).toBe(200)
  })

  it('reports a preflight that can open the stored password', async () => {
    const host = await createHost()
    const response = await call('POST', `/api/webssh/hosts/${host.id}/preflight`, { body: {} })
    expect(response.status).toBe(200)
    const preflight = await json<WebsshHostPreflight>(response)
    expect(preflight.ready).toBe(true)
    expect(preflight.issues).toEqual([])
    expect(preflight.credentialLabel).toBe('root password')
  })
})

describe('ssh keychain', () => {
  it('imports an unencrypted OpenSSH key and derives its public half', async () => {
    const imported = await importKey('throwaway-ed25519')
    expect(imported.encrypted).toBe(false)
    expect(imported.key.algorithm).toBe('ssh-ed25519')
    expect(imported.key.fingerprint).toBe('SHA256:oZamLz7wzZLRA1hhP0y9iQPnakRHCh6L5K5ZrU47Gu8')
    expect(imported.key.publicKey.split(' ')[0]).toBe('ssh-ed25519')
    expect(JSON.stringify(imported)).not.toContain('BEGIN OPENSSH')
  })

  it('imports an encrypted key with the right passphrase and refuses the missing or wrong one', async () => {
    const imported = await importKey('throwaway-ed25519-enc', PASSPHRASE)
    expect(imported.encrypted).toBe(true)
    expect(imported.key.fingerprint).toBe('SHA256:DKCSOm3f7YTyX2lAUeATITlkGpl6EeYQGAktWz2nNj8')

    const missing = await call('POST', '/api/webssh/keys', {
      body: { label: 'no pass', privateKey: readFileSync(`${FIXTURES}throwaway-ed25519-enc`, 'utf8') },
    })
    expect(missing.status).toBe(422)
    expect((await json<{ error: { details: { reason: string } } }>(missing)).error.details.reason).toBe('passphrase_required')

    const wrong = await call('POST', '/api/webssh/keys', {
      body: { label: 'wrong', privateKey: readFileSync(`${FIXTURES}throwaway-ed25519-enc`, 'utf8'), passphrase: 'not-the-pass' },
    })
    expect(wrong.status).toBe(422)
    expect((await json<{ error: { details: { reason: string } } }>(wrong)).error.details.reason).toBe('passphrase_invalid')
  })

  it('refuses a passphrase on an unencrypted key and a duplicate fingerprint', async () => {
    const withPassphrase = await call('POST', '/api/webssh/keys', {
      body: { label: 'odd', privateKey: readFileSync(`${FIXTURES}throwaway-ed25519`, 'utf8'), passphrase: 'nope' },
    })
    expect(withPassphrase.status).toBe(400)
    await importKey('throwaway-ed25519')
    const duplicate = await call('POST', '/api/webssh/keys', {
      body: { label: 'again', privateKey: readFileSync(`${FIXTURES}throwaway-ed25519`, 'utf8') },
    })
    expect(duplicate.status).toBe(409)
  })

  it('keeps the private key and passphrase out of D1 in plaintext', async () => {
    const imported = await importKey('throwaway-ed25519-enc', PASSPHRASE)
    const row = sqlite.prepare('SELECT private_key_ciphertext, passphrase_ciphertext FROM webssh_keys WHERE user_id = ? AND id = ?')
      .get(OWNER_ID, imported.key.id) as { private_key_ciphertext: string; passphrase_ciphertext: string }
    expect(row.private_key_ciphertext.startsWith('v1.')).toBe(true)
    expect(row.private_key_ciphertext).not.toContain('BEGIN OPENSSH')
    expect(row.passphrase_ciphertext.startsWith('v1.')).toBe(true)
    expect(row.passphrase_ciphertext).not.toContain(PASSPHRASE)
    const listed = await call('GET', '/api/webssh/keys')
    const listedText = await listed.text()
    expect(listedText).not.toContain(PASSPHRASE)
    expect(listedText).not.toContain('privateKey')
  })

  it('serves the public key as a download and refuses to delete a referenced key', async () => {
    const imported = await importKey('throwaway-ed25519')
    const download = await call('GET', `/api/webssh/keys/${imported.key.id}/public`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('text/plain')
    expect(await download.text()).toBe(`${imported.key.publicKey}\n`)

    const host = await createHost({ authMethod: 'publickey', credentialId: '', keyId: imported.key.id })
    const blocked = await call('DELETE', `/api/webssh/keys/${imported.key.id}`)
    expect(blocked.status).toBe(409)
    expect((await json<{ error: { details: { hostCount: number } } }>(blocked)).error.details.hostCount).toBe(1)
    await call('DELETE', `/api/webssh/hosts/${host.id}`)
    expect((await call('DELETE', `/api/webssh/keys/${imported.key.id}`)).status).toBe(200)
    const keys = await json<{ keys: WebsshKey[] }>(await call('GET', '/api/webssh/keys'))
    expect(keys.keys).toHaveLength(0)
  })

  it('counts key references in chunks so more than ninety-nine keys still list', async () => {
    const now = Date.now()
    const insert = sqlite.prepare(
      `INSERT INTO webssh_keys (user_id, id, label, algorithm, public_key, fingerprint, private_key_ciphertext, passphrase_ciphertext, created_at, updated_at)
       VALUES (?, ?, ?, 'ssh-ed25519', 'ssh-ed25519 AAAA', ?, 'v1.x', '', ?, ?)`,
    )
    for (let index = 0; index < 120; index += 1) {
      insert.run(OWNER_ID, newId(), `key-${index}`, `SHA256:${String(index).padStart(2, '0')}${'A'.repeat(41)}`, now, now)
    }
    const tight = testBindings(makeD1(sqlite, { maxBoundParameters: 99 }), {
      CREDENTIAL_VAULT: testDurableObjectNamespace((request) => new CredentialVault(vaultState()).fetch(request)),
    })
    const response = await call('GET', '/api/webssh/keys', { targetEnv: tight })
    expect(response.status, await response.clone().text()).toBe(200)
    const listed = await json<{ keys: WebsshKey[] }>(response)
    expect(listed.keys).toHaveLength(120)
  })
})

describe('host fingerprint trust', () => {
  const first = `SHA256:${'B'.repeat(43)}`
  const second = `SHA256:${'C'.repeat(43)}`

  it('walks first trust, a changed key, re-trust and revoke', async () => {
    const host = await createHost()

    const empty = await json<{ fingerprints: WebsshHostKey[] }>(await call('GET', `/api/webssh/hosts/${host.id}/fingerprints`))
    expect(empty.fingerprints).toHaveLength(0)

    const untrusted = await json<{ check: WebsshHostKeyCheck }>(await call('POST', `/api/webssh/hosts/${host.id}/fingerprint/check`, {
      body: { algorithm: 'ssh-ed25519', fingerprint: first },
    }))
    expect(untrusted.check.state).toBe('untrusted')

    const trusted = await json<{ check: WebsshHostKeyCheck }>(await call('POST', `/api/webssh/hosts/${host.id}/fingerprints/trust`, {
      body: { algorithm: 'ssh-ed25519', fingerprint: first },
    }))
    expect(trusted.check.state).toBe('trusted')

    const changed = await json<{ check: WebsshHostKeyCheck }>(await call('POST', `/api/webssh/hosts/${host.id}/fingerprint/check`, {
      body: { algorithm: 'ssh-ed25519', fingerprint: second },
    }))
    expect(changed.check.state).toBe('changed')
    expect(changed.check.trustedFingerprint).toBe(first)

    const preflight = await json<WebsshHostPreflight>(await call('POST', `/api/webssh/hosts/${host.id}/preflight`, {
      body: { algorithm: 'ssh-ed25519', fingerprint: second },
    }))
    expect(preflight.hostKey?.state).toBe('changed')

    const retrusted = await json<{ check: WebsshHostKeyCheck }>(await call('POST', `/api/webssh/hosts/${host.id}/fingerprints/trust`, {
      body: { algorithm: 'ssh-ed25519', fingerprint: second },
    }))
    expect(retrusted.check.state).toBe('trusted')
    const listed = await json<{ fingerprints: WebsshHostKey[] }>(await call('GET', `/api/webssh/hosts/${host.id}/fingerprints`))
    expect(listed.fingerprints).toHaveLength(2)
    expect(listed.fingerprints.find((entry) => entry.fingerprint === first)?.revokedAt).toBeTruthy()

    const revoked = await json<{ check: WebsshHostKeyCheck }>(await call('POST', `/api/webssh/hosts/${host.id}/fingerprints/revoke`, {
      body: { fingerprint: second },
    }))
    expect(revoked.check.state).toBe('revoked')
  })

  it('clears host trust rows when the host is deleted', async () => {
    const host = await createHost()
    await call('POST', `/api/webssh/hosts/${host.id}/fingerprints/trust`, {
      body: { algorithm: 'ssh-ed25519', fingerprint: first },
    })
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM webssh_host_keys WHERE user_id = ? AND host_id = ?').get(OWNER_ID, host.id) as { n: number }).n).toBe(1)
    await call('DELETE', `/api/webssh/hosts/${host.id}`)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM webssh_host_keys WHERE user_id = ? AND host_id = ?').get(OWNER_ID, host.id) as { n: number }).n).toBe(0)
    const credentials = await json<{ credentials: WebsshCredential[] }>(await call('GET', '/api/webssh/credentials'))
    expect(credentials.credentials).toHaveLength(1)
  })

  it('rejects a malformed fingerprint before it reaches D1', async () => {
    const host = await createHost()
    for (const fingerprint of ['', 'SHA256:short', 'MD5:aa:bb']) {
      const response = await call('POST', `/api/webssh/hosts/${host.id}/fingerprint/check`, {
        body: { algorithm: 'ssh-ed25519', fingerprint },
      })
      expect(response.status).toBe(400)
    }
  })
})

describe('preflight readiness', () => {
  it('reports a missing credential that was removed underneath the host', async () => {
    const host = await createHost()
    sqlite.prepare('DELETE FROM webssh_credentials WHERE user_id = ? AND id = ?').run(OWNER_ID, host.credentialId)
    const preflight = await json<WebsshHostPreflight>(await call('POST', `/api/webssh/hosts/${host.id}/preflight`, { body: {} }))
    expect(preflight.ready).toBe(false)
    expect(preflight.issues).toContain('credential_missing')
    expect(preflight.credentialLabel).toBeNull()
  })
})
