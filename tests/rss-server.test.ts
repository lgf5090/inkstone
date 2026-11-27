// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLibrary, newFeed } from '../src/shared/rss/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { parseServerFeed } from '../src/worker/lib/rss-parse'
import { runRssSchedulerTick } from '../src/worker/lib/rss-scheduler'
import { createRssRule, loadRssReadingStats, loadServerRssArticles, saveServerRssArticles, searchServerRssArticles, storeRssLibrary } from '../src/worker/lib/rss-store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'server-rss-user'
let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, settings, created_at, last_seen_at)
    VALUES (?1, ?1, 'x', ?1, '', 'owner', '{}', 1, 1)`).run(USER)
  db = makeD1(sqlite)
})

afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })

describe('server feed parsing and storage', () => {
  it('parses RSS into stable article rows and reads them back', async () => {
    const parsed = parseServerFeed(`<rss version="2.0"><channel><title>Server feed</title><link>https://example.com/</link>
      <item><title>One</title><link>https://example.com/1</link><guid>one</guid><pubDate>Tue, 02 Sep 2025 08:30:00 GMT</pubDate>
      <description>&lt;p&gt;Body&lt;/p&gt;</description><enclosure url="https://cdn.example/one.mp3" type="audio/mpeg"/></item>
      <item><title>Two</title><link>https://example.com/2</link><guid>two</guid></item></channel></rss>`, 'f1', 'https://example.com/feed.xml')
    expect(parsed.title).toBe('Server feed')
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.entries[0].content).toContain('<p>Body</p>')
    expect(parsed.entries[0].audioUrl).toBe('https://cdn.example/one.mp3')
    await saveServerRssArticles(db, USER, 'f1', parsed.entries, 10)
    const stored = await loadServerRssArticles(db, USER, 'f1')
    expect(stored.map(entry => entry.title)).toEqual(['One', 'Two'])
    expect(stored[0].publishedTs).toBe(Date.UTC(2025, 8, 2, 8, 30))
  })

  it('searches titles, summaries and bodies in the server article store', async () => {
    await storeRssLibrary(db, USER, { ...emptyLibrary(), feeds: [newFeed('f1', 'https://example.com/feed', 'Search', 0)] }, 1)
    const parsed = parseServerFeed('<rss><channel><title>Search</title><item><title>Alpha</title><description>Needle in body</description></item><item><title>Beta</title><description>Other</description></item></channel></rss>', 'f1', 'https://example.com/feed')
    await saveServerRssArticles(db, USER, 'f1', parsed.entries, 1)
    expect((await searchServerRssArticles(db, USER, 'Needle')).map(entry => entry.title)).toEqual(['Alpha'])
    expect(await searchServerRssArticles(db, USER, 'missing')).toEqual([])
  })

  it('parses JSON Feed on the server', () => {
    const parsed = parseServerFeed(JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1', title: 'JSON', items: [{ id: '1', title: 'One', content_text: 'Body' }],
    }), 'f1', 'https://example.com/feed.json')
    expect(parsed.entries[0].content).toContain('Body')
  })

  it('queues signed-webhook deliveries for new articles without exporting body text', async () => {
    sqlite.prepare(`INSERT INTO note_webhooks (id, user_id, title, url, secret_ciphertext, events, enabled, created_at, updated_at)
      VALUES ('hook-rss', ?1, 'RSS', 'https://hooks.example/rss', 'cipher', '["rss.article.new"]', 1, 1, 1)`).run(USER)
    sqlite.prepare(`INSERT INTO note_webhooks (id, user_id, title, url, secret_ciphertext, events, enabled, created_at, updated_at)
      VALUES ('hook-notes', ?1, 'Notes', 'https://hooks.example/notes', 'cipher', '["note.created"]', 1, 1, 1)`).run(USER)
    const parsed = parseServerFeed(`<rss><channel><title>Hook</title><item><title>Public title</title><description>Private body ${'x'.repeat(1000)} Private tail</description></item></channel></rss>`, 'f1', 'https://example.com/feed')
    await saveServerRssArticles(db, USER, 'f1', parsed.entries, 10)
    await saveServerRssArticles(db, USER, 'f1', parsed.entries, 11)
    const rows = sqlite.prepare('SELECT webhook_id, event, payload FROM note_webhook_deliveries ORDER BY webhook_id').all() as Array<{ webhook_id: string, event: string, payload: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ webhook_id: 'hook-rss', event: 'rss.article.new' })
    expect(rows[0].payload).toContain('Public title')
    expect(rows[0].payload).not.toContain('Private tail')
  })

  it('summarizes reading state and recent opens', async () => {
    const feed = newFeed('f1', 'https://example.com/feed', 'Example', 0)
    const library = { ...emptyLibrary(), feeds: [feed], readIds: ['e1'], favorites: ['e1'], opened: { e1: Date.now() } }
    await storeRssLibrary(db, USER, library, 1)
    await saveServerRssArticles(db, USER, 'f1', [
      { id: 'e1', feedId: 'f1', title: 'One', link: 'https://example.com/1', author: '', publishedTs: 2, summary: '', content: '', imageUrl: '', audioUrl: '' },
      { id: 'e2', feedId: 'f1', title: 'Two', link: 'https://example.com/2', author: '', publishedTs: 1, summary: '', content: '', imageUrl: '', audioUrl: '' },
    ], 1)
    const stats = await loadRssReadingStats(db, USER)
    expect(stats).toMatchObject({ total: 2, read: 1, unread: 1, favorites: 1 })
    expect(stats.daily.reduce((sum, day) => sum + day.count, 0)).toBe(1)
  })

  it('refuses entity declarations', () => {
    expect(() => parseServerFeed('<!DOCTYPE rss [<!ENTITY x "boom">]><rss><channel>&x;</channel></rss>', 'f1', 'https://example.com/feed'))
      .toThrow(/entities/i)
  })
})

describe('scheduled server refresh', () => {
  it('refreshes only due feeds and stores their articles', async () => {
    const now = Date.UTC(2026, 10, 27, 12)
    sqlite.prepare('UPDATE users SET settings = ?1 WHERE id = ?2').run(JSON.stringify({ rss: { refreshIntervalMinutes: 5 } }), USER)
    const feed = { ...newFeed('f1', 'https://example.com/feed.xml', 'Example', 0), lastAttemptAt: now - 6 * 60_000 }
    await storeRssLibrary(db, USER, { ...emptyLibrary(), feeds: [feed] }, 1)
    await createRssRule(db, USER, 'f1', 'Fresh')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<rss><channel><title>Example</title><item><title>Fresh</title><link>https://example.com/fresh</link></item></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } })))
    expect(await runRssSchedulerTick(db, now)).toEqual({ refreshed: 1, failed: 0 })
    expect((await loadServerRssArticles(db, USER, 'f1')).map(entry => entry.title)).toEqual(['Fresh'])
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications WHERE user_id = ?').get(USER)).toMatchObject({ count: 1 })
    expect(await runRssSchedulerTick(db, now + 1000)).toEqual({ refreshed: 0, failed: 0 })
    expect(await runRssSchedulerTick(db, now + 6 * 60_000)).toEqual({ refreshed: 1, failed: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications WHERE user_id = ?').get(USER)).toMatchObject({ count: 1 })
  })
})
