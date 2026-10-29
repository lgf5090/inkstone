// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/worker/lib/host-guard', () => ({ resolvePublicHost: vi.fn(async () => 'ok') }))
import { NAV_SCHEMA_STATEMENTS } from '../src/worker/nav/schema'
import { navBackupRoutes } from '../src/worker/nav/backup'
import { runScheduledNavBackups } from '../src/worker/nav/backup-scheduler'
import { navDataRoutes, navSettingsRoutes } from '../src/worker/nav/routes'
import { errorResponse } from '../src/worker/lib/errors'
import { sha256Hex } from '../src/worker/lib/encoding'
import { newNavId, type NavBackup, type NavBackupConfig, type NavBootstrap, type NavCategory, type NavLink, type NavSettings } from '../src/shared/nav/model'
import type { AppBindings, Env } from '../src/worker/env'
import { testBindings, testDurableObjectNamespace } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER_A = 'user-alice'
const USER_B = 'user-bob'

interface CallOptions {
  user?: string | null
  body?: unknown
  headers?: Record<string, string>
}

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))

  app.use('*', async (c, next) => {
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

  app.route('/api/nav/settings', navSettingsRoutes)
  app.route('/api/nav', navDataRoutes)
  app.route('/api/nav', navBackupRoutes)
  return app
}


function makeVault(): DurableObjectNamespace {
  const entries = new Map<string, { scope: string; value: unknown }>()
  let sequence = 0
  return testDurableObjectNamespace(async (request) => {
    const url = new URL(request.url)
    const body = await request.json() as { scope?: string; value?: unknown; ciphertext?: string }
    if (url.pathname === '/encrypt') {
      const ciphertext = `vault-${++sequence}`
      entries.set(ciphertext, { scope: body.scope ?? '', value: body.value })
      return Response.json({ ciphertext })
    }
    if (url.pathname === '/decrypt') {
      const entry = entries.get(body.ciphertext ?? '')
      if (!entry || entry.scope !== body.scope) return Response.json({}, { status: 422 })
      return Response.json({ value: entry.value })
    }
    return new Response('not found', { status: 404 })
  })
}

const app = testApp()

let sqlite: DatabaseSync
let env: Env

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const userId = options.user === undefined ? USER_A : options.user
  const headers: Record<string, string> = { ...options.headers }
  if (userId) headers['x-test-user'] = userId
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(new Request(`http://localhost${path}`, { method, headers, body }), env)
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function errorCode(response: Response): Promise<string> {
  const body = await json<{ error: { code: string; message: string } }>(response)
  return body.error.code
}

async function createCategory(
  user: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<NavCategory> {
  const response = await call('POST', '/api/nav/categories', {
    user,
    body: { name, icon: 'folder', ...extra },
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return (await json<{ category: NavCategory }>(response)).category
}

async function createLink(
  user: string,
  categoryId: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<NavLink> {
  const response = await call('POST', '/api/nav/links', {
    user,
    body: { title, url: `https://${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example.com/`, categoryId, ...extra },
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return (await json<{ link: NavLink }>(response)).link
}

function count(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

function categoryRow(id: string): Record<string, unknown> | undefined {
  return sqlite.prepare('SELECT * FROM nav_categories WHERE id = ?').get(id) as Record<string, unknown> | undefined
}

function linkRow(id: string): Record<string, unknown> | undefined {
  return sqlite.prepare('SELECT * FROM nav_links WHERE id = ?').get(id) as Record<string, unknown> | undefined
}

async function insertExpiredUnlock(user: string, categoryId: string, token: string): Promise<void> {
  const hash = await sha256Hex(token)
  const existing = sqlite.prepare('SELECT 1 FROM nav_category_unlocks WHERE user_id = ? AND category_id = ?')
    .get(user, categoryId)
  if (existing) {
    sqlite.prepare('UPDATE nav_category_unlocks SET token_hash = ?, expires_at = ?, created_at = ? WHERE user_id = ? AND category_id = ?')
      .run(hash, Date.now() - 1_000, Date.now(), user, categoryId)
  } else {
    sqlite.prepare(`INSERT INTO nav_category_unlocks (user_id, category_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(user, categoryId, hash, Date.now() - 1_000, Date.now())
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of NAV_SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  sqlite.exec('CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, last_fail_at INTEGER NOT NULL, locked_until INTEGER)')
  env = testBindings(makeD1(sqlite, { maxBoundParameters: 100 }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('authentication and tenant isolation', () => {
  it('rejects anonymous reads and writes on every nav router', async () => {
    expect((await call('GET', '/api/nav', { user: null })).status).toBe(401)
    expect((await call('GET', '/api/nav/settings', { user: null })).status).toBe(401)
    expect((await call('POST', '/api/nav/categories', { user: null, body: { name: 'X', icon: 'folder' } })).status).toBe(401)
    expect((await call('POST', '/api/nav/links', { user: null, body: {} })).status).toBe(401)
    expect((await call('POST', '/api/nav/import', { user: null, body: { categories: [], links: [] } })).status).toBe(401)
    expect((await call('PUT', '/api/nav/settings/display', { user: null, body: {} })).status).toBe(401)
  })

  it('keeps categories, links, visits, counts and settings per user', async () => {
    const category = await createCategory(USER_A, 'Alice Tools', { icon: 'wrench' })
    const link = await createLink(USER_A, category.id, 'Alice Link')
    const visit = await call('POST', '/api/nav/visits', { body: { visits: [{ linkId: link.id, count: 2 }] } })
    expect(visit.status).toBe(200)
    await call('PUT', '/api/nav/settings/display', { body: { navTitle: 'Alice Nav' } })

    const a = await json<NavBootstrap>(await call('GET', '/api/nav'))
    expect(a.categories).toHaveLength(1)
    expect(a.links).toHaveLength(1)
    expect(a.counts).toEqual({ total: 1, byCategory: { [category.id]: 1 } })
    expect(a.visits[link.id]).toMatchObject({ visitCount: 2 })
    expect(a.settings.display.navTitle).toBe('Alice Nav')

    const bResponse = await call('GET', '/api/nav', { user: USER_B })
    expect(bResponse.status).toBe(200)
    const b = await json<NavBootstrap>(bResponse)
    expect(b.categories).toEqual([])
    expect(b.links).toEqual([])
    expect(b.visits).toEqual({})
    expect(b.counts).toEqual({ total: 0, byCategory: {} })
    expect(b.settings.display.navTitle).toBe('')
    expect((await json<{ display: NavSettings['display'] }>(await call('GET', '/api/nav/settings', { user: USER_B }))).display.navTitle).toBe('')
  })

  it('answers cross-user reads and writes as not found and refuses their categories', async () => {
    const category = await createCategory(USER_A, 'Private')
    const link = await createLink(USER_A, category.id, 'Private Link')
    const missing = newNavId()

    expect((await call('PATCH', `/api/nav/categories/${category.id}`, { user: USER_B, body: { name: 'Stolen' } })).status).toBe(404)
    expect((await call('DELETE', `/api/nav/categories/${category.id}`, { user: USER_B, body: { fallbackCategoryId: missing } })).status).toBe(404)
    expect((await call('PATCH', `/api/nav/links/${link.id}`, { user: USER_B, body: { title: 'Stolen' } })).status).toBe(404)
    expect((await call('DELETE', `/api/nav/links/${link.id}`, { user: USER_B })).status).toBe(404)

    const wrongCategory = await call('POST', '/api/nav/links', {
      user: USER_B,
      body: { title: 'Cross tenant', url: 'https://cross.example.com/', categoryId: category.id },
    })
    expect(wrongCategory.status).toBe(400)
    expect(count('nav_links')).toBe(1)
    expect((categoryRow(category.id)!.name as string)).toBe('Private')

    const order = await call('POST', '/api/nav/categories/order', {
      user: USER_B,
      body: { orderedIds: [category.id] },
    })
    expect(order.status).toBe(400)

    const visits = await call('POST', '/api/nav/visits', {
      user: USER_B,
      body: { visits: [{ linkId: link.id, count: 5 }] },
    })
    expect(visits.status).toBe(200)
    expect(count('nav_link_visits')).toBe(0)
  })
})

describe('category CRUD and ordering', () => {
  it('creates roots and children, normalizes fields and rejects invalid input', async () => {
    const rootId = newNavId()
    const created = await call('POST', '/api/nav/categories', {
      body: { id: rootId, name: '  My   Tools  ', icon: 'Lucide:FolderOpen' },
    })
    expect(created.status).toBe(200)
    const root = (await json<{ category: NavCategory }>(created)).category
    expect(root).toMatchObject({
      id: rootId,
      name: 'My Tools',
      icon: 'folder-open',
      parentId: null,
      hasPassword: false,
      passwordMode: 'none',
      sortOrder: 0,
    })
    expect(root.createdAt).toBeGreaterThan(0)
    expect(JSON.stringify(root)).not.toContain('password_hash')
    expect(JSON.stringify(root)).not.toContain('passwordHash')

    const second = await createCategory(USER_A, 'Second')
    expect(second.sortOrder).toBe(1)

    const child = await createCategory(USER_A, 'Child', { parentId: root.id })
    expect(child.parentId).toBe(root.id)
    expect(child.sortOrder).toBe(0)

    expect((await call('POST', '/api/nav/categories', {
      body: { name: 'Grandchild', icon: 'folder', parentId: child.id },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/categories', {
      body: { id: root.id, name: 'Duplicate', icon: 'folder' },
    })).status).toBe(409)
    expect((await call('POST', '/api/nav/categories', { body: { name: '   ', icon: 'folder' } })).status).toBe(400)
    expect((await call('POST', '/api/nav/categories', { body: { name: 'x'.repeat(61), icon: 'folder' } })).status).toBe(400)
    expect((await call('POST', '/api/nav/categories', { body: { name: 'Long icon', icon: 'x'.repeat(81) } })).status).toBe(400)
    expect((await call('POST', '/api/nav/categories', {
      body: { name: 'Missing parent', icon: 'folder', parentId: newNavId() },
    })).status).toBe(400)
  })

  it('patches names, icons and password mode without exposing a hash', async () => {
    const category = await createCategory(USER_A, 'Original')
    const patched = await call('PATCH', `/api/nav/categories/${category.id}`, {
      body: { name: '  Renamed   Name  ', icon: 'Star' },
    })
    expect(patched.status).toBe(200)
    const renamed = (await json<{ category: NavCategory }>(patched)).category
    expect(renamed.name).toBe('Renamed Name')
    expect(renamed.icon).toBe('star')

    const locked = await call('PATCH', `/api/nav/categories/${category.id}`, {
      body: { passwordMode: 'custom', password: 'a-long-password' },
    })
    expect(locked.status).toBe(200)
    const lockedCategory = (await json<{ category: NavCategory }>(locked)).category
    expect(lockedCategory.hasPassword).toBe(true)
    expect(lockedCategory.passwordMode).toBe('custom')
    const row = categoryRow(category.id)!
    expect(row.password_hash).not.toBe('a-long-password')
    expect(String(row.password_hash).startsWith('scrypt$')).toBe(true)
    expect(JSON.stringify(lockedCategory)).not.toContain('scrypt$')

    expect((await call('PATCH', `/api/nav/categories/${category.id}`, {
      body: { passwordMode: 'custom', password: 'short' },
    })).status).toBe(400)
    expect((await call('PATCH', `/api/nav/categories/${category.id}`, {
      body: { name: '' },
    })).status).toBe(400)
    expect((await call('PATCH', `/api/nav/categories/${category.id}`, {
      user: USER_B,
      body: { name: 'Nope' },
    })).status).toBe(404)

    const cleared = await call('PATCH', `/api/nav/categories/${category.id}`, { body: { passwordMode: 'none' } })
    expect(cleared.status).toBe(200)
    const clearedCategory = (await json<{ category: NavCategory }>(cleared)).category
    expect(clearedCategory.hasPassword).toBe(false)
    expect(clearedCategory.passwordMode).toBe('none')
    expect(categoryRow(category.id)!.password_hash).toBeNull()
    expect(categoryRow(category.id)!.use_default_password).toBe(0)
  })

  it('deletes a category tree by moving every link to the fallback first', async () => {
    const root = await createCategory(USER_A, 'Root')
    const child = await createCategory(USER_A, 'Child', { parentId: root.id })
    const fallback = await createCategory(USER_A, 'Fallback')
    const rootLink = await createLink(USER_A, root.id, 'Root Link')
    const childLink = await createLink(USER_A, child.id, 'Child Link')
    sqlite.prepare(`INSERT INTO nav_category_unlocks (user_id, category_id, token_hash, expires_at, created_at)
      VALUES (?, ?, 'hash-root', ?, ?)`).run(USER_A, root.id, Date.now() + 60_000, Date.now())
    sqlite.prepare(`INSERT INTO nav_category_unlocks (user_id, category_id, token_hash, expires_at, created_at)
      VALUES (?, ?, 'hash-child', ?, ?)`).run(USER_A, child.id, Date.now() + 60_000, Date.now())

    const deleted = await call('DELETE', `/api/nav/categories/${root.id}`, {
      body: { fallbackCategoryId: fallback.id },
    })
    expect(deleted.status).toBe(200)
    expect(await json(deleted)).toEqual({ ok: true })

    expect(count('nav_categories')).toBe(1)
    expect(categoryRow(root.id)).toBeUndefined()
    expect(categoryRow(child.id)).toBeUndefined()
    expect(linkRow(rootLink.id)!.category_id).toBe(fallback.id)
    expect(linkRow(childLink.id)!.category_id).toBe(fallback.id)
    expect(count('nav_category_unlocks')).toBe(0)

    expect((await call('DELETE', `/api/nav/categories/${root.id}`, {
      body: { fallbackCategoryId: fallback.id },
    })).status).toBe(404)
  })

  it('refuses a fallback that is the deleted category, its child or another user\'s', async () => {
    const root = await createCategory(USER_A, 'Root')
    const child = await createCategory(USER_A, 'Child', { parentId: root.id })
    const other = await createCategory(USER_B, 'Other')

    expect((await call('DELETE', `/api/nav/categories/${root.id}`, {
      body: { fallbackCategoryId: root.id },
    })).status).toBe(400)
    expect((await call('DELETE', `/api/nav/categories/${root.id}`, {
      body: { fallbackCategoryId: child.id },
    })).status).toBe(400)
    expect((await call('DELETE', `/api/nav/categories/${root.id}`, {
      body: { fallbackCategoryId: other.id },
    })).status).toBe(400)
    expect((await call('DELETE', `/api/nav/categories/${newNavId()}`, {
      body: { fallbackCategoryId: root.id },
    })).status).toBe(404)
    expect(count('nav_categories')).toBe(3)
  })

  it('reorders a group only when the order covers every id exactly once', async () => {
    const first = await createCategory(USER_A, 'First')
    const second = await createCategory(USER_A, 'Second')
    const third = await createCategory(USER_A, 'Third')
    const childA = await createCategory(USER_A, 'Child A', { parentId: first.id })
    const childB = await createCategory(USER_A, 'Child B', { parentId: first.id })

    const reorder = await call('POST', '/api/nav/categories/order', {
      body: { orderedIds: [third.id, first.id, second.id] },
    })
    expect(reorder.status).toBe(200)
    const roots = (await json<NavBootstrap>(await call('GET', '/api/nav'))).categories.filter((entry) => !entry.parentId)
    expect(roots.map((entry) => entry.id)).toEqual([third.id, first.id, second.id])
    expect(roots.map((entry) => entry.sortOrder)).toEqual([0, 1, 2])

    const childOrder = await call('POST', '/api/nav/categories/order', {
      body: { parentId: first.id, orderedIds: [childB.id, childA.id] },
    })
    expect(childOrder.status).toBe(200)
    const children = (await json<NavBootstrap>(await call('GET', '/api/nav'))).categories.filter((entry) => entry.parentId === first.id)
    expect(children.map((entry) => entry.id)).toEqual([childB.id, childA.id])

    expect((await call('POST', '/api/nav/categories/order', {
      body: { orderedIds: [third.id, first.id] },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/categories/order', {
      body: { orderedIds: [third.id, third.id, first.id, second.id] },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/categories/order', {
      user: USER_B,
      body: { orderedIds: [third.id, first.id, second.id] },
    })).status).toBe(400)
    expect((await json<NavBootstrap>(await call('GET', '/api/nav'))).categories
      .filter((entry) => !entry.parentId).map((entry) => entry.id)).toEqual([third.id, first.id, second.id])
  })
})

describe('category passwords and unlock tokens', () => {
  it('hashes custom passwords, filters locked links and unlocks with a server token', async () => {
    const locked = await createCategory(USER_A, 'Locked', {
      passwordMode: 'custom',
      password: 'correct-horse',
    })
    expect(locked.hasPassword).toBe(true)
    expect(locked.passwordMode).toBe('custom')
    const visible = await createCategory(USER_A, 'Visible')
    const secretLink = await createLink(USER_A, locked.id, 'Secret Link')
    const openLink = await createLink(USER_A, visible.id, 'Open Link')

    const before = await json<NavBootstrap>(await call('GET', '/api/nav'))
    expect(before.links.map((link) => link.id)).toEqual([openLink.id])
    expect(before.counts.total).toBe(2)
    expect(before.counts.byCategory[locked.id]).toBe(1)
    expect(before.counts.byCategory[visible.id]).toBe(1)
    expect(before.categories.find((entry) => entry.id === locked.id)!.hasPassword).toBe(true)

    const wrong = await call('POST', `/api/nav/categories/${locked.id}/unlock`, { body: { password: 'wrong-password' } })
    expect(wrong.status).toBe(401)
    expect(await errorCode(wrong)).toBe('wrong_password')

    const unlock = await call('POST', `/api/nav/categories/${locked.id}/unlock`, { body: { password: 'correct-horse' } })
    expect(unlock.status).toBe(200)
    const unlockBody = await json<{ token: string; expiresAt: number }>(unlock)
    expect(unlockBody.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(unlockBody.expiresAt).toBeGreaterThan(Date.now() + 11 * 60 * 60 * 1000)
    const stored = sqlite.prepare('SELECT token_hash FROM nav_category_unlocks WHERE user_id = ? AND category_id = ?')
      .get(USER_A, locked.id) as { token_hash: string }
    expect(stored.token_hash).not.toBe(unlockBody.token)
    expect(stored.token_hash).toBe(await sha256Hex(unlockBody.token))

    const unlocked = await json<NavBootstrap>(await call('GET', '/api/nav', {
      headers: { 'X-Nav-Unlocks': unlockBody.token },
    }))
    expect(unlocked.links.map((link) => link.id).sort()).toEqual([openLink.id, secretLink.id].sort())
    expect(unlocked.visits).toBeDefined()

    const malformed = await json<NavBootstrap>(await call('GET', '/api/nav', {
      headers: { 'X-Nav-Unlocks': 'not-a-token' },
    }))
    expect(malformed.links.map((link) => link.id)).toEqual([openLink.id])

    const otherUser = await json<NavBootstrap>(await call('GET', '/api/nav', {
      user: USER_B,
      headers: { 'X-Nav-Unlocks': unlockBody.token },
    }))
    expect(otherUser.links).toEqual([])
  })

  it('locks repeated wrong password attempts in the database', async () => {
    const locked = await createCategory(USER_A, 'Locked attempts', {
      passwordMode: 'custom',
      password: 'attempt-password',
    })
    const statuses: number[] = []
    for (let index = 0; index < 7; index += 1) {
      statuses.push((await call('POST', `/api/nav/categories/${locked.id}/unlock`, { body: { password: 'wrong-password' } })).status)
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(statuses[5]).toBe(429)
  })

  it('needs the unlock token when reordering pinned links from an unlocked category', async () => {
    const locked = await createCategory(USER_A, 'Locked Pins', {
      passwordMode: 'custom',
      password: 'pin-password',
    })
    const open = await createCategory(USER_A, 'Open Pins')
    const secret = await createLink(USER_A, locked.id, 'Secret Pin', { pinned: true })
    const openLink = await createLink(USER_A, open.id, 'Open Pin', { pinned: true })
    const unlock = await json<{ token: string }>(await call('POST', `/api/nav/categories/${locked.id}/unlock`, {
      body: { password: 'pin-password' },
    }))
    const visible = await json<NavBootstrap>(await call('GET', '/api/nav', {
      headers: { 'X-Nav-Unlocks': unlock.token },
    }))
    expect(visible.links.filter((link) => link.pinned).map((link) => link.id).sort())
      .toEqual([secret.id, openLink.id].sort())

    const withoutToken = await call('POST', '/api/nav/links/order', {
      body: { scope: 'pinned', orderedIds: [secret.id, openLink.id] },
    })
    expect(withoutToken.status).toBe(409)
    expect(await errorCode(withoutToken)).toBe('nav_order_mismatch')

    const withToken = await call('POST', '/api/nav/links/order', {
      headers: { 'X-Nav-Unlocks': unlock.token },
      body: { scope: 'pinned', orderedIds: [openLink.id, secret.id] },
    })
    expect(withToken.status).toBe(200)
    const after = await json<NavBootstrap>(await call('GET', '/api/nav', {
      headers: { 'X-Nav-Unlocks': unlock.token },
    }))
    expect(after.links.filter((link) => link.pinned).sort((left, right) => left.pinnedOrder - right.pinnedOrder).map((link) => link.id))
      .toEqual([openLink.id, secret.id])
  })

  it('hides a child category and its links when the parent is locked', async () => {
    const locked = await createCategory(USER_A, 'Locked Parent', {
      passwordMode: 'custom',
      password: 'parent-password',
    })
    const child = await createCategory(USER_A, 'Child', { parentId: locked.id })
    const open = await createCategory(USER_A, 'Open')
    const childLink = await createLink(USER_A, child.id, 'Child Link')
    const openLink = await createLink(USER_A, open.id, 'Open Link')

    const before = await json<NavBootstrap>(await call('GET', '/api/nav'))
    expect(before.links.map((link) => link.id)).toEqual([openLink.id])

    const unlock = await json<{ token: string }>(await call('POST', `/api/nav/categories/${locked.id}/unlock`, {
      body: { password: 'parent-password' },
    }))
    const after = await json<NavBootstrap>(await call('GET', '/api/nav', {
      headers: { 'X-Nav-Unlocks': unlock.token },
    }))
    expect(after.links.map((link) => link.id).sort()).toEqual([childLink.id, openLink.id].sort())
  })

  it('ignores an unlock row whose expiry lies in the past', async () => {
    const locked = await createCategory(USER_A, 'Expired Lock', {
      passwordMode: 'custom',
      password: 'correct-horse',
    })
    const secretLink = await createLink(USER_A, locked.id, 'Expired Secret')
    const token = 'e'.repeat(43)
    await insertExpiredUnlock(USER_A, locked.id, token)

    const response = await call('GET', '/api/nav', { headers: { 'X-Nav-Unlocks': token } })
    expect(response.status).toBe(200)
    const body = await json<NavBootstrap>(response)
    expect(body.links).toEqual([])
    expect(body.counts.total).toBe(1)
    expect(count('nav_link_visits')).toBe(0)
    expect(linkRow(secretLink.id)).toBeDefined()
  })

  it('removes unlock rows when a password changes and when a category is deleted', async () => {
    const locked = await createCategory(USER_A, 'Locked', {
      passwordMode: 'custom',
      password: 'first-password',
    })
    const unlock = await call('POST', `/api/nav/categories/${locked.id}/unlock`, { body: { password: 'first-password' } })
    expect(unlock.status).toBe(200)
    expect(count('nav_category_unlocks')).toBe(1)

    const changed = await call('PATCH', `/api/nav/categories/${locked.id}`, {
      body: { passwordMode: 'custom', password: 'second-password' },
    })
    expect(changed.status).toBe(200)
    expect(count('nav_category_unlocks')).toBe(0)
  })

  it('requires the server default password for default-mode categories', async () => {
    expect((await call('POST', '/api/nav/categories', {
      body: { name: 'Default Locked', icon: 'folder', passwordMode: 'default' },
    })).status).toBe(400)
    expect(await errorCode(await call('POST', '/api/nav/categories', {
      body: { name: 'Default Locked', icon: 'folder', passwordMode: 'default' },
    }))).toBe('nav_default_password_not_configured')
    expect(count('nav_categories')).toBe(0)

    env.NAV_DEFAULT_CATEGORY_PASSWORD = 'server-default-password'
    const created = await createCategory(USER_A, 'Default Locked', { passwordMode: 'default' })
    expect(created.passwordMode).toBe('default')
    expect(created.hasPassword).toBe(true)
    const row = categoryRow(created.id)!
    expect(row.password_hash).toBeNull()
    expect(row.use_default_password).toBe(1)

    expect((await call('POST', `/api/nav/categories/${created.id}/unlock`, { body: { password: 'nope' } })).status).toBe(401)
    expect((await call('POST', `/api/nav/categories/${created.id}/unlock`, { body: { password: 'server-default-password' } })).status).toBe(200)

    delete env.NAV_DEFAULT_CATEGORY_PASSWORD
    const unavailable = await call('POST', `/api/nav/categories/${created.id}/unlock`, { body: { password: 'server-default-password' } })
    expect(unavailable.status).toBe(503)
    expect(await errorCode(unavailable)).toBe('nav_default_password_not_configured')
  })
})

describe('link CRUD, pinning and ordering', () => {
  it('creates links with normalized fields and assigns category and pinned order', async () => {
    const firstCategory = await createCategory(USER_A, 'First')
    const secondCategory = await createCategory(USER_A, 'Second')
    const explicit = newNavId()

    const first = await call('POST', '/api/nav/links', {
      body: {
        id: explicit,
        title: '  Example  ',
        url: 'example.com',
        icon: ' https://cdn.example.com/i.png ',
        description: '  hi  ',
        categoryId: firstCategory.id,
      },
    })
    expect(first.status).toBe(200)
    const link = (await json<{ link: NavLink }>(first)).link
    expect(link).toMatchObject({
      id: explicit,
      title: 'Example',
      url: 'https://example.com/',
      icon: 'https://cdn.example.com/i.png',
      description: 'hi',
      categoryId: firstCategory.id,
      pinned: false,
      pinnedOrder: 0,
      sortOrder: 0,
    })
    expect(link.createdAt).toBeGreaterThan(0)

    const second = await createLink(USER_A, firstCategory.id, 'Second Link')
    expect(second.sortOrder).toBe(1)
    const other = await createLink(USER_A, secondCategory.id, 'Other Link')
    expect(other.sortOrder).toBe(0)
    const pinnedOne = await createLink(USER_A, firstCategory.id, 'Pinned One', { pinned: true })
    expect(pinnedOne.pinned).toBe(true)
    expect(pinnedOne.pinnedOrder).toBe(0)
    const pinnedTwo = await createLink(USER_A, firstCategory.id, 'Pinned Two', { pinned: true })
    expect(pinnedTwo.pinnedOrder).toBe(1)

    expect((await call('POST', '/api/nav/links', {
      body: { id: explicit, title: 'Duplicate', url: 'https://dup.example.com/', categoryId: firstCategory.id },
    })).status).toBe(409)
    expect((await call('POST', '/api/nav/links', {
      body: { title: 'Bad', url: 'javascript:alert(1)', categoryId: firstCategory.id },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/links', {
      body: { title: '', url: 'https://empty.example.com/', categoryId: firstCategory.id },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/links', {
      body: { title: 'x'.repeat(201), url: 'https://long.example.com/', categoryId: firstCategory.id },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/links', {
      body: { title: 'Long', url: 'https://long.example.com/', description: 'x'.repeat(501), categoryId: firstCategory.id },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/links', {
      body: { title: 'Icon', url: 'https://icon.example.com/', icon: 'javascript:alert(1)', categoryId: firstCategory.id },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/links', {
      body: { title: 'No category', url: 'https://none.example.com/', categoryId: newNavId() },
    })).status).toBe(400)
    const otherCategory = await createCategory(USER_B, 'Bob Category')
    expect((await call('POST', '/api/nav/links', {
      body: { title: 'Cross', url: 'https://cross.example.com/', categoryId: otherCategory.id },
    })).status).toBe(400)
  })

  it('patches fields, moves categories, pins and unpins, and deletes visits', async () => {
    const firstCategory = await createCategory(USER_A, 'First')
    const secondCategory = await createCategory(USER_A, 'Second')
    const link = await createLink(USER_A, firstCategory.id, 'Editable')
    const target = await createLink(USER_A, secondCategory.id, 'Target')
    const pinned = await createLink(USER_A, firstCategory.id, 'Pinned', { pinned: true })

    const patched = await call('PATCH', `/api/nav/links/${link.id}`, {
      body: { title: 'Renamed', url: 'https://renamed.example.com/x', icon: null, description: null },
    })
    expect(patched.status).toBe(200)
    const renamed = (await json<{ link: NavLink }>(patched)).link
    expect(renamed).toMatchObject({
      title: 'Renamed',
      url: 'https://renamed.example.com/x',
      icon: null,
      description: null,
      categoryId: firstCategory.id,
    })

    const moved = await call('PATCH', `/api/nav/links/${link.id}`, { body: { categoryId: secondCategory.id } })
    expect(moved.status).toBe(200)
    const movedLink = (await json<{ link: NavLink }>(moved)).link
    expect(movedLink.categoryId).toBe(secondCategory.id)
    expect(movedLink.sortOrder).toBe(target.sortOrder + 1)

    const pinnedResponse = await call('PATCH', `/api/nav/links/${link.id}`, { body: { pinned: true } })
    expect(pinnedResponse.status).toBe(200)
    const nowPinned = (await json<{ link: NavLink }>(pinnedResponse)).link
    expect(nowPinned.pinned).toBe(true)
    expect(nowPinned.pinnedOrder).toBe(pinned.pinnedOrder + 1)

    const unpinned = await call('PATCH', `/api/nav/links/${link.id}`, { body: { pinned: false } })
    expect(unpinned.status).toBe(200)
    expect((await json<{ link: NavLink }>(unpinned)).link).toMatchObject({ pinned: false, pinnedOrder: 0 })

    expect((await call('PATCH', `/api/nav/links/${link.id}`, {
      body: { url: 'javascript:alert(1)' },
    })).status).toBe(400)
    expect(linkRow(link.id)!.url).toBe('https://renamed.example.com/x')

    expect((await call('PATCH', `/api/nav/links/${link.id}`, {
      user: USER_B,
      body: { title: 'Stolen' },
    })).status).toBe(404)
    expect((await call('PATCH', `/api/nav/links/${newNavId()}`, {
      body: { title: 'Missing' },
    })).status).toBe(404)

    expect((await call('POST', '/api/nav/visits', {
      body: { visits: [{ linkId: link.id, count: 3 }] },
    })).status).toBe(200)
    expect(count('nav_link_visits')).toBe(1)
    expect((await call('DELETE', `/api/nav/links/${link.id}`)).status).toBe(200)
    expect(linkRow(link.id)).toBeUndefined()
    expect(count('nav_link_visits')).toBe(0)
    expect((await call('DELETE', `/api/nav/links/${link.id}`)).status).toBe(404)
    expect((await call('DELETE', `/api/nav/links/${target.id}`, { user: USER_B })).status).toBe(404)
  })

  it('orders pinned links globally and ordinary links per category', async () => {
    const category = await createCategory(USER_A, 'Ordered')
    const one = await createLink(USER_A, category.id, 'One')
    const two = await createLink(USER_A, category.id, 'Two')
    const pinned = await createLink(USER_A, category.id, 'Pinned', { pinned: true })

    const categoryOrder = await call('POST', '/api/nav/links/order', {
      body: { scope: 'category', categoryId: category.id, orderedIds: [two.id, one.id] },
    })
    expect(categoryOrder.status).toBe(200)
    expect(linkRow(two.id)!.sort_order).toBe(0)
    expect(linkRow(one.id)!.sort_order).toBe(1)
    expect(linkRow(pinned.id)!.sort_order).toBe(2)

    const pinnedOrder = await call('POST', '/api/nav/links/order', {
      body: { scope: 'pinned', orderedIds: [pinned.id] },
    })
    expect(pinnedOrder.status).toBe(200)
    const pinnedTwo = await createLink(USER_A, category.id, 'Pinned Two', { pinned: true })
    expect((await call('POST', '/api/nav/links/order', {
      body: { scope: 'pinned', orderedIds: [pinnedTwo.id, pinned.id] },
    })).status).toBe(200)
    expect(linkRow(pinnedTwo.id)!.pinned_order).toBe(0)
    expect(linkRow(pinned.id)!.pinned_order).toBe(1)

    expect((await call('POST', '/api/nav/links/order', {
      body: { scope: 'pinned', orderedIds: [pinnedTwo.id] },
    })).status).toBe(409)
    expect((await call('POST', '/api/nav/links/order', {
      body: { scope: 'category', orderedIds: [one.id, two.id] },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/links/order', {
      body: { scope: 'category', categoryId: category.id, orderedIds: [one.id] },
    })).status).toBe(409)
    const other = await createCategory(USER_B, 'Other')
    const foreign = await createLink(USER_B, other.id, 'Foreign')
    expect((await call('POST', '/api/nav/links/order', {
      body: { scope: 'category', categoryId: category.id, orderedIds: [one.id, two.id, foreign.id] },
    })).status).toBe(409)
  })
})

describe('visits', () => {
  it('increments owned links, keeps the latest timestamp and ignores unknown links', async () => {
    const category = await createCategory(USER_A, 'Visits')
    const first = await createLink(USER_A, category.id, 'First Visit')
    const second = await createLink(USER_A, category.id, 'Second Visit')
    const unknown = newNavId()
    const started = Date.now()

    const recorded = await call('POST', '/api/nav/visits', {
      body: { visits: [
        { linkId: first.id, count: 2 },
        { linkId: second.id, count: 1 },
        { linkId: unknown, count: 5 },
      ] },
    })
    expect(recorded.status).toBe(200)
    expect(await json(recorded)).toEqual({ ok: true })

    const after = await json<NavBootstrap>(await call('GET', '/api/nav'))
    expect(after.visits[first.id]!.visitCount).toBe(2)
    expect(after.visits[second.id]!.visitCount).toBe(1)
    expect(after.visits[unknown]).toBeUndefined()
    expect(after.visits[first.id]!.lastVisitedAt).toBeGreaterThanOrEqual(started)
    expect(count('nav_link_visits')).toBe(2)

    expect((await call('POST', '/api/nav/visits', {
      body: { visits: [{ linkId: first.id, count: 3 }] },
    })).status).toBe(200)
    const increment = await json<NavBootstrap>(await call('GET', '/api/nav'))
    expect(increment.visits[first.id]!.visitCount).toBe(5)
    expect(increment.visits[first.id]!.lastVisitedAt).toBeGreaterThanOrEqual(after.visits[first.id]!.lastVisitedAt)

    expect((await call('POST', '/api/nav/visits', {
      body: { visits: [{ linkId: first.id, count: 0 }] },
    })).status).toBe(400)
    const tooMany = Array.from({ length: 201 }, () => ({ linkId: first.id, count: 1 }))
    expect((await call('POST', '/api/nav/visits', { body: { visits: tooMany } })).status).toBe(400)

    expect((await call('POST', '/api/nav/visits', {
      body: { visits: [{ linkId: unknown, count: 1 }] },
    })).status).toBe(200)
    expect(count('nav_link_visits')).toBe(2)
  })
})

describe('bookmark import', () => {
  function importCategory(id: string, name: string, parentId: string | null = null) {
    return { id, name, icon: 'folder', parentId, sortOrder: 0, createdAt: 0 }
  }

  function importLink(id: string, url: string, categoryId: string, title = 'Imported') {
    return {
      id,
      title,
      url,
      icon: null,
      description: null,
      categoryId,
      pinned: false,
      pinnedOrder: 0,
      sortOrder: 0,
      createdAt: 0,
    }
  }

  it('skips existing URLs by default and upserts by id when skipping is disabled', async () => {
    const categoryId = newNavId()
    const linkId = newNavId()
    const payload = {
      categories: [importCategory(categoryId, 'Imported Folder')],
      links: [importLink(linkId, 'https://import.example.com/a', categoryId)],
      skipExisting: true,
    }
    const first = await call('POST', '/api/nav/import', { body: payload })
    expect(first.status).toBe(200)
    expect(await json(first)).toEqual({ imported: 1, skipped: 0 })
    expect(count('nav_categories')).toBe(1)
    expect(count('nav_links')).toBe(1)

    const second = await call('POST', '/api/nav/import', {
      body: {
        categories: [importCategory(categoryId, 'Imported Folder Renamed')],
        links: [importLink(linkId, 'https://import.example.com/a', categoryId, 'Retitled')],
      },
    })
    expect(second.status).toBe(200)
    expect(await json(second)).toEqual({ imported: 0, skipped: 1 })
    expect(count('nav_links')).toBe(1)
    expect(categoryRow(categoryId)!.name).toBe('Imported Folder Renamed')

    const third = await call('POST', '/api/nav/import', {
      body: {
        categories: [importCategory(categoryId, 'Imported Folder Renamed')],
        links: [importLink(linkId, 'https://import.example.com/changed', categoryId, 'Changed')],
        skipExisting: false,
      },
    })
    expect(third.status).toBe(200)
    expect(await json(third)).toEqual({ imported: 1, skipped: 0 })
    expect(count('nav_links')).toBe(1)
    expect(linkRow(linkId)!.url).toBe('https://import.example.com/changed')
    expect(linkRow(linkId)!.title).toBe('Changed')
  })

  it('deduplicates repeated URLs inside one request', async () => {
    const categoryId = newNavId()
    const response = await call('POST', '/api/nav/import', {
      body: {
        categories: [importCategory(categoryId, 'Folder')],
        links: [
          importLink(newNavId(), 'https://same.example.com/', categoryId, 'One'),
          importLink(newNavId(), 'https://same.example.com/', categoryId, 'Two'),
        ],
        skipExisting: true,
      },
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ imported: 1, skipped: 1 })
    expect(count('nav_links')).toBe(1)
  })

  it('keeps duplicate URLs when skipExisting is off', async () => {
    const categoryId = newNavId()
    const firstId = newNavId()
    const secondId = newNavId()
    const response = await call('POST', '/api/nav/import', {
      body: {
        categories: [importCategory(categoryId, 'Duplicates')],
        links: [
          importLink(firstId, 'https://same.example.com/', categoryId, 'One'),
          importLink(secondId, 'https://same.example.com/', categoryId, 'Two'),
        ],
        skipExisting: false,
      },
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ imported: 2, skipped: 0 })
    expect(count('nav_links')).toBe(2)
  })

  it('creates an uncategorized folder when imported links name a missing category', async () => {
    const response = await call('POST', '/api/nav/import', {
      user: USER_B,
      body: {
        categories: [],
        links: [importLink(newNavId(), 'https://orphan.example.com/', newNavId(), 'Orphan')],
      },
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ imported: 1, skipped: 0 })
    const body = await json<NavBootstrap>(await call('GET', '/api/nav', { user: USER_B }))
    expect(body.categories.map((entry) => entry.name)).toEqual(['Uncategorized'])
    expect(body.links[0]!.categoryId).toBe(body.categories[0]!.id)
  })

  it('validates every imported row and the per-request ceiling', async () => {
    const categoryId = newNavId()
    const category = importCategory(categoryId, 'Folder')
    expect((await call('POST', '/api/nav/import', {
      body: { categories: [category], links: [importLink(newNavId(), 'javascript:alert(1)', categoryId)] },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/import', {
      body: { categories: [{ ...category, name: '' }], links: [] },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/import', {
      body: { categories: [category], links: [], skipExisting: 'yes' },
    })).status).toBe(400)
    const tooMany = Array.from({ length: 201 }, (_, index) => importLink(newNavId(), `https://many.example.com/${index}`, categoryId))
    expect((await call('POST', '/api/nav/import', { body: { categories: [category], links: tooMany } })).status).toBe(400)
    expect(count('nav_links')).toBe(0)
  })

  it('keeps bulk import and large category deletion under the D1 bound-parameter ceiling', async () => {
    const fallback = await createCategory(USER_A, 'Fallback')
    const rootId = newNavId()
    const categories = [importCategory(rootId, 'Root')]
    const links = []
    for (let index = 0; index < 150; index += 1) {
      const childId = newNavId()
      categories.push(importCategory(childId, `Child ${index}`, rootId))
      links.push(importLink(newNavId(), `https://bulk.example.com/${index}`, childId))
    }
    const imported = await call('POST', '/api/nav/import', { body: { categories, links, skipExisting: true } })
    expect(imported.status).toBe(200)
    expect(await json(imported)).toEqual({ imported: 150, skipped: 0 })

    const removed = await call('DELETE', `/api/nav/categories/${rootId}`, { body: { fallbackCategoryId: fallback.id } })
    expect(removed.status).toBe(200)
    expect(count('nav_categories')).toBe(1)
    const body = await json<NavBootstrap>(await call('GET', '/api/nav'))
    expect(body.links).toHaveLength(150)
    expect(body.links.every((link) => link.categoryId === fallback.id)).toBe(true)
  })

  it('does not let one user overwrite another user\'s rows by reusing their ids', async () => {
    const category = await createCategory(USER_A, 'Alice Private')
    const link = await createLink(USER_A, category.id, 'Alice Link', { url: 'https://alice.example.com/original' })

    const hijack = await call('POST', '/api/nav/import', {
      user: USER_B,
      body: {
        categories: [{ id: category.id, name: 'Hijacked', icon: 'skull', parentId: null, sortOrder: 0, createdAt: 0 }],
        links: [importLink(link.id, 'https://evil.example.com/hijacked', category.id, 'Hijacked Link')],
        skipExisting: false,
      },
    })
    expect(hijack.status).toBe(200)

    const alice = await json<NavBootstrap>(await call('GET', '/api/nav'))
    expect(alice.categories).toHaveLength(1)
    expect(alice.categories[0]).toMatchObject({ id: category.id, name: 'Alice Private', icon: 'folder' })
    expect(alice.links).toHaveLength(1)
    expect(alice.links[0]).toMatchObject({ id: link.id, title: 'Alice Link', url: 'https://alice.example.com/original' })
    expect(categoryRow(category.id)!.user_id).toBe(USER_A)
    expect(linkRow(link.id)!.user_id).toBe(USER_A)

    const bob = await json<NavBootstrap>(await call('GET', '/api/nav', { user: USER_B }))
    expect(bob.categories).toEqual([])
    expect(bob.links).toEqual([])
  })

  it('allows the same URL in two different users\' imports', async () => {
    const url = 'https://shared.example.com/bookmark'
    const first = await call('POST', '/api/nav/import', {
      body: { categories: [importCategory(newNavId(), 'Alice')], links: [importLink(newNavId(), url, newNavId())], skipExisting: true },
    })
    expect(first.status).toBe(200)
    const second = await call('POST', '/api/nav/import', {
      user: USER_B,
      body: { categories: [importCategory(newNavId(), 'Bob')], links: [importLink(newNavId(), url, newNavId())], skipExisting: true },
    })
    expect(second.status).toBe(200)
    expect(await json(second)).toEqual({ imported: 1, skipped: 0 })
    expect(count('nav_links')).toBe(2)
  })
})

describe('batch link operations', () => {
  it('deletes owned links, reports missing ids and clears their visits', async () => {
    const category = await createCategory(USER_A, 'Batch')
    const keep = await createLink(USER_A, category.id, 'Keep')
    const remove = await createLink(USER_A, category.id, 'Remove')
    const missing = newNavId()
    await call('POST', '/api/nav/visits', { body: { visits: [{ linkId: remove.id, count: 2 }] } })

    const response = await call('POST', '/api/nav/links/batch', {
      body: { action: 'delete', ids: [remove.id, missing] },
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ deleted: 1, failed: [missing] })
    expect(linkRow(remove.id)).toBeUndefined()
    expect(linkRow(keep.id)).toBeDefined()
    expect(count('nav_link_visits')).toBe(0)
  })

  it('moves links to another owned category and reports missing ids', async () => {
    const from = await createCategory(USER_A, 'From')
    const to = await createCategory(USER_A, 'To')
    const existing = await createLink(USER_A, to.id, 'Existing')
    const first = await createLink(USER_A, from.id, 'Move One')
    const second = await createLink(USER_A, from.id, 'Move Two')
    const missing = newNavId()

    const response = await call('POST', '/api/nav/links/batch', {
      body: { action: 'move', ids: [first.id, second.id, missing], fallbackCategoryId: to.id },
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ moved: 2, failed: [missing] })
    expect(linkRow(first.id)!.category_id).toBe(to.id)
    expect(linkRow(second.id)!.category_id).toBe(to.id)
    expect(linkRow(first.id)!.sort_order).toBe(existing.sortOrder + 1)
    expect(linkRow(second.id)!.sort_order).toBe(existing.sortOrder + 2)

    const foreign = await createCategory(USER_B, 'Foreign')
    expect((await call('POST', '/api/nav/links/batch', {
      body: { action: 'move', ids: [first.id], fallbackCategoryId: foreign.id },
    })).status).toBe(400)
    expect(linkRow(first.id)!.category_id).toBe(to.id)
  })

  it('rewrites URLs with each placeholder and reports invalid results per link', async () => {
    const category = await createCategory(USER_A, 'Rewrite')
    const pathLink = await createLink(USER_A, category.id, 'Path Link', {
      url: 'https://old.example.com/a/b?q=1#frag',
    })
    const hostLink = await createLink(USER_A, category.id, 'Host Link', {
      url: 'https://old.example.com/x?y=1',
    })
    const fixedLink = await createLink(USER_A, category.id, 'Fixed Link', {
      url: 'https://old.example.com/z',
    })
    const missing = newNavId()

    const pathRewrite = await call('POST', '/api/nav/links/batch', {
      body: { action: 'rewrite', ids: [pathLink.id, missing], template: 'https://new.example.com{path}' },
    })
    expect(pathRewrite.status).toBe(200)
    expect(await json(pathRewrite)).toEqual({
      updated: [{ id: pathLink.id, url: 'https://new.example.com/a/b?q=1#frag' }],
      failed: [{ id: missing, error: 'not_found' }],
    })

    const hostRewrite = await call('POST', '/api/nav/links/batch', {
      body: { action: 'rewrite', ids: [hostLink.id], template: 'https://{old_host}/mirror{path}' },
    })
    expect(hostRewrite.status).toBe(200)
    expect(await json(hostRewrite)).toEqual({
      updated: [{ id: hostLink.id, url: 'https://old.example.com/mirror/x?y=1' }],
      failed: [],
    })

    const fixed = await call('POST', '/api/nav/links/batch', {
      body: { action: 'rewrite', ids: [fixedLink.id], template: 'https://same.example.com/fixed' },
    })
    expect(fixed.status).toBe(200)
    expect(await json(fixed)).toEqual({
      updated: [{ id: fixedLink.id, url: 'https://same.example.com/fixed' }],
      failed: [],
    })

    const invalid = await call('POST', '/api/nav/links/batch', {
      body: { action: 'rewrite', ids: [fixedLink.id], template: 'javascript:alert(1)' },
    })
    expect(invalid.status).toBe(200)
    expect(await json(invalid)).toEqual({
      updated: [],
      failed: [{ id: fixedLink.id, error: 'invalid_url' }],
    })
    expect(linkRow(fixedLink.id)!.url).toBe('https://same.example.com/fixed')
  })

  it('requires ids, a move target and a rewrite template', async () => {
    expect((await call('POST', '/api/nav/links/batch', { body: { action: 'delete', ids: [] } })).status).toBe(400)
    expect((await call('POST', '/api/nav/links/batch', {
      body: { action: 'move', ids: [newNavId()] },
    })).status).toBe(400)
    expect((await call('POST', '/api/nav/links/batch', {
      body: { action: 'rewrite', ids: [newNavId()] },
    })).status).toBe(400)
  })
})

describe('settings groups', () => {
  it('returns defaults and persists one validated group at a time', async () => {
    const defaults = await call('GET', '/api/nav/settings')
    expect(defaults.status).toBe(200)
    const initial = await json<{
      display: NavSettings['display']
      search: NavSettings['search']
      ai: NavSettings['ai']
      webdav: { url: string; username: string; hasPassword: boolean }
    }>(defaults)
    expect(initial.display).toEqual({
      navTitle: '',
      cardStyle: 'detailed',
      recentLinksCount: 10,
      frequentLinksCount: 10,
      autoFetchIcon: true,
    })
    expect(initial.search.mode).toBe('internal')
    expect(initial.search.sources).toHaveLength(10)
    expect(initial.search.selectedSourceId).toBeNull()
    expect(initial.ai).toEqual({ modelId: '' })
    expect(initial.webdav).toEqual({ url: '', username: '', hasPassword: false })

    const display = await call('PUT', '/api/nav/settings/display', {
      body: { navTitle: 'My Nav', cardStyle: 'simple', recentLinksCount: 5, frequentLinksCount: 0, autoFetchIcon: false },
    })
    expect(display.status).toBe(200)
    expect((await json<{ value: NavSettings['display'] }>(display)).value).toEqual({
      navTitle: 'My Nav',
      cardStyle: 'simple',
      recentLinksCount: 5,
      frequentLinksCount: 0,
      autoFetchIcon: false,
    })
    expect((await json<{ display: NavSettings['display'] }>(await call('GET', '/api/nav/settings'))).display.cardStyle).toBe('simple')

    const source = {
      id: 'custom',
      name: 'Custom',
      url: 'https://search.example.com/?q={query}',
      icon: null,
      enabled: true,
      createdAt: 1,
    }
    const search = await call('PUT', '/api/nav/settings/search', {
      body: { mode: 'external', sources: [source], selectedSourceId: 'custom' },
    })
    expect(search.status).toBe(200)
    const savedSearch = (await json<{ search: NavSettings['search'] }>(await call('GET', '/api/nav/settings'))).search
    expect(savedSearch.mode).toBe('external')
    expect(savedSearch.sources).toHaveLength(1)
    expect(savedSearch.sources[0]!.id).toBe('custom')
    expect(savedSearch.selectedSourceId).toBe('custom')

    const ai = await call('PUT', '/api/nav/settings/ai', { body: { modelId: 'model-1' } })
    expect(ai.status).toBe(200)
    expect((await json<{ ai: NavSettings['ai'] }>(await call('GET', '/api/nav/settings'))).ai.modelId).toBe('model-1')
  })

  it('rejects invalid group values and unknown groups without touching stored settings', async () => {
    expect((await call('PUT', '/api/nav/settings/display', {
      body: { cardStyle: 'fancy' },
    })).status).toBe(400)
    expect((await call('PUT', '/api/nav/settings/display', {
      body: { recentLinksCount: 101 },
    })).status).toBe(400)
    expect((await call('PUT', '/api/nav/settings/display', {
      body: { recentLinksCount: -1 },
    })).status).toBe(400)
    expect((await call('PUT', '/api/nav/settings/display', {
      body: { navTitle: 'x'.repeat(61) },
    })).status).toBe(400)
    expect((await call('PUT', '/api/nav/settings/search', {
      body: { mode: 'internal', sources: [{ name: 'No query', url: 'https://search.example.com/' }] },
    })).status).toBe(400)
    const tooMany = Array.from({ length: 21 }, (_, index) => ({
      name: `S${index}`,
      url: `https://s${index}.example.com/?q={query}`,
    }))
    expect((await call('PUT', '/api/nav/settings/search', {
      body: { mode: 'internal', sources: tooMany },
    })).status).toBe(400)
    expect((await call('PUT', '/api/nav/settings/ai', {
      body: { modelId: 'x'.repeat(65) },
    })).status).toBe(400)
    expect((await call('PUT', '/api/nav/settings/unknown', { body: {} })).status).toBe(404)
    expect((await call('PUT', '/api/nav/settings/display', { body: null })).status).toBe(400)

    const after = await json<{ display: NavSettings['display'] }>(await call('GET', '/api/nav/settings'))
    expect(after.display.cardStyle).toBe('detailed')
  })

  it('drops a selected search source that is not in the list', async () => {
    const source = { id: 'present', name: 'Present', url: 'https://present.example.com/?q={query}' }
    expect((await call('PUT', '/api/nav/settings/search', {
      body: { mode: 'external', sources: [source], selectedSourceId: 'gone' },
    })).status).toBe(200)
    const saved = (await json<{ search: NavSettings['search'] }>(await call('GET', '/api/nav/settings'))).search
    expect(saved.selectedSourceId).toBeNull()
  })
})

describe('WebDAV settings and secrets', () => {
  it('stores URL and username without ever returning a secret', async () => {
    const saved = await call('PUT', '/api/nav/settings/webdav', {
      body: { url: 'https://dav.example.com/root', username: 'alice' },
    })
    expect(saved.status).toBe(200)
    expect(await json(saved)).toEqual({
      url: 'https://dav.example.com/root',
      username: 'alice',
      hasPassword: false,
    })
    const settings = await json<{ webdav: { url: string; username: string; hasPassword: boolean } }>(
      await call('GET', '/api/nav/settings'),
    )
    expect(settings.webdav).toEqual({ url: 'https://dav.example.com/root', username: 'alice', hasPassword: false })
    expect(JSON.stringify(settings)).not.toContain('password')

    const bob = await json<{ webdav: { url: string; username: string; hasPassword: boolean } }>(
      await call('GET', '/api/nav/settings', { user: USER_B }),
    )
    expect(bob.webdav).toEqual({ url: '', username: '', hasPassword: false })

    expect((await call('PUT', '/api/nav/settings/webdav', { body: { url: 'https://dav.example.com/root' } })).status).toBe(400)
    expect((await call('PUT', '/api/nav/settings/webdav', {
      body: { url: 42, username: 'alice' },
    })).status).toBe(400)
  })

  it('reports hasPassword from the secrets row and clears it without a vault', async () => {
    await call('PUT', '/api/nav/settings/webdav', {
      body: { url: 'https://dav.example.com/root', username: 'alice' },
    })
    sqlite.prepare(`INSERT INTO nav_secrets (user_id, key, ciphertext, hint, updated_at)
      VALUES (?, 'webdav', 'v1.stored', '{}', ?)`).run(USER_A, Date.now())

    const withSecret = await json<{ webdav: { hasPassword: boolean } }>(await call('GET', '/api/nav/settings'))
    expect(withSecret.webdav.hasPassword).toBe(true)

    const updatedConfig = await call('PUT', '/api/nav/settings/webdav', {
      body: { url: 'https://dav.example.com/other', username: 'alice' },
    })
    expect(updatedConfig.status).toBe(200)
    expect((await json<{ hasPassword: boolean }>(updatedConfig)).hasPassword).toBe(true)
    expect(count('nav_secrets')).toBe(1)

    const cleared = await call('PUT', '/api/nav/webdav/secret', { body: { clear: true } })
    expect(cleared.status).toBe(200)
    expect(await json(cleared)).toEqual({ hasPassword: false })
    expect(count('nav_secrets')).toBe(0)
  })

  it('answers 503 when asked to encrypt a WebDAV password without a vault', async () => {
    const response = await call('PUT', '/api/nav/webdav/secret', { body: { password: 'dav-password' } })
    expect(response.status).toBe(503)
    expect(await errorCode(response)).toBe('storage_unavailable')
    expect(count('nav_secrets')).toBe(0)
    expect((await call('PUT', '/api/nav/webdav/secret', { body: {} })).status).toBe(400)
  })

  it('requires a saved config and a password before testing a connection', async () => {
    const missingConfig = await call('POST', '/api/nav/webdav/test', { body: {} })
    expect(missingConfig.status).toBe(400)

    await call('PUT', '/api/nav/settings/webdav', {
      body: { url: 'https://dav.example.com/root', username: 'alice' },
    })
    const missingPassword = await call('POST', '/api/nav/webdav/test', { body: {} })
    expect(missingPassword.status).toBe(401)
    expect(await errorCode(missingPassword)).toBe('wrong_password')
  })

  it('forgets both the config and the secret', async () => {
    await call('PUT', '/api/nav/settings/webdav', {
      body: { url: 'https://dav.example.com/root', username: 'alice' },
    })
    sqlite.prepare(`INSERT INTO nav_secrets (user_id, key, ciphertext, hint, updated_at)
      VALUES (?, 'webdav', 'v1.stored', '{}', ?)`).run(USER_A, Date.now())
    const forgotten = await call('POST', '/api/nav/webdav/forget', { body: {} })
    expect(forgotten.status).toBe(200)
    expect(await json(forgotten)).toEqual({ ok: true })
    expect(count('nav_secrets')).toBe(0)
    const settings = await json<{ webdav: { url: string; username: string; hasPassword: boolean } }>(
      await call('GET', '/api/nav/settings'),
    )
    expect(settings.webdav).toEqual({ url: '', username: '', hasPassword: false })
  })
})

describe('WebDAV backup runs', () => {
  const NAV_USER = 'b'.repeat(26)

  function webdavStub(): { calls: Array<{ method: string; url: string }>; mock: ReturnType<typeof vi.fn> } {
    const calls: Array<{ method: string; url: string }> = []
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ method, url })
      const status = method === 'PROPFIND' ? 207 : method === 'PUT' ? 201 : method === 'DELETE' ? 200 : 200
      return new Response(null, { status })
    })
    vi.stubGlobal('fetch', mock)
    return { calls, mock }
  }

  async function configure(retention: number): Promise<void> {
    const response = await call('PUT', '/api/nav/webdav/config', {
      user: NAV_USER,
      body: { url: 'https://dav.example.com/root', username: 'alice', password: 'dav-password', schedule: 'hourly', retention },
    })
    expect(response.status).toBe(200)
  }

  it('uploads, records the run and prunes the oldest timestamped files', async () => {
    env = testBindings(makeD1(sqlite), { CREDENTIAL_VAULT: makeVault() })
    await configure(2)
    sqlite.prepare("UPDATE nav_settings SET value = ?1 WHERE user_id = ?2 AND key = 'backup'").run(JSON.stringify({
      schedule: 'hourly',
      retention: 2,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      lastFilename: null,
      history: ['inkstone-nav-backup_2026-01-01_00-00-00.json', 'inkstone-nav-backup_2026-01-02_00-00-00.json'],
    }), NAV_USER)
    const { calls } = webdavStub()

    const response = await call('POST', '/api/nav/webdav/backup', { user: NAV_USER, body: { timestamped: true } })
    expect(response.status).toBe(200)
    const body = await json<{ filename: string; verified: boolean }>(response)
    expect(body.filename).toMatch(/^inkstone-nav-backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/)
    expect(body.verified).toBe(true)

    const state = JSON.parse((sqlite.prepare("SELECT value FROM nav_settings WHERE user_id = ?1 AND key = 'backup'").get(NAV_USER) as { value: string }).value) as {
      lastStatus: string
      history: string[]
    }
    expect(state.lastStatus).toBe('success')
    expect(state.history[0]).toBe(body.filename)
    expect(state.history).toContain('inkstone-nav-backup_2026-01-01_00-00-00.json')
    expect(state.history).not.toContain('inkstone-nav-backup_2026-01-02_00-00-00.json')
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('inkstone-nav-backup_2026-01-02_00-00-00.json'))).toBe(true)
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('inkstone-nav-backup_2026-01-01_00-00-00.json'))).toBe(false)
  })

  it('runs the scheduled backup for a due account', async () => {
    env = testBindings(makeD1(sqlite), { CREDENTIAL_VAULT: makeVault() })
    await configure(0)
    const { calls } = webdavStub()
    await runScheduledNavBackups(env, Date.now() + 2 * 60 * 60 * 1000)
    const state = JSON.parse((sqlite.prepare("SELECT value FROM nav_settings WHERE user_id = ?1 AND key = 'backup'").get(NAV_USER) as { value: string }).value) as {
      lastStatus: string
      filename?: string
    }
    expect(state.lastStatus).toBe('success')
    expect(calls.some((call) => call.method === 'PUT')).toBe(true)
  })
})

describe('saved WebDAV credentials', () => {
  const NAV_USER = 'a'.repeat(26)

  it('saves a target once and reuses the encrypted password without asking again', async () => {
    env = testBindings(makeD1(sqlite), { CREDENTIAL_VAULT: makeVault() })
    const saved = await call('PUT', '/api/nav/webdav/config', {
      user: NAV_USER,
      body: { url: 'https://dav.example.com/root', username: 'alice', password: 'dav-password', schedule: 'daily', retention: 7 },
    })
    expect(saved.status).toBe(200)
    const body = await json<NavBackupConfig>(saved)
    expect(body).toMatchObject({
      url: 'https://dav.example.com/root',
      username: 'alice',
      hasPassword: true,
      schedule: 'daily',
      retention: 7,
    })
    expect(JSON.stringify(body)).not.toContain('dav-password')
    expect(count('nav_secrets')).toBe(1)

    const second = await call('PUT', '/api/nav/webdav/config', {
      user: NAV_USER,
      body: { url: 'https://dav.example.com/other', username: 'alice' },
    })
    expect(second.status).toBe(200)
    expect((await json<NavBackupConfig>(second)).hasPassword).toBe(true)
    expect(count('nav_secrets')).toBe(1)

    const onlySchedule = await call('PUT', '/api/nav/webdav/config', { user: NAV_USER, body: { schedule: 'weekly', retention: 14 } })
    expect(onlySchedule.status).toBe(200)
    const status = await json<NavBackupConfig>(await call('GET', '/api/nav/webdav/config', { user: NAV_USER }))
    expect(status).toMatchObject({
      url: 'https://dav.example.com/other',
      username: 'alice',
      hasPassword: true,
      schedule: 'weekly',
      retention: 14,
    })
  })

  it('requires a password on the first save and refuses a non-HTTPS endpoint', async () => {
    env = testBindings(makeD1(sqlite), { CREDENTIAL_VAULT: makeVault() })
    const missing = await call('PUT', '/api/nav/webdav/config', {
      user: NAV_USER,
      body: { url: 'https://dav.example.com/root', username: 'alice' },
    })
    expect(missing.status).toBe(401)
    expect(await errorCode(missing)).toBe('wrong_password')
    const insecure = await call('PUT', '/api/nav/webdav/config', {
      user: NAV_USER,
      body: { url: 'http://dav.example.com/root', username: 'alice', password: 'dav-password' },
    })
    expect(insecure.status).toBe(400)
    expect(count('nav_secrets')).toBe(0)
  })
})

describe('local JSON backup', () => {
  it('exports locked links, visits and settings and restores the whole snapshot', async () => {
    const open = await createCategory(USER_A, 'Open')
    const locked = await createCategory(USER_A, 'Locked', { passwordMode: 'custom', password: 'password-123' })
    const openLink = await createLink(USER_A, open.id, 'Open Link')
    const hidden = await createLink(USER_A, locked.id, 'Hidden Link', { description: 'secret' })
    await call('POST', '/api/nav/visits', { body: { visits: [{ linkId: openLink.id, count: 2 }] } })
    await call('PUT', '/api/nav/settings/display', { body: { navTitle: 'Snapshot' } })

    const exportedResponse = await call('GET', '/api/nav/backup')
    expect(exportedResponse.status).toBe(200)
    expect(exportedResponse.headers.get('cache-control')).toBe('no-store')
    const exported = await json<NavBackup>(exportedResponse)
    expect(exported.format).toBe('inkstone-nav-backup')
    expect(exported.links.map((link) => link.id).sort()).toEqual([openLink.id, hidden.id].sort())
    expect(exported.categories.find((category) => category.id === locked.id)!.hasPassword).toBe(true)
    expect(JSON.stringify(exported)).not.toContain('passwordHash')
    expect(exported.visits[openLink.id]!.visitCount).toBe(2)
    expect(exported.settings.display.navTitle).toBe('Snapshot')

    await call('DELETE', `/api/nav/links/${openLink.id}`)
    await createLink(USER_A, open.id, 'Extra Link')
    await call('PUT', '/api/nav/settings/display', { body: { navTitle: 'Changed' } })

    const restoredResponse = await call('POST', '/api/nav/backup/restore', { body: exported })
    expect(restoredResponse.status).toBe(200)
    const restored = await json<{ restoredLinks: number; restoredCategories: number; unlockedCategoryNames: string[] }>(restoredResponse)
    expect(restored.restoredLinks).toBe(2)
    expect(restored.restoredCategories).toBe(2)
    expect(restored.unlockedCategoryNames).toEqual([])

    const after = await json<NavBootstrap>(await call('GET', '/api/nav'))
    expect(after.links.map((link) => link.title)).toEqual(['Open Link'])
    expect(after.links.some((link) => link.title === 'Extra Link')).toBe(false)
    expect(after.visits[openLink.id]!.visitCount).toBe(2)
    expect(after.settings.display.navTitle).toBe('Snapshot')
    expect(count('nav_links')).toBe(2)

    const unlock = await json<{ token: string }>(await call('POST', `/api/nav/categories/${locked.id}/unlock`, {
      body: { password: 'password-123' },
    }))
    const visible = await json<NavBootstrap>(await call('GET', '/api/nav', {
      headers: { 'X-Nav-Unlocks': unlock.token },
    }))
    expect(visible.links.map((link) => link.title).sort()).toEqual(['Hidden Link', 'Open Link'])
  })

  it('unlocks a protected category that the account does not have yet', async () => {
    const categoryId = newNavId()
    const linkId = newNavId()
    const backup = {
      format: 'inkstone-nav-backup',
      version: 1,
      categories: [{
        id: categoryId,
        name: 'From Backup',
        icon: 'folder',
        parentId: null,
        sortOrder: 0,
        createdAt: 1,
        hasPassword: true,
        passwordMode: 'custom',
      }],
      links: [{
        id: linkId,
        title: 'Restored Link',
        url: 'https://restored.example.com/',
        icon: null,
        description: null,
        categoryId,
        pinned: false,
        pinnedOrder: 0,
        sortOrder: 0,
        createdAt: 1,
      }],
    }
    const restored = await call('POST', '/api/nav/backup/restore', { body: backup })
    expect(restored.status).toBe(200)
    expect(await json<{ unlockedCategoryNames: string[] }>(restored)).toMatchObject({ unlockedCategoryNames: ['From Backup'] })
    const after = await json<NavBootstrap>(await call('GET', '/api/nav'))
    expect(after.links.map((link) => link.title)).toEqual(['Restored Link'])
  })

  it('rejects a snapshot with a broken reference without touching stored rows', async () => {
    await createCategory(USER_A, 'Keep')
    const before = count('nav_categories')
    const malformed = {
      format: 'inkstone-nav-backup',
      version: 1,
      categories: [importCategoryForBackup('1'.repeat(26), 'Orphan', '2'.repeat(26))],
      links: [],
    }
    const response = await call('POST', '/api/nav/backup/restore', { body: malformed })
    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('bad_request')
    expect(count('nav_categories')).toBe(before)
  })

  it('requires a session for export and restore', async () => {
    expect((await call('GET', '/api/nav/backup', { user: null })).status).toBe(401)
    expect((await call('POST', '/api/nav/backup/restore', { user: null, body: {} })).status).toBe(401)
  })
})

function importCategoryForBackup(id: string, name: string, parentId: string | null) {
  return { id, name, icon: 'folder', parentId, sortOrder: 0, createdAt: 1, hasPassword: false }
}
