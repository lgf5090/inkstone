// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardBundle } from '../src/shared/project/model'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

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
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
       VALUES (?, ?, 'hash', ?, ?, 'member', ?, ?)`,
    ).run(account, account, account, account, now, now)
    tokens.set(account, await createSession(env.DB, account))
  }
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards;
    DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_views;
    DELETE FROM project_card_contents; DELETE FROM project_comments`)
})

const pid = (n: number) => `p${String(n).padStart(26, '0')}`

async function req(account: Account | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {}
  if (account) headers.Cookie = `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}`
  if (method !== 'GET') headers[CLIENT_HEADER] = '1'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(
    new Request(`http://localhost/api/project${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}

async function reqRaw(account: Account, path: string, bytes: Uint8Array): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/api/project${path}`, {
      method: 'POST',
      headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get(account)}`, [CLIENT_HEADER]: '1', 'Content-Type': 'application/zip' },
      body: bytes as BodyInit,
    }),
    env,
  )
}

async function createBoard(account: Account, body: Record<string, unknown> = {}): Promise<ProjectBoard> {
  const response = await req(account, 'POST', '/boards', body)
  expect(response.status, await response.clone().text()).toBe(201)
  return ((await response.json()) as { board: ProjectBoard }).board
}

async function bundle(account: Account, boardId: string): Promise<ProjectBoardBundle> {
  const response = await req(account, 'GET', `/boards/${boardId}/bundle`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as ProjectBoardBundle
}

async function richBoard(): Promise<ProjectBoard> {
  const board = await createBoard('alice', {
    title: 'Roadmap', description: 'Desc', icon: '🗺️', showDescription: true,
    cardProperties: [
      { id: pid(1), name: 'Status', type: 'select', options: [{ id: pid(11), value: 'Open', color: 'propColorRed' }] },
      { id: pid(2), name: 'Tags', type: 'multiSelect', options: [] },
    ],
  })
  const cardResponse = await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Card', icon: '📌', values: { [pid(1)]: pid(11), [pid(2)]: '["a","b"]' } })
  const card = ((await cardResponse.json()) as { card: { id: string } }).card
  await req('alice', 'POST', `/boards/${board.id}/views`, { title: 'Table', viewType: 'table', fields: { cardOrder: [card.id] } })
  await req('alice', 'POST', `/cards/${card.id}/contents`, { type: 'checkbox', title: 'Step', fields: { checked: true } })
  await req('alice', 'POST', `/cards/${card.id}/comments`, { body: 'Nice' })
  return board
}

describe('archive export and import', () => {
  it('exports a v2 ZIP and imports it field for field under a new owner', async () => {
    const board = await richBoard()
    const original = await bundle('alice', board.id)
    const exportResponse = await req('alice', 'GET', `/boards/${board.id}/archive`)
    expect(exportResponse.status).toBe(200)
    expect(exportResponse.headers.get('Content-Type')).toBe('application/zip')
    const bytes = new Uint8Array(await exportResponse.arrayBuffer())
    const entries = unzipSync(bytes)
    expect(Object.keys(entries)).toContain('version.json')
    expect(Object.keys(entries)).toContain(`${board.id}/board.jsonl`)

    // Import into a fresh instance: the archive's ids are preserved, so the source board must be gone.
    sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards;
      DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_views;
      DELETE FROM project_card_contents; DELETE FROM project_comments`)
    const importResponse = await reqRaw('bob', '/boards/import', bytes)
    expect(importResponse.status, await importResponse.clone().text()).toBe(201)
    const result = (await importResponse.json()) as { board: ProjectBoard }
    expect(result.board.id).toBe(board.id)
    expect(result.board.ownerId).toBe('bob')

    const restored = await bundle('bob', board.id)
    expect(restored.properties).toEqual(original.properties)
    expect(restored.cards).toEqual(original.cards)
    expect(restored.views).toEqual(original.views)
    expect(restored.contents).toEqual(original.contents)
    expect(restored.comments).toEqual(original.comments)
    expect(restored.board).toMatchObject({ title: 'Roadmap', description: 'Desc', icon: '🗺️', showDescription: true })
    expect(restored.board.ownerId).toBe('bob')
    expect(restored.members.map((m) => m.userId)).toEqual(['bob'])
  })

  it('refuses to import over an existing board id', async () => {
    const board = await richBoard()
    const bytes = new Uint8Array(await (await req('alice', 'GET', `/boards/${board.id}/archive`)).arrayBuffer())
    const response = await reqRaw('alice', '/boards/import', bytes)
    expect(response.status).toBe(409)
  })

  it('imports a v1 JSON archive with the board carried as a block', async () => {
    const v1 = {
      version: 1,
      date: 1,
      blocks: [
        { id: 'b-v1', type: 'board', parentId: '', boardId: '', title: 'Legacy', fields: { cardProperties: [{ id: pid(1), name: 'Status', type: 'select', options: [] }] }, createAt: 1, updateAt: 1 },
        { id: 'c-v1', type: 'card', parentId: 'b-v1', boardId: 'b-v1', title: 'Old card', fields: { properties: { [pid(1)]: 'x' } }, createAt: 1, updateAt: 1 },
      ],
    }
    const response = await reqRaw('carol', '/boards/import', strToU8(JSON.stringify(v1)))
    expect(response.status, await response.clone().text()).toBe(201)
    const result = (await response.json()) as { board: ProjectBoard }
    expect(result.board).toMatchObject({ id: 'b-v1', title: 'Legacy', ownerId: 'carol' })
    const restored = await bundle('carol', 'b-v1')
    expect(restored.cards[0]).toMatchObject({ id: 'c-v1', title: 'Old card', values: { [pid(1)]: 'x' } })
    expect(restored.properties.map((p) => p.id)).toEqual([pid(1)])
  })

  it('rejects bytes that are neither a ZIP nor a v1 JSON', async () => {
    expect((await reqRaw('alice', '/boards/import', strToU8('not an archive'))).status).toBe(400)
  })

  it('lets a viewer export but hides the archive from a stranger', async () => {
    const board = await richBoard()
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(board.id, 'bob', 'viewer')
    expect((await req('bob', 'GET', `/boards/${board.id}/archive`)).status).toBe(200)
    expect((await req('carol', 'GET', `/boards/${board.id}/archive`)).status).toBe(404)
  })
})

function archiveWithLines(boardId: string, lines: unknown[]): Uint8Array {
  return zipSync({
    'version.json': strToU8(JSON.stringify({ version: 2, date: 1 })),
    [`${boardId}/board.jsonl`]: strToU8(lines.map((line) => JSON.stringify(line)).join('\n') + '\n'),
  })
}

const boardLine = (id: string): unknown => ({ type: 'board', data: { id, title: 'Imported', cardProperties: [] } })
const cardBlock = (id: string, boardId: string): unknown => ({
  type: 'block',
  data: { id, type: 'card', parentId: boardId, boardId, title: 'Card', fields: {}, createAt: 1, updateAt: 1 },
})

describe('archive import trust boundary', () => {
  it('never restores member rows from an uploaded archive', async () => {
    const bytes = archiveWithLines('b-attack1', [
      boardLine('b-attack1'),
      cardBlock('c-attack1', 'b-attack1'),
      { type: 'boardMember', data: { boardId: 'b-attack1', userId: 'alice', role: 'admin' } },
      { type: 'boardMember', data: { boardId: 'b-attack1', userId: 'bob', role: 'viewer' } },
    ])
    const response = await reqRaw('carol', '/boards/import', bytes)
    expect(response.status, await response.clone().text()).toBe(201)
    const members = (await (await req('carol', 'GET', '/boards/b-attack1/members')).json()) as { members: { userId: string }[] }
    expect(members.members.map((entry) => entry.userId)).toEqual(['carol'])
  })

  it('rejects content and comments that point at a card outside the archive', async () => {
    const foreign = {
      type: 'block',
      data: { id: 'a-foreign', type: 'text', parentId: 'c-elsewhere', boardId: 'b-attack2', title: 'Injected', fields: {}, createAt: 1, updateAt: 1 },
    }
    const bytes = archiveWithLines('b-attack2', [boardLine('b-attack2'), cardBlock('c-attack2', 'b-attack2'), foreign])
    const response = await reqRaw('alice', '/boards/import', bytes)
    expect(response.status).toBe(400)
    expect(sqlite.prepare('SELECT count(*) AS n FROM project_board_members WHERE board_id = ?').get('b-attack2')).toMatchObject({ n: 0 })
  })

  it('rejects ids that could escape into a header or an iCalendar field', async () => {
    const bytes = archiveWithLines('b-attack3', [
      { type: 'board', data: { id: 'b-attack3"\r\nX-Injected: 1', title: 'Bad', cardProperties: [] } },
    ])
    expect((await reqRaw('alice', '/boards/import', bytes)).status).toBe(400)
  })

  it('sanitizes export filenames for boards carrying legacy ids', async () => {
    const id = 'b-legacy"\r\nX-Injected: 1'
    sqlite.prepare(
      `INSERT INTO project_boards (id, owner_id, type, minimum_role, title, description, icon,
        show_description, is_template, template_version, created_by, modified_by, create_at, update_at, delete_at, archived)
       VALUES (?, 'alice', 'P', '', 'Legacy', '', '', 0, 0, 0, 'alice', 'alice', 1, 1, 0, 0)`,
    ).run(id)
    sqlite.prepare('INSERT INTO project_board_members (board_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
      .run(id, 'alice', 'admin')
    const response = await req('alice', 'GET', `/boards/${encodeURIComponent(id)}/csv`)
    expect(response.status, await response.clone().text()).toBe(200)
    const disposition = response.headers.get('Content-Disposition') ?? ''
    expect(disposition).toBe('attachment; filename="b-legacy___X-Injected__1.csv"')
  })

  it('rejects a ZIP with too many members before decompressing it', async () => {
    const files: Record<string, Uint8Array> = {
      'version.json': strToU8(JSON.stringify({ version: 2, date: 1 })),
      'b-many/board.jsonl': strToU8(`${JSON.stringify(boardLine('b-many'))}\n`),
    }
    for (let index = 0; index < 101; index += 1) files[`extra/${index}.txt`] = strToU8('x')
    expect((await reqRaw('alice', '/boards/import', zipSync(files))).status).toBe(413)
  })
})