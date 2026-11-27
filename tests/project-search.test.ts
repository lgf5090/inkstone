// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard } from '../src/shared/project/model'
import type { ProjectSearchResult } from '../src/worker/project/search'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'
import { SCHEMA_MIGRATIONS } from '../src/worker/db/schema'
import { PROJECT_CONTENT_SCHEMA_STATEMENTS, PROJECT_CORE_SCHEMA_STATEMENTS } from '../src/worker/project/schema'

const ACCOUNTS = ['alice', 'bob', 'carol'] as const
type Account = (typeof ACCOUNTS)[number]
const app = createApp()
const tokens = new Map<Account, string>()
let sqlite: DatabaseSync
let env: Env

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  for (const account of ACCOUNTS) {
    sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at) VALUES (?,?, 'hash', ?, ?, 'member', ?, ?)`).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_board_members; DELETE FROM project_boards; DELETE FROM project_cards`)
})

async function req(account: Account, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}` }
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

async function search(account: Account, q: string): Promise<ProjectSearchResult> {
  const response = await req(account, 'GET', `/search?q=${encodeURIComponent(q)}`)
  expect(response.status).toBe(200)
  return (await response.json()) as ProjectSearchResult
}

describe('cross-board search respects visibility', () => {
  it('backfills existing project text when migration 448 installs FTS', () => {
    const legacy = new DatabaseSync(':memory:')
    legacy.exec([...PROJECT_CORE_SCHEMA_STATEMENTS, ...PROJECT_CONTENT_SCHEMA_STATEMENTS].join(';'))
    legacy.prepare(`INSERT INTO project_boards (id, owner_id, title, created_by, modified_by, create_at, update_at)
      VALUES ('b1', 'alice', 'Board', 'alice', 'alice', 1, 1)`).run()
    legacy.prepare(`INSERT INTO project_cards (id, board_id, title, created_by, modified_by, create_at, update_at)
      VALUES ('c1', 'b1', 'Legacy title', 'alice', 'alice', 1, 1)`).run()
    legacy.prepare(`INSERT INTO project_card_contents (id, card_id, board_id, type, title, created_by, modified_by, create_at, update_at)
      VALUES ('x1', 'c1', 'b1', 'text', 'Legacy body', 'alice', 'alice', 1, 1)`).run()
    legacy.prepare(`INSERT INTO project_comments (id, card_id, board_id, author_id, body, create_at, update_at)
      VALUES ('m1', 'c1', 'b1', 'alice', 'Legacy comment', 1, 1)`).run()
    legacy.prepare(`INSERT INTO project_card_values (card_id, property_id, value, updated_at)
      VALUES ('c1', 'p1', 'Legacy value', 1)`).run()
    const migration = SCHEMA_MIGRATIONS.find((entry) => entry.version === 448)
    expect(migration).toBeDefined()
    for (const statement of migration!.statements) legacy.exec(statement)
    expect(legacy.prepare("SELECT COUNT(*) AS count FROM project_search_docs").get()).toMatchObject({ count: 4 })
    expect(legacy.prepare("SELECT COUNT(*) AS count FROM project_search_fts WHERE project_search_fts MATCH 'legacy'").get()).toMatchObject({ count: 4 })
    legacy.close()
  })

  it('hides a private board and its cards from a stranger, then reveals them once shared', async () => {
    const created = await req('alice', 'POST', '/boards', { title: 'Secret roadmap' })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Launch plan' })
    expect((await search('bob', 'Launch')).cards).toEqual([])
    expect((await search('bob', 'Secret')).boards).toEqual([])
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?,?,?,1,1)').run(board.id, 'bob', 'viewer')
    expect((await search('bob', 'Launch')).cards.map((c) => c.title)).toEqual(['Launch plan'])
    expect((await search('bob', 'Secret')).boards.map((b) => b.id)).toEqual([board.id])
    expect((await search('carol', 'Launch')).cards).toEqual([])
  })

  it('finds a card by a body block or a comment, not only its title', async () => {
    const created = await req('alice', 'POST', '/boards', { title: 'Search body' })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    const cardRes = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Unrelated title' })
    const card = ((await cardRes.json()) as { card: { id: string } }).card
    await req('alice', 'POST', `/cards/${card.id}/contents`, { type: 'text', title: 'ship the exporter' })
    await req('alice', 'POST', `/cards/${card.id}/comments`, { body: 'internal discussion' })
    expect((await search('alice', 'exporter')).cards.map((entry) => entry.id)).toEqual([card.id])
    expect((await search('alice', 'internal discussion')).cards.map((entry) => entry.id)).toEqual([card.id])
  })

  it('returns empty for a blank query and escapes LIKE wildcards', async () => {
    const created = await req('alice', 'POST', '/boards', { title: '100% done' })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    await req('alice', 'POST', `/boards/${board.id}/cards`, { title: '50% off' })
    expect((await search('alice', '')).cards).toEqual([])
    expect((await search('alice', '50%')).cards.map((c) => c.title)).toEqual(['50% off'])
    expect((await search('alice', '50_')).cards).toEqual([])
  })

  it('rejects patterns beyond the production 50-byte LIKE ceiling', async () => {
    const tooLong = await req('alice', 'GET', `/search?q=${'a'.repeat(49)}`)
    expect(tooLong.status).toBe(400)
    expect(((await tooLong.json()) as { error: { message: string } }).error.message).toBe('search query is too long')
    const escaped = await req('alice', 'GET', `/search?q=${'%25'.repeat(49)}`)
    expect(escaped.status).toBe(400)
    const boundary = await req('alice', 'GET', `/search?q=${encodeURIComponent('中'.repeat(16))}`)
    expect(boundary.status).toBe(200)
    const beyond = await req('alice', 'GET', `/search?q=${encodeURIComponent('中'.repeat(17))}`)
    expect(beyond.status).toBe(400)
  })

  it('finds a card by a property value and still escapes LIKE wildcards there', async () => {
    const propertyId = 'p'.repeat(27)
    const created = await req('alice', 'POST', '/boards', {
      title: 'Values',
      cardProperties: [{ id: propertyId, name: 'Notes', type: 'text', options: [] }],
    })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    const cardRes = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Plain title', values: { [propertyId]: 'invoice-42' } })
    const card = ((await cardRes.json()) as { card: { id: string } }).card
    expect((await search('alice', 'invoice-42')).cards.map((entry) => entry.id)).toEqual([card.id])
    expect((await search('alice', 'invoice_42')).cards).toEqual([])
  })

  it('updates and removes FTS documents as cards, contents, comments and values change', async () => {
    const propertyId = 'p'.repeat(27)
    const created = await req('alice', 'POST', '/boards', {
      title: 'Incremental', cardProperties: [{ id: propertyId, name: 'Notes', type: 'text', options: [] }],
    })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    const cardRes = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Old title', values: { [propertyId]: 'oldvalue' } })
    const card = ((await cardRes.json()) as { card: { id: string } }).card
    const content = ((await (await req('alice', 'POST', `/cards/${card.id}/contents`, { type: 'text', title: 'oldcontent' })).json()) as { content: { id: string } }).content
    const comment = ((await (await req('alice', 'POST', `/cards/${card.id}/comments`, { body: 'oldcomment' })).json()) as { comment: { id: string } }).comment
    expect((await search('alice', 'oldcontent')).cards.map((entry) => entry.id)).toEqual([card.id])
    expect((await search('alice', 'expor')).cards).toEqual([])
    await req('alice', 'PATCH', `/cards/${card.id}`, { title: 'New title', values: { [propertyId]: 'newvalue' } })
    await req('alice', 'PATCH', `/contents/${content.id}`, { title: 'exporter' })
    await req('alice', 'PATCH', `/comments/${comment.id}`, { body: 'newcomment' })
    expect((await search('alice', 'oldcontent')).cards).toEqual([])
    expect((await search('alice', 'oldcomment')).cards).toEqual([])
    expect((await search('alice', 'oldvalue')).cards).toEqual([])
    expect((await search('alice', 'expor')).cards.map((entry) => entry.id)).toEqual([card.id])
    expect((await search('alice', 'newcomment')).cards.map((entry) => entry.id)).toEqual([card.id])
    await req('alice', 'DELETE', `/contents/${content.id}`)
    await req('alice', 'DELETE', `/comments/${comment.id}`)
    await req('alice', 'DELETE', `/cards/${card.id}`)
    expect((await search('alice', 'exporter')).cards).toEqual([])
    expect((await search('alice', 'newcomment')).cards).toEqual([])
    expect((await search('alice', 'newvalue')).cards).toEqual([])
  })

  it('does not return property hits hidden from the viewer', async () => {
    const propertyId = 'p'.repeat(27)
    const created = await req('alice', 'POST', '/boards', {
      title: 'Restricted values', cardProperties: [{ id: propertyId, name: 'Secret notes', type: 'text', options: [] }],
    })
    const board = ((await created.json()) as { board: ProjectBoard }).board
    await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Plain', values: { [propertyId]: 'needle-secret' } })
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?,?,?,1,1)').run(board.id, 'bob', 'viewer')
    sqlite.prepare(
      `INSERT INTO project_property_configs (board_id, property_id, config, updated_at) VALUES (?, ?, ?, 1)
       ON CONFLICT(board_id, property_id) DO UPDATE SET config = excluded.config`,
    ).run(board.id, propertyId, JSON.stringify({ viewRoles: ['admin'] }))
    expect((await search('alice', 'needle-secret')).cards).toHaveLength(1)
    expect((await search('bob', 'needle-secret')).cards).toEqual([])
  })
})