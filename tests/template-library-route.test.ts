// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildTemplateLibraryExport, parseTemplateLibraryExport } from '../src/shared/note-templates'
import { DEFAULT_NEW_NOTE_TEMPLATE } from '../src/shared/constants'
import type { NoteTemplate, NoteTemplateCategory } from '../src/shared/types'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { templateLibraryRoutes } from '../src/worker/routes/template-library'
import { makeD1 } from './doubles/d1-sqlite'

const FIRST = 'user-first'
const SECOND = 'user-second'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let db: D1Database

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.route('/api/templates', templateLibraryRoutes)

const CATEGORY: NoteTemplateCategory = { id: 'cat-1', name: 'Notes', builtin: false, position: 0, createdAt: 1 }

function template(id: string, name = nameFor(id)): NoteTemplate {
  return {
    id,
    categoryId: CATEGORY.id,
    name,
    description: '',
    content: DEFAULT_NEW_NOTE_TEMPLATE,
    tags: [],
    builtin: false,
    isPinned: false,
    isStarred: false,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function nameFor(id: string): string {
  return `Template ${id}`
}

function libraryText(ids: string[]): string {
  return JSON.stringify(buildTemplateLibraryExport([CATEGORY], ids.map((id) => template(id))))
}

function send(method: string, body: unknown, userId = FIRST): Promise<Response> {
  mocks.userId = userId
  return app.request('/api/templates/library', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, { DB: db } as unknown as AppBindings['Bindings'], {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext)
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

async function load(userId = FIRST): Promise<Record<string, unknown>> {
  mocks.userId = userId
  const response = await app.request('/api/templates/library', {}, {
    DB: db,
  } as unknown as AppBindings['Bindings'], {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext)
  return await jsonOf(response)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  for (const id of [FIRST, SECOND]) {
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
       VALUES (?, ?, 'h', ?, 'Name', '', 'member', '{}', 1, 1)`,
    ).run(id, id, id)
  }
  db = makeD1(sqlite)
})

describe('the account template library', () => {
  it('starts empty', async () => {
    expect(await load()).toEqual({ savedAt: 0, library: null })
  })

  it('stores a library and reads it back', async () => {
    const response = await send('PUT', { library: libraryText(['tpl-a', 'tpl-b']) })
    expect(response.status).toBe(200)
    const savedAt = Number((await jsonOf(response)).savedAt)
    expect(savedAt).toBeGreaterThan(0)
    const loaded = await load()
    expect(loaded.savedAt).toBe(savedAt)
    const parsed = parseTemplateLibraryExport(JSON.stringify(loaded.library))
    expect(parsed.data?.templates.map((item) => item.id)).toEqual(['tpl-a', 'tpl-b'])
    expect(parsed.data?.categories.map((item) => item.id)).toEqual([CATEGORY.id])
  })

  it('keeps one copy per account and lets the newest write win', async () => {
    await send('PUT', { library: libraryText(['tpl-a']) }, FIRST)
    await send('PUT', { library: libraryText(['tpl-z']) }, SECOND)
    const first = await load(FIRST)
    const second = await load(SECOND)
    expect((parseTemplateLibraryExport(JSON.stringify(first.library)).data?.templates ?? []).map((item) => item.id))
      .toEqual(['tpl-a'])
    expect((parseTemplateLibraryExport(JSON.stringify(second.library)).data?.templates ?? []).map((item) => item.id))
      .toEqual(['tpl-z'])
    await send('PUT', { library: libraryText(['tpl-a', 'tpl-b']) }, FIRST)
    const again = parseTemplateLibraryExport(JSON.stringify((await load(FIRST)).library)).data
    expect(again?.templates.map((item) => item.id)).toEqual(['tpl-a', 'tpl-b'])
    expect(again?.templates.map((item) => item.name)).toEqual(['Template tpl-a', 'Template tpl-b'])
  })

  it('refuses a body that is not a library document', async () => {
    expect((await send('PUT', { library: 'not json at all' })).status).toBe(400)
    expect((await send('PUT', { library: JSON.stringify({ hello: 'world' }) })).status).toBe(400)
    expect((await send('PUT', { library: 42 })).status).toBe(400)
    expect((await send('PUT', {})).status).toBe(400)
  })

  it('refuses a library whose entries had to be dropped', async () => {
    const broken = JSON.stringify({
      app: 'inkstone',
      kind: 'template-library',
      version: 1,
      exportedAt: 1,
      categories: [CATEGORY],
      templates: [template('tpl-ok'), { ...template('tpl-bad'), name: 42 }],
    })
    const response = await send('PUT', { library: broken })
    expect(response.status).toBe(400)
    expect(await load()).toEqual({ savedAt: 0, library: null })
  })

  it('refuses a library larger than the account can hold', async () => {
    const huge = libraryText(['tpl-a'])
    const padded = JSON.stringify({
      app: 'inkstone',
      kind: 'template-library',
      version: 1,
      exportedAt: 1,
      categories: [CATEGORY],
      templates: [{ ...template('tpl-a'), content: 'x'.repeat(1024 * 1024 + 8) }],
    })
    expect(huge.length).toBeLessThan(padded.length)
    expect((await send('PUT', { library: padded })).status).toBe(413)
  })

  it('reads a damaged stored value as empty instead of failing', async () => {
    sqlite.prepare('UPDATE users SET template_library = ? WHERE id = ?').run('{oops', FIRST)
    expect(await load(FIRST)).toEqual({ savedAt: 0, library: null })
    sqlite.prepare('UPDATE users SET template_library = ? WHERE id = ?').run('[]', FIRST)
    expect(await load(FIRST)).toEqual({ savedAt: 0, library: null })
    sqlite.prepare('UPDATE users SET template_library = ? WHERE id = ?')
      .run(JSON.stringify({ savedAt: 'soon', library: {} }), FIRST)
    expect(await load(FIRST)).toEqual({ savedAt: 0, library: null })
  })

  it('writes only the row that belongs to the signed-in account', async () => {
    await send('PUT', { library: libraryText(['tpl-a']) }, FIRST)
    expect(sqlite.prepare('SELECT template_library FROM users WHERE id = ?').get(SECOND)).toEqual({ template_library: null })
  })
})
