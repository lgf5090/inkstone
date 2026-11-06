// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { blogPublicRoutes } from '../src/worker/blog/public-routes'
import {
  exportNewsletterSubscribers,
  listNewsletterSubscribers,
  newsletterCsv,
  rotateConfirmationToken,
} from '../src/worker/blog/newsletter'
import { sha256Hex } from '../src/worker/lib/encoding'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'owner-1'
const NOW = 1_790_000_000_000
const PROXY_KEY = 'test-proxy-key'
const VISITOR = 'visitor-0123456789abcdef'

async function installed() {
  const sqlite = new DatabaseSync(':memory:')
  const db = makeD1(sqlite) as unknown as D1Database
  await initializeDatabase({ DB: db } as unknown as Env)
  sqlite.exec(`
    INSERT INTO users (id, username, password_hash, login, role, created_at, last_seen_at)
      VALUES ('${USER}', 'owner', 'hash', 'owner', 'owner', 1, 1);
  `)
  const app = new Hono()
  app.onError((error, c) => {
    const status = (error as { status?: number }).status ?? 500
    return c.json({ error: { message: error.message } }, status as 400)
  })
  app.route('/api/blog', blogPublicRoutes)
  const env = { DB: db, BLOG_PROXY_KEY: PROXY_KEY, BLOG_PUBLIC_ORIGIN: 'https://blog.example' } as unknown as Env
  return { sqlite, db, app, env }
}

function post(
  sqlite: DatabaseSync,
  options: { id: string; slug: string; title: string; encrypted?: number },
) {
  sqlite
    .prepare(
      `INSERT INTO blog_posts
         (id, user_id, note_id, slug, title, status, encrypted, published_at, created_at, updated_at, hide_home_content)
       VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, 1)`,
    )
    .run(
      options.id, USER, `note-${options.id}`, options.slug, options.title,
      options.encrypted ?? 0, NOW - 1000, NOW - 2000, NOW - 1000,
    )
}

function request(
  app: Hono,
  env: Env,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return app.fetch(new Request(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'x-blog-proxy-key': PROXY_KEY,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }), env)
}

async function tokenHash(token: string): Promise<string> {
  return sha256Hex(`blog-newsletter-token|${token}`)
}

describe('newsletter double opt-in', () => {
  let ctx: Awaited<ReturnType<typeof installed>>

  beforeEach(async () => {
    ctx = await installed()
  })

  it('stores a pending address without returning it or claiming mail was sent', async () => {
    const response = await request(ctx.app, ctx.env, '/api/blog/newsletter/subscribe', {
      method: 'POST',
      body: { email: 'Reader@Example.com ', source: 'footer' },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({ status: 'pending', emailSent: false, delivery: 'unavailable' })
    expect(JSON.stringify(body)).not.toContain('reader@example.com')
    const row = ctx.sqlite.prepare(
      'SELECT email, email_normalized, status, source, confirm_token_hash FROM blog_newsletter_subscribers',
    ).get() as Record<string, string>
    expect(row.email).toBe('Reader@Example.com')
    expect(row.email_normalized).toBe('reader@example.com')
    expect(row.status).toBe('pending')
    expect(row.source).toBe('footer')
    expect(row.confirm_token_hash).not.toBe('')
  })

  it('answers a repeated subscribe within the cooldown without rotating or claiming a send', async () => {
    const first = await request(ctx.app, ctx.env, '/api/blog/newsletter/subscribe', {
      method: 'POST', body: { email: 'a@example.com' },
    })
    expect(first.status).toBe(200)
    const second = await request(ctx.app, ctx.env, '/api/blog/newsletter/subscribe', {
      method: 'POST', body: { email: 'a@example.com' },
    })
    expect(await second.json()).toMatchObject({ status: 'pending', emailSent: false, delivery: 'cooldown' })
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS total FROM blog_newsletter_subscribers').get()).toEqual({ total: 1 })
  })

  it('confirms once from the link and answers a repeated click as already confirmed', async () => {
    const response = await request(ctx.app, ctx.env, '/api/blog/newsletter/subscribe', {
      method: 'POST', body: { email: 'a@example.com' },
    })
    expect(response.status).toBe(200)
    const id = (ctx.sqlite.prepare('SELECT id FROM blog_newsletter_subscribers').get() as { id: string }).id
    const { url } = await rotateConfirmationToken(ctx.env, USER, id)
    const token = new URL(url).searchParams.get('token') ?? ''
    const confirmed = await request(ctx.app, ctx.env, '/api/blog/newsletter/confirm', {
      method: 'POST', body: { token },
    })
    expect(await confirmed.json()).toEqual({ status: 'confirmed', already: false })
    const repeated = await request(ctx.app, ctx.env, '/api/blog/newsletter/confirm', {
      method: 'POST', body: { token },
    })
    expect(await repeated.json()).toEqual({ status: 'confirmed', already: true })
  })

  it('unsubscribes with the stored token and keeps a repeated request honest', async () => {
    const unsubscribeToken = 'unsubscribe-known-token'
    ctx.sqlite.prepare(
      `INSERT INTO blog_newsletter_subscribers
         (id, user_id, email, email_normalized, status, source, confirm_token_hash,
          unsubscribe_token_hash, created_at, updated_at)
       VALUES ('s1', ?, 'a@example.com', 'a@example.com', 'confirmed', 'footer', '', ?, ?, ?)`,
    ).run(USER, await tokenHash(unsubscribeToken), NOW, NOW)
    const first = await request(ctx.app, ctx.env, '/api/blog/newsletter/unsubscribe', {
      method: 'POST', body: { token: unsubscribeToken },
    })
    expect(await first.json()).toEqual({ status: 'unsubscribed', already: false })
    const second = await request(ctx.app, ctx.env, '/api/blog/newsletter/unsubscribe', {
      method: 'POST', body: { token: unsubscribeToken },
    })
    expect(await second.json()).toEqual({ status: 'unsubscribed', already: true })
  })

  it('rejects an invalid address without writing a row', async () => {
    const response = await request(ctx.app, ctx.env, '/api/blog/newsletter/subscribe', {
      method: 'POST', body: { email: 'not-an-address' },
    })
    expect(response.status).toBe(400)
    expect(ctx.sqlite.prepare('SELECT COUNT(*) AS total FROM blog_newsletter_subscribers').get()).toEqual({ total: 0 })
  })

  it('paginates, searches and exports without leaking a token', async () => {
    ctx.sqlite.exec(`
      INSERT INTO blog_newsletter_subscribers
        (id, user_id, email, email_normalized, status, source, confirm_token_hash, unsubscribe_token_hash, created_at, updated_at)
      VALUES
        ('n1', '${USER}', 'alice@example.com', 'alice@example.com', 'confirmed', 'footer', 'c1', 'u1', 1, 1),
        ('n2', '${USER}', 'bob@example.com', 'bob@example.com', 'pending', 'footer', 'c2', 'u2', 2, 2),
        ('n3', '${USER}', 'carol@example.com', 'carol@example.com', 'unsubscribed', 'footer', 'c3', 'u3', 3, 3);
    `)
    const pending = await listNewsletterSubscribers(ctx.db, USER, { status: 'pending', q: '' }, 1, 20)
    expect(pending.total).toBe(1)
    expect(pending.items[0]).toMatchObject({ email: 'bob@example.com', status: 'pending' })
    expect(pending.counts).toEqual({ pending: 1, confirmed: 1, unsubscribed: 1 })
    const searched = await listNewsletterSubscribers(ctx.db, USER, { status: 'all', q: 'example.com' }, 1, 2)
    expect(searched.total).toBe(3)
    expect(searched.items).toHaveLength(2)
    const exported = await exportNewsletterSubscribers(ctx.db, USER, { status: 'all', q: '' })
    expect(exported).toHaveLength(3)
    const csv = newsletterCsv(exported)
    expect(csv).not.toContain('c1')
    expect(csv).not.toContain('u1')
    expect(csv.split('\r\n')[0]).toContain('email')
  })
})

describe('anonymous likes and reading list', () => {
  let ctx: Awaited<ReturnType<typeof installed>>

  beforeEach(async () => {
    ctx = await installed()
    post(ctx.sqlite, { id: 'pub', slug: 'public-post', title: 'Public post' })
    post(ctx.sqlite, { id: 'sec', slug: 'secret-post', title: 'Secret title', encrypted: 1 })
  })

  it('counts one like per visitor and converges on repeated requests', async () => {
    const first = await request(ctx.app, ctx.env, '/api/blog/engagement/posts/public-post', {
      method: 'POST', body: { like: true }, headers: { 'x-blog-visitor': VISITOR },
    })
    expect(await first.json()).toMatchObject({ likeCount: 1, liked: true, favorited: false })
    const again = await request(ctx.app, ctx.env, '/api/blog/engagement/posts/public-post', {
      method: 'POST', body: { like: true }, headers: { 'x-blog-visitor': VISITOR },
    })
    expect(await again.json()).toMatchObject({ likeCount: 1, liked: true })
    const other = await request(ctx.app, ctx.env, '/api/blog/engagement/posts/public-post', {
      method: 'POST', body: { like: true }, headers: { 'x-blog-visitor': 'visitor-other-0123456789' },
    })
    expect(await other.json()).toMatchObject({ likeCount: 2, liked: true })
  })

  it('removes a like and can favorite a post into the reading list', async () => {
    const liked = await request(ctx.app, ctx.env, '/api/blog/engagement/posts/public-post', {
      method: 'POST', body: { like: true, favorite: true }, headers: { 'x-blog-visitor': VISITOR },
    })
    expect(await liked.json()).toMatchObject({ likeCount: 1, liked: true, favorited: true })
    const unliked = await request(ctx.app, ctx.env, '/api/blog/engagement/posts/public-post', {
      method: 'POST', body: { like: false }, headers: { 'x-blog-visitor': VISITOR },
    })
    expect(await unliked.json()).toMatchObject({ likeCount: 0, liked: false, favorited: true })
    const saved = await request(ctx.app, ctx.env, '/api/blog/engagement/saved', {
      headers: { 'x-blog-visitor': VISITOR },
    })
    expect(await saved.json()).toMatchObject({ total: 1, items: [{ slug: 'public-post' }] })
  })

  it('keeps protected articles out of engagement and the reading list', async () => {
    const direct = await request(ctx.app, ctx.env, '/api/blog/engagement/posts/secret-post', {
      headers: { 'x-blog-visitor': VISITOR },
    })
    expect(direct.status).toBe(404)
    const write = await request(ctx.app, ctx.env, '/api/blog/engagement/posts/secret-post', {
      method: 'POST', body: { favorite: true }, headers: { 'x-blog-visitor': VISITOR },
    })
    expect(write.status).toBe(404)
    const saved = await request(ctx.app, ctx.env, '/api/blog/engagement/saved', {
      headers: { 'x-blog-visitor': VISITOR },
    })
    expect(await saved.json()).toMatchObject({ total: 0, items: [] })
  })

  it('reports the public count in the post detail and listing', async () => {
    await request(ctx.app, ctx.env, '/api/blog/engagement/posts/public-post', {
      method: 'POST', body: { like: true }, headers: { 'x-blog-visitor': VISITOR },
    })
    const detail = await request(ctx.app, ctx.env, '/api/blog/posts/public-post')
    expect(await detail.json()).toMatchObject({ likeCount: 1 })
    const list = await request(ctx.app, ctx.env, '/api/blog/posts?limit=50')
    const body = await list.json() as { items: { slug: string; likeCount: number }[] }
    expect(body.items.find((item) => item.slug === 'public-post')?.likeCount).toBe(1)
  })

  it('requires a valid visitor identity for writes', async () => {
    const response = await request(ctx.app, ctx.env, '/api/blog/engagement/posts/public-post', {
      method: 'POST', body: { like: true },
    })
    expect(response.status).toBe(400)
  })
})

describe('the newsletter and engagement migrations', () => {
  it('records 282-285 and converges on a second boot', async () => {
    const sqlite = new DatabaseSync(':memory:')
    await initializeDatabase({ DB: makeD1(sqlite) as unknown as D1Database } as unknown as Env)
    const versions = (sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
      .map((row) => row.version)
    expect(versions).toEqual(expect.arrayContaining([282, 283, 284, 285]))
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
      ('blog_newsletter_subscribers','blog_post_likes','blog_post_favorites') ORDER BY name`).all()).toEqual([
      { name: 'blog_newsletter_subscribers' },
      { name: 'blog_post_favorites' },
      { name: 'blog_post_likes' },
    ])
  })
})
