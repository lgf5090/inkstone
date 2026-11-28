// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '../src/shared/constants'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectBoardBundle } from '../src/shared/project/model'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'
import { listBoardAttachments } from '../src/worker/project/files'

const ACCOUNTS = ['alice', 'bob', 'carol'] as const
type Account = (typeof ACCOUNTS)[number]

const app = createApp()
const tokens = new Map<Account, string>()
let sqlite: DatabaseSync
let env: Env
let files: TestR2Bucket

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  files = testR2Bucket()
  env = testBindings(makeD1(sqlite, { maxBatchStatements: 1000 }), { FILES: files })
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

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.restoreAllMocks()
  files.objects.clear()
  files.types.clear()
  sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards;
    DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_views;
    DELETE FROM project_card_contents; DELETE FROM project_comments; DELETE FROM project_card_links; DELETE FROM project_attachments`)
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

function withoutAuthors<T extends object>(entity: T): Partial<T> {
  const copy = { ...entity } as Record<string, unknown>
  delete copy.createdBy
  delete copy.modifiedBy
  delete copy.authorId
  return copy as Partial<T>
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

async function seedAttachment(boardId: string, index: number, withBytes: boolean): Promise<string> {
  const attachmentId = `i${String(index).padStart(26, '0')}`
  const objectKey = `project/other/alice/${attachmentId}.txt`
  sqlite.prepare(`INSERT INTO project_attachments
    (id, user_id, board_id, card_id, filename, mime, size, storage, object_key, created_at, updated_at)
    VALUES (?, 'alice', ?, NULL, ?, 'text/plain', 1, 'r2', ?, ?, ?)`)
    .run(attachmentId, boardId, `${index}.txt`, objectKey, index, index)
  if (withBytes) await files.put(objectKey, new Uint8Array([1]))
  return attachmentId
}

describe('archive export and import', () => {
  it('exports a v2 ZIP and imports it field for field under a new owner', async () => {
    const board = await richBoard()
    const original = await bundle('alice', board.id)
    const multipart = vi.spyOn(files, 'createMultipartUpload')
    const exportResponse = await req('alice', 'GET', `/boards/${board.id}/archive`)
    expect(exportResponse.status).toBe(200)
    expect(exportResponse.headers.get('Content-Type')).toBe('application/zip')
    expect(multipart).toHaveBeenCalledOnce()
    const bytes = new Uint8Array(await exportResponse.arrayBuffer())
    expect(exportResponse.headers.get('Content-Length')).toBe(String(bytes.byteLength))
    expect([...files.objects.keys()].some((key) => key.startsWith('project/exports/'))).toBe(false)
    const entries = unzipSync(bytes)
    expect(Object.keys(entries)).toContain('version.json')
    expect(Object.keys(entries)).toContain(`${board.id}/board.jsonl`)

    // Import into a fresh instance: the archive's ids are preserved, so the source board must be gone.
    sqlite.exec(`DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards;
      DELETE FROM project_cards; DELETE FROM project_card_values; DELETE FROM project_views;
      DELETE FROM project_card_contents; DELETE FROM project_comments; DELETE FROM project_card_links; DELETE FROM project_attachments`)
    const importResponse = await reqRaw('bob', '/boards/import', bytes)
    expect(importResponse.status, await importResponse.clone().text()).toBe(201)
    const result = (await importResponse.json()) as { board: ProjectBoard }
    expect(result.board.id).toBe(board.id)
    expect(result.board.ownerId).toBe('bob')

    const restored = await bundle('bob', board.id)
    expect(restored.properties).toEqual(original.properties)
    expect(restored.cards.map(withoutAuthors)).toEqual(original.cards.map(withoutAuthors))
    expect(restored.views.map(withoutAuthors)).toEqual(original.views.map(withoutAuthors))
    expect(restored.contents.map(withoutAuthors)).toEqual(original.contents.map(withoutAuthors))
    expect(restored.comments.map(withoutAuthors)).toEqual(original.comments.map(withoutAuthors))
    expect(restored.board).toMatchObject({ title: 'Roadmap', description: 'Desc', icon: '🗺️', showDescription: true })
    expect(restored.board.ownerId).toBe('bob')
    expect(restored.members.map((m) => m.userId)).toEqual(['bob'])
  })

  it('streams a whole-account export containing only readable boards and cleans up its temporary object', async () => {
    const first = await createBoard('alice', { title: 'First' })
    const second = await createBoard('alice', { title: 'Second' })
    const foreign = await createBoard('bob', { title: 'Foreign' })
    const multipart = vi.spyOn(files, 'createMultipartUpload')
    const response = await req('alice', 'GET', '/export')
    expect(response.status).toBe(200)
    expect(multipart).toHaveBeenCalledOnce()
    const bytes = new Uint8Array(await response.arrayBuffer())
    const entries = unzipSync(bytes)
    expect(Object.keys(entries)).toContain('version.json')
    expect(Object.keys(entries)).toContain(`${first.id}/board.jsonl`)
    expect(Object.keys(entries)).toContain(`${second.id}/board.jsonl`)
    expect(Object.keys(entries).some((name) => name.startsWith(foreign.id))).toBe(false)
    expect([...files.objects.keys()].some((key) => key.startsWith('project/exports/'))).toBe(false)
  })

  it('carries card hierarchy, recurrence and dependency edges through a round trip', async () => {
    const board = await createBoard('alice', { title: 'Tree' })
    const parent = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Parent' })).json()) as { card: { id: string } }).card
    const child = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, {
      title: 'Child', parentId: parent.id, recurrence: { freq: 'monthly', interval: 2 },
    })).json()) as { card: { id: string } }).card
    expect((await req('alice', 'POST', `/cards/${child.id}/links`, { toCardId: parent.id, kind: 'blocks' })).status).toBe(201)
    const bytes = new Uint8Array(await (await req('alice', 'GET', `/boards/${board.id}/archive`)).arrayBuffer())
    sqlite.exec(`DELETE FROM project_attachments; DELETE FROM project_card_links; DELETE FROM project_card_values;
      DELETE FROM project_cards; DELETE FROM project_card_contents; DELETE FROM project_comments; DELETE FROM project_views;
      DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards`)
    expect((await reqRaw('bob', '/boards/import', bytes)).status).toBe(201)
    const restored = await bundle('bob', board.id)
    expect(restored.cards.find((card) => card.id === child.id)!.parentId).toBe(parent.id)
    expect(restored.cards.find((card) => card.id === child.id)!.recurrence).toEqual({ freq: 'monthly', interval: 2 })
    const links = sqlite.prepare('SELECT from_card_id, to_card_id, kind FROM project_card_links WHERE board_id = ?').all(board.id)
    expect(links).toEqual([{ from_card_id: child.id, to_card_id: parent.id, kind: 'blocks' }])
  })

  it('packs attachment bytes and restores them with new storage keys', async () => {
    const board = await createBoard('alice', { title: 'Files' })
    const card = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Holder' })).json()) as { card: { id: string } }).card
    const content = new TextEncoder().encode('hello archive')
    const form = new FormData()
    form.set('file', new File([content], 'note.txt', { type: 'text/plain' }))
    form.set('cardId', card.id)
    const uploaded = await app.fetch(new Request(`http://localhost/api/project/boards/${board.id}/files`, {
      method: 'POST',
      headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get('alice')}`, [CLIENT_HEADER]: '1' },
      body: form,
    }), env)
    expect(uploaded.status, await uploaded.clone().text()).toBe(201)
    const attachment = ((await uploaded.json()) as { file: { id: string, objectKey: string } }).file
    const bytes = new Uint8Array(await (await req('alice', 'GET', `/boards/${board.id}/archive`)).arrayBuffer())
    const entries = unzipSync(bytes)
    expect(entries[`${board.id}/files/${attachment.id}`]).toEqual(content)

    files.objects.clear()
    files.types.clear()
    sqlite.exec(`DELETE FROM project_attachments; DELETE FROM project_card_links; DELETE FROM project_card_values;
      DELETE FROM project_cards; DELETE FROM project_card_contents; DELETE FROM project_comments; DELETE FROM project_views;
      DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards`)
    expect((await reqRaw('bob', '/boards/import', bytes)).status).toBe(201)
    const row = sqlite.prepare('SELECT card_id, object_key FROM project_attachments WHERE id = ?').get(attachment.id) as { card_id: string, object_key: string }
    expect(row.card_id).toBe(card.id)
    expect(row.object_key).not.toBe(attachment.objectKey)
    const restored = await req('bob', 'GET', `/files/${attachment.id}`)
    expect(restored.status, await restored.clone().text()).toBe(200)
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(content)
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

  it('rejects malformed archive version metadata', async () => {
    const bytes = zipSync({
      'version.json': strToU8('{'),
      'b-bad-version/board.jsonl': strToU8(`${JSON.stringify(boardLine('b-bad-version'))}\n`),
    })
    expect((await reqRaw('alice', '/boards/import', bytes)).status).toBe(400)
    expect((await reqRaw('alice', '/boards/import-account', bytes)).status).toBe(400)
  })

  it('refuses an export when bundle contents or comments are truncated', async () => {
    const board = await createBoard('alice', { title: 'Too many blocks' })
    const card = ((await (await req('alice', 'POST', `/boards/${board.id}/cards`, { title: 'Card' })).json()) as { card: { id: string } }).card
    const insert = sqlite.prepare(`INSERT INTO project_card_contents
      (id, card_id, board_id, type, title, fields, position, created_by, modified_by, create_at, update_at, delete_at)
      VALUES (?, ?, ?, 'text', ?, '{}', ?, 'alice', 'alice', 1, 1, 0)`)
    for (let index = 0; index < 2001; index += 1) insert.run(`a${String(index).padStart(26, '0')}`, card.id, board.id, `Block ${index}`, index)
    const response = await req('alice', 'GET', `/boards/${board.id}/archive`)
    expect(response.status).toBe(413)
  })

  it('records streamed attachment byte counts instead of stale database sizes', async () => {
    const board = await createBoard('alice', { title: 'Streamed file size' })
    const attachmentId = await seedAttachment(board.id, 1, true)
    sqlite.prepare('UPDATE project_attachments SET size = ? WHERE id = ?').run(999, attachmentId)
    const response = await req('alice', 'GET', `/boards/${board.id}/archive`)
    expect(response.status).toBe(200)
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
    const lines = strFromU8(entries[`${board.id}/board.jsonl`]!).trim().split('\n').map((line) => JSON.parse(line) as { type: string, data: { id?: string, size?: number } })
    expect(lines.find((line) => line.type === 'attachment' && line.data.id === attachmentId)?.data.size).toBe(1)
    expect(entries[`${board.id}/files/${attachmentId}`]).toHaveLength(1)
  })

  it('bounds the in-memory fallback and requires multipart storage for large exports', async () => {
    const board = await createBoard('alice', { title: 'KV fallback' })
    const request = () => app.fetch(new Request(`http://localhost/api/project/boards/${board.id}/archive`, {
      headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${tokens.get('alice')}` },
    }), { ...env, FILES: undefined })
    const small = await request()
    expect(small.status).toBe(200)
    expect(new Uint8Array(await small.arrayBuffer()).byteLength).toBeGreaterThan(0)
    const attachmentId = await seedAttachment(board.id, 1, false)
    sqlite.prepare('UPDATE project_attachments SET size = ? WHERE id = ?').run(5 * 1024 * 1024, attachmentId)
    expect((await request()).status).toBe(413)
  })

  it('refuses an export when attachment bytes are missing and aborts the temporary upload', async () => {
    const board = await createBoard('alice', { title: 'Missing file' })
    await seedAttachment(board.id, 1, false)
    const createMultipartUpload = files.createMultipartUpload.bind(files)
    let aborts = 0
    vi.spyOn(files, 'createMultipartUpload').mockImplementation(async (key, options) => {
      const upload = await createMultipartUpload(key, options)
      const abort = upload.abort.bind(upload)
      upload.abort = async () => { aborts += 1; await abort() }
      return upload
    })
    const response = await req('alice', 'GET', `/boards/${board.id}/archive`)
    expect(response.status).toBe(400)
    expect(aborts).toBe(1)
    expect([...files.objects.keys()].some((key) => key.startsWith('project/exports/'))).toBe(false)
  })

  it('reads beyond 200 attachments and refuses archives over the ZIP member budget', async () => {
    const board = await createBoard('alice', { title: 'Many files' })
    for (let index = 0; index < 201; index += 1) await seedAttachment(board.id, index, true)
    expect(await listBoardAttachments(env.DB, board.id)).toHaveLength(200)
    expect(await listBoardAttachments(env.DB, board.id, undefined, 500)).toHaveLength(201)
    const response = await req('alice', 'GET', `/boards/${board.id}/archive`)
    expect(response.status).toBe(413)
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
  it('rejects an archive whose card hierarchy contains a cycle', async () => {
    const boardId = 'b-cycle'
    const firstBlock = cardBlock('c-cycle-a', boardId) as { data: { fields: Record<string, unknown> } }
    const secondBlock = cardBlock('c-cycle-b', boardId) as { data: { fields: Record<string, unknown> } }
    const first = { ...firstBlock.data, fields: { ...firstBlock.data.fields, parentId: 'c-cycle-b' } }
    const second = { ...secondBlock.data, fields: { ...secondBlock.data.fields, parentId: 'c-cycle-a' } }
    const bytes = archiveWithLines(boardId, [boardLine(boardId), { type: 'block', data: first }, { type: 'block', data: second }])
    const response = await reqRaw('alice', '/boards/import', bytes)
    expect(response.status).toBe(400)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM project_boards WHERE id = ?').get(boardId)).toMatchObject({ count: 0 })
  })

  it('rejects an oversized import before creating a partial board', async () => {
    const boardId = 'b-large-import'
    const lines: unknown[] = [{ type: 'board', data: { id: boardId, title: 'Large', cardProperties: [{ id: pid(1), name: 'Value', type: 'text', options: [] }] } }]
    for (let index = 0; index < 500; index += 1) {
      lines.push({ type: 'block', data: {
        id: `c${String(index).padStart(26, '0')}`, type: 'card', parentId: boardId, boardId, title: 'Card',
        fields: { properties: { [pid(1)]: 'x' } }, createAt: 1, updateAt: 1,
      } })
    }
    const response = await reqRaw('alice', '/boards/import', archiveWithLines(boardId, lines))
    expect(response.status).toBe(413)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM project_boards WHERE id = ?').get(boardId)).toMatchObject({ count: 0 })
  })

  it('rolls back earlier boards when a later account-import board is invalid', async () => {
    const files = {
      'version.json': strToU8(JSON.stringify({ version: 2, date: 1 })),
      'b-account-a/board.jsonl': strToU8(`${JSON.stringify(boardLine('b-account-a'))}\n`),
      'b-account-b/board.jsonl': strToU8([
        JSON.stringify(boardLine('b-account-b')),
        JSON.stringify({ type: 'block', data: { id: 'c-account-b', type: 'card', parentId: 'b-account-b', boardId: 'b-account-b', title: 'Bad', fields: { parentId: 'missing' }, createAt: 1, updateAt: 1 } }),
      ].join('\n') + '\n'),
    }
    const response = await reqRaw('alice', '/boards/import-account', zipSync(files))
    expect(response.status).toBe(400)
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM project_boards WHERE id IN ('b-account-a','b-account-b')").get()).toMatchObject({ count: 0 })
  })

  it('rejects unknown property types and values that reference missing properties', async () => {
    const unknownType = archiveWithLines('b-unknown-type', [
      { type: 'board', data: { id: 'b-unknown-type', title: 'Bad type', cardProperties: [{ id: pid(1), name: 'Bad', type: 'not-a-type', options: [] }] } },
    ])
    expect((await reqRaw('alice', '/boards/import', unknownType)).status).toBe(400)
    const orphanValue = archiveWithLines('b-orphan-value', [
      boardLine('b-orphan-value'),
      { type: 'block', data: { id: 'c-orphan-value', type: 'card', parentId: 'b-orphan-value', boardId: 'b-orphan-value', title: 'Bad value', fields: { properties: { [pid(1)]: 'x' } }, createAt: 1, updateAt: 1 } },
    ])
    expect((await reqRaw('alice', '/boards/import', orphanValue)).status).toBe(400)
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM project_boards WHERE id IN ('b-unknown-type','b-orphan-value')").get()).toMatchObject({ count: 0 })
  })

  it('rejects duplicate entity ids and file blocks with missing attachments', async () => {
    const duplicateBytes = archiveWithLines('b-duplicate-id', [
      boardLine('b-duplicate-id'), cardBlock('c-duplicate', 'b-duplicate-id'), cardBlock('c-duplicate', 'b-duplicate-id'),
    ])
    expect((await reqRaw('alice', '/boards/import', duplicateBytes)).status).toBe(400)
    const orphanBytes = archiveWithLines('b-orphan-file', [
      boardLine('b-orphan-file'),
      cardBlock('c-orphan-file', 'b-orphan-file'),
      { type: 'block', data: { id: 'a-orphan-file', type: 'file', parentId: 'c-orphan-file', boardId: 'b-orphan-file', title: 'File', fields: { attachmentId: 'i-missing' }, createAt: 1, updateAt: 1 } },
    ])
    expect((await reqRaw('alice', '/boards/import', orphanBytes)).status).toBe(400)
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM project_boards WHERE id IN ('b-duplicate-id','b-orphan-file')").get()).toMatchObject({ count: 0 })
  })

  it('rewrites imported authors to the importing account', async () => {
    const boardId = 'b-author-rewrite'
    const cardId = 'c'.repeat(27)
    const contentId = 'a'.repeat(27)
    const commentId = 'm'.repeat(27)
    const viewId = 'v'.repeat(27)
    const bytes = archiveWithLines(boardId, [
      boardLine(boardId),
      { type: 'block', data: { id: cardId, type: 'card', parentId: boardId, boardId, title: 'Card', fields: {}, createdBy: 'alice', modifiedBy: 'alice', createAt: 1, updateAt: 1 } },
      { type: 'block', data: { id: viewId, type: 'view', parentId: boardId, boardId, title: 'View', fields: { viewType: 'table' }, createdBy: 'alice', modifiedBy: 'alice', createAt: 1, updateAt: 1 } },
      { type: 'block', data: { id: contentId, type: 'text', parentId: cardId, boardId, title: 'Body', fields: {}, createdBy: 'alice', modifiedBy: 'alice', createAt: 1, updateAt: 1 } },
      { type: 'block', data: { id: commentId, type: 'comment', parentId: cardId, boardId, title: 'Comment', fields: {}, createdBy: 'alice', modifiedBy: 'alice', createAt: 1, updateAt: 1 } },
    ])
    const response = await reqRaw('bob', '/boards/import', bytes)
    expect(response.status, await response.clone().text()).toBe(201)
    expect(sqlite.prepare('SELECT created_by, modified_by FROM project_cards WHERE id = ?').get(cardId)).toMatchObject({ created_by: 'bob', modified_by: 'bob' })
    expect(sqlite.prepare('SELECT created_by, modified_by FROM project_card_contents WHERE id = ?').get(contentId)).toMatchObject({ created_by: 'bob', modified_by: 'bob' })
    expect(sqlite.prepare('SELECT created_by, modified_by FROM project_views WHERE id = ?').get(viewId)).toMatchObject({ created_by: 'bob', modified_by: 'bob' })
    expect(sqlite.prepare('SELECT author_id FROM project_comments WHERE id = ?').get(commentId)).toMatchObject({ author_id: 'bob' })

    const accountResponse = await reqRaw('bob', '/boards/import-account', bytes)
    expect(accountResponse.status, await accountResponse.clone().text()).toBe(201)
    const { boards } = await accountResponse.json() as { boards: { id: string }[] }
    const accountBoardId = boards[0]!.id
    expect(sqlite.prepare('SELECT created_by, modified_by FROM project_cards WHERE board_id = ?').get(accountBoardId)).toMatchObject({ created_by: 'bob', modified_by: 'bob' })
    expect(sqlite.prepare('SELECT created_by, modified_by FROM project_card_contents WHERE board_id = ?').get(accountBoardId)).toMatchObject({ created_by: 'bob', modified_by: 'bob' })
    expect(sqlite.prepare('SELECT created_by, modified_by FROM project_views WHERE board_id = ?').get(accountBoardId)).toMatchObject({ created_by: 'bob', modified_by: 'bob' })
    expect(sqlite.prepare('SELECT author_id FROM project_comments WHERE board_id = ?').get(accountBoardId)).toMatchObject({ author_id: 'bob' })
  })

  it('remaps file block references when account import creates fresh attachment ids', async () => {
    const boardId = 'b-file-remap'
    const cardId = 'c-file-remap'
    const attachmentId = 'i-file-old'
    const content = new Uint8Array([1, 2, 3])
    const bytes = zipSync({
      'version.json': strToU8(JSON.stringify({ version: 2, date: 1 })),
      [`${boardId}/board.jsonl`]: strToU8([
        boardLine(boardId),
        cardBlock(cardId, boardId),
        { type: 'block', data: { id: 'a-file-block', type: 'file', parentId: cardId, boardId, title: 'File', fields: { attachmentId }, createAt: 1, updateAt: 1 } },
        { type: 'attachment', data: { id: attachmentId, cardId, filename: 'file.bin', mime: 'application/octet-stream', size: content.byteLength, storage: 'r2', path: `${boardId}/files/${attachmentId}` } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n'),
      [`${boardId}/files/${attachmentId}`]: content,
    })
    const response = await reqRaw('bob', '/boards/import-account', bytes)
    expect(response.status, await response.clone().text()).toBe(201)
    const { boards } = await response.json() as { boards: { id: string }[] }
    const importedBoardId = boards[0]!.id
    const attachment = sqlite.prepare('SELECT id, card_id FROM project_attachments WHERE board_id = ?').get(importedBoardId) as { id: string, card_id: string }
    const block = sqlite.prepare('SELECT fields FROM project_card_contents WHERE board_id = ?').get(importedBoardId) as { fields: string }
    expect(attachment.id).not.toBe(attachmentId)
    expect(JSON.parse(block.fields)).toMatchObject({ attachmentId: attachment.id })
    const restored = await req('bob', 'GET', `/files/${attachment.id}`)
    expect(restored.status, await restored.clone().text()).toBe(200)
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(content)
  })

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