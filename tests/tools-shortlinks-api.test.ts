// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TOOLS_SHORTLINKS_REQUIRED_INDEXES,
  TOOLS_SHORTLINKS_REQUIRED_TABLES,
  TOOLS_SHORTLINKS_SCHEMA_STATEMENTS,
} from '../src/worker/tools/shortlinks/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsShortlinksRoutes } from '../src/worker/routes/tools-shortlinks'
import { toolsShortlinksRedirectRoutes } from '../src/worker/routes/tools-shortlinks-redirect'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER_A = 'user-alice'
const USER_B = 'user-bob'

interface CallOptions {
  user?: string | null
  body?: unknown
}

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))

  // Simulate authentication for /api/*
  app.use('/api/tools/shortlinks/*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: userId,
        login: userId,
        name: userId,
        avatarUrl: '',
        role: 'member',
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })

  app.route('/api/tools/shortlinks', toolsShortlinksRoutes)
  app.route('/', toolsShortlinksRedirectRoutes)
  return app
}

const app = testApp()

let sqlite: DatabaseSync
let env: Env

async function call(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const userId = options.user === undefined ? USER_A : options.user
  const headers: Record<string, string> = {}
  if (userId) {
    headers['x-test-user'] = userId
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-Inkstone-Client'] = '1'
  }
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(
    new Request(`http://localhost${path}`, { method, headers, body }),
    env,
  )
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_SHORTLINKS_SCHEMA_STATEMENTS) {
    sqlite.exec(statement)
  }
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
})

afterEach(() => {
  sqlite.close()
})

describe('Shortlinks D1 Schema & Tenant Isolation', () => {
  it('creates all 8 required tables and 15 indexes', () => {
    const tableRows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
    const tables = new Set(tableRows.map((r) => r.name))
    for (const table of TOOLS_SHORTLINKS_REQUIRED_TABLES) {
      expect(tables.has(table), `Table ${table} should exist`).toBe(true)
    }

    const indexRows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>
    const indexes = new Set(indexRows.map((r) => r.name))
    for (const index of TOOLS_SHORTLINKS_REQUIRED_INDEXES) {
      expect(indexes.has(index), `Index ${index} should exist`).toBe(true)
    }
  })

  it('enforces authentication on management endpoints', async () => {
    const res = await call('GET', '/api/tools/shortlinks/links', { user: null })
    expect(res.status).toBe(401)
  })

  it('strictly isolates tenant data between users', async () => {
    // User A creates a link
    const resA = await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://example.com/alice', label: 'Alice Link' },
    })
    expect(resA.status).toBe(200)
    const linkA = (await json<any>(resA)).data

    // User B lists links and should see 0
    const resB = await call('GET', '/api/tools/shortlinks/links', { user: USER_B })
    const dataB = (await json<any>(resB)).data
    expect(dataB.total).toBe(0)
    expect(dataB.items).toHaveLength(0)

    // User B cannot access or modify Alice's link
    const getRes = await call('GET', `/api/tools/shortlinks/links/${linkA.id}`, { user: USER_B })
    expect(getRes.status).toBe(404)

    const updateRes = await call('PUT', `/api/tools/shortlinks/links/${linkA.id}`, {
      user: USER_B,
      body: { label: 'Hacked' },
    })
    expect(updateRes.status).toBe(404)
  })
})

describe('Shortlinks Link Lifecycle & Slugs', () => {
  it('creates links with custom slug and duplicate prevention', async () => {
    const res1 = await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://github.com/test', custom_slug: 'gh-test' },
    })
    expect(res1.status).toBe(200)
    const data1 = (await json<any>(res1)).data
    expect(data1.slugs[0].slug).toBe('gh-test')

    // Duplicate creation without allow_duplicate throws 409
    const resDup = await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://github.com/test', custom_slug: 'gh-test-2' },
    })
    expect(resDup.status).toBe(409)

    // Duplicate creation with allow_duplicate succeeds
    const resAllowed = await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://github.com/test', custom_slug: 'gh-test-2', allow_duplicate: true },
    })
    expect(resAllowed.status).toBe(200)
  })

  it('manages secondary slugs and primary switching', async () => {
    const createRes = await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://news.ycombinator.com', custom_slug: 'hn-main' },
    })
    const link = (await json<any>(createRes)).data

    // Add alias slug
    const addSlugRes = await call('POST', `/api/tools/shortlinks/links/${link.id}/slugs`, {
      user: USER_A,
      body: { slug: 'hn-alias' },
    })
    expect(addSlugRes.status).toBe(200)

    // Set hn-alias as primary
    const setPrimaryRes = await call('PUT', `/api/tools/shortlinks/links/${link.id}/slugs/primary`, {
      user: USER_A,
      body: { slug: 'hn-alias' },
    })
    expect(setPrimaryRes.status).toBe(200)

    const updated = (await json<any>(await call('GET', `/api/tools/shortlinks/links/${link.id}`))).data
    const primary = updated.slugs.find((s: any) => s.is_primary)
    expect(primary.slug).toBe('hn-alias')

    // Delete alias slug
    const delRes = await call('DELETE', `/api/tools/shortlinks/links/${link.id}/slugs/hn-main`)
    expect(delRes.status).toBe(200)
  })

  it('handles disabling, enabling and expiration', async () => {
    const now = Math.floor(Date.now() / 1000)
    const createRes = await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://example.com/disable-test', custom_slug: 'disable-me' },
    })
    const link = (await json<any>(createRes)).data

    // Works initially
    const red1 = await call('GET', '/l/disable-me', { user: null })
    expect(red1.status).toBe(302)
    expect(red1.headers.get('Location')).toBe('https://example.com/disable-test')

    // Disable
    await call('POST', `/api/tools/shortlinks/links/${link.id}/disable`)
    const red2 = await call('GET', '/l/disable-me', { user: null })
    expect(red2.status).toBe(404)

    // Re-enable
    await call('POST', `/api/tools/shortlinks/links/${link.id}/enable`)
    const red3 = await call('GET', '/l/disable-me', { user: null })
    expect(red3.status).toBe(302)

    // Expire
    await call('PUT', `/api/tools/shortlinks/links/${link.id}`, {
      body: { expires_at: now - 100 },
    })
    const red4 = await call('GET', '/l/disable-me', { user: null })
    expect(red4.status).toBe(404)
  })

  it('protects link with password and serves gate page', async () => {
    await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: {
        url: 'https://secret.example.com',
        custom_slug: 'secret-link',
        password: 'vault-password-123',
      },
    })

    // Access without password returns 401 gate HTML
    const gateRes = await call('GET', '/l/secret-link', { user: null })
    expect(gateRes.status).toBe(401)
    const html = await gateRes.text()
    expect(html).toContain('受保护的短链接')

    // Access with wrong password in query or POST fails
    const wrongRes = await call('GET', '/l/secret-link?pwd=wrong', { user: null })
    expect(wrongRes.status).toBe(401)

    // Access with correct password redirects
    const okRes = await call('GET', '/l/secret-link?pwd=vault-password-123', { user: null })
    expect(okRes.status).toBe(302)
    expect(okRes.headers.get('Location')).toBe('https://secret.example.com')
  })
})

describe('Shortlinks Bundles and Analytics', () => {
  it('creates bundle, adds links and calculates aggregate metrics', async () => {
    // Create bundle
    const bRes = await call('POST', '/api/tools/shortlinks/bundles', {
      user: USER_A,
      body: { name: 'Work Bundle', accent: 'purple', description: 'Work links' },
    })
    expect(bRes.status).toBe(200)
    const bundle = (await json<any>(bRes)).data
    expect(bundle.accent).toBe('purple')

    // Create 2 links
    const l1 = (await json<any>(await call('POST', '/api/tools/shortlinks/links', { body: { url: 'https://w1.com', custom_slug: 'w1' } }))).data
    const l2 = (await json<any>(await call('POST', '/api/tools/shortlinks/links', { body: { url: 'https://w2.com', custom_slug: 'w2' } }))).data

    // Add links to bundle
    const addRes = await call('POST', `/api/tools/shortlinks/bundles/${bundle.id}/links`, {
      body: { link_ids: [l1.id, l2.id] },
    })
    expect(addRes.status).toBe(200)

    // Fetch bundle analytics
    const aRes = await call('GET', `/api/tools/shortlinks/bundles/${bundle.id}/analytics`)
    expect(aRes.status).toBe(200)
    const analytics = (await json<any>(aRes)).data
    expect(analytics.link_count).toBe(2)
  })

  it('handles dashboard overview and settings', async () => {
    const dashRes = await call('GET', '/api/tools/shortlinks/dashboard')
    expect(dashRes.status).toBe(200)
    const dash = (await json<any>(dashRes)).data
    expect(dash).toHaveProperty('total_links')
    expect(dash).toHaveProperty('timeline')

    // Settings update
    const setRes = await call('PUT', '/api/tools/shortlinks/settings', {
      body: { slug_default_length: 5, default_range: '7d' },
    })
    expect(setRes.status).toBe(200)
    const settings = (await json<any>(setRes)).data
    expect(settings.slug_default_length).toBe(5)
    expect(settings.default_range).toBe('7d')
  })

  it('creates API key and lists keys', async () => {
    const keyRes = await call('POST', '/api/tools/shortlinks/keys', {
      body: { title: 'CI Deployer', scope: 'read,write' },
    })
    expect(keyRes.status).toBe(200)
    const keyData = (await json<any>(keyRes)).data
    expect(keyData.apiKey).toMatch(/^sl_/)

    const listRes = await call('GET', '/api/tools/shortlinks/keys')
    const keys = (await json<any>(listRes)).data
    expect(keys).toHaveLength(1)
    expect(keys[0].title).toBe('CI Deployer')
  })

  it('exports and backups data', async () => {
    await call('POST', '/api/tools/shortlinks/links', { body: { url: 'https://export1.com', custom_slug: 'e1' } })

    const exportRes = await call('POST', '/api/tools/shortlinks/export', {
      body: { format: 'txt' },
    })
    expect(exportRes.status).toBe(200)
    const expData = (await json<any>(exportRes)).data
    expect(expData.key).toContain('tools/shortlinks/txt/')

    const backupRes = await call('POST', '/api/tools/shortlinks/backups')
    expect(backupRes.status).toBe(200)
    const bkpData = (await json<any>(backupRes)).data
    expect(bkpData.r2_key).toContain('tools/shortlinks/backup/')
  })
})
