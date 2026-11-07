// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  WebsshHost,
  WebsshImportCommitResult,
  WebsshImportPreview,
  WebsshSnippet,
  WebsshSnippetListResponse,
} from '../src/shared/webssh/types'
import { createApp } from '../src/worker/app'
import type { Env } from '../src/worker/env'
import { hashToken } from '../src/worker/lib/session-store'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const OWNER_ID = 'user-owner'
const OTHER_ID = 'user-other'
const OWNER_TOKEN = 'a'.repeat(64)
const OTHER_TOKEN = 'b'.repeat(64)

const app = createApp()
const ctx = {
  waitUntil(promise: Promise<unknown>) {
    void promise
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext

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

async function call(method: string, path: string, options: { session?: string | null; body?: unknown } = {}): Promise<Response> {
  const token = options.session === undefined ? OWNER_TOKEN : options.session
  const headers: Record<string, string> = {}
  if (token) headers.Cookie = `inkstone_session=${token}`
  if (method !== 'GET') headers['X-Inkstone-Client'] = '1'
  let body: string | undefined
  if (options.body !== undefined && method !== 'GET') {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), env, ctx)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await call('GET', '/api/health')
})

beforeEach(async () => {
  for (const table of [
    'webssh_snippets', 'webssh_hosts', 'webssh_host_groups', 'webssh_credentials', 'webssh_keys',
    'webssh_host_keys', 'webssh_sessions', 'webssh_session_tickets', 'webssh_recordings',
    'webssh_shares', 'webssh_audit_events', 'webssh_settings',
  ]) {
    sqlite.exec(`DELETE FROM ${table}`)
  }
  sqlite.exec('DELETE FROM sessions')
  sqlite.exec('DELETE FROM users')
  insertUser(OWNER_ID, 'owner')
  insertUser(OTHER_ID, 'other')
  await insertSession(OWNER_TOKEN, OWNER_ID)
  await insertSession(OTHER_TOKEN, OTHER_ID)
})

async function createSnippet(body: Record<string, unknown> = {}): Promise<WebsshSnippet> {
  const response = await call('POST', '/api/webssh/snippets', {
    body: { title: 'list containers', command: 'docker ps -a', ...body },
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return (await json<{ snippet: WebsshSnippet }>(response)).snippet
}

describe('snippet authorization', () => {
  it('requires a session for every snippet and import route', async () => {
    const id = 'a'.repeat(26)
    const paths: Array<[string, string]> = [
      ['GET', '/api/webssh/snippets'],
      ['POST', '/api/webssh/snippets'],
      ['PATCH', `/api/webssh/snippets/${id}`],
      ['DELETE', `/api/webssh/snippets/${id}`],
      ['POST', `/api/webssh/snippets/${id}/touch`],
      ['POST', '/api/webssh/imports/preview'],
      ['POST', '/api/webssh/imports'],
    ]
    for (const [method, path] of paths) {
      const response = await call(method, path, { session: null, body: {} })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })
})

describe('snippet CRUD', () => {
  it('creates, searches, favorites and deletes a snippet within the account', async () => {
    const snippet = await createSnippet({ tags: ['ops', 'docker'], shell: 'bash', description: 'all containers' })
    expect(snippet.title).toBe('list containers')
    expect(snippet.command).toBe('docker ps -a')
    expect(snippet.tags).toEqual(['ops', 'docker'])
    expect(snippet.favorite).toBe(false)
    expect(snippet.lastUsedAt).toBeNull()

    const search = await json<WebsshSnippetListResponse>(await call('GET', '/api/webssh/snippets?q=docker'))
    expect(search.total).toBe(1)
    expect(search.items[0]?.id).toBe(snippet.id)

    const favorite = await json<{ snippet: WebsshSnippet }>(await call('PATCH', `/api/webssh/snippets/${snippet.id}`, {
      body: { favorite: true, title: 'containers' },
    }))
    expect(favorite.snippet.favorite).toBe(true)
    expect(favorite.snippet.title).toBe('containers')

    const favorites = await json<WebsshSnippetListResponse>(await call('GET', '/api/webssh/snippets?favorite=1'))
    expect(favorites.total).toBe(1)

    const touched = await json<{ snippet: WebsshSnippet }>(await call('POST', `/api/webssh/snippets/${snippet.id}/touch`))
    expect(touched.snippet.lastUsedAt).toBeTypeOf('number')

    const removed = await call('DELETE', `/api/webssh/snippets/${snippet.id}`)
    expect(removed.status).toBe(200)
    expect((await json<WebsshSnippetListResponse>(await call('GET', '/api/webssh/snippets'))).total).toBe(0)
  })

  it('never returns or mutates another account\'s snippet', async () => {
    const snippet = await createSnippet()
    for (const [method, path, body] of [
      ['PATCH', `/api/webssh/snippets/${snippet.id}`, { title: 'stolen' }],
      ['DELETE', `/api/webssh/snippets/${snippet.id}`, undefined],
      ['POST', `/api/webssh/snippets/${snippet.id}/touch`, undefined],
    ] as Array<[string, string, unknown]>) {
      const response = await call(method, path, { session: OTHER_TOKEN, body })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    const list = await json<WebsshSnippetListResponse>(await call('GET', '/api/webssh/snippets', { session: OTHER_TOKEN }))
    expect(list.total).toBe(0)
    // The owner still holds the row unchanged.
    const owner = await json<WebsshSnippetListResponse>(await call('GET', '/api/webssh/snippets'))
    expect(owner.items[0]?.title).toBe('list containers')
  })

  it('pages results and rejects an over-long command', async () => {
    for (let index = 0; index < 25; index += 1) await createSnippet({ title: `snippet-${index}` })
    const first = await json<WebsshSnippetListResponse>(await call('GET', '/api/webssh/snippets?pageSize=10&page=1'))
    expect(first.total).toBe(25)
    expect(first.items).toHaveLength(10)
    expect(first.page).toBe(1)
    const third = await json<WebsshSnippetListResponse>(await call('GET', '/api/webssh/snippets?pageSize=10&page=3'))
    expect(third.items).toHaveLength(5)

    const tooLong = await call('POST', '/api/webssh/snippets', { body: { title: 'x', command: 'a'.repeat(4097) } })
    expect(tooLong.status).toBe(400)
  })
})

describe('host import', () => {
  it('previews an ssh config, skips wildcard blocks, and commits hosts without secrets', async () => {
    const content = [
      'Host web-01',
      '  HostName 192.0.2.10',
      '  User deploy',
      '  Port 2222',
      '',
      'Host *.internal',
      '  User root',
      '',
      'Host db-01',
      '  HostName db.example.com',
      '  User postgres',
    ].join('\n')
    const preview = await json<WebsshImportPreview>(await call('POST', '/api/webssh/imports/preview', {
      body: { format: 'auto', content },
    }))
    expect(preview.format).toBe('ssh-config')
    expect(preview.rejected).toBe(1)
    expect(preview.candidates).toHaveLength(2)
    expect(preview.candidates[0]).toMatchObject({ name: 'web-01', host: '192.0.2.10', port: 2222, username: 'deploy', issues: [] })
    expect(preview.candidates[1]).toMatchObject({ name: 'db-01', host: 'db.example.com', username: 'postgres' })

    const commit = await json<WebsshImportCommitResult>(await call('POST', '/api/webssh/imports', {
      body: { hosts: preview.candidates },
    }))
    expect(commit.created).toHaveLength(2)
    expect(commit.skipped).toHaveLength(0)
    for (const host of commit.created) {
      expect(host.credentialId).toBe('')
      expect(host.keyId).toBe('')
      expect(host.authMethod).toBe('password')
    }

    const again = await json<WebsshImportCommitResult>(await call('POST', '/api/webssh/imports', {
      body: { hosts: preview.candidates },
    }))
    expect(again.created).toHaveLength(0)
    expect(again.skipped).toHaveLength(2)
    expect(again.skipped[0]?.reason).toBe('duplicate')

    const hosts = await json<{ items: WebsshHost[] }>(await call('GET', '/api/webssh/hosts'))
    expect(hosts.items).toHaveLength(2)
  })

  it('previews CSV with a header, quoted fields and tags', async () => {
    const content = [
      'name,host,port,username,tags',
      'prod-web,web.example.com,22,deploy,prod|web',
      '"quoted name",10.0.0.2,2222,root,"staging;db"',
    ].join('\n')
    const preview = await json<WebsshImportPreview>(await call('POST', '/api/webssh/imports/preview', {
      body: { format: 'csv', content },
    }))
    expect(preview.format).toBe('csv')
    expect(preview.candidates).toHaveLength(2)
    expect(preview.candidates[1]).toMatchObject({ name: 'quoted name', host: '10.0.0.2', port: 2222, username: 'root' })
    expect(preview.candidates[0]?.tags).toEqual(['prod', 'web'])
    expect(preview.candidates[1]?.tags).toEqual(['staging', 'db'])
  })
})
