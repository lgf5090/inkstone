// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { communityTemplatesRoutes } from '../src/worker/routes/community-templates'
import { newId } from '../src/worker/lib/id'
import { makeD1 } from './doubles/d1-sqlite'

const AUTHOR = 'user-author'
const STRANGER = 'user-stranger'

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
app.route('/api/templates/community', communityTemplatesRoutes)

const BASE = '/api/templates/community'

function request(suffix: string, init: RequestInit = {}, userId = AUTHOR): Promise<Response> {
  mocks.userId = userId
  return app.request(BASE + suffix, init, { DB: db } as unknown as AppBindings['Bindings'], {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext)
}

function jsonRequest(method: string, body: unknown, userId = AUTHOR): Promise<Response> {
  return request('', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, userId)
}

function publish(overrides: Record<string, unknown> = {}, userId = AUTHOR) {
  return jsonRequest('POST', { name: 'Weekly review', content: '# Review\n', ...overrides }, userId)
}

function insert(overrides: Partial<{ id: string; author: string; name: string; created: number }> = {}) {
  sqlite.prepare(
    `INSERT INTO community_templates (id, author_id, author_name, name, description, content, tags, category, created_at)
     VALUES (?, ?, ?, ?, '', 'body', '[]', '', ?)`,
  ).run(overrides.id ?? newId(), overrides.author ?? AUTHOR, 'Author', overrides.name ?? 'Row', overrides.created ?? 1)
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'h', ?, 'Display Name', '', 'member', '{}', 1, 1)`,
  ).run(AUTHOR, 'author', 'author')
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'h', ?, 'Other', '', 'member', '{}', 1, 1)`,
  ).run(STRANGER, 'stranger', 'stranger')
  db = makeD1(sqlite)
})

describe('publishing', () => {
  it('stores a template under the signed-in account', async () => {
    const response = await publish({ tags: ['work', '  ', 'x'.repeat(60)] })
    expect(response.status).toBe(200)
    const { template } = await bodyOf(response) as { template: Record<string, unknown> }
    expect(template).toMatchObject({
      authorId: AUTHOR,
      authorName: 'Display Name',
      name: 'Weekly review',
      category: '',
    })
    expect(template.tags).toEqual(['work', `${'x'.repeat(30)}`])
  })

  it('requires a name and a body', async () => {
    expect((await publish({ name: '   ' })).status).toBe(400)
    expect((await publish({ content: '   ' })).status).toBe(400)
    expect((await publish({ content: 42 as unknown as string })).status).toBe(400)
  })

  it('refuses a body past the shared-template ceiling', async () => {
    const response = await publish({ content: 'a'.repeat(LIMITS.communityTemplateContentMaxLength + 1) })
    expect(response.status).toBe(400)
  })

  it('clamps name, description and category to their declared widths', async () => {
    const { template } = await bodyOf(await publish({
      name: 'n'.repeat(2000),
      description: 'd'.repeat(2000),
      category: 'c'.repeat(2000),
    })) as { template: Record<string, string> }
    expect(template.name).toHaveLength(LIMITS.titleMaxLength)
    expect(template.description).toHaveLength(240)
    expect(template.category).toHaveLength(120)
  })

  it('keeps at most eight tags', async () => {
    const tags = Array.from({ length: 20 }, (_, index) => `t${index}`)
    const { template } = await bodyOf(await publish({ tags })) as { template: { tags: string[] } }
    expect(template.tags).toHaveLength(8)
  })

  it('lets an author update their own row and keeps the original date', async () => {
    const created = await bodyOf(await publish()) as { template: { id: string, createdAt: number } }
    const updated = await bodyOf(await publish({ id: created.template.id, name: 'Renamed' })) as {
      template: { id: string, name: string, createdAt: number }
    }
    expect(updated.template.id).toBe(created.template.id)
    expect(updated.template.name).toBe('Renamed')
    expect(updated.template.createdAt).toBe(created.template.createdAt)
  })

  it('will not let one author write over another’s id', async () => {
    const mine = await bodyOf(await publish()) as { template: { id: string } }
    const response = await publish({ id: mine.template.id, name: 'Squatter' }, STRANGER)
    expect(response.status).toBe(403)
    expect(sqlite.prepare('SELECT name FROM community_templates WHERE id = ?').get(mine.template.id)).toMatchObject({
      name: 'Weekly review',
    })
  })

  it('caps how many templates one account may publish', async () => {
    for (let index = 0; index < LIMITS.communityTemplatesMaxPerUser; index++) insert()
    const response = await publish()
    expect(response.status).toBe(403)
  })

  it('throttles a burst of publishes on one account', async () => {
    let blocked: Response | undefined
    for (let attempt = 0; attempt <= LIMITS.communityTemplatesPerHour; attempt++) {
      const response = await publish({ name: `Burst ${attempt}` })
      if (response.status === 429) {
        blocked = response
        break
      }
    }
    expect(blocked?.status).toBe(429)
    const payload = await bodyOf(blocked!) as { error: { code: string, details?: { retryAfter?: number } } }
    expect(payload.error.code).toBe('too_many_attempts')
    expect(payload.error.details?.retryAfter).toBeGreaterThan(0)
  })
})

describe('listing', () => {
  it('returns the newest first with the author’s display name', async () => {
    insert({ id: 'old', created: 100, name: 'Old' })
    insert({ id: 'new', created: 200, name: 'New' })
    const { templates } = await bodyOf(await request('')) as { templates: Array<{ name: string }> }
    expect(templates.map((item) => item.name)).toEqual(['New', 'Old'])
  })

  it('pages with a cursor and stops when the directory is exhausted', async () => {
    const ids = Array.from({ length: 5 }, () => newId())
    ids.forEach((id, index) => insert({ id, created: index + 1 }))
    const first = await bodyOf(await request('?limit=2')) as {
      templates: Array<{ id: string }>
      hasMore: boolean
      nextCursor: string
    }
    expect(first.templates.map((item) => item.id)).toEqual([ids[4], ids[3]])
    expect(first.hasMore).toBe(true)
    const second = await bodyOf(await request(`?limit=2&before=${encodeURIComponent(first.nextCursor)}`)) as {
      templates: Array<{ id: string }>
      hasMore: boolean
      nextCursor: string
    }
    expect(second.templates.map((item) => item.id)).toEqual([ids[2], ids[1]])
    const last = await bodyOf(await request(`?limit=2&before=${encodeURIComponent(second.nextCursor)}`)) as {
      templates: Array<{ id: string }>
      hasMore: boolean
      nextCursor: string | null
    }
    expect(last.templates.map((item) => item.id)).toEqual([ids[0]])
    expect(last.hasMore).toBe(false)
    expect(last.nextCursor).toBe(null)
  })

  it('clamps a requested page size into range', async () => {
    insert()
    for (const raw of ['0', '-5', '99999', 'abc', '1e9']) {
      const response = await request(`?limit=${raw}`)
      expect(response.status, raw).toBe(200)
    }
    const huge = await bodyOf(await request(`?limit=${LIMITS.communityTemplatesPageSizeMax + 500}`)) as {
      templates: unknown[]
    }
    expect(huge.templates.length).toBeLessThanOrEqual(LIMITS.communityTemplatesPageSizeMax)
  })

  it('rejects a malformed cursor', async () => {
    for (const raw of ['nounderscore', 'abc-1_1', `1_${'z'.repeat(200)}`, '-1_abc', `NaN_${newId()}`]) {
      const response = await request(`?before=${encodeURIComponent(raw)}`)
      expect(response.status, raw).toBe(400)
    }
  })

  it('reads a corrupt tags column as no tags', async () => {
    sqlite.prepare(
      `INSERT INTO community_templates (id, author_id, author_name, name, description, content, tags, category, created_at)
       VALUES (?, ?, 'A', 'Broken', '', 'body', 'not json', '', 1)`,
    ).run(newId(), AUTHOR)
    const { templates } = await bodyOf(await request('')) as { templates: Array<{ tags: unknown }> }
    expect(templates[0].tags).toEqual([])
  })
})

describe('unpublishing', () => {
  it('removes the author’s own row', async () => {
    const id = newId()
    insert({ id })
    expect((await request(`/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM community_templates').get()).toMatchObject({ n: 0 })
  })

  it('refuses another account and an unknown id', async () => {
    const id = newId()
    insert({ id })
    expect((await request(`/${id}`, { method: 'DELETE' }, STRANGER)).status).toBe(403)
    expect((await request(`/${newId()}`, { method: 'DELETE' })).status).toBe(404)
    expect((await request('/not-an-id', { method: 'DELETE' })).status).toBe(400)
  })
})
