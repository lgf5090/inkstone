// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { blogPublicRoutes } from '../src/worker/blog/public-routes'
import {
  blogArchive,
  findAdjacentPosts,
  findPublishedPostByAlias,
  listPostTags,
  updateAdminPostMeta,
} from '../src/worker/blog/store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'owner-1'
const NOW = 1_790_000_000_000
const PROXY_KEY = 'test-proxy-key'

/**
 * A protected article is not a public listing entry: the title and the link are the finding. The
 * public routes must omit it, while the article page still answers its own slug so a direct link
 * can reach the unlock form.
 */
async function installed(files?: R2Bucket) {
  const sqlite = new DatabaseSync(':memory:')
  const db = makeD1(sqlite) as unknown as D1Database
  await initializeDatabase({ DB: db } as unknown as Env)
  sqlite.exec(`
    INSERT INTO users (id, username, password_hash, login, role, created_at, last_seen_at)
      VALUES ('${USER}', 'owner', 'hash', 'owner', 'owner', 1, 1);
  `)
  const app = new Hono()
  // The production app maps ApiError to its own status; the harness needs the same answer so a
  // protected read is distinguishable from a crash.
  app.onError((error, c) => {
    const status = (error as { status?: number }).status ?? 500
    return c.json({ error: { message: error.message } }, status as 400)
  })
  app.route('/api/blog', blogPublicRoutes)
  const env = { DB: db, BLOG_PROXY_KEY: PROXY_KEY, ...(files ? { FILES: files } : {}) } as unknown as Env
  return { sqlite, db, app, env }
}

/** A render snapshot the feed reader can load: only the HTML a full-text feed prints. */
function memoryFiles() {
  const objects = new Map<string, string>()
  const bucket = {
    get: async (key: string) => objects.has(key)
      ? { text: async () => objects.get(key)! }
      : null,
  } as unknown as R2Bucket
  return { objects, bucket }
}

function post(
  sqlite: DatabaseSync,
  options: {
    id: string
    slug: string
    title: string
    encrypted?: number
    alias?: string
    permalink?: string
    viewCount?: number
    publishedAt?: number
  },
) {
  sqlite
    .prepare(
      `INSERT INTO blog_posts
         (id, user_id, note_id, slug, title, status, encrypted, alias, permalink, view_count,
          published_at, created_at, updated_at, hide_home_content)
       VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(
      options.id,
      USER,
      `note-${options.id}`,
      options.slug,
      options.title,
      options.encrypted ?? 0,
      options.alias ?? '',
      options.permalink ?? '',
      options.viewCount ?? 0,
      options.publishedAt ?? NOW - 1000,
      NOW - 2000,
      NOW - 1000,
    )
}

function request(app: Hono, env: Env, path: string, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, { headers: { 'x-blog-proxy-key': PROXY_KEY, ...headers } }),
    env,
  )
}

describe('protected articles stay out of every public listing', () => {
  let ctx: Awaited<ReturnType<typeof installed>>

  beforeEach(async () => {
    ctx = await installed()
    post(ctx.sqlite, { id: 'pub', slug: 'public-post', title: 'Public post' })
    post(ctx.sqlite, { id: 'sec', slug: 'secret-post', title: 'Secret title', encrypted: 1, viewCount: 3, publishedAt: NOW - 500 })
  })

  it('drops the encrypted title from the posts listing and its total', async () => {
    const response = await request(ctx.app, ctx.env, '/api/blog/posts?limit=50')
    const body = (await response.json()) as { items: { slug: string }[]; total: number }
    expect(body.items.map((item) => item.slug)).toEqual(['public-post'])
    expect(body.total).toBe(1)
  })

  it('drops the encrypted title from the feed payload', async () => {
    const response = await request(ctx.app, ctx.env, '/api/blog/feeds')
    const body = (await response.json()) as { posts: { slug: string; title: string }[] }
    expect(body.posts.map((item) => item.slug)).toEqual(['public-post'])
    expect(JSON.stringify(body)).not.toContain('Secret title')
  })

  it('keeps the archive count and adjacent list free of encrypted posts', async () => {
    const archive = await blogArchive(ctx.db, USER)
    expect(archive[0]?.count).toBe(1)
    const current = ctx.sqlite
      .prepare('SELECT published_at FROM blog_posts WHERE id = ?')
      .get('pub') as { published_at: number }
    const adjacent = await findAdjacentPosts(ctx.db, USER, { id: 'pub', published_at: current.published_at })
    expect(adjacent.previous).toBeNull()
    expect(adjacent.next).toBeNull()
  })
})

describe('view counts only move for the page open', () => {
  let ctx: Awaited<ReturnType<typeof installed>>

  beforeEach(async () => {
    ctx = await installed()
    post(ctx.sqlite, { id: 'pub', slug: 'counted-post', title: 'Counted', viewCount: 5 })
  })

  const stored = () => (ctx.sqlite.prepare('SELECT view_count FROM blog_posts WHERE id = ?').get('pub') as { view_count: number }).view_count

  it('increments once for a page read and leaves internal body reads alone', async () => {
    const first = await request(ctx.app, ctx.env, '/api/blog/posts/counted-post')
    expect(((await first.json()) as { viewCount: number }).viewCount).toBe(6)
    expect(stored()).toBe(6)

    const replay = await request(ctx.app, ctx.env, '/api/blog/posts/counted-post', { 'x-blog-view': 'none' })
    expect(((await replay.json()) as { viewCount: number }).viewCount).toBe(6)
    expect(stored()).toBe(6)

    const second = await request(ctx.app, ctx.env, '/api/blog/posts/counted-post')
    expect(((await second.json()) as { viewCount: number }).viewCount).toBe(7)
    expect(stored()).toBe(7)
  })

  it('never counts a protected article, even when it is unlocked for reading', async () => {
    post(ctx.sqlite, { id: 'sec', slug: 'secret-counted', title: 'Secret', encrypted: 1, viewCount: 2 })
    const response = await request(ctx.app, ctx.env, '/api/blog/posts/secret-counted')
    expect(response.status).toBe(403)
    expect((ctx.sqlite.prepare('SELECT view_count FROM blog_posts WHERE id = ?').get('sec') as { view_count: number }).view_count).toBe(2)
  })
})

describe('article aliases resolve to a safe 301 target', () => {
  let ctx: Awaited<ReturnType<typeof installed>>

  beforeEach(async () => {
    ctx = await installed()
    ctx.sqlite.exec(`INSERT INTO blog_settings (user_id, key, value, updated_at) VALUES ('${USER}', 'permalink', '{"enable":false}', 1)`)
    post(ctx.sqlite, { id: 'astro', slug: 'astro-ssr', title: 'Astro SSR', alias: '/old/astro-ssr-path', publishedAt: NOW - 500 })
    post(ctx.sqlite, { id: 'other', slug: 'other-post', title: 'Other', publishedAt: NOW - 800 })
  })

  const resolve = async (path: string) => {
    const response = await request(ctx.app, ctx.env, `/api/blog/redirect?path=${encodeURIComponent(path)}`)
    return (await response.json()) as { found: boolean; to?: string; status?: number }
  }

  it('turns the alias into a site-relative 301 to the canonical post', async () => {
    expect(await resolve('/old/astro-ssr-path')).toEqual({ found: true, to: '/posts/astro-ssr', status: 301 })
    expect(await resolve('/old-astro-ssr-path')).toEqual({ found: false })
  })

  it('lets an explicit redirect keep priority over an alias', async () => {
    ctx.sqlite.exec(
      `INSERT INTO blog_redirects (user_id, from_slug, to_slug, status, created_at)
       VALUES ('${USER}', '/old/astro-ssr-path', '/manual', 301, 1)`,
    )
    expect(await resolve('/old/astro-ssr-path')).toEqual({ found: true, to: '/manual', status: 301 })
  })

  it('never resolves a protected article alias', async () => {
    post(ctx.sqlite, { id: 'sec', slug: 'secret-alias', title: 'Secret alias', encrypted: 1, alias: 'hidden-path' })
    expect(await resolve('/hidden-path')).toEqual({ found: false })
  })

  it('picks the newest post when legacy data has the same alias twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    post(ctx.sqlite, { id: 'older', slug: 'older-post', title: 'Older', alias: 'legacy-alias', publishedAt: NOW - 3000 })
    post(ctx.sqlite, { id: 'newer', slug: 'newer-post', title: 'Newer', alias: 'legacy-alias', publishedAt: NOW - 200 })
    expect(await resolve('/legacy-alias')).toEqual({ found: true, to: '/posts/newer-post', status: 301 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('rejects an admin alias change that another live post already owns', async () => {
    // The first post owns the path, so assigning it to the second one is an explicit conflict.
    await expect(updateAdminPostMeta(ctx.db, USER, 'other', { alias: '/old/astro-ssr-path' })).rejects.toThrow('blog_alias_conflict')
    // Re-setting an alias a post already owns stays allowed.
    await expect(updateAdminPostMeta(ctx.db, USER, 'astro', { alias: '/old/astro-ssr-path' })).resolves.toBeTruthy()
  })

  it('keeps the alias scope per owner and per published state', async () => {
    expect(await findPublishedPostByAlias(ctx.db, USER, 'old/astro-ssr-path')).toEqual({
      slug: 'astro-ssr',
      permalink: '',
    })
  })
})

describe('archive years follow the site time zone', () => {
  // 2025-12-31T16:30Z is already 2026-01-01 00:30 in Asia/Shanghai: the archive, the year filter
  // and the count must agree on which year owns it instead of each reading its own UTC boundary.
  const BOUNDARY = Date.UTC(2025, 11, 31, 16, 30)

  it('files a UTC-year-end post under the next local year', async () => {
    const ctx = await installed()
    post(ctx.sqlite, { id: 'boundary', slug: 'new-year', title: 'New year', publishedAt: BOUNDARY })
    ctx.sqlite.exec(`INSERT INTO blog_settings (user_id, key, value, updated_at)
      VALUES ('${USER}', 'site', '{"timeZone":"Asia/Shanghai"}', 1)`)

    const shanghai = await blogArchive(ctx.db, USER, 'Asia/Shanghai')
    expect(shanghai).toEqual([{ year: '2026', count: 1, months: [{ month: '01', count: 1 }] }])
    expect(await blogArchive(ctx.db, USER, 'UTC')).toEqual([
      { year: '2025', count: 1, months: [{ month: '12', count: 1 }] },
    ])

    const local = await request(ctx.app, ctx.env, '/api/blog/archive')
    expect((await local.json()) as { years: unknown }).toEqual({ years: shanghai })

    expect(((await (await request(ctx.app, ctx.env, '/api/blog/posts?year=2026')).json()) as { items: unknown[] }).items).toHaveLength(1)
    expect(((await (await request(ctx.app, ctx.env, '/api/blog/posts?year=2025')).json()) as { items: unknown[] }).items).toHaveLength(0)
  })
})

describe('the sitemap feed is not cut off at one page', () => {
  it('returns every public post so older slugs stay discoverable', async () => {
    const ctx = await installed()
    for (let index = 0; index < 120; index++) {
      post(ctx.sqlite, {
        id: `p${index}`,
        slug: `post-${index}`,
        title: `Post ${index}`,
        publishedAt: NOW - index * 1000,
      })
    }
    post(ctx.sqlite, { id: 'sec', slug: 'secret', title: 'Secret', encrypted: 1, publishedAt: NOW - 500 })

    const body = (await (await request(ctx.app, ctx.env, '/api/blog/feeds')).json()) as {
      posts: { slug: string }[]
    }
    expect(body.posts).toHaveLength(120)
    expect(body.posts.some((item) => item.slug === 'secret')).toBe(false)
  })
})

describe('feed bodies are opt-in and bounded', () => {
  it('adds contentHtml only for the first 50 entries when includeContent=1', async () => {
    const files = memoryFiles()
    const ctx = await installed(files.bucket)
    for (let index = 0; index < 55; index++) {
      post(ctx.sqlite, {
        id: `p${index}`,
        slug: `post-${index}`,
        title: `Post ${index}`,
        publishedAt: NOW - index * 1000,
      })
      const key = `renders/p${index}.json`
      ctx.sqlite.prepare('UPDATE blog_posts SET render_key = ? WHERE id = ?').run(key, `p${index}`)
      files.objects.set(key, JSON.stringify({ html: `<p>Body ${index}</p>` }))
    }
    post(ctx.sqlite, { id: 'sec', slug: 'secret', title: 'Secret', encrypted: 1, publishedAt: NOW - 500 })
    const secretKey = 'renders/secret.json'
    ctx.sqlite.prepare('UPDATE blog_posts SET render_key = ? WHERE id = ?').run(secretKey, 'sec')
    files.objects.set(secretKey, JSON.stringify({ html: '<p>SECRET-BODY</p>' }))

    const bareText = await (await request(ctx.app, ctx.env, '/api/blog/feeds')).text()
    expect(bareText).not.toContain('contentHtml')

    const fullResponse = await request(ctx.app, ctx.env, '/api/blog/feeds?includeContent=1')
    const fullText = await fullResponse.text()
    const body = JSON.parse(fullText) as { posts: { slug: string; contentHtml?: string }[] }
    expect(body.posts).toHaveLength(55)
    expect(body.posts.slice(0, 50).every((item) => item.contentHtml)).toBe(true)
    expect(body.posts.slice(50).some((item) => item.contentHtml)).toBe(false)
    expect(body.posts.some((item) => item.slug === 'secret')).toBe(false)
    expect(fullText).not.toContain('SECRET-BODY')
    expect(fullText.length - bareText.length).toBeGreaterThan(1000)
  })
})

describe('tag lookups stay inside the D1 bind budget', () => {
  it('batches more than 100 post ids instead of sending one oversized statement', async () => {
    const ctx = await installed()
    // D1 refuses a statement with more than 100 bound parameters. The wrapper fails the test the
    // way the real database would, while node:sqlite would otherwise happily accept 121.
    const limited = {
      prepare(sql: string) {
        const statement = ctx.db.prepare(sql)
        return {
          bind(...values: unknown[]) {
            if (values.length > 100) throw new Error('D1_ERROR: variable number must be between ?1 and ?100')
            return statement.bind(...values)
          },
        }
      },
    } as unknown as D1Database
    const ids = Array.from({ length: 121 }, (_, index) => `p${index}`)
    await expect(listPostTags(limited, USER, ids)).resolves.toBeInstanceOf(Map)
  })
})

describe('out-of-range pages select nothing', () => {
  it('answers a negative, zero or non-numeric page with an empty set', async () => {
    const ctx = await installed()
    post(ctx.sqlite, { id: 'one', slug: 'one', title: 'Public one' })
    post(ctx.sqlite, { id: 'two', slug: 'two', title: 'Public two' })

    for (const page of ['-1', '0', 'abc', '1.5']) {
      const body = (await (await request(ctx.app, ctx.env, `/api/blog/posts?page=${page}`)).json()) as {
        items: unknown[]
        total: number
      }
      expect(body.items, `page=${page}`).toEqual([])
      expect(body.total, `page=${page}`).toBe(0)
    }

    const pastLast = (await (await request(ctx.app, ctx.env, '/api/blog/posts?page=999')).json()) as {
      items: unknown[]
      total: number
    }
    expect(pastLast.items).toEqual([])
    expect(pastLast.total).toBe(2)

    const first = (await (await request(ctx.app, ctx.env, '/api/blog/posts')).json()) as { items: unknown[] }
    expect(first.items).toHaveLength(2)

    const search = (await (await request(ctx.app, ctx.env, '/api/blog/search?q=Public&page=-1')).json()) as {
      items: unknown[]
    }
    expect(search.items).toEqual([])
  })
})
