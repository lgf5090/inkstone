// @vitest-environment node
// Search behaviour: literal substring matching (Chinese included), escaped LIKE wildcards,
// title/page precedence, snippet shape, trash exclusion, notebook filtering and account isolation.
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { inknoteRoutes } from '../src/worker/routes/inknote'
import type { InknoteLibraryResponse, InknoteNoteResponse, InknoteSearchResponse } from '../src/shared/inknote/api'
import type { InknotePage } from '../src/shared/inknote/types'
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

async function library(user = ALICE): Promise<InknoteLibraryResponse> {
  return await read<InknoteLibraryResponse>(await send(user, 'GET', '/library'))
}

async function createNote(user: string, title: string, notebookId?: string): Promise<InknoteNoteResponse> {
  const lib = await library(user)
  const response = await send(user, 'POST', '/notes', {
    notebookId: notebookId ?? lib.notebooks[0]!.id,
    title,
  })
  expect(response.status).toBe(201)
  return await read<InknoteNoteResponse>(response)
}

function textContent(text: string): string {
  return JSON.stringify({
    format: 'inknote-page',
    version: 1,
    strokes: [],
    texts: [{
      id: newId(),
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

async function saveText(
  user: string,
  noteId: string,
  pageId: string,
  text: string,
  baseRev = 1,
): Promise<number> {
  const response = await send(user, 'PUT', `/notes/${noteId}/pages/${pageId}`, {
    content: textContent(text),
    baseRev,
  })
  expect(response.status).toBe(200)
  return (await read<{ rev: number }>(response)).rev
}

async function search(
  user: string,
  q: string,
  options: { notebookId?: string; limit?: number } = {},
): Promise<InknoteSearchResponse> {
  const params = new URLSearchParams({ q })
  if (options.notebookId) params.set('notebookId', options.notebookId)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  const response = await send(user, 'GET', `/search?${params.toString()}`)
  expect(response.status).toBe(200)
  return await read<InknoteSearchResponse>(response)
}

describe('inknote search', () => {
  it('matches one, two and three-character Chinese substrings and the first hit page', async () => {
    const created = await createNote(ALICE, '数学笔记')
    const firstPage = created.pages[0]!
    await saveText(ALICE, created.note.id, firstPage.id, '微积分基础很重要')

    const secondPageResponse = await send(ALICE, 'POST', `/notes/${created.note.id}/pages`, {})
    expect(secondPageResponse.status).toBe(201)
    const secondPage = await read<InknotePage>(secondPageResponse)
    await saveText(ALICE, created.note.id, secondPage.id, '第二页的积分公式')

    const one = await search(ALICE, '微')
    expect(one.total).toBe(1)
    expect(one.results[0]!.titleMatch).toBe(false)
    expect(one.results[0]!.pageIndex).toBe(0)
    expect(one.results[0]!.snippet).toContain('微积分')

    const two = await search(ALICE, '积分')
    expect(two.results[0]!.pageIndex).toBe(0)

    const three = await search(ALICE, '微积分')
    expect(three.results[0]!.snippet).toContain('微积分')
  })

  it('reports the earliest matching page when the title does not match', async () => {
    const created = await createNote(ALICE, 'Chinese pages')
    const firstPage = created.pages[0]!
    await saveText(ALICE, created.note.id, firstPage.id, 'nothing on this page')
    const second = await read<InknotePage>(await send(ALICE, 'POST', `/notes/${created.note.id}/pages`, {}))
    await saveText(ALICE, created.note.id, second.id, '积分 appears here')
    const third = await read<InknotePage>(await send(ALICE, 'POST', `/notes/${created.note.id}/pages`, {}))
    await saveText(ALICE, created.note.id, third.id, '积分 appears again')

    const result = await search(ALICE, '积分')
    expect(result.results).toHaveLength(1)
    expect(result.results[0]!.pageIndex).toBe(1)
    expect(result.results[0]!.titleMatch).toBe(false)
    expect(result.results[0]!.snippet).toContain('积分')
  })

  it('matches titles case-insensitively and marks them as page zero', async () => {
    await createNote(ALICE, 'Quantum Mechanics')
    const lower = await search(ALICE, 'quantum')
    expect(lower.results[0]!.titleMatch).toBe(true)
    expect(lower.results[0]!.pageIndex).toBe(0)
    expect(lower.results[0]!.snippet).toContain('Quantum')
    const upper = await search(ALICE, 'MECHANICS')
    expect(upper.results[0]!.titleMatch).toBe(true)
  })

  it('treats %, _ and backslash literally', async () => {
    const percent = await createNote(ALICE, 'Progress')
    await saveText(ALICE, percent.note.id, percent.pages[0]!.id, '100% done')
    const other = await createNote(ALICE, 'Other progress')
    await saveText(ALICE, other.note.id, other.pages[0]!.id, '100x done')
    const percentHits = await search(ALICE, '%')
    expect(percentHits.results.map((result) => result.noteId)).toEqual([percent.note.id])

    const underscore = await createNote(ALICE, 'Files')
    await saveText(ALICE, underscore.note.id, underscore.pages[0]!.id, 'file_name')
    const plain = await createNote(ALICE, 'Plain files')
    await saveText(ALICE, plain.note.id, plain.pages[0]!.id, 'fileXname')
    const underscoreHits = await search(ALICE, '_')
    expect(underscoreHits.results.map((result) => result.noteId)).toEqual([underscore.note.id])

    const slash = await createNote(ALICE, 'Slashes')
    await saveText(ALICE, slash.note.id, slash.pages[0]!.id, 'back\\slash')
    const slashHits = await search(ALICE, '\\')
    expect(slashHits.results.map((result) => result.noteId)).toEqual([slash.note.id])
  })

  it('hides trashed notes and returns them again after restore', async () => {
    const created = await createNote(ALICE, 'Zebra migrations')
    expect((await search(ALICE, 'zebra')).total).toBe(1)
    await send(ALICE, 'DELETE', `/notes/${created.note.id}`)
    expect((await search(ALICE, 'zebra')).total).toBe(0)
    await send(ALICE, 'POST', `/notes/${created.note.id}/restore`)
    expect((await search(ALICE, 'zebra')).total).toBe(1)
  })

  it('filters by notebook and keeps the total before the limit', async () => {
    const lib = await library()
    const subjectId = lib.subjects[0]!.id
    const secondNotebook = await read<{ id: string }>(await send(ALICE, 'POST', '/notebooks', {
      subjectId,
      name: 'Second notebook',
    }))
    const first = await createNote(ALICE, 'Filter target', lib.notebooks[0]!.id)
    await createNote(ALICE, 'Filter target', secondNotebook.id)
    await createNote(ALICE, 'Filter target', secondNotebook.id)

    const filtered = await search(ALICE, 'Filter target', { notebookId: lib.notebooks[0]!.id })
    expect(filtered.total).toBe(1)
    expect(filtered.results[0]!.noteId).toBe(first.note.id)
    expect(filtered.results[0]!.notebookName).toBe(lib.notebooks[0]!.name)
    expect(filtered.results[0]!.subjectName).toBe(lib.subjects[0]!.name)

    const limited = await search(ALICE, 'Filter target', { limit: 2 })
    expect(limited.results).toHaveLength(2)
    expect(limited.total).toBe(3)

    const clamped = await search(ALICE, 'Filter target', { limit: 10_000 })
    expect(clamped.results).toHaveLength(3)
  })

  it('keeps snippets plain text of at most 160 characters', async () => {
    const created = await createNote(ALICE, 'Snippet')
    await saveText(ALICE, created.note.id, created.pages[0]!.id, `${'前'.repeat(200)}命中词${'后'.repeat(200)}`)
    const result = await search(ALICE, '命中词')
    expect(result.results).toHaveLength(1)
    const snippet = result.results[0]!.snippet
    expect(Array.from(snippet).length).toBeLessThanOrEqual(160)
    expect(snippet).toContain('命中词')
    expect(snippet).not.toContain('<')
  })

  it('never returns another account\'s matches and validates the query', async () => {
    const created = await createNote(ALICE, 'Alice private term')
    await saveText(ALICE, created.note.id, created.pages[0]!.id, 'private page term')
    expect((await search(BOB, 'private')).results).toEqual([])
    expect((await search(BOB, 'private')).total).toBe(0)

    expect((await send(ALICE, 'GET', '/search?q=')).status).toBe(400)
    expect((await send(ALICE, 'GET', `/search?q=${'q'.repeat(201)}`)).status).toBe(400)
  })
})
