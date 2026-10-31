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
import { sha256Hex } from '../src/worker/lib/encoding'
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
  form?: Record<string, string>
  headers?: Record<string, string>
}

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))

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
  const headers: Record<string, string> = { ...options.headers }
  if (userId) {
    headers['x-test-user'] = userId
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-Inkstone-Client'] = '1'
  }
  let body: string | undefined
  if (options.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(options.form).toString()
  } else if (options.body !== undefined) {
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
  it('creates every required table and index', () => {
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
    const resA = await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://example.com/alice', label: 'Alice Link' },
    })
    expect(resA.status).toBe(200)
    const linkA = (await json<any>(resA)).data

    const resB = await call('GET', '/api/tools/shortlinks/links', { user: USER_B })
    const dataB = (await json<any>(resB)).data
    expect(dataB.total).toBe(0)
    expect(dataB.items).toHaveLength(0)

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

    const resDup = await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://github.com/test', custom_slug: 'gh-test-2' },
    })
    expect(resDup.status).toBe(409)

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

    const addSlugRes = await call('POST', `/api/tools/shortlinks/links/${link.id}/slugs`, {
      user: USER_A,
      body: { slug: 'hn-alias' },
    })
    expect(addSlugRes.status).toBe(200)

    const setPrimaryRes = await call('PUT', `/api/tools/shortlinks/links/${link.id}/slugs/primary`, {
      user: USER_A,
      body: { slug: 'hn-alias' },
    })
    expect(setPrimaryRes.status).toBe(200)

    const updated = (await json<any>(await call('GET', `/api/tools/shortlinks/links/${link.id}`))).data
    const primary = updated.slugs.find((s: any) => s.is_primary)
    expect(primary.slug).toBe('hn-alias')

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

    const red1 = await call('GET', '/l/disable-me', { user: null })
    expect(red1.status).toBe(302)
    expect(red1.headers.get('Location')).toBe('https://example.com/disable-test')

    await call('POST', `/api/tools/shortlinks/links/${link.id}/disable`)
    const red2 = await call('GET', '/l/disable-me', { user: null })
    expect(red2.status).toBe(404)

    await call('POST', `/api/tools/shortlinks/links/${link.id}/enable`)
    const red3 = await call('GET', '/l/disable-me', { user: null })
    expect(red3.status).toBe(302)

    await call('PUT', `/api/tools/shortlinks/links/${link.id}`, {
      body: { expires_at: now - 100 },
    })
    const red4 = await call('GET', '/l/disable-me', { user: null })
    expect(red4.status).toBe(404)
  })

  it('protects link with password, signs the cookie and refuses a query-string secret', async () => {
    const created = await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: {
        url: 'https://secret.example.com',
        custom_slug: 'secret-link',
        password: 'vault-password-123',
      },
    })
    expect(created.status).toBe(200)

    const gateRes = await call('GET', '/l/secret-link', { user: null })
    expect(gateRes.status).toBe(401)
    expect(gateRes.headers.get('Cache-Control')).toBe('no-store')
    const html = await gateRes.text()
    expect(html).toContain('受保护的短链接')

    const viaQuery = await call('GET', '/l/secret-link?pwd=vault-password-123', { user: null })
    expect(viaQuery.status).toBe(401)

    const wrongRes = await call('POST', '/l/secret-link', { user: null, form: { password: 'wrong' } })
    expect(wrongRes.status).toBe(401)

    const okRes = await call('POST', '/l/secret-link', {
      user: null,
      form: { password: 'vault-password-123' },
    })
    expect(okRes.status).toBe(302)
    expect(okRes.headers.get('Location')).toBe('https://secret.example.com')
    expect(okRes.headers.get('Cache-Control')).toBe('no-store')

    const stored = sqlite
      .prepare(
        'SELECT password_hash FROM tools_shortlinks_links WHERE id = (SELECT link_id FROM tools_shortlinks_slugs WHERE slug = ?)',
      )
      .get('secret-link') as { password_hash: string }
    expect(stored.password_hash.startsWith('scrypt$')).toBe(true)

    const setCookie = okRes.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('sl_auth_secret-link=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).not.toContain('vault-password-123')
    expect(setCookie).not.toContain(stored.password_hash)

    const cookiePair = setCookie.split(';')[0]!
    const replay = await call('GET', '/l/secret-link', {
      user: null,
      headers: { cookie: cookiePair },
    })
    expect(replay.status).toBe(302)

    const forged = await call('GET', '/l/secret-link', {
      user: null,
      headers: { cookie: 'sl_auth_secret-link=9999999999.deadbeef' },
    })
    expect(forged.status).toBe(401)
  })

  it('upgrades a legacy unsalted digest on the first successful unlock', async () => {
    await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://legacy.example.com', custom_slug: 'legacy-link' },
    })
    const legacy = await sha256Hex('legacy-pass')
    sqlite
      .prepare(
        'UPDATE tools_shortlinks_links SET password_hash = ?, is_password_protected = 1 WHERE id = (SELECT link_id FROM tools_shortlinks_slugs WHERE slug = ?)',
      )
      .run(legacy, 'legacy-link')

    const okRes = await call('POST', '/l/legacy-link', { user: null, form: { password: 'legacy-pass' } })
    expect(okRes.status).toBe(302)

    const row = sqlite
      .prepare(
        'SELECT password_hash FROM tools_shortlinks_links WHERE id = (SELECT link_id FROM tools_shortlinks_slugs WHERE slug = ?)',
      )
      .get('legacy-link') as { password_hash: string }
    expect(row.password_hash.startsWith('scrypt$')).toBe(true)
  })

  it('throttles repeated password failures per visitor', async () => {
    await call('POST', '/api/tools/shortlinks/links', {
      user: USER_A,
      body: { url: 'https://secret.example.com/two', custom_slug: 'secret-two', password: 'correct-password' },
    })

    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await call('POST', '/l/secret-two', {
        user: null,
        form: { password: `wrong-${attempt}` },
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      })
      expect(res.status).toBe(401)
    }

    const blocked = await call('POST', '/l/secret-two', {
      user: null,
      form: { password: 'correct-password' },
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    })
    expect(blocked.status).toBe(429)

    const otherVisitor = await call('POST', '/l/secret-two', {
      user: null,
      form: { password: 'correct-password' },
      headers: { 'cf-connecting-ip': '198.51.100.9' },
    })
    expect(otherVisitor.status).toBe(302)
  })
})

describe('Shortlinks Bundles and Analytics', () => {
  it('creates bundle, adds links and calculates aggregate metrics', async () => {
    const bRes = await call('POST', '/api/tools/shortlinks/bundles', {
      user: USER_A,
      body: { name: 'Work Bundle', accent: 'purple', description: 'Work links' },
    })
    expect(bRes.status).toBe(200)
    const bundle = (await json<any>(bRes)).data
    expect(bundle.accent).toBe('purple')

    const l1 = (await json<any>(await call('POST', '/api/tools/shortlinks/links', { body: { url: 'https://w1.com', custom_slug: 'w1' } }))).data
    const l2 = (await json<any>(await call('POST', '/api/tools/shortlinks/links', { body: { url: 'https://w2.com', custom_slug: 'w2' } }))).data

    const addRes = await call('POST', `/api/tools/shortlinks/bundles/${bundle.id}/links`, {
      body: { link_ids: [l1.id, l2.id] },
    })
    expect(addRes.status).toBe(200)

    const aRes = await call('GET', `/api/tools/shortlinks/bundles/${bundle.id}/analytics`)
    expect(aRes.status).toBe(200)
    const analytics = (await json<any>(aRes)).data
    expect(analytics.link_count).toBe(2)

    // Verify bundle stats alias and PATCH update
    const statsRes = await call('GET', `/api/tools/shortlinks/bundles/${bundle.id}/stats`)
    expect(statsRes.status).toBe(200)
    const patchBundleRes = await call('PATCH', `/api/tools/shortlinks/bundles/${bundle.id}`, {
      body: { name: 'Campaign 2026 Renamed' },
    })
    expect(patchBundleRes.status).toBe(200)
  })

  it('handles dashboard overview and settings', async () => {
    const dashRes = await call('GET', '/api/tools/shortlinks/dashboard')
    expect(dashRes.status).toBe(200)
    const dash = (await json<any>(dashRes)).data
    expect(dash).toHaveProperty('total_links')
    expect(dash).toHaveProperty('timeline')

    const setRes = await call('PATCH', '/api/tools/shortlinks/settings', {
      body: { slug_default_length: 5, default_range: '7d' },
    })
    expect(setRes.status).toBe(200)
    const settings = (await json<any>(setRes)).data
    expect(settings.slug_default_length).toBe(5)
    expect(settings.default_range).toBe('7d')
  })

  it('creates API key and lists keys', async () => {
    const keyRes = await call('POST', '/api/tools/shortlinks/keys', {
      body: { title: 'CI Deployer', scope: 'write' },
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
    expect(expData.url).toContain('/api/tools/shortlinks/export/download')

    const dlRes = await call('GET', expData.url)
    expect(dlRes.status).toBe(200)

    const backupRes = await call('POST', '/api/tools/shortlinks/backups')
    expect(backupRes.status).toBe(200)
    const bkpData = (await json<any>(backupRes)).data
    expect(bkpData.r2_key).toContain('tools/shortlinks/backup/')
  })
})
