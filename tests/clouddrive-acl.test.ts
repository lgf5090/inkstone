import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { hashToken } from '../src/worker/lib/session-store'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket } from './doubles/bindings'
import type { Env } from '../src/worker/env'

const OWNER = '0123456789abcdefghjkmnpqrs'
const MEMBER = '0123456789abcdefghjkmnpqrt'
const OWNER_TOKEN = 'a'.repeat(64)
const MEMBER_TOKEN = 'b'.repeat(64)

interface Harness {
  sqlite: DatabaseSync
  env: Env
  app: ReturnType<typeof createApp>
}

async function harness(): Promise<Harness> {
  const sqlite = new DatabaseSync(':memory:')
  const env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
  const app = createApp()
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const user of [
    { id: OWNER, username: 'owner', role: 'owner', token: OWNER_TOKEN },
    { id: MEMBER, username: 'member', role: 'member', token: MEMBER_TOKEN },
  ]) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, '', ?, '{}', ?, ?)`,
    ).run(user.id, user.username, user.username, user.username, user.role, now, now)
    sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(await hashToken(user.token), user.id, now + 600_000, now)
  }
  return { sqlite, env, app }
}

async function request(
  h: Harness,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const token = userId === OWNER ? OWNER_TOKEN : MEMBER_TOKEN
  return await h.app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      Cookie: `inkstone_session=${token}`,
      'X-Inkstone-Client': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), h.env)
}

async function upload(h: Harness, parentPath: string, name: string, content: string): Promise<{ id: string; path: string }> {
  const init = await request(h, OWNER, 'POST', '/api/clouddrive/uploads', {
    parentPath, name, size: content.length, mime: 'text/plain',
  })
  expect(init.status).toBe(200)
  const session = await init.json() as { session: { id: string } }
  const put = await h.app.fetch(new Request(`http://localhost/api/clouddrive/uploads/${session.session.id}/content`, {
    method: 'PUT',
    headers: { Cookie: `inkstone_session=${OWNER_TOKEN}`, 'X-Inkstone-Client': '1' },
    body: content,
  }), h.env)
  expect(put.status).toBe(200)
  const complete = await request(h, OWNER, 'POST', `/api/clouddrive/uploads/${session.session.id}/complete`, {})
  expect(complete.status).toBe(200)
  return (await complete.json() as { entry: { id: string; path: string } }).entry
}

let h: Harness

beforeEach(async () => {
  h = await harness()
})

afterEach(() => {
  h.sqlite.close()
})

describe('CloudDrive account ACL', () => {
  it('grants a file to another account for read-only access and revokes it', async () => {
    const file = await upload(h, '/', 'note.txt', 'hello from owner')
    const grant = await request(h, OWNER, 'POST', '/api/clouddrive/acl/grants', {
      fileId: file.id, username: 'member',
    })
    expect(grant.status).toBe(200)
    expect((await request(h, OWNER, 'GET', `/api/clouddrive/acl/grants?fileId=${file.id}`)).status).toBe(200)

    const shared = await request(h, MEMBER, 'GET', '/api/clouddrive/acl/shared')
    const list = await shared.json() as { shared: { fileId: string; ownerUsername: string }[] }
    expect(list.shared).toMatchObject([{ fileId: file.id, ownerUsername: 'owner' }])

    const content = await h.app.fetch(new Request(
      `http://localhost/api/clouddrive/acl/shared/${OWNER}/${file.id}/content`,
      { headers: { Cookie: `inkstone_session=${MEMBER_TOKEN}` } },
    ), h.env)
    expect(content.status).toBe(200)
    expect(await content.text()).toBe('hello from owner')

    const other = await upload(h, '/', 'private.txt', 'nope')
    const denied = await h.app.fetch(new Request(
      `http://localhost/api/clouddrive/acl/shared/${OWNER}/${other.id}/content`,
      { headers: { Cookie: `inkstone_session=${MEMBER_TOKEN}` } },
    ), h.env)
    expect(denied.status).toBe(404)

    expect((await request(h, OWNER, 'DELETE', '/api/clouddrive/acl/grants', {
      fileId: file.id, granteeId: MEMBER,
    })).status).toBe(200)
    expect((await request(h, MEMBER, 'GET', '/api/clouddrive/acl/shared')).status).toBe(200)
    expect(((await (await request(h, MEMBER, 'GET', '/api/clouddrive/acl/shared')).json()) as { shared: unknown[] }).shared).toHaveLength(0)
  })

  it('grants a folder and lists descendants without escaping it', async () => {
    const folder = await request(h, OWNER, 'POST', '/api/clouddrive/folders', { parentPath: '/', name: 'shared' })
    expect(folder.status).toBe(201)
    const folderId = (await folder.json() as { entry: { id: string } }).entry.id
    const child = await upload(h, '/shared', 'child.txt', 'inside')
    await upload(h, '/', 'outside.txt', 'outside')

    await request(h, OWNER, 'POST', '/api/clouddrive/acl/grants', { fileId: folderId, username: 'member' })
    const listing = await request(h, MEMBER, 'GET', `/api/clouddrive/acl/shared/${OWNER}/${folderId}/list`)
    expect(listing.status).toBe(200)
    expect(((await listing.json()) as { entries: { fileId: string }[] }).entries.map((entry) => entry.fileId)).toEqual([child.id])

    const content = await h.app.fetch(new Request(
      `http://localhost/api/clouddrive/acl/shared/${OWNER}/${child.id}/content`,
      { headers: { Cookie: `inkstone_session=${MEMBER_TOKEN}` } },
    ), h.env)
    expect(await content.text()).toBe('inside')

    const escape = await request(h, MEMBER, 'GET', `/api/clouddrive/acl/shared/${OWNER}/${folderId}/list?path=%2F`)
    expect(escape.status).toBe(403)
  })

  it('rejects self-grants and unknown usernames', async () => {
    const file = await upload(h, '/', 'self.txt', 'x')
    expect((await request(h, OWNER, 'POST', '/api/clouddrive/acl/grants', { fileId: file.id, username: 'owner' })).status).toBe(400)
    expect((await request(h, OWNER, 'POST', '/api/clouddrive/acl/grants', { fileId: file.id, username: 'ghost' })).status).toBe(404)
  })
})
