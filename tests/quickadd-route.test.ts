// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUICKADD_APP,
  QUICKADD_KIND,
  QUICKADD_VERSION,
  buildQuickAddPayload,
  defaultQuickAddSettings,
  newCaptureChoice,
  newTemplateChoice,
  parseQuickAddRecord,
  parseQuickAddText,
  type QuickAddChoice,
} from '../src/shared/quickadd'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { quickAddRoutes } from '../src/worker/routes/quickadd'
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
app.route('/api/quickadd', quickAddRoutes)

function choices(...ids: string[]): QuickAddChoice[] {
  return ids.map((id, index) => (index % 2
    ? { ...newCaptureChoice(id, `Capture ${id}`, index), targetTitle: 'Inbox' }
    : { ...newTemplateChoice(id, `Template ${id}`, index), templateId: 'tpl-1' }))
}

function libraryText(ids: string[]): string {
  return JSON.stringify(buildQuickAddPayload(defaultQuickAddSettings(), choices(...ids)))
}

function send(method: string, body: unknown, userId = FIRST): Promise<Response> {
  mocks.userId = userId
  return app.request('/api/quickadd/library', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, { DB: db } as unknown as AppBindings['Bindings'], {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext)
}

async function load(userId = FIRST): Promise<Record<string, unknown>> {
  mocks.userId = userId
  const response = await app.request('/api/quickadd/library', {}, {
    DB: db,
  } as unknown as AppBindings['Bindings'], {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext)
  return await response.json() as Record<string, unknown>
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

describe('the account quickadd library', () => {
  it('starts empty', async () => {
    expect(await load()).toEqual({ savedAt: 0, library: null })
  })

  it('stores a library and reads it back', async () => {
    const response = await send('PUT', { library: libraryText(['qa-a', 'qa-b']) })
    expect(response.status).toBe(200)
    const savedAt = Number((await response.json() as Record<string, unknown>).savedAt)
    expect(savedAt).toBeGreaterThan(0)

    const loaded = await load()
    const parsed = parseQuickAddRecord(loaded.library)
    expect(loaded.savedAt).toBe(savedAt)
    expect(parsed.data?.choices.map((choice) => choice.id)).toEqual(['qa-a', 'qa-b'])
    expect(parsed.data?.version).toBe(QUICKADD_VERSION)
  })

  it('keeps the options it was given, not the ones it shipped', async () => {
    const settings = defaultQuickAddSettings()
    settings.notifications = false
    settings.defaultFolder = 'Inbox/Later'
    settings.globalVars = [{ name: 'author', value: 'Me' }]
    const text = JSON.stringify(buildQuickAddPayload(settings, choices('qa-a')))
    const put = await send('PUT', { library: text })
    expect(put.status).toBe(200)
    const parsed = parseQuickAddRecord((await load()).library)
    expect(parsed.data?.settings).toMatchObject({
      notifications: false,
      defaultFolder: 'Inbox/Later',
      globalVars: [{ name: 'author', value: 'Me' }],
    })
  })

  it('refuses a body it would have to silently repair', async () => {
    const dropped = JSON.stringify({
      app: QUICKADD_APP,
      kind: QUICKADD_KIND,
      version: 1,
      settings: defaultQuickAddSettings(),
      choices: [choices('qa-ok'), { id: 'bad id', name: 'Nope', type: 'template' }],
    })
    const response = await send('PUT', { library: dropped })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: { code: string } }).error.code).toBe('bad_request')
    expect(await load()).toEqual({ savedAt: 0, library: null })
  })

  it('refuses a library that is not one at all', async () => {
    expect((await send('PUT', { library: '{"choices":[]}' })).status).toBe(400)
    expect((await send('PUT', { library: 'not json' })).status).toBe(400)
    expect((await send('PUT', { library: 42 })).status).toBe(400)
    expect((await send('PUT', {})).status).toBe(400)
  })

  it('refuses a library bigger than the transport budget', async () => {
    const huge = JSON.stringify(buildQuickAddPayload(defaultQuickAddSettings(), [
      { ...newCaptureChoice('qa-c', 'C', 0), format: { enabled: true, format: 'x'.repeat(2 * 1024 * 1024) } },
    ]))
    const response = await send('PUT', { library: huge })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(await load()).toEqual({ savedAt: 0, library: null })
  })

  it('keeps one copy per account', async () => {
    await send('PUT', { library: libraryText(['qa-a']) }, FIRST)
    await send('PUT', { library: libraryText(['qa-z']) }, SECOND)
    const first = parseQuickAddRecord((await load(FIRST)).library).data
    const second = parseQuickAddRecord((await load(SECOND)).library).data
    expect(first?.choices.map((choice) => choice.id)).toEqual(['qa-a'])
    expect(second?.choices.map((choice) => choice.id)).toEqual(['qa-z'])
  })

  it('lets the newest write win and replaces the whole record', async () => {
    await send('PUT', { library: libraryText(['qa-a', 'qa-b']) })
    await send('PUT', { library: libraryText(['qa-c']) })
    const parsed = parseQuickAddRecord((await load()).library).data
    expect(parsed?.choices.map((choice) => choice.id)).toEqual(['qa-c'])
  })

  it('serves a record written in the stored envelope shape', async () => {
    const envelope = JSON.stringify({
      savedAt: 7,
      version: QUICKADD_VERSION,
      library: {
        app: QUICKADD_APP,
        kind: QUICKADD_KIND,
        version: 1,
        settings: { notifications: true },
        choices: [{ id: 'qa-t', name: 'T', type: 'template' }],
      },
    })
    sqlite.prepare('UPDATE users SET quickadd = ?1 WHERE id = ?2').run(envelope, FIRST)

    const loaded = await load()
    expect(loaded.savedAt).toBe(7)
    const parsed = parseQuickAddRecord(loaded.library)
    expect(parsed.data?.choices.map((choice) => choice.id)).toEqual(['qa-t'])
    expect(parsed.data?.settings.notifications).toBe(true)
  })

  it('survives a corrupt stored record by reading it as empty', async () => {
    sqlite.prepare('UPDATE users SET quickadd = ? WHERE id = ?').run('{oops', FIRST)
    expect(await load()).toEqual({ savedAt: 0, library: null })
    sqlite.prepare('UPDATE users SET quickadd = ? WHERE id = ?').run('[]', FIRST)
    expect(await load()).toEqual({ savedAt: 0, library: null })
    sqlite.prepare('UPDATE users SET quickadd = ? WHERE id = ?')
      .run(JSON.stringify({ savedAt: 'now', library: {} }), FIRST)
    expect(await load()).toEqual({ savedAt: 0, library: null })
  })

  it('answers a request for an account that is not there', async () => {
    mocks.userId = 'user-gone'
    const response = await app.request('/api/quickadd/library', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library: libraryText(['qa-a']) }),
    }, { DB: db } as unknown as AppBindings['Bindings'], {
      waitUntil() {},
      passThroughOnException() {},
    } as ExecutionContext)
    expect(response.status).toBe(404)
  })
})
