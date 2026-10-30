/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { BLOG_SCHEMA_STATEMENTS } from '../src/worker/blog/schema'
import { listPublicCollection, saveCollectionItem } from '../src/worker/blog/collections'
import {
  findPublishedPost,
  listAdminPosts,
  listPublishedPosts,
  publishPostSnapshot,
  syncBlogPostFromNote,
  updateAdminPostMeta,
} from '../src/worker/blog/store'
import { sha256Hex } from '../src/worker/lib/encoding'
import { DEFAULT_BLOG_SETTINGS, publicBlogSite } from '@shared/blog/settings'
import type { BlogRenderSnapshot } from '@shared/blog/model'

type SqliteDatabase = {
  prepare(sql: string): { run(...values: unknown[]): unknown; all(...values: unknown[]): unknown[] }
  exec(sql: string): void
}

function positionalSql(sql: string): string {
  let max = 0
  for (const match of sql.matchAll(/\?(\d+)/g)) max = Math.max(max, Number(match[1]))
  let next = max
  return sql.replace(/\?(?!\d)/g, () => `?${++next}`)
}

function bindArgs(sql: string, values: unknown[]): unknown[] {
  const normalized = positionalSql(sql)
  return /\?\d+/.test(normalized)
    ? [Object.fromEntries(values.map((value, index) => [String(index + 1), value]))]
    : values
}

function topLevelVerb(sql: string): string | null {
  let depth = 0
  for (const match of sql.matchAll(/[()]|\b(select|insert|update|delete)\b/gi)) {
    const token = match[0]
    if (token === '(') depth += 1
    else if (token === ')') depth -= 1
    else if (depth === 0) return token.toLowerCase()
  }
  return null
}

function d1Over(sqlite: SqliteDatabase): D1Database {
  const db = {
    prepare(rawSql: string) {
      const sql = positionalSql(rawSql)
      let values: unknown[] = []
      const run = () => Number(sqlite.prepare(sql).run(...bindArgs(sql, values)) as { changes: number }['changes'])
      const statement = {
        bind(...bound: unknown[]) {
          values = bound
          return statement
        },
        async all() {
          if (topLevelVerb(sql) === 'select') {
            return { results: sqlite.prepare(sql).all(...bindArgs(sql, values)), meta: { changes: 0 } }
          }
          if (/\breturning\b/i.test(sql)) {
            const rows = sqlite.prepare(sql).all(...bindArgs(sql, values))
            return { results: rows, meta: { changes: rows.length } }
          }
          return { results: [], meta: { changes: run() } }
        },
        async first() {
          const result = await statement.all()
          return (result.results as Record<string, unknown>[])[0] ?? null
        },
        async run() {
          return { meta: { changes: run() } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ all(): Promise<{ results: unknown[]; meta?: { changes: number } }> }>) {
      sqlite.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.all())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
  return db as unknown as D1Database
}

const USER = 'owner-1'
const NOTE = 'note-1'

function memoryBucket(): R2Bucket {
  const objects = new Map<string, string>()
  return {
    async put(key: string, value: string) {
      objects.set(key, value)
      return {}
    },
    async get(key: string) {
      const text = objects.get(key)
      return text === undefined ? null : { text: async () => text }
    },
    async head(key: string) {
      return objects.has(key) ? {} : null
    },
  } as unknown as R2Bucket
}

function note(content: string, deletedAt: number | null = null) {
  return { id: NOTE, title: 'Scheduled story', content, deleted_at: deletedAt }
}

function snapshot(content: string, html: string): BlogRenderSnapshot {
  return {
    version: 1,
    rendererVersion: 'test',
    noteId: NOTE,
    contentHash: '',
    html,
    headings: [],
    fences: { kanban: [], excalidraw: [] },
    features: [],
    assets: [],
    wikiLinks: [],
    settings: { locale: 'en', emojiShortcodes: false },
    generatedAt: Date.now(),
    warnings: [],
  } as BlogRenderSnapshot
}

describe('blog admin projection', () => {
  let sqlite: SqliteDatabase
  let db: D1Database

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:') as unknown as SqliteDatabase
    for (const statement of BLOG_SCHEMA_STATEMENTS) sqlite.exec(statement)
    sqlite.exec(`CREATE TABLE notes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, deleted_at INTEGER
    )`)
    sqlite.exec('CREATE TABLE tags (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, color TEXT)')
    sqlite.exec('CREATE TABLE note_tags (note_id TEXT, tag_id TEXT, user_id TEXT)')
    sqlite.prepare(`INSERT INTO notes (id, user_id, title, content, deleted_at) VALUES (?, ?, ?, ?, ?)`)
      .run(NOTE, USER, 'Scheduled story', '', null)
    db = d1Over(sqlite)
  })

  it('keeps a draft projection for a blog note that is not published', async () => {
    const row = await syncBlogPostFromNote(db, USER, note('---\nblogType: post\nisPublished: false\n---\n\nBody'))
    expect(row?.status).toBe('draft')
    expect(row?.published_at).toBeNull()
    expect(row?.slug).toBe('scheduled-story')
  })

  it('holds a future publication out of every public read', async () => {
    const future = Date.now() + 86_400_000
    const content = `---\nblogType: post\nisPublished: true\nblogPublishedAt: ${new Date(future).toISOString()}\n---\n\nBody`
    const row = await syncBlogPostFromNote(db, USER, note(content))
    expect(row?.status).toBe('scheduled')
    expect(row?.published_at).toBe(future)
    expect((await listPublishedPosts(db, USER, 1, 10)).rows).toHaveLength(0)
    expect(await findPublishedPost(db, USER, row!.slug)).toBeNull()
  })

  it('turns a due scheduled post into a published row on the next admin read', async () => {
    const content = '---\nblogType: post\nisPublished: true\n---\n\nBody'
    const future = Date.now() + 60_000
    const row = await syncBlogPostFromNote(db, USER, note(content), Date.now() - 1000)
    sqlite.prepare('UPDATE blog_posts SET status = ?, published_at = ?, render_status = ? WHERE user_id = ? AND id = ?')
      .run('scheduled', Date.now() - 1, 'ready', USER, row!.id)
    const listed = await listAdminPosts(db, USER, { status: 'published' })
    expect(listed.rows.map((item) => item.id)).toEqual([row!.id])
    expect(listed.rows[0].status).toBe('published')
    sqlite.prepare('UPDATE blog_posts SET status = ?, published_at = ? WHERE user_id = ? AND id = ?')
      .run('scheduled', future, USER, row!.id)
    const stillScheduled = await listAdminPosts(db, USER, { status: 'published' })
    expect(stillScheduled.rows).toHaveLength(0)
  })

  it('publishes a ready snapshot and serves it once its time has come', async () => {
    const content = '---\nblogType: post\nisPublished: true\n---\n\nBody'
    const rendered = snapshot(content, '<p>Body</p>')
    rendered.contentHash = await sha256Hex(content)
    const row = await syncBlogPostFromNote(db, USER, note(content), Date.now() - 1000)
    sqlite.prepare('UPDATE notes SET content = ? WHERE id = ?').run(content, NOTE)
    await publishPostSnapshot(db, memoryBucket(), USER, NOTE, rendered, Date.now())
    const published = await findPublishedPost(db, USER, row!.slug)
    expect(published?.status).toBe('published')
    const list = await listPublishedPosts(db, USER, 1, 10)
    expect(list.rows.map((item) => item.slug)).toEqual([row!.slug])
  })

  it('does not resurrect a trashed projection when its note keeps changing', async () => {
    const content = '---\nblogType: post\nisPublished: true\n---\n\nBody'
    const row = await syncBlogPostFromNote(db, USER, note(content))
    sqlite.prepare(`UPDATE blog_posts SET deleted_at = ?, status = 'withdrawn' WHERE user_id = ? AND id = ?`)
      .run(Date.now(), USER, row!.id)
    const again = await syncBlogPostFromNote(db, USER, note(`${content}\n\nMore`))
    expect(again?.status).toBe('withdrawn')
    expect(again?.deleted_at).not.toBeNull()
    expect(await findPublishedPost(db, USER, row!.slug)).toBeNull()
  })

  it('updates every admin metadata field in one statement and can clear a password', async () => {
    const content = '---\nblogType: post\nisPublished: true\n---\n\nBody'
    const row = await syncBlogPostFromNote(db, USER, note(content))
    const updated = await updateAdminPostMeta(db, USER, row!.id, {
      slug: 'renamed-story',
      excerpt: 'Summary',
      description: 'SEO',
      pinned: true,
      commentsEnabled: false,
      language: 'zh-CN',
      license: 'MIT',
      alias: '/alias',
      permalink: '/permalink',
      hideHomeContent: false,
      password: 'secret-pass',
    })
    expect(updated.slug).toBe('renamed-story')
    expect(updated.pinned).toBe(1)
    expect(updated.comments_enabled).toBe(0)
    expect(updated.encrypted).toBe(1)
    expect(updated.password_hash).toBeTruthy()
    const cleared = await updateAdminPostMeta(db, USER, row!.id, { clearPassword: true })
    expect(cleared.encrypted).toBe(0)
    expect(cleared.password_hash).toBeNull()
  })

  it('keeps javascript: out of the public navigation and profile links', () => {
    const settings = {
      ...DEFAULT_BLOG_SETTINGS,
      nav: { links: [{ label: 'Safe', href: '/posts' }, { label: 'Bad', href: 'javascript:alert(1)' }] },
      profile: { ...DEFAULT_BLOG_SETTINGS.profile, links: [{ label: 'Bad', url: 'javascript:alert(1)' }, { label: 'Ok', url: 'https://example.com' }] },
    }
    const site = publicBlogSite(settings, { posts: 0, categories: 0, tags: 0, series: 0 })
    expect(site.nav.map((link) => link.href)).toEqual(['/posts'])
    expect(site.profile.links.map((link) => link.url)).toEqual(['https://example.com'])
  })

  it('creates moments with their own timestamps and defaults', async () => {
    const moment = await saveCollectionItem(db, USER, 'moments', null, { content: 'Hello moment' })
    expect(moment.kind).toBe('moments')
    expect(moment.status).toBe('published')
    expect(moment.updatedAt).toBeGreaterThan(0)
    const raw = sqlite.prepare(`SELECT created_at, updated_at FROM blog_moments WHERE user_id = ? AND id = ?`)
      .all(USER, moment.id)
    expect(raw).toHaveLength(1)
  })

  it('keeps protected albums out of the public collection and strips their hint', async () => {
    const open = await saveCollectionItem(db, USER, 'albums', null, { title: 'Open album', published_at: Date.now() })
    await saveCollectionItem(db, USER, 'albums', null, {
      title: 'Locked album',
      published_at: Date.now(),
      password: 'secret-pass',
      password_hint: 'the usual one',
    })
    const items = await listPublicCollection(db, USER, 'albums')
    expect(items.map((item) => item.id)).toEqual([open.id])
    expect(items[0].data.password_hint).toBeUndefined()
    expect(items[0].data.hasPassword).toBeUndefined()
  })

  it('fills a cleared album column count instead of failing its NOT NULL column', async () => {
    const album = await saveCollectionItem(db, USER, 'albums', null, { title: 'Album', columns: null })
    const updated = await saveCollectionItem(db, USER, 'albums', album.id, { columns: null })
    expect(updated.data.columns).toBe(3)
  })
})
