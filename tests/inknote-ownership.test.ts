// @vitest-environment node
// The account boundary across every Inknote route: reads, metadata writes, page writes, copies,
// restores and purges issued by another account must look exactly like missing rows.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { inknoteRoutes } from '../src/worker/routes/inknote'
import type { InknoteLibraryResponse, InknoteNoteResponse } from '../src/shared/inknote/api'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'

const mocks = { userId: ALICE }
const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('*', async (c, next) => {
  c.set('userId', mocks.userId)
  await next()
})
app.route('/api/inknote', inknoteRoutes)

const ctx: ExecutionContext = { waitUntil() {}, passThroughOnException() {}, props: {} }

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
})

async function send(user: string, method: string, path: string, body?: unknown): Promise<Response> {
  mocks.userId = user
  return await app.request(
    `/api/inknote${path}`,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { DB: db } as unknown as AppBindings['Bindings'],
    ctx,
  )
}

async function read<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function library(user: string): Promise<InknoteLibraryResponse> {
  const response = await send(user, 'GET', '/library')
  expect(response.status).toBe(200)
  return await read<InknoteLibraryResponse>(response)
}

async function createNote(user: string, title: string): Promise<InknoteNoteResponse> {
  const lib = await library(user)
  const response = await send(user, 'POST', '/notes', { notebookId: lib.notebooks[0]!.id, title })
  expect(response.status).toBe(201)
  return await read<InknoteNoteResponse>(response)
}

describe('inknote ownership', () => {
  it('keeps libraries, notes, subjects and notebooks per account', async () => {
    const alice = await createNote(ALICE, 'Alice notes')
    const bob = await createNote(BOB, 'Bob notes')

    expect((await library(ALICE)).notes.map((note) => note.id)).toEqual([alice.note.id])
    expect((await library(BOB)).notes.map((note) => note.id)).toEqual([bob.note.id])

    expect((await send(BOB, 'GET', `/notes/${alice.note.id}`)).status).toBe(404)
    expect((await send(ALICE, 'GET', `/notes/${bob.note.id}`)).status).toBe(404)
  })

  it('answers another account\'s note mutations as 404 and leaves the row untouched', async () => {
    const alice = await createNote(ALICE, 'Private')
    const noteId = alice.note.id
    const pageId = alice.pages[0]!.id

    expect((await send(BOB, 'PATCH', `/notes/${noteId}`, { title: 'Hijacked', baseRev: 1 })).status).toBe(404)
    expect((await send(BOB, 'DELETE', `/notes/${noteId}`)).status).toBe(404)
    expect((await send(BOB, 'POST', `/notes/${noteId}/restore`)).status).toBe(404)
    expect((await send(BOB, 'DELETE', `/notes/${noteId}/purge`)).status).toBe(404)
    expect((await send(BOB, 'POST', `/notes/${noteId}/duplicate`, {})).status).toBe(404)

    expect((await send(BOB, 'PUT', `/notes/${noteId}/pages/${pageId}`, {
      content: JSON.stringify({ format: 'inknote-page', version: 1, strokes: [], texts: [], images: [], bg: null }),
      baseRev: 1,
    })).status).toBe(404)
    expect((await send(BOB, 'POST', `/notes/${noteId}/pages`, {})).status).toBe(404)
    expect((await send(BOB, 'POST', `/notes/${noteId}/pages/${pageId}/duplicate`)).status).toBe(404)
    expect((await send(BOB, 'DELETE', `/notes/${noteId}/pages/${pageId}`)).status).toBe(404)
    expect((await send(BOB, 'PATCH', `/notes/${noteId}/pages/order`, { pageIds: [pageId] })).status).toBe(404)

    const bobNote = await createNote(BOB, 'Bob note')
    expect((await send(BOB, 'POST', `/notes/${bobNote.note.id}/pages/copy`, {
      sourceNoteId: noteId,
      pageId,
    })).status).toBe(404)

    const aliceRow = sqlite.prepare(
      'SELECT title, rev, deleted_at FROM inknote_notes WHERE user_id = ? AND id = ?',
    ).get(ALICE, noteId) as { title: string; rev: number; deleted_at: number | null }
    expect(aliceRow.title).toBe('Private')
    expect(Number(aliceRow.rev)).toBe(1)
    expect(aliceRow.deleted_at).toBeNull()

    const bobPage = await read<InknoteNoteResponse>(await send(BOB, 'GET', `/notes/${bobNote.note.id}`))
    expect(bobPage.note.pageCount).toBe(1)
    expect(bobPage.pages).toHaveLength(1)
  })

  it('answers another account\'s subject and notebook mutations as 404', async () => {
    const aliceLib = await library(ALICE)
    const subjectId = aliceLib.subjects[0]!.id
    const notebookId = aliceLib.notebooks[0]!.id

    expect((await send(BOB, 'PATCH', `/subjects/${subjectId}`, { name: 'Stolen' })).status).toBe(404)
    expect((await send(BOB, 'DELETE', `/subjects/${subjectId}`)).status).toBe(404)
    expect((await send(BOB, 'PATCH', `/notebooks/${notebookId}`, { name: 'Stolen' })).status).toBe(404)
    expect((await send(BOB, 'DELETE', `/notebooks/${notebookId}`)).status).toBe(404)

    const subject = sqlite.prepare(
      'SELECT name FROM inknote_subjects WHERE user_id = ? AND id = ?',
    ).get(ALICE, subjectId) as { name: string }
    expect(subject.name).toBe(aliceLib.subjects[0]!.name)
  })

  it('rejects client ids already owned by another account for subjects and notebooks', async () => {
    const aliceLib = await library(ALICE)
    const subjectId = newId()
    expect((await send(ALICE, 'POST', '/subjects', { id: subjectId, name: 'Alice subject' })).status).toBe(201)
    const bobLib = await library(BOB)
    expect((await send(BOB, 'POST', '/subjects', { id: subjectId, name: 'Bob subject' })).status).toBe(409)

    const notebookId = newId()
    expect((await send(ALICE, 'POST', '/notebooks', {
      id: notebookId,
      subjectId: aliceLib.subjects[0]!.id,
      name: 'Alice notebook',
    })).status).toBe(201)
    expect((await send(BOB, 'POST', '/notebooks', {
      id: notebookId,
      subjectId: bobLib.subjects[0]!.id,
      name: 'Bob notebook',
    })).status).toBe(409)
  })

  it('purges only the caller\'s note and page rows', async () => {
    const alice = await createNote(ALICE, 'Alice purge')
    const bob = await createNote(BOB, 'Bob keep')
    expect((await send(ALICE, 'DELETE', `/notes/${alice.note.id}`)).status).toBe(200)
    expect((await send(ALICE, 'DELETE', `/notes/${alice.note.id}/purge`)).status).toBe(200)

    const rows = sqlite.prepare('SELECT user_id, id FROM inknote_notes ORDER BY user_id').all() as Array<{ user_id: string; id: string }>
    expect(rows).toEqual([{ user_id: BOB, id: bob.note.id }])
    const pages = sqlite.prepare('SELECT user_id FROM inknote_pages').all() as Array<{ user_id: string }>
    expect(pages.every((row) => row.user_id === BOB)).toBe(true)
    expect((await send(BOB, 'GET', `/notes/${bob.note.id}`)).status).toBe(200)
  })

  it('does not let another account copy a page into its own note', async () => {
    const alice = await createNote(ALICE, 'Source')
    const bob = await createNote(BOB, 'Target')
    const alicePageId = alice.pages[0]!.id
    const response = await send(BOB, 'POST', `/notes/${bob.note.id}/pages/copy`, {
      sourceNoteId: alice.note.id,
      pageId: alicePageId,
    })
    expect(response.status).toBe(404)
    const pages = sqlite.prepare(
      'SELECT COUNT(*) AS total FROM inknote_pages WHERE user_id = ? AND note_id = ?',
    ).get(BOB, bob.note.id) as { total: number }
    expect(Number(pages.total)).toBe(1)
  })

  it('does not return another account\'s pages through search or trash', async () => {
    const alice = await createNote(ALICE, 'Alice secret')
    const alicePage = alice.pages[0]!
    const content = JSON.stringify({
      format: 'inknote-page',
      version: 1,
      strokes: [],
      texts: [{
        id: 'text-1',
        x: 0.1,
        y: 0.1,
        w: 0.6,
        h: 0.2,
        text: 'shared search term',
        fontSize: 26,
        color: '#1e293b',
        align: 'left',
        bold: false,
        italic: false,
        underline: false,
        hl: null,
        lh: 1.3,
        list: null,
      }],
      images: [],
      bg: null,
    })
    expect((await send(ALICE, 'PUT', `/notes/${alice.note.id}/pages/${alicePage.id}`, {
      content,
      baseRev: 1,
    })).status).toBe(200)

    const bobSearch = await read<{ results: unknown[]; total: number }>(
      await send(BOB, 'GET', '/search?q=shared%20search%20term'),
    )
    expect(bobSearch).toEqual({ results: [], total: 0 })

    await send(ALICE, 'DELETE', `/notes/${alice.note.id}`)
    const bobTrash = await read<{ notes: Array<{ id: string }> }>(await send(BOB, 'GET', '/trash'))
    expect(bobTrash.notes).toEqual([])
    const aliceTrash = await read<{ notes: Array<{ id: string }> }>(await send(ALICE, 'GET', '/trash'))
    expect(aliceTrash.notes.map((note) => note.id)).toEqual([alice.note.id])
  })
})
