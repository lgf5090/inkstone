// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { hashOpaqueToken } from '../src/worker/memos/tokens'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = '01m5ghxyg0e8whsnzne3qsppb1'
const MEMO = '01m5ghxykgpg6peq014434xhqb'
const ATTACHMENT = '01m5ghxyq1y8qkxhggffy2arnm'
const SHARE_TOKEN = 'a'.repeat(43)
const SHARE_ID = '01m5ghxyzzzzzzzzzzzzzzzzzz'

let env: Env
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  const sqlite = new DatabaseSync(':memory:')
  env = {
    DB: makeD1(sqlite),
    ASSETS: { fetch: async () => new Response('ok') },
  } as unknown as Env
  app = createApp()
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Math.floor(Date.now() / 1000)
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, 'owner', 'hash', 'owner', 'Owner', '', 'owner', '{}', ?, ?)`,
  ).run(USER, now, now)
  sqlite.prepare(
    `INSERT INTO memos_items (
       id, user_id, space_id, parent_id, content, content_search, title, snippet, visibility,
       state, pinned, has_link, has_code, has_task_list, has_incomplete_tasks, has_location,
       location_placeholder, latitude, longitude, rev, created_at, updated_at
     ) VALUES (?, ?, NULL, NULL, 'Shared body', 'shared body', 'Shared body', '', 'public',
       'normal', 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, 1, ?, ?)`,
  ).run(MEMO, USER, now, now)
  sqlite.prepare(
    `INSERT INTO memos_attachments (
       id, user_id, memo_id, filename, mime, size, storage, storage_key, width, height,
       thumbnail_key, media_metadata, motion_group_id, motion_role, created_at, updated_at
     ) VALUES (?, ?, ?, 'photo.png', 'image/png', 4, 'r2', 'memos/photo', 1, 1,
       NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(ATTACHMENT, USER, MEMO, now, now)
  sqlite.prepare(
    `INSERT INTO memos_shares (id, user_id, memo_id, token_hash, expires_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
  ).run(SHARE_ID, USER, MEMO, await hashOpaqueToken(SHARE_TOKEN), now)
})

async function request(path: string): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    headers: { 'X-Inkstone-Client': '1' },
  }), env)
}

it('lets an anonymous reader load the explore feed and a share', async () => {
  const explore = await request('/api/memos/public/explore')
  expect(explore.status).toBe(200)
  expect((await explore.json() as { items: Array<{ id: string }> }).items.map((item) => item.id))
    .toContain(MEMO)

  const share = await request(`/api/memos/public/shares/${SHARE_TOKEN}`)
  expect(share.status).toBe(200)
  expect((await share.json() as { id: string }).id).toBe(MEMO)
})

it('reaches the file route before any authenticated memo mount', async () => {
  const shared = await request(`/api/memos/files/${ATTACHMENT}?share=${SHARE_TOKEN}`)
  expect(shared.status).not.toBe(401)
  const publicFile = await request(`/api/memos/files/${ATTACHMENT}`)
  expect(publicFile.status).not.toBe(401)
  const privateBody = await request('/api/memos')
  expect(privateBody.status).toBe(401)
})
