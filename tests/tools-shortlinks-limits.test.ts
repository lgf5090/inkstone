// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TOOLS_SHORTLINKS_SCHEMA_STATEMENTS } from '../src/worker/tools/shortlinks/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { toolsShortlinksRoutes } from '../src/worker/routes/tools-shortlinks'
import type { AppBindings, Env } from '../src/worker/env'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-heavy'

/**
 * The ceiling the audit hit in production: D1 rejects a statement with more bound parameters than
 * this. The shared double only enforces it when a suite opts in, so this file opts in on purpose —
 * an un-chunked `IN (?, ?, …)` fails here instead of passing on a permissive local SQLite.
 */
const D1_BOUND_PARAMETER_LIMIT = 100

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/tools/shortlinks/*', async (c, next) => {
    c.set('userId', USER)
    c.set('user', {
      id: USER,
      username: USER,
      login: USER,
      name: USER,
      avatarUrl: '',
      role: 'member',
      createdAt: 0,
      settingsRaw: '{}',
    })
    await next()
  })
  app.route('/api/tools/shortlinks', toolsShortlinksRoutes)
  return app
}

const app = testApp()

let sqlite: DatabaseSync
let env: Env

async function call(method: string, path: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (method !== 'GET' && method !== 'HEAD') headers['X-Inkstone-Client'] = '1'
  return app.fetch(new Request(`http://localhost${path}`, { method, headers }), env)
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Inserts `count` links, each with one primary slug, the way a bulk import leaves the account. */
function seedLinks(count: number, bundleId?: number): number[] {
  const insertLink = sqlite.prepare(
    'INSERT INTO tools_shortlinks_links (user_id, url, label, is_password_protected, created_at) VALUES (?, ?, ?, 0, ?)',
  )
  const insertSlug = sqlite.prepare(
    'INSERT INTO tools_shortlinks_slugs (slug, user_id, link_id, is_custom, is_primary, created_at) VALUES (?, ?, ?, 1, 1, ?)',
  )
  const insertBundleLink = sqlite.prepare(
    'INSERT INTO tools_shortlinks_bundle_links (user_id, bundle_id, link_id, added_at) VALUES (?, ?, ?, ?)',
  )
  const stamp = Math.floor(Date.now() / 1000)
  const ids: number[] = []
  for (let index = 0; index < count; index++) {
    const inserted = insertLink.run(USER, `https://limits.example.com/${index}`, `limit ${index}`, stamp)
    const linkId = Number(inserted.lastInsertRowid)
    ids.push(linkId)
    insertSlug.run(`limits-${index}`, USER, linkId, stamp)
    if (bundleId !== undefined) insertBundleLink.run(USER, bundleId, linkId, stamp)
  }
  return ids
}

function createBundle(name: string): number {
  const now = Math.floor(Date.now() / 1000)
  const inserted = sqlite
    .prepare(
      `INSERT INTO tools_shortlinks_bundles (user_id, name, accent, created_by, created_at, updated_at)
       VALUES (?, ?, 'orange', 'user', ?, ?)`,
    )
    .run(USER, name, now, now)
  return Number(inserted.lastInsertRowid)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_SHORTLINKS_SCHEMA_STATEMENTS) {
    sqlite.exec(statement)
  }
  env = testBindings(makeD1(sqlite, { maxBoundParameters: D1_BOUND_PARAMETER_LIMIT }), {
    FILES: testR2Bucket(),
  })
})

afterEach(() => {
  sqlite.close()
})

describe('READ-1 read paths past the D1 bound-parameter ceiling', () => {
  it('lists, exports and backs up 150 links without exceeding D1 parameter limits', async () => {
    seedLinks(150)

    const firstPage = await call('GET', '/api/tools/shortlinks/links?limit=100')
    expect(firstPage.status).toBe(200)
    const first = await json<{ data: { items: Array<{ id: number; slugs: Array<{ slug: string }> }>; total: number } }>(firstPage)
    expect(first.data.total).toBe(150)
    expect(first.data.items).toHaveLength(100)
    expect(first.data.items.every((link) => link.slugs.length === 1)).toBe(true)

    const secondPage = await call('GET', '/api/tools/shortlinks/links?limit=100&offset=100')
    expect(secondPage.status).toBe(200)
    const second = await json<{ data: { items: Array<{ id: number }>; total: number } }>(secondPage)
    expect(second.data.total).toBe(150)
    expect(second.data.items).toHaveLength(50)

    const txtRes = await call('GET', '/api/tools/shortlinks/export/txt')
    expect(txtRes.status).toBe(200)
    const txtExport = (await json<{ data: { url: string } }>(txtRes)).data
    const txtDownload = await call('GET', txtExport.url)
    expect(txtDownload.status).toBe(200)
    const txtLines = (await txtDownload.text()).split('\n').filter(Boolean)
    expect(txtLines).toHaveLength(150)
    expect(txtLines).toContain('[limits-149] -> https://limits.example.com/149 (limit 149)')

    const csvRes = await call('GET', '/api/tools/shortlinks/export/csv')
    expect(csvRes.status).toBe(200)
    const csvExport = (await json<{ data: { url: string } }>(csvRes)).data
    const csvDownload = await call('GET', csvExport.url)
    expect(csvDownload.status).toBe(200)
    const csvText = await csvDownload.text()
    const csvLines = csvText.split('\n').filter(Boolean)
    expect(csvLines).toHaveLength(151)
    expect(csvText).toContain('limits-149')

    const backupRes = await call('POST', '/api/tools/shortlinks/backups')
    expect(backupRes.status).toBe(200)
    const backup = (await json<{ data: { link_count: number; r2_key: string } }>(backupRes)).data
    expect(backup.link_count).toBe(150)
    expect(backup.r2_key).toContain('tools/shortlinks/backup/')
  })

  it('serves a 120-link bundle with full links and cross-chunk click counts', async () => {
    const bundleId = createBundle('Heavy bundle')
    const ids = seedLinks(120, bundleId)
    const stamp = Math.floor(Date.now() / 1000)
    const insertClick = sqlite.prepare(
      `INSERT INTO tools_shortlinks_clicks (user_id, link_id, slug, clicked_at, link_mode)
       VALUES (?, ?, ?, ?, 'link')`,
    )
    // One click in the first slice and one in the last, so the per-link merge has to span chunks.
    insertClick.run(USER, ids[0], 'limits-0', stamp)
    insertClick.run(USER, ids[119], 'limits-119', stamp)

    const linksRes = await call('GET', `/api/tools/shortlinks/bundles/${bundleId}/links`)
    expect(linksRes.status).toBe(200)
    const links = (await json<{ data: Array<{ id: number; slugs: Array<{ slug: string }> }> }>(linksRes)).data
    expect(links).toHaveLength(120)
    expect(links.every((link) => link.slugs.length === 1)).toBe(true)

    const statsRes = await call('GET', `/api/tools/shortlinks/bundles/${bundleId}/stats`)
    expect(statsRes.status).toBe(200)
    const stats = (
      await json<{
        data: { link_count: number; total_clicks: number; clicked_links: number; per_link: Array<{ link_id: number; click_count: number }> }
      }>(statsRes)
    ).data
    expect(stats.link_count).toBe(120)
    expect(stats.total_clicks).toBe(2)
    expect(stats.clicked_links).toBe(2)
    expect(stats.per_link.find((link) => link.link_id === ids[0])?.click_count).toBe(1)
    expect(stats.per_link.find((link) => link.link_id === ids[119])?.click_count).toBe(1)
  })

  describe.each([0, 1, 99, 100, 120])('with %i links', (count) => {
    it('keeps list, export and backup whole at the boundary', async () => {
      seedLinks(count)

      const listRes = await call('GET', '/api/tools/shortlinks/links?limit=100')
      expect(listRes.status).toBe(200)
      const list = await json<{ data: { items: Array<unknown>; total: number } }>(listRes)
      expect(list.data.total).toBe(count)
      expect(list.data.items).toHaveLength(Math.min(count, 100))

      const txtRes = await call('GET', '/api/tools/shortlinks/export/txt')
      expect(txtRes.status).toBe(200)
      const txtDownload = await call('GET', (await json<{ data: { url: string } }>(txtRes)).data.url)
      expect(txtDownload.status).toBe(200)
      expect((await txtDownload.text()).split('\n').filter(Boolean)).toHaveLength(count)

      const backupRes = await call('POST', '/api/tools/shortlinks/backups')
      expect(backupRes.status).toBe(200)
      expect((await json<{ data: { link_count: number } }>(backupRes)).data.link_count).toBe(count)
    })
  })
})
