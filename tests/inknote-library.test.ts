// @vitest-environment node
// Behavioural coverage for the Inknote library: default seed, subject/notebook/note CRUD,
// soft-delete/restore/purge, note duplication, and the account boundary that every route keeps.
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
import type { InknoteNoteMeta, InknoteSubject } from '../src/shared/inknote/types'
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

async function send(
  user: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
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

async function library(user = ALICE): Promise<InknoteLibraryResponse> {
  const response = await send(user, 'GET', '/library')
  expect(response.status).toBe(200)
  return await read<InknoteLibraryResponse>(response)
}

async function createNote(user = ALICE, title = 'Lecture notes'): Promise<InknoteNoteResponse> {
  const lib = await library(user)
  const notebookId = lib.notebooks[0]!.id
  const response = await send(user, 'POST', '/notes', { notebookId, title })
  expect(response.status).toBe(201)
  return await read<InknoteNoteResponse>(response)
}

function contentWithIds(strokeId: string, textId: string): string {
  return JSON.stringify({
    format: 'inknote-page',
    version: 1,
    strokes: [{
      id: strokeId,
      tool: 'ballpen',
      style: 'normal',
      shape: null,
      color: '#1e293b',
      width: 4,
      points: [{ x: 1, y: 2, p: 1 }],
    }],
    texts: [{
      id: textId,
      x: 0.1,
      y: 0.1,
      w: 0.4,
      h: 0.1,
      text: 'hello inknote',
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
}

describe('inknote library', () => {
  it('seeds one subject and notebook on the first library read', async () => {
    const lib = await library()
    expect(lib.subjects).toHaveLength(1)
    expect(lib.notebooks).toHaveLength(1)
    expect(lib.notebooks[0]!.subjectId).toBe(lib.subjects[0]!.id)
    expect(lib.notes).toEqual([])
    expect(lib.templates).toEqual([])
    expect(lib.settings.tool).toBe('ballpen')
    expect(lib.counts).toEqual({ subjects: 1, notebooks: 1, notes: 0 })
  })

  it('creates a subject, notebook and note and returns metadata without page content', async () => {
    const lib = await library()
    const subjectResponse = await send(ALICE, 'POST', '/subjects', { name: 'Physics' })
    expect(subjectResponse.status).toBe(201)
    const subject = await read<InknoteSubject>(subjectResponse)
    expect(subject.position).toBe(1)

    const notebookResponse = await send(ALICE, 'POST', '/notebooks', {
      subjectId: subject.id,
      name: 'Mechanics',
      coverColor: '#38bdf8',
      emoji: 'P',
    })
    expect(notebookResponse.status).toBe(201)

    const created = await createNote()
    expect(created.note.pageCount).toBe(1)
    expect(created.note.contentBytes).toBe(0)
    expect(created.note.pageWidth).toBe(816)
    expect(created.note.pageHeight).toBe(1056)
    expect(created.note.contentWidth).toBe(816)
    expect(created.note.contentHeight).toBe(1056)
    expect(created.note.rev).toBe(1)
    expect(created.pages).toHaveLength(1)
    expect(created.pages[0]!.content.strokes).toEqual([])
    expect(created.pages[0]!.rev).toBe(1)

    const after = await library()
    expect(after.notes).toHaveLength(1)
    expect(after.notes[0]).not.toHaveProperty('pages')
    expect(after.counts).toEqual({ subjects: 2, notebooks: 2, notes: 1 })
  })

  it('honours a client note id idempotently and rejects an id owned by another account', async () => {
    const lib = await library()
    const id = newId()
    const first = await send(ALICE, 'POST', '/notes', {
      id,
      notebookId: lib.notebooks[0]!.id,
      title: 'Client chosen',
    })
    expect(first.status).toBe(201)
    const again = await send(ALICE, 'POST', '/notes', {
      id,
      notebookId: lib.notebooks[0]!.id,
      title: 'Different title',
    })
    expect(again.status).toBe(200)
    const repeated = await read<InknoteNoteResponse>(again)
    expect(repeated.note.title).toBe('Client chosen')
    expect(repeated.pages).toHaveLength(1)

    const bobLibrary = await library(BOB)
    mocks.userId = BOB
    const collision = await send(BOB, 'POST', '/notes', {
      id,
      notebookId: bobLibrary.notebooks[0]!.id,
      title: 'Stolen',
    })
    expect(collision.status).toBe(409)
  })

  it('soft deletes, restores and purges a note with its pages', async () => {
    const created = await createNote()
    const noteId = created.note.id
    const pageId = created.pages[0]!.id

    const deleted = await send(ALICE, 'DELETE', `/notes/${noteId}`)
    expect(deleted.status).toBe(200)
    const trash = await read<{ notes: InknoteNoteMeta[] }>(await send(ALICE, 'GET', '/trash'))
    expect(trash.notes.map((note) => note.id)).toContain(noteId)
    expect((await library()).notes).toHaveLength(0)

    const restored = await send(ALICE, 'POST', `/notes/${noteId}/restore`)
    expect(restored.status).toBe(200)
    expect((await read<InknoteNoteMeta>(restored)).deletedAt).toBeNull()
    expect((await library()).notes).toHaveLength(1)

    await send(ALICE, 'DELETE', `/notes/${noteId}`)
    const purged = await send(ALICE, 'DELETE', `/notes/${noteId}/purge`)
    expect(purged.status).toBe(200)
    expect(await send(ALICE, 'GET', `/notes/${noteId}`)).toHaveProperty('status', 404)

    const notes = sqlite.prepare('SELECT COUNT(*) AS total FROM inknote_notes WHERE user_id = ?').get(ALICE) as { total: number }
    const pages = sqlite.prepare('SELECT COUNT(*) AS total FROM inknote_pages WHERE user_id = ?').get(ALICE) as { total: number }
    expect(Number(notes.total)).toBe(0)
    expect(Number(pages.total)).toBe(0)
    expect(pageId).toBeTruthy()
  })

  it('moves notes to the trash with their notebook and restores them into a replacement', async () => {
    const created = await createNote()
    const notebookId = created.note.notebookId

    const removed = await send(ALICE, 'DELETE', `/notebooks/${notebookId}`)
    expect(removed.status).toBe(200)
    expect(await read<{ trashed: number; removed: number }>(removed)).toEqual({ trashed: 1, removed: 1 })
    expect((await library()).notes).toHaveLength(0)

    const restored = await send(ALICE, 'POST', `/notes/${created.note.id}/restore`)
    expect(restored.status).toBe(200)
    const note = await read<InknoteNoteMeta>(restored)
    expect(note.notebookId).not.toBe(notebookId)
    const lib = await library()
    expect(lib.notebooks.map((notebook) => notebook.id)).toContain(note.notebookId)
    expect(lib.notes.map((entry) => entry.id)).toContain(created.note.id)
  })

  it('duplicates a note with fresh page, stroke and text ids', async () => {
    const created = await createNote()
    const page = created.pages[0]!
    const saved = await send(ALICE, 'PUT', `/notes/${created.note.id}/pages/${page.id}`, {
      content: contentWithIds('stroke-original', 'text-original'),
      baseRev: page.rev,
    })
    expect(saved.status).toBe(200)

    const response = await send(ALICE, 'POST', `/notes/${created.note.id}/duplicate`, { title: 'Copy of lecture' })
    expect(response.status).toBe(201)
    const copy = await read<InknoteNoteResponse>(response)
    expect(copy.note.id).not.toBe(created.note.id)
    expect(copy.note.title).toBe('Copy of lecture')
    expect(copy.note.pageCount).toBe(1)
    expect(copy.pages[0]!.id).not.toBe(page.id)
    expect(copy.pages[0]!.content.strokes[0]!.id).not.toBe('stroke-original')
    expect(copy.pages[0]!.content.texts[0]!.id).not.toBe('text-original')
    expect(copy.pages[0]!.content.texts[0]!.text).toBe('hello inknote')
    expect(copy.note.contentBytes).toBeGreaterThan(0)
  })

  it('enforces the name and title limits instead of truncating', async () => {
    const longName = 'n'.repeat(121)
    expect((await send(ALICE, 'POST', '/subjects', { name: longName })).status).toBe(400)

    const lib = await library()
    const response = await send(ALICE, 'POST', '/notes', {
      notebookId: lib.notebooks[0]!.id,
      title: 't'.repeat(513),
    })
    expect(response.status).toBe(400)
  })
})
