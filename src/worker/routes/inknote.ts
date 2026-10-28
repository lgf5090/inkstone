/**
 * The Inknote HTTP surface: a thin parser over `InknoteStore` and `searchInknote`.
 *
 * Nothing here builds SQL. A handler validates the shapes a client can send, calls one store method
 * and answers with the record it returns; every domain failure (404/409/413) is thrown as `ApiError`
 * by the store so the app's error middleware renders the same envelope as every other route.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { INKNOTE_LIMITS } from '@shared/inknote/constants'
import type {
  InknoteNoteResponse,
  InknotePageSaveResponse,
  InknoteSearchResponse,
} from '@shared/inknote/api'
import type { InknoteNotebook, InknoteSubject } from '@shared/inknote/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { clampInt, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { searchInknote } from '../inknote/search'
import {
  INKNOTE_PAGE_SIZE_LIMITS,
  InknoteStore,
  type InknotePageDto,
} from '../inknote/store'

const SMALL_BODY_LIMIT = 64 * 1024
// The parsed page must stay under 1.8 MB; escaping inside a JSON string body is bounded by this.
const PAGE_BODY_LIMIT = INKNOTE_LIMITS.pageContentMaxBytes * 6 + 64 * 1024

export const inknoteRoutes = new Hono<AppBindings>()

inknoteRoutes.use('*', requireAuth)

function storeFor(c: Context<AppBindings>): InknoteStore {
  return new InknoteStore(c.env.DB, c.get('userId'))
}

type JsonBody = Record<string, unknown>

function requiredName(value: unknown): string {
  if (typeof value !== 'string') throw ApiError.badRequest('name must be a string')
  const name = value.trim()
  if (!name) throw ApiError.badRequest('name is required')
  if (Array.from(name).length > INKNOTE_LIMITS.nameMaxLength) {
    throw ApiError.badRequest(`name exceeds ${INKNOTE_LIMITS.nameMaxLength} characters`)
  }
  return name
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a string`)
  if (Array.from(value).length > max) {
    throw ApiError.badRequest(`${field} exceeds ${max} characters`)
  }
  return value
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!isValidId(value)) throw ApiError.badRequest(`${field} must be a 26-character id`)
  return value
}

function requiredId(value: unknown, field: string): string {
  if (!isValidId(value)) throw ApiError.badRequest(`${field} must be a 26-character id`)
  return value
}

function optionalPosition(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw ApiError.badRequest(`${field} must be a non-negative integer`)
  }
  return value
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${field} must be a boolean`)
  return value
}

function optionalPaper(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest('paper must be an object')
  }
  return value
}

function optionalPageSize(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw ApiError.badRequest(`${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

function optionalColorTag(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 32) {
    throw ApiError.badRequest('colorTag must be a colour string or null')
  }
  return value
}

function pageIdsField(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > INKNOTE_LIMITS.pagesPerNote) {
    throw ApiError.badRequest(`pageIds must hold between 1 and ${INKNOTE_LIMITS.pagesPerNote} ids`)
  }
  const ids = value.map((entry) => {
    if (!isValidId(entry)) throw ApiError.badRequest('pageIds must contain 26-character ids')
    return entry
  })
  if (new Set(ids).size !== ids.length) throw ApiError.badRequest('pageIds must not repeat an id')
  return ids
}

// ---------------------------------------------------------------- library, trash

inknoteRoutes.get('/library', async (c) => {
  return c.json(await storeFor(c).library())
})

inknoteRoutes.get('/trash', async (c) => {
  return c.json({ notes: await storeFor(c).trash() })
})

// ------------------------------------------------------------------------ subjects

inknoteRoutes.post('/subjects', async (c) => {
  const body = await readJson<JsonBody>(c, SMALL_BODY_LIMIT)
  const result = await storeFor(c).createSubject({
    id: optionalId(body.id, 'id'),
    name: requiredName(body.name),
    position: optionalPosition(body.position, 'position'),
  })
  const subject: InknoteSubject = result.subject
  return c.json(subject, result.created ? 201 : 200)
})

inknoteRoutes.patch('/subjects/:id', async (c) => {
  const body = await readJson<JsonBody>(c, SMALL_BODY_LIMIT)
  const name = body.name === undefined ? undefined : requiredName(body.name)
  return c.json(await storeFor(c).updateSubject(c.req.param('id'), {
    name,
    position: optionalPosition(body.position, 'position'),
  }))
})

inknoteRoutes.delete('/subjects/:id', async (c) => {
  return c.json(await storeFor(c).deleteSubject(c.req.param('id')))
})

// ----------------------------------------------------------------------- notebooks

inknoteRoutes.post('/notebooks', async (c) => {
  const body = await readJson<JsonBody>(c, SMALL_BODY_LIMIT)
  const result = await storeFor(c).createNotebook({
    id: optionalId(body.id, 'id'),
    subjectId: requiredId(body.subjectId, 'subjectId'),
    name: requiredName(body.name),
    coverColor: optionalText(body.coverColor, 'coverColor', 32),
    emoji: optionalText(body.emoji, 'emoji', 16),
    position: optionalPosition(body.position, 'position'),
  })
  const notebook: InknoteNotebook = result.notebook
  return c.json(notebook, result.created ? 201 : 200)
})

inknoteRoutes.patch('/notebooks/:id', async (c) => {
  const body = await readJson<JsonBody>(c, SMALL_BODY_LIMIT)
  return c.json(await storeFor(c).updateNotebook(c.req.param('id'), {
    name: body.name === undefined ? undefined : requiredName(body.name),
    coverColor: optionalText(body.coverColor, 'coverColor', 32),
    emoji: optionalText(body.emoji, 'emoji', 16),
    position: optionalPosition(body.position, 'position'),
  }))
})

inknoteRoutes.delete('/notebooks/:id', async (c) => {
  return c.json(await storeFor(c).deleteNotebook(c.req.param('id')))
})

// ---------------------------------------------------------------------------- notes

inknoteRoutes.get('/notes/:id', async (c) => {
  const requested = c.req.query('content')
  if (requested !== undefined && requested !== 'all' && requested !== 'none') {
    throw ApiError.badRequest("content must be 'all' or 'none'")
  }
  const note = await storeFor(c).getNoteWithPages(c.req.param('id'), requested === 'none' ? 'none' : 'all')
  if (!note) throw ApiError.notFound('Note not found')
  const response: InknoteNoteResponse = note
  return c.json(response)
})

inknoteRoutes.post('/notes', async (c) => {
  const body = await readJson<JsonBody>(c, SMALL_BODY_LIMIT)
  if (body.pages !== undefined) {
    if (!Array.isArray(body.pages)) throw ApiError.badRequest('pages must be an array')
    if (body.pages.length) {
      throw ApiError.badRequest('Initial pages are not supported; create the note, then save its pages')
    }
  }
  const result = await storeFor(c).createNote({
    id: optionalId(body.id, 'id'),
    notebookId: requiredId(body.notebookId, 'notebookId'),
    title: optionalText(body.title, 'title', INKNOTE_LIMITS.titleMaxLength),
    paper: optionalPaper(body.paper),
  })
  const response: InknoteNoteResponse = { note: result.note, pages: result.pages }
  return c.json(response, result.created ? 201 : 200)
})

inknoteRoutes.patch('/notes/:id', async (c) => {
  const body = await readJson<JsonBody>(c, SMALL_BODY_LIMIT)
  if (typeof body.baseRev !== 'number' || !Number.isInteger(body.baseRev) || body.baseRev < 1) {
    throw ApiError.badRequest('baseRev must be a positive integer')
  }
  const notebookId = body.notebookId === undefined ? undefined : requiredId(body.notebookId, 'notebookId')
  return c.json(await storeFor(c).updateNote(c.req.param('id'), {
    title: optionalText(body.title, 'title', INKNOTE_LIMITS.titleMaxLength),
    notebookId,
    paper: optionalPaper(body.paper),
    pageWidth: optionalPageSize(
      body.pageWidth,
      'pageWidth',
      INKNOTE_PAGE_SIZE_LIMITS.minWidth,
      INKNOTE_PAGE_SIZE_LIMITS.maxWidth,
    ),
    pageHeight: optionalPageSize(
      body.pageHeight,
      'pageHeight',
      INKNOTE_PAGE_SIZE_LIMITS.minHeight,
      INKNOTE_PAGE_SIZE_LIMITS.maxHeight,
    ),
    colorTag: optionalColorTag(body.colorTag),
    pinned: optionalBoolean(body.pinned, 'pinned'),
    baseRev: body.baseRev,
  }))
})

inknoteRoutes.delete('/notes/:id', async (c) => {
  return c.json(await storeFor(c).deleteNote(c.req.param('id')))
})

inknoteRoutes.post('/notes/:id/restore', async (c) => {
  return c.json(await storeFor(c).restoreNote(c.req.param('id')))
})

inknoteRoutes.delete('/notes/:id/purge', async (c) => {
  await storeFor(c).purgeNote(c.req.param('id'))
  return c.json({ purged: true })
})

inknoteRoutes.post('/notes/:id/duplicate', async (c) => {
  const body = await readJson<JsonBody>(c, SMALL_BODY_LIMIT)
  const result = await storeFor(c).duplicateNote(
    c.req.param('id'),
    optionalText(body.title, 'title', INKNOTE_LIMITS.titleMaxLength),
  )
  const response: InknoteNoteResponse = { note: result.note, pages: result.pages }
  return c.json(response, 201)
})

// ---------------------------------------------------------------------------- pages

/** Static page paths are registered before the `:pageId` shapes they would otherwise be read as. */
inknoteRoutes.patch('/notes/:id/pages/order', async (c) => {
  const body = await readJson<JsonBody>(c, SMALL_BODY_LIMIT)
  return c.json(await storeFor(c).reorderPages(c.req.param('id'), pageIdsField(body.pageIds)))
})

inknoteRoutes.post('/notes/:id/pages/copy', async (c) => {
  const body = await readJson<JsonBody>(c, SMALL_BODY_LIMIT)
  if (typeof body.pageId !== 'string' || !body.pageId) {
    throw ApiError.badRequest('pageId is required')
  }
  const page = await storeFor(c).copyPage(
    c.req.param('id'),
    requiredId(body.sourceNoteId, 'sourceNoteId'),
    body.pageId,
  )
  return c.json(page, 201)
})

inknoteRoutes.post('/notes/:id/pages', async (c) => {
  const body = await readJson<JsonBody>(c, PAGE_BODY_LIMIT)
  if (body.content !== undefined && typeof body.content !== 'string') {
    throw ApiError.badRequest('content must be a serialized page string')
  }
  if (body.afterPageId !== undefined && typeof body.afterPageId !== 'string') {
    throw ApiError.badRequest('afterPageId must be a string')
  }
  const result = await storeFor(c).createPage(c.req.param('id'), {
    id: optionalId(body.id, 'id'),
    afterPageId: body.afterPageId as string | undefined,
    content: body.content as string | undefined,
  })
  const page: InknotePageDto = result.page
  return c.json(page, result.created ? 201 : 200)
})

inknoteRoutes.post('/notes/:id/pages/:pageId/duplicate', async (c) => {
  return c.json(await storeFor(c).duplicatePage(c.req.param('id'), c.req.param('pageId')), 201)
})

inknoteRoutes.put('/notes/:id/pages/:pageId', async (c) => {
  const body = await readJson<JsonBody>(c, PAGE_BODY_LIMIT)
  if (typeof body.content !== 'string') {
    throw ApiError.badRequest('content must be a serialized page string')
  }
  if (typeof body.baseRev !== 'number' || !Number.isInteger(body.baseRev) || body.baseRev < 1) {
    throw ApiError.badRequest('baseRev must be a positive integer')
  }
  const result = await storeFor(c).savePageContent(
    c.req.param('id'),
    c.req.param('pageId'),
    body.content,
    body.baseRev,
  )
  const response: InknotePageSaveResponse & { searchText: string } = result
  return c.json(response)
})

inknoteRoutes.delete('/notes/:id/pages/:pageId', async (c) => {
  return c.json(await storeFor(c).deletePage(c.req.param('id'), c.req.param('pageId')))
})

// --------------------------------------------------------------------------- search

inknoteRoutes.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (!q) throw ApiError.badRequest('q is required')
  if (Array.from(q).length > INKNOTE_LIMITS.searchQueryMaxLength) {
    throw ApiError.badRequest(`q exceeds ${INKNOTE_LIMITS.searchQueryMaxLength} characters`)
  }
  const notebookId = c.req.query('notebookId')?.trim() || undefined
  if (notebookId !== undefined && notebookId.length > 64) {
    throw ApiError.badRequest('notebookId is invalid')
  }
  const limit = clampInt(c.req.query('limit'), 1, INKNOTE_LIMITS.searchResultsMax, 50)
  const result: InknoteSearchResponse = await searchInknote(c.env.DB, c.get('userId'), {
    q,
    notebookId,
    limit,
  })
  return c.json(result)
})
