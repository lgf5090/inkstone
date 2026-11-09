// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectAttachment, ProjectBoard } from '../src/shared/project/model'
import { sweepProjectReminders } from '../src/worker/project/scheduler'
import { attachmentCategory } from '../src/worker/project/files'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
let sqlite: DatabaseSync
let env: Env
let token: string

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES ('alice','alice','hash','alice','alice','member',?,?)`).run(now, now)
  token = await createSession(env.DB, 'alice')
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_attachments; DELETE FROM project_subscriptions; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_properties`)
})

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${token}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function makeBoard(): Promise<ProjectBoard> {
  return ((await (await req('POST', '/boards', { title: 'Files' })).json()) as { board: ProjectBoard }).board
}

describe('project attachments', () => {
  it('uploads to a categorized R2 key, lists, serves and deletes', async () => {
    const board = await makeBoard()
    const form = new FormData()
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' }))
    const upload = await app.fetch(new Request(`http://localhost/api/project/boards/${board.id}/files`, {
      method: 'POST', headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${token}`, [CLIENT_HEADER]: '1' }, body: form,
    }), env)
    expect(upload.status, await upload.clone().text()).toBe(201)
    const file = ((await upload.json()) as { file: ProjectAttachment }).file
    expect(file.objectKey.startsWith('project/images/alice/')).toBe(true)
    const list = ((await (await req('GET', `/boards/${board.id}/files`)).json()) as { files: ProjectAttachment[] }).files
    expect(list.map((f) => f.id)).toEqual([file.id])
    const served = await req('GET', `/files/${file.id}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('Content-Type')).toBe('image/png')
    expect((await req('DELETE', `/files/${file.id}`)).status).toBe(200)
    expect(((await (await req('GET', `/boards/${board.id}/files`)).json()) as { files: unknown[] }).files).toEqual([])
  })

  it('serves unsafe mime as an opaque download, never inline in this origin (R2-3)', async () => {
    const board = await makeBoard()
    const form = new FormData()
    form.append('file', new File(['<script>alert(1)</script>'], 'evil.html', { type: 'text/html' }))
    const upload = await app.fetch(new Request(`http://localhost/api/project/boards/${board.id}/files`, {
      method: 'POST', headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${token}`, [CLIENT_HEADER]: '1' }, body: form,
    }), env)
    expect(upload.status, await upload.clone().text()).toBe(201)
    const file = ((await upload.json()) as { file: ProjectAttachment }).file
    const served = await req('GET', `/files/${file.id}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(served.headers.get('Content-Disposition')).toMatch(/^attachment;/)
    expect(served.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
  it('maps mime to category', () => {
    expect(attachmentCategory('image/png')).toBe('images')
    expect(attachmentCategory('application/pdf')).toBe('pdf')
    expect(attachmentCategory('text/plain')).toBe('txt')
    expect(attachmentCategory('application/zip')).toBe('archives')
  })
})

describe('project due reminders (F-10)', () => {
  it('reminds subscribers once for a card due within a day', async () => {
    const board = await makeBoard()
    const due = Date.now() + 60 * 60 * 1000
    const pid = 'd'.repeat(27)
    sqlite.prepare(`INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at) VALUES (?, ?, 'Due', 'date', '[]', 0, 1, 1)`).run(board.id, pid)
    const card = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Due card', values: { [pid]: JSON.stringify({ from: due }) } })).json()) as { card: { id: string } }).card
    sqlite.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at) VALUES ('card', ?, 'alice', 0, 1, 0)`).run(card.id)
    const first = await sweepProjectReminders(env, Date.now())
    expect(first).toBe(1)
    const second = await sweepProjectReminders(env, Date.now())
    expect(second).toBe(0)
  })
})