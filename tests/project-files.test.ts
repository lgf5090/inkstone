// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectAttachment, ProjectBoard } from '../src/shared/project/model'
import { sweepProjectReminders } from '../src/worker/project/scheduler'
import { attachmentCategory } from '../src/worker/project/files'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'
import { PROJECT_AUX_SCHEMA_STATEMENTS, PROJECT_CORE_SCHEMA_STATEMENTS } from '../src/worker/project/schema'

const app = createApp()
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  0, 0, 0, 1, 0, 0, 0, 1,
])
let sqlite: DatabaseSync
let env: Env
let token: string
let bobToken: string

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES ('alice','alice','hash','alice','alice','member',?,?)`).run(now, now)
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES ('bob','bob','hash','bob','bob','member',?,?)`).run(now, now)
  token = await createSession(env.DB, 'alice')
  bobToken = await createSession(env.DB, 'bob')
})

beforeEach(() => {
  sqlite.prepare('UPDATE users SET settings = ?').run(JSON.stringify({ appearance: { language: 'en-US' } }))
  sqlite.exec(`DELETE FROM attachment_cleanup; DELETE FROM project_attachments; DELETE FROM project_subscriptions; DELETE FROM project_reminders; DELETE FROM chat_notifications; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_properties`)
})

afterEach(() => { vi.restoreAllMocks() })

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${token}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function reqAs(who: string, method: string, path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost/api/project${path}`, {
    method,
    headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${who}`, [CLIENT_HEADER]: '1' },
  }), env)
}

async function makeBoard(): Promise<ProjectBoard> {
  return ((await (await req('POST', '/boards', { title: 'Files' })).json()) as { board: ProjectBoard }).board
}

describe('project attachments', () => {
  it('uploads to a categorized R2 key, lists, serves and deletes', async () => {
    const board = await makeBoard()
    const form = new FormData()
    form.append('file', new File([PNG], 'pic.png', { type: 'image/png' }))
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

  it('hides trashed card attachments from ordinary viewers', async () => {
    const board = await makeBoard()
    const card = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Trashed' })).json()) as { card: { id: string } }).card
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(board.id, 'bob', 'viewer')
    const form = new FormData()
    form.append('file', new File([PNG], 'pic.png', { type: 'image/png' }))
    form.append('cardId', card.id)
    const upload = await app.fetch(new Request(`http://localhost/api/project/boards/${board.id}/files`, {
      method: 'POST', headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${token}`, [CLIENT_HEADER]: '1' }, body: form,
    }), env)
    expect(upload.status).toBe(201)
    const file = ((await upload.json()) as { file: ProjectAttachment }).file
    expect((await req('DELETE', `/cards/${card.id}`)).status).toBe(200)
    const list = await reqAs(bobToken, 'GET', `/boards/${board.id}/files`)
    expect(((await list.json()) as { files: unknown[] }).files).toEqual([])
    expect((await reqAs(bobToken, 'GET', `/files/${file.id}`)).status).toBe(404)
  })

  it('keeps a cleanup row when R2 deletion fails after the database row is gone', async () => {
    const board = await makeBoard()
    const form = new FormData()
    form.append('file', new File([PNG], 'pic.png', { type: 'image/png' }))
    const upload = await app.fetch(new Request(`http://localhost/api/project/boards/${board.id}/files`, {
      method: 'POST', headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${token}`, [CLIENT_HEADER]: '1' }, body: form,
    }), env)
    expect(upload.status).toBe(201)
    const file = ((await upload.json()) as { file: ProjectAttachment }).file
    vi.spyOn(env.FILES!, 'delete').mockRejectedValueOnce(new Error('R2 unavailable'))
    expect((await req('DELETE', `/files/${file.id}`)).status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM project_attachments WHERE id = ?').get(file.id)).toMatchObject({ count: 0 })
    expect(sqlite.prepare('SELECT object_key FROM attachment_cleanup WHERE object_key = ?').get(`r2:${file.objectKey}`)).toMatchObject({ object_key: `r2:${file.objectKey}` })
  })

  it('downgrades a declared image whose bytes do not match its signature', async () => {
    const board = await makeBoard()
    const form = new FormData()
    form.append('file', new File(['<script>alert(1)</script>'], 'fake.png', { type: 'image/png' }))
    const upload = await app.fetch(new Request(`http://localhost/api/project/boards/${board.id}/files`, {
      method: 'POST', headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${token}`, [CLIENT_HEADER]: '1' }, body: form,
    }), env)
    expect(upload.status, await upload.clone().text()).toBe(201)
    const file = ((await upload.json()) as { file: ProjectAttachment }).file
    expect(file.mime).toBe('application/octet-stream')
    const served = await req('GET', `/files/${file.id}`)
    expect(served.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(served.headers.get('Content-Disposition')).toMatch(/^attachment;/)
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

async function createDueCard(board: ProjectBoard, title: string, due: number): Promise<{ id: string }> {
  const pid = 'd'.repeat(27)
  sqlite.prepare(`INSERT OR IGNORE INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at) VALUES (?, ?, 'Due', 'date', '[]', 0, 1, 1)`).run(board.id, pid)
  return ((await (await req('POST', `/boards/${board.id}/cards`, { title, values: { [pid]: JSON.stringify({ from: due }) } })).json()) as { card: { id: string } }).card
}

describe('project due reminders (F-10)', () => {
  it('backfills existing subscribed dates when migration 440 installs the queue', () => {
    const legacy = new DatabaseSync(':memory:')
    for (const statement of [...PROJECT_CORE_SCHEMA_STATEMENTS, ...PROJECT_AUX_SCHEMA_STATEMENTS]) legacy.exec(statement)
    const due = Date.now() + 60 * 60 * 1000
    legacy.prepare(`INSERT INTO project_boards (id, owner_id, title, created_by, modified_by, create_at, update_at)
      VALUES ('b-legacy-reminder', 'alice', 'Legacy', 'alice', 'alice', 1, 1)`).run()
    legacy.prepare(`INSERT INTO project_cards (id, board_id, title, created_by, modified_by, create_at, update_at)
      VALUES ('c-legacy-reminder', 'b-legacy-reminder', 'Due', 'alice', 'alice', 1, 1)`).run()
    legacy.prepare(`INSERT INTO project_properties (board_id, id, name, type, created_at, updated_at)
      VALUES ('b-legacy-reminder', 'p-legacy-reminder', 'Due', 'date', 1, 1)`).run()
    legacy.prepare(`INSERT INTO project_card_values (card_id, property_id, value, updated_at)
      VALUES ('c-legacy-reminder', 'p-legacy-reminder', ?, 1)`).run(JSON.stringify({ from: due }))
    legacy.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at)
      VALUES ('card', 'c-legacy-reminder', 'alice', ?, 1)`).run(due)
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 440)
    expect(migration).toBeDefined()
    for (const statement of migration!.statements) legacy.exec(statement)
    expect(legacy.prepare('SELECT card_id, property_id, due_at, board_id, notified_at FROM project_reminders').all())
      .toEqual([{ card_id: 'c-legacy-reminder', property_id: 'p-legacy-reminder', due_at: due, board_id: 'b-legacy-reminder', notified_at: due }])
    legacy.close()
  })

  it('reminds subscribers once for a card due within a day', async () => {
    const board = await makeBoard()
    const due = Date.now() + 60 * 60 * 1000
    const pid = 'd'.repeat(27)
    sqlite.prepare(`INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at) VALUES (?, ?, 'Due', 'date', '[]', 0, 1, 1)`).run(board.id, pid)
    const card = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Due card', values: { [pid]: JSON.stringify({ from: due }) } })).json()) as { card: { id: string } }).card
    sqlite.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at) VALUES ('card', ?, 'alice', 0, 1, 0)`).run(card.id)
    const first = await sweepProjectReminders(env, Date.now())
    expect(first).toBe(1)
    const notices = sqlite.prepare('SELECT title, body, link FROM chat_notifications WHERE user_id = ?').all('alice') as { title: string, body: string, link: string }[]
    expect(notices).toEqual([{ title: 'Due: Due card', body: 'Due card', link: `project:${board.id}:${card.id}` }])
    sqlite.prepare('UPDATE project_cards SET delete_at = delete_at WHERE id = ?').run(card.id)
    sqlite.prepare('UPDATE project_boards SET archived = archived WHERE id = ?').run(board.id)
    sqlite.prepare("UPDATE project_subscriptions SET delete_at = delete_at WHERE block_id = ? AND subscriber_id = 'alice'").run(card.id)
    const second = await sweepProjectReminders(env, Date.now())
    expect(second).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications WHERE user_id = ?').get('alice')).toMatchObject({ count: 1 })
  })

  it('does not let hundreds of unsubscribed due cards starve a later subscriber', async () => {
    const board = await makeBoard()
    const pid = 'd'.repeat(27)
    sqlite.prepare(`INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at) VALUES (?, ?, 'Due', 'date', '[]', 0, 1, 1)`).run(board.id, pid)
    const due = Date.now() + 60 * 60 * 1000
    const insertCard = sqlite.prepare(`INSERT INTO project_cards (id, board_id, parent_id, title, icon, is_template, content_order, created_by, modified_by, create_at, update_at, delete_at) VALUES (?, ?, '', 'Filler', '', 0, '[]', 'alice', 'alice', 1, 1, 0)`)
    const insertValue = sqlite.prepare(`INSERT INTO project_card_values (card_id, property_id, value, updated_at) VALUES (?, ?, ?, 1)`)
    for (let index = 0; index < 600; index += 1) {
      const id = `f${String(index).padStart(26, '0')}`
      insertCard.run(id, board.id)
      insertValue.run(id, pid, JSON.stringify({ from: due }))
    }
    const card = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Due soon', values: { [pid]: JSON.stringify({ from: due }) } })).json()) as { card: { id: string } }).card
    sqlite.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at) VALUES ('card', ?, 'alice', 0, 1, 0)`).run(card.id)
    expect(await sweepProjectReminders(env, Date.now())).toBe(1)
  })

  it('bounds subscriber work per sweep without starving the next card', async () => {
    const board = await makeBoard()
    const due = Date.now() + 60 * 60 * 1000
    const first = await createDueCard(board, 'First', due)
    const second = await createDueCard(board, 'Second', due)
    const subscribe = sqlite.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at)
      VALUES ('card', ?, ?, 0, 1, 0)`)
    for (const card of [first, second]) {
      for (let index = 0; index < 51; index += 1) subscribe.run(card.id, index === 0 ? 'alice' : `outsider-${index}`)
    }
    expect(await sweepProjectReminders(env, Date.now())).toBe(1)
    expect(await sweepProjectReminders(env, Date.now())).toBe(1)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications WHERE user_id = ?').get('alice')).toMatchObject({ count: 2 })
  })

  it('skips an oversized subscriber group and reminds a later card in the same sweep', async () => {
    const board = await makeBoard()
    const now = Date.now()
    const oversized = await createDueCard(board, 'Oversized', now + 60 * 60 * 1000)
    const later = await createDueCard(board, 'Later', now + 2 * 60 * 60 * 1000)
    const subscribe = sqlite.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at)
      VALUES ('card', ?, ?, 0, 1, 0)`)
    for (let index = 0; index < 101; index += 1) subscribe.run(oversized.id, index === 0 ? 'alice' : `outsider-${index}`)
    subscribe.run(later.id, 'alice')
    expect(await sweepProjectReminders(env, now)).toBe(1)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications WHERE user_id = ?').get('alice')).toMatchObject({ count: 1 })
    expect(sqlite.prepare('SELECT notified_at FROM project_reminders WHERE card_id = ?').get(oversized.id)).toMatchObject({ notified_at: 0 })
  })

  it('removes materialized reminders when their card is deleted or their board is archived', async () => {
    const due = Date.now() + 60 * 60 * 1000
    const deletedBoard = await makeBoard()
    const deletedCard = await createDueCard(deletedBoard, 'Deleted', due)
    sqlite.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at) VALUES ('card', ?, 'alice', 0, 1, 0)`).run(deletedCard.id)
    expect(await sweepProjectReminders(env, Date.now())).toBe(1)
    expect((await req('DELETE', `/cards/${deletedCard.id}`)).status).toBe(200)

    const archivedBoard = await makeBoard()
    const archivedCard = await createDueCard(archivedBoard, 'Archived', due)
    sqlite.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at) VALUES ('card', ?, 'alice', 0, 1, 0)`).run(archivedCard.id)
    expect(await sweepProjectReminders(env, Date.now())).toBe(1)
    expect((await req('PATCH', `/boards/${archivedBoard.id}`, { archived: true })).status).toBe(200)

    expect(await sweepProjectReminders(env, Date.now())).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM project_reminders').get()).toMatchObject({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications WHERE user_id = ?').get('alice')).toMatchObject({ count: 2 })
  })

  it('keeps the queue synchronized when a date changes or the last subscriber leaves', async () => {
    const board = await makeBoard()
    const due = Date.now() + 60 * 60 * 1000
    const card = await createDueCard(board, 'Rescheduled', due)
    const pid = 'd'.repeat(27)
    sqlite.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at) VALUES ('card', ?, 'alice', 0, 1, 0)`).run(card.id)
    expect(sqlite.prepare('SELECT due_at FROM project_reminders').all()).toEqual([{ due_at: due }])

    expect((await req('PATCH', `/cards/${card.id}`, { values: { [pid]: JSON.stringify({ from: due }) } })).status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM project_reminders').get()).toMatchObject({ count: 1 })
    expect(await sweepProjectReminders(env, Date.now())).toBe(1)

    const nextDue = due + 2 * 60 * 60 * 1000
    expect((await req('PATCH', `/cards/${card.id}`, { values: { [pid]: JSON.stringify({ from: nextDue }) } })).status).toBe(200)
    expect(sqlite.prepare('SELECT due_at, notified_at FROM project_reminders').all()).toEqual([{ due_at: nextDue, notified_at: 0 }])
    expect((await req('DELETE', `/subscriptions/${card.id}`)).status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM project_reminders').get()).toMatchObject({ count: 0 })
  })

  it('ignores malformed date values without blocking a valid reminder', async () => {
    const board = await makeBoard()
    const pid = 'd'.repeat(27)
    sqlite.prepare(`INSERT INTO project_properties (board_id, id, name, type, options, position, created_at, updated_at) VALUES (?, ?, 'Due', 'date', '[]', 0, 1, 1)`).run(board.id, pid)
    const malformed = ((await (await req('POST', `/boards/${board.id}/cards`, { title: 'Malformed', values: { [pid]: 'not-json' } })).json()) as { card: { id: string } }).card
    const valid = await createDueCard(board, 'Valid', Date.now() + 60 * 60 * 1000)
    const subscribe = sqlite.prepare(`INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at) VALUES ('card', ?, 'alice', 0, 1, 0)`)
    subscribe.run(malformed.id)
    subscribe.run(valid.id)
    expect(await sweepProjectReminders(env, Date.now())).toBe(1)
    expect(sqlite.prepare('SELECT card_id FROM project_reminders').all()).toEqual([{ card_id: valid.id }])
    expect(sqlite.prepare('SELECT body FROM chat_notifications WHERE user_id = ?').all('alice')).toEqual([{ body: 'Valid' }])
  })
})

describe('the board cursor (R3-15)', () => {
  it('answers the bundle cursor without the bundle and moves when a card changes', async () => {
    const board = await makeBoard()
    const before = ((await (await req('GET', `/boards/${board.id}/cursor`)).json()) as { cursor: number }).cursor
    const bundle = await (await req('GET', `/boards/${board.id}/bundle`)).json() as { cursor: number }
    expect(before).toBe(bundle.cursor)
    await req('POST', `/boards/${board.id}/cards`, { title: 'Moves the cursor' })
    const after = ((await (await req('GET', `/boards/${board.id}/cursor`)).json()) as { cursor: number }).cursor
    expect(after).toBeGreaterThanOrEqual(before)
    const fresh = await (await req('GET', `/boards/${board.id}/bundle`)).json() as { cursor: number }
    expect(after).toBe(fresh.cursor)
  })
})