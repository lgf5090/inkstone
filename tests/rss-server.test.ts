// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLibrary, newFeed } from '../src/shared/rss/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { parseServerFeed } from '../src/worker/lib/rss-parse'
import { runRssSchedulerTick } from '../src/worker/lib/rss-scheduler'
import { loadServerRssArticles, saveServerRssArticles, storeRssLibrary } from '../src/worker/lib/rss-store'
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

  it('parses JSON Feed on the server', () => {
    const parsed = parseServerFeed(JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1', title: 'JSON', items: [{ id: '1', title: 'One', content_text: 'Body' }],
    }), 'f1', 'https://example.com/feed.json')
    expect(parsed.entries[0].content).toContain('Body')
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<rss><channel><title>Example</title><item><title>Fresh</title><link>https://example.com/fresh</link></item></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } })))
    expect(await runRssSchedulerTick(db, now)).toEqual({ refreshed: 1, failed: 0 })
    expect((await loadServerRssArticles(db, USER, 'f1')).map(entry => entry.title)).toEqual(['Fresh'])
    expect(await runRssSchedulerTick(db, now + 1000)).toEqual({ refreshed: 0, failed: 0 })
  })
})
