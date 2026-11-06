// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { blogPublicRoutes } from '../src/worker/blog/public-routes'
import {
  BLOG_PREVIEW_TOKEN_TTL_MS,
  createBlogPreviewToken,
  listBlogPreviewTokens,
  revokeBlogPreviewToken,
} from '../src/worker/blog/preview'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'owner-1'
const NOW = Date.now()
const PROXY_KEY = 'test-proxy-key'

async function installed() {
  const sqlite = new DatabaseSync(':memory:')
  const db = makeD1(sqlite) as unknown as D1Database
  await initializeDatabase({ DB: db } as unknown as Env)
  sqlite.exec(`
    INSERT INTO users (id, username, password_hash, login, role, created_at, last_seen_at)
      VALUES ('${USER}', 'owner', 'hash', 'owner', 'owner', 1, 1);
    INSERT INTO blog_settings (user_id, key, value, updated_at)
      VALUES ('${USER}', 'profile', '{"name":"Alice Example","bio":"Writes things","location":"Hangzhou"}', 1);
  `)
  const app = new Hono()
  app.onError((error, c) => {
    const status = (error as { status?: number }).status ?? 500
    return c.json({ error: { message: error.message } }, status as 400)
  })
  app.route('/api/blog', blogPublicRoutes)
  const env = { DB: db, BLOG_PROXY_KEY: PROXY_KEY } as unknown as Env
  return { sqlite, db, app, env }
}

function post(
  sqlite: DatabaseSync,
  options: {
    id: string
    slug: string
    title: string
    status?: string
    encrypted?: number
    publishedAt?: number
    updatedAt?: number
  },
) {
  sqlite
    .prepare(
      `INSERT INTO blog_posts
         (id, user_id, note_id, slug, title, status, encrypted, published_at, created_at, updated_at, hide_home_content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      options.id,
      USER,
      `note-${options.id}`,
      options.slug,
      options.title,
      options.status ?? 'published',
      options.encrypted ?? 0,
      options.publishedAt ?? NOW - 1000,
      NOW - 2000,
      options.updatedAt ?? NOW - 1000,
    )
}

function note(sqlite: DatabaseSync, postId: string, content: string) {
  sqlite
    .prepare(
      `INSERT INTO notes
         (id, user_id, folder_id, title, title_key, content, excerpt, rev, word_count, char_count,
          is_pinned, is_starred, is_archived, is_encrypted, position, content_hash, created_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, ?, ?, ?, '', 1, 1, 1, 0, 0, 0, 0, 0, ?, ?, ?, NULL)`,
    )
    .run(`note-${postId}`, USER, `Title ${postId}`, `title-${postId}`, content, 'hash', NOW - 3000, NOW - 1000)
}

function request(app: Hono, env: Env, path: string) {
  return app.fetch(
    new Request(`http://localhost${path}`, { headers: { 'x-blog-proxy-key': PROXY_KEY } }),
    env,
  )
}

describe('the author page aggregates only publishable articles', () => {
  let ctx: Awaited<ReturnType<typeof installed>>

  beforeEach(async () => {
    ctx = await installed()
    post(ctx.sqlite, { id: 'a', slug: 'alpha', title: 'Alpha', publishedAt: NOW - 3000 })
    post(ctx.sqlite, { id: 'b', slug: 'beta', title: 'Beta', publishedAt: NOW - 2000 })
    post(ctx.sqlite, { id: 'c', slug: 'gamma', title: 'Gamma', publishedAt: NOW - 1000 })
    post(ctx.sqlite, { id: 'secret', slug: 'secret', title: 'Secret title', encrypted: 1 })
    post(ctx.sqlite, { id: 'draft', slug: 'draft', title: 'Draft title', status: 'draft' })
    post(ctx.sqlite, { id: 'future', slug: 'future', title: 'Future title', status: 'scheduled', publishedAt: NOW + 60_000 })
  })

  it('returns the profile and the published, unencrypted set with its total', async () => {
    const response = await request(ctx.app, ctx.env, '/api/blog/authors/alice-example')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      author: { slug: string; name: string; bio: string; articleCount: number }
      items: { slug: string; title: string }[]
      total: number
    }
    expect(body.author).toMatchObject({ slug: 'alice-example', name: 'Alice Example', bio: 'Writes things', articleCount: 3 })
    expect(body.items.map((item) => item.slug)).toEqual(['gamma', 'beta', 'alpha'])
    expect(body.total).toBe(3)
    expect(JSON.stringify(body)).not.toContain('Secret title')
    expect(JSON.stringify(body)).not.toContain('Draft title')
    expect(JSON.stringify(body)).not.toContain('Future title')
  })

  it('paginates and sorts the same aggregated set', async () => {
    const page = await request(ctx.app, ctx.env, '/api/blog/authors/alice-example?page=2&limit=2')
    const body = (await page.json()) as { items: { slug: string }[]; page: number; limit: number; total: number }
    expect(body.page).toBe(2)
    expect(body.limit).toBe(2)
    expect(body.total).toBe(3)
    expect(body.items.map((item) => item.slug)).toEqual(['alpha'])

    const sorted = await request(ctx.app, ctx.env, '/api/blog/authors/alice-example?sort=title')
    const titles = ((await sorted.json()) as { items: { title: string }[] }).items.map((item) => item.title)
    expect(titles).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('answers 404 for a slug that is not the owner', async () => {
    const response = await request(ctx.app, ctx.env, '/api/blog/authors/someone-else')
    expect(response.status).toBe(404)
  })
})

describe('preview links expose a draft only through their token', () => {
  let ctx: Awaited<ReturnType<typeof installed>>

  beforeEach(async () => {
    ctx = await installed()
    post(ctx.sqlite, { id: 'draft', slug: 'draft', title: 'Draft title', status: 'draft', publishedAt: NOW })
    note(ctx.sqlite, 'draft', '# Draft title\n\nOnly a preview reads this.')
  })

  it('renders the draft body with no-store and noindex headers without counting a view', async () => {
    const created = await createBlogPreviewToken(ctx.db, USER, 'draft')
    const response = await request(ctx.app, ctx.env, `/api/blog/preview/${created.token}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    const body = (await response.json()) as { preview: boolean; content: string; title: string }
    expect(body.preview).toBe(true)
    expect(body.title).toBe('Draft title')
    expect(body.content).toContain('Only a preview reads this.')
    const stored = ctx.sqlite.prepare('SELECT view_count, used_at FROM blog_posts p JOIN blog_preview_tokens t ON t.post_id = p.id WHERE p.id = ?').get('draft') as { view_count: number; used_at: number | null }
    expect(stored.view_count).toBe(0)
    expect(stored.used_at).not.toBeNull()
  })

  it('rejects an expired token, a revoked token and an unknown token', async () => {
    const expired = await createBlogPreviewToken(ctx.db, USER, 'draft', NOW - BLOG_PREVIEW_TOKEN_TTL_MS * 2)
    expect((await request(ctx.app, ctx.env, `/api/blog/preview/${expired.token}`)).status).toBe(404)

    const revoked = await createBlogPreviewToken(ctx.db, USER, 'draft')
    expect(await revokeBlogPreviewToken(ctx.db, USER, 'draft', revoked.hash)).toBe(true)
    expect((await request(ctx.app, ctx.env, `/api/blog/preview/${revoked.token}`)).status).toBe(404)

    expect((await request(ctx.app, ctx.env, '/api/blog/preview/not-a-token')).status).toBe(404)
  })

  it('lists the link with its used state and keeps the plain token out of the list', async () => {
    const created = await createBlogPreviewToken(ctx.db, USER, 'draft')
    await request(ctx.app, ctx.env, `/api/blog/preview/${created.token}`)
    const items = await listBlogPreviewTokens(ctx.db, USER, 'draft')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ hash: created.hash, status: 'used', revokedAt: null })
    expect(JSON.stringify(items)).not.toContain(created.token)
  })
})
