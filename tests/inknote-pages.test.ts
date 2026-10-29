// @vitest-environment node
// Behavioural coverage for Inknote pages: rev conflicts, content validation and limits, the
// 500-page reorder statement, page duplication/copy/deletion, and the note's byte counters.
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
import type { InknoteNoteMeta, InknotePage, InknotePageContent } from '../src/shared/inknote/types'
import { emptyPageContent, serializePageContent } from '../src/shared/inknote/parse'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
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

async function send(method: string, path: string, body?: unknown): Promise<Response> {
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

async function library(): Promise<InknoteLibraryResponse> {
  return await read<InknoteLibraryResponse>(await send('GET', '/library'))
}

async function createNote(title = 'Page tests'): Promise<InknoteNoteResponse> {
  const lib = await library()
  const response = await send('POST', '/notes', { notebookId: lib.notebooks[0]!.id, title })
  expect(response.status).toBe(201)
  return await read<InknoteNoteResponse>(response)
}

function textContent(text: string): string {
  return JSON.stringify({
    format: 'inknote-page',
    version: 1,
    strokes: [],
    texts: [{
      id: 'text-1',
      x: 0.1,
      y: 0.1,
      w: 0.6,
      h: 0.2,
      text,
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

/** A page just below the per-page ceiling: 88 boxes of 20,000 characters. */
function nearPageLimitContent(): string {
  const texts = Array.from({ length: 88 }, (_, index) => ({
    id: `text-${index}`,
    x: 0.1,
    y: 0.1,
    w: 0.6,
    h: 0.2,
    text: 'a'.repeat(20_000),
    fontSize: 26,
    color: '#1e293b',
    align: 'left',
    bold: false,
    italic: false,
    underline: false,
    hl: null,
    lh: 1.3,
    list: null,
  }))
  return JSON.stringify({
    format: 'inknote-page',
    version: 1,
    strokes: [],
    texts,
    images: [],
    bg: null,
  })
}

function overPageLimitContent(): string {
  const texts = Array.from({ length: 91 }, (_, index) => ({
    id: `big-${index}`,
    x: 0.1,
    y: 0.1,
    w: 0.6,
    h: 0.2,
    text: 'a'.repeat(20_000),
    fontSize: 26,
    color: '#1e293b',
    align: 'left',
    bold: false,
    italic: false,
    underline: false,
    hl: null,
    lh: 1.3,
    list: null,
  }))
  return JSON.stringify({
    format: 'inknote-page',
    version: 1,
    strokes: [],
    texts,
    images: [],
    bg: null,
  })
}

describe('inknote pages', () => {
  it('saves a page, bumps its rev, rejects a stale rev and returns the server copy', async () => {
    const created = await createNote()
    const noteId = created.note.id
    const page = created.pages[0]!

    const saved = await send('PUT', `/notes/${noteId}/pages/${page.id}`, {
      content: textContent('first version'),
      baseRev: 1,
    })
    expect(saved.status).toBe(200)
    const saveResult = await read<{ rev: number; updatedAt: number; searchText: string }>(saved)
    expect(saveResult.rev).toBe(2)
    expect(saveResult.searchText).toBe('first version')

    const stale = await send('PUT', `/notes/${noteId}/pages/${page.id}`, {
      content: textContent('stale version'),
      baseRev: 1,
    })
    expect(stale.status).toBe(409)
    const conflict = await read<{ error: { details: { current: { content: string; rev: number } } } }>(stale)
    expect(conflict.error.details.current.rev).toBe(2)
    expect(JSON.parse(conflict.error.details.current.content)).toMatchObject({ format: 'inknote-page' })

    const opened = await read<InknoteNoteResponse>(await send('GET', `/notes/${noteId}`))
    expect(opened.pages[0]!.rev).toBe(2)
    expect(opened.pages[0]!.content.texts[0]!.text).toBe('first version')
    expect(opened.note.contentBytes).toBeGreaterThan(0)
    expect(opened.note.updatedAt).toBe(saveResult.updatedAt)

    const metadataOnly = await read<InknoteNoteResponse>(await send('GET', `/notes/${noteId}?content=none`))
    expect(metadataOnly.pages).toEqual([])
    expect(metadataOnly.note.pageCount).toBe(1)
  })

  it('rejects malformed and over-limit content without writing', async () => {
    const created = await createNote()
    const noteId = created.note.id
    const page = created.pages[0]!

    const malformed = await send('PUT', `/notes/${noteId}/pages/${page.id}`, {
      content: '{"format":"wrong"}',
      baseRev: 1,
    })
    expect(malformed.status).toBe(400)

    const tooBig = await send('PUT', `/notes/${noteId}/pages/${page.id}`, {
      content: overPageLimitContent(),
      baseRev: 1,
    })
    expect(tooBig.status).toBe(413)

    const state = sqlite.prepare(
      'SELECT rev, content FROM inknote_pages WHERE user_id = ? AND note_id = ? AND id = ?',
    ).get(ALICE, noteId, page.id) as { rev: number; content: string }
    expect(Number(state.rev)).toBe(1)
    expect(JSON.parse(state.content).texts).toEqual([])
  })

  it('adds, duplicates and copies pages while keeping positions contiguous', async () => {
    const created = await createNote()
    const noteId = created.note.id
    const firstPage = created.pages[0]!

    const inserted = await send('POST', `/notes/${noteId}/pages`, { afterPageId: firstPage.id })
    expect(inserted.status).toBe(201)
    const secondPage = await read<InknotePage>(inserted)
    expect(secondPage.position).toBe(1)

    const duplicated = await send('POST', `/notes/${noteId}/pages/${firstPage.id}/duplicate`)
    expect(duplicated.status).toBe(201)
    const duplicate = await read<InknotePage>(duplicated)
    expect(duplicate.position).toBe(1)
    expect(duplicate.id).not.toBe(firstPage.id)

    const opened = await read<InknoteNoteResponse>(await send('GET', `/notes/${noteId}`))
    expect(opened.pages.map((page) => page.position)).toEqual([0, 1, 2])
    expect(opened.note.pageCount).toBe(3)

    const other = await createNote('Other note')
    const copied = await send('POST', `/notes/${other.note.id}/pages/copy`, {
      sourceNoteId: noteId,
      pageId: firstPage.id,
    })
    expect(copied.status).toBe(201)
    const copiedPage = await read<InknotePage>(copied)
    expect(copiedPage.position).toBe(1)
    expect(copiedPage.content).toEqual(firstPage.content)
    const otherAfter = await read<InknoteNoteResponse>(await send('GET', `/notes/${other.note.id}`))
    expect(otherAfter.note.pageCount).toBe(2)

    let current = otherAfter
    while (current.pages.length > 1) {
      const target = current.pages[current.pages.length - 1]!
      const removed = await send('DELETE', `/notes/${other.note.id}/pages/${target.id}`)
      expect(removed.status).toBe(200)
      current = await read<InknoteNoteResponse>(await send('GET', `/notes/${other.note.id}`))
    }
    const lastDelete = await send('DELETE', `/notes/${other.note.id}/pages/${current.pages[0]!.id}`)
    expect(lastDelete.status).toBe(400)
  })

  it('reorders 500 pages from one json_each statement', async () => {
    const created = await createNote()
    const noteId = created.note.id
    const content = serializePageContent(emptyPageContent())
    const ids = [created.pages[0]!.id]
    const insert = sqlite.prepare(
      `INSERT INTO inknote_pages (user_id, id, note_id, position, content, search_text, rev, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', 1, 1, 1)`,
    )
    sqlite.exec('BEGIN')
    for (let position = 1; position < 500; position++) {
      const id = newId()
      ids.push(id)
      insert.run(ALICE, id, noteId, position, content)
    }
    sqlite.exec('COMMIT')
    sqlite.prepare('UPDATE inknote_notes SET page_count = 500 WHERE user_id = ? AND id = ?').run(ALICE, noteId)

    const reversed = [...ids].reverse()
    const response = await send('PATCH', `/notes/${noteId}/pages/order`, { pageIds: reversed })
    expect(response.status).toBe(200)

    const rows = sqlite.prepare(
      'SELECT id, position FROM inknote_pages WHERE user_id = ? AND note_id = ? ORDER BY position ASC',
    ).all(ALICE, noteId) as Array<{ id: string; position: number }>
    expect(rows.map((row) => row.id)).toEqual(reversed)
    expect(rows.map((row) => Number(row.position))).toEqual(Array.from({ length: 500 }, (_, index) => index))

    const missing = await send('PATCH', `/notes/${noteId}/pages/order`, { pageIds: reversed.slice(1) })
    expect(missing.status).toBe(400)
  })

  it('refuses a save that pushes the whole note past 12 MB', async () => {
    const created = await createNote()
    const noteId = created.note.id
    const pageIds = [created.pages[0]!.id]
    for (let index = 0; index < 6; index++) {
      const response = await send('POST', `/notes/${noteId}/pages`, {})
      expect(response.status).toBe(201)
      pageIds.push((await read<InknotePage>(response)).id)
    }
    const content = nearPageLimitContent()
    for (let index = 0; index < 6; index++) {
      const response = await send('PUT', `/notes/${noteId}/pages/${pageIds[index]}`, {
        content,
        baseRev: 1,
      })
      expect(response.status).toBe(200)
    }
    const overflow = await send('PUT', `/notes/${noteId}/pages/${pageIds[6]}`, {
      content,
      baseRev: 1,
    })
    expect(overflow.status).toBe(413)
    const row = sqlite.prepare(
      'SELECT rev FROM inknote_pages WHERE user_id = ? AND id = ?',
    ).get(ALICE, pageIds[6]) as { rev: number }
    expect(Number(row.rev)).toBe(1)

    const note = sqlite.prepare(
      'SELECT page_count, content_bytes FROM inknote_notes WHERE user_id = ? AND id = ?',
    ).get(ALICE, noteId) as { page_count: number; content_bytes: number }
    expect(Number(note.page_count)).toBe(7)
    expect(Number(note.content_bytes)).toBeLessThanOrEqual(12_000_000)
  })

  it('reports a corrupt stored page without failing the whole note', async () => {
    const created = await createNote()
    sqlite.prepare('UPDATE inknote_pages SET content = ? WHERE user_id = ? AND note_id = ?')
      .run('{not json', ALICE, created.note.id)
    const response = await send('GET', `/notes/${created.note.id}`)
    expect(response.status).toBe(200)
    const opened = await read<InknoteNoteResponse & { pages: Array<InknotePage & { contentError?: string }> }>(response)
    expect(opened.pages[0]!.contentError).toBe('invalid_json')
    expect(opened.pages[0]!.content).toEqual(emptyPageContent() as InknotePageContent)
  })
})
