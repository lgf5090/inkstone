// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '@shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard, ProjectCardNoteLink, ProjectNoteCardLink } from '@shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
const tokens = new Map<string, string>()
let sqlite: DatabaseSync
let env: Env
const aliceNote = 'n'.repeat(26)
const bobNote = 'm'.repeat(26)
const lockedNote = 'l'.repeat(26)

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const account of ['alice', 'bob']) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, 'member', ?, ?)`,
    ).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_card_notes; DELETE FROM project_cards; DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM notes`)
})

async function req(account: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

function note(id: string, userId: string, title: string, encrypted = false): void {
  sqlite.prepare(`INSERT INTO notes (id, user_id, title, title_key, content, rev, is_encrypted, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', 1, ?, 1, 2)`).run(id, userId, title, title.toLowerCase(), encrypted ? 1 : 0)
}

async function boardWithCard(): Promise<{ board: ProjectBoard, card: ProjectCard }> {
  const board = ((await (await req('alice', 'POST', '/boards', { title: 'Notes' })).json()) as { board: ProjectBoard }).board
  const card = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Card' })).json()) as { card: ProjectCard }).card
  return { board, card }
}

describe('note and card links', () => {
  it('links, lists and unlinks a note in both directions', async () => {
    note(aliceNote, 'alice', 'Meeting notes')
    const { card } = await boardWithCard()
    const linked = await req('alice', 'POST', `/cards/${card.id}/notes`, { noteId: aliceNote })
    expect(linked.status, await linked.clone().text()).toBe(201)
    expect(((await linked.json()) as { note: ProjectCardNoteLink }).note).toMatchObject({ cardId: card.id, noteId: aliceNote, title: 'Meeting notes' })
    expect((await req('alice', 'POST', `/cards/${card.id}/notes`, { noteId: aliceNote })).status).toBe(201)
    const notes = ((await (await req('alice', 'GET', `/cards/${card.id}/notes`)).json()) as { notes: ProjectCardNoteLink[] }).notes
    expect(notes).toHaveLength(1)
    const cards = ((await (await req('alice', 'GET', `/notes/${aliceNote}/cards`)).json()) as { cards: ProjectNoteCardLink[] }).cards
    expect(cards).toEqual([expect.objectContaining({ cardId: card.id, boardTitle: 'Notes', title: 'Card' })])
    expect((await req('alice', 'DELETE', `/cards/${card.id}/notes/${aliceNote}`)).status).toBe(200)
    expect(((await (await req('alice', 'GET', `/notes/${aliceNote}/cards`)).json()) as { cards: ProjectNoteCardLink[] }).cards).toEqual([])
  })

  it('rejects foreign, locked and viewer-linked notes', async () => {
    note(aliceNote, 'alice', 'Mine')
    note(bobNote, 'bob', 'Theirs')
    note(lockedNote, 'alice', 'Locked', true)
    const { board, card } = await boardWithCard()
    expect((await req('alice', 'POST', `/cards/${card.id}/notes`, { noteId: bobNote })).status).toBe(404)
    expect((await req('alice', 'POST', `/cards/${card.id}/notes`, { noteId: lockedNote })).status).toBe(409)
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(board.id, 'bob', 'viewer')
    expect((await req('bob', 'POST', `/cards/${card.id}/notes`, { noteId: aliceNote })).status).toBe(403)
    expect(((await (await req('bob', 'GET', `/notes/${aliceNote}/cards`)).json()) as { cards: ProjectNoteCardLink[] }).cards).toEqual([])
  })
})
