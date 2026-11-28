// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  RSS_LIMITS,
  emptyLibrary,
  newFeed,
  newGroup,
  type RssLibrary,
} from '../src/shared/rss/model'
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { diffLibrary } from '../src/shared/rss/patch'
import { loadRssLibrary, loadServerRssArticles, queryServerRssArticles, rssFeedExists, rssMarkPatchFits, saveServerRssArticles, storeRssLibrary, storeRssPatch } from '../src/worker/lib/rss-store'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-store'
const OTHER = 'user-other'

let sqlite: DatabaseSync
let db: D1Database

// `node:sqlite` only takes its own input types, so the values a test binds are checked at the call
// site instead of being widened away.
function select<T>(sql: string, ...values: SQLInputValue[]): T[] {
  return sqlite.prepare(sql).all(...values) as T[]
}

function count(table: string, userId = USER): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number }).n
}

function library(): RssLibrary {
  const value = emptyLibrary()
  const shelf = newGroup('g1', 'Tech', 0, null, 5)
  const child = newGroup('g2', 'Front end', 1, 'g1', 6)
  child.collapsed = true
  const weekly = newFeed('f1', 'https://weekly.test/feed.xml', 'A weekly', 0)
  weekly.tags = ['tech', 'tech/front-end']
  weekly.siteUrl = 'https://weekly.test'
  weekly.imageUrl = 'https://weekly.test/logo.png'
  weekly.groupId = 'g2'
  weekly.etag = '"v7"'
  weekly.lastModified = 'Tue, 02 Sep 2025 08:30:00 GMT'
  weekly.updatedAt = 11
  weekly.paused = true
  const podcast = newFeed('f2', 'https://show.test/feed', 'A show', 1)
  podcast.pinned = true
  podcast.error = 'unreachable'
  podcast.errorCount = 3
  podcast.lastErrorAt = 9
  value.groups.push(shelf, child)
  value.feeds.push(weekly, podcast)
  value.readIds = ['e30', 'e2', 'e1']
  value.favorites = ['e2']
  value.readLater = ['e3']
  value.hiddenIds = ['e9']
  value.opened = { e1: 100, e2: 200 }
  value.savedNotes = { 'e1|note': 'n1', 'e2|copy': 'n2' }
  value.lastChannel = 'group:g1'
  return value
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  for (const id of [USER, OTHER]) {
    sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, settings, created_at, last_seen_at)
      VALUES (?, ?, 'x', ?, '', 'owner', '{}', 1, 1)`).run(id, id, id)
  }
  db = makeD1(sqlite)
})

describe('the row store', () => {
  it('hands back the library it was given', async () => {
    const want = library()
    await storeRssLibrary(db, USER, want, 500)
    const got = await loadRssLibrary(db, USER)
    expect(got.savedAt).toBe(500)
    expect(got.library).toEqual(want)
  })

  it('round-trips a per-feed read watermark', async () => {
    const base = library()
    base.feeds[0]!.readBefore = 1_700_000_000_000
    await storeRssLibrary(db, USER, base, 1)
    const got = await loadRssLibrary(db, USER)
    expect(got.library?.feeds[0]?.readBefore).toBe(1_700_000_000_000)
  })

  it('answers null for an account that has never saved', async () => {
    expect(await loadRssLibrary(db, USER)).toEqual({ savedAt: 0, library: null })
  })

  it('applies concurrent change sets without deleting unrelated marks', async () => {
    const base = { ...library(), favorites: [] }
    await storeRssLibrary(db, USER, base, 1)
    const first = diffLibrary(base, { ...base, favorites: ['e1'] }, () => 10)
    const second = diffLibrary(base, { ...base, favorites: ['e2'] }, () => 20)
    await storeRssPatch(db, USER, { ...first, feeds: { upsert: [], remove: [] } }, 2)
    await storeRssPatch(db, USER, { ...second, feeds: { upsert: [], remove: [] } }, 3)
    const got = await loadRssLibrary(db, USER)
    expect(got.library?.favorites).toEqual(['e2', 'e1'])
  })

  it('checks marks-only ceilings from counts and touched keys', async () => {
    const base = library()
    base.favorites = Array.from({ length: RSS_LIMITS.favorites }, (_, index) => `e${index}`)
    await storeRssLibrary(db, USER, base, 1)
    const overflow = diffLibrary(base, { ...base, favorites: ['extra', ...base.favorites] }, () => 2)
    expect(await rssMarkPatchFits(db, USER, overflow)).toBe(false)
    const removal = diffLibrary(base, { ...base, favorites: base.favorites.slice(1) }, () => 3)
    expect(await rssMarkPatchFits(db, USER, removal)).toBe(true)
  })

  it('finds one migrated feed without depending on a full library read', async () => {
    const base = library()
    await storeRssLibrary(db, USER, base, 1)
    expect(await rssFeedExists(db, USER, 'f1')).toBe(true)
    expect(await rssFeedExists(db, USER, 'missing')).toBe(false)
  })

  it('removes every RSS row when the account is deleted', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    await saveServerRssArticles(db, USER, 'f1', [{ id: 'e1', feedId: 'f1', title: 'One', link: 'https://example.com/1', author: '', content: 'Body', summary: '', publishedTs: 1, imageUrl: '', audioUrl: '' }], 1)
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(USER)
    for (const table of ['rss_feed', 'rss_feed_tag', 'rss_group', 'rss_mark', 'rss_state', 'rss_article', 'rss_rule']) {
      expect(count(table, USER)).toBe(0)
    }
  })

  it('keeps one account inside its own rows', async () => {
    await storeRssLibrary(db, USER, library(), 500)
    expect(await loadRssLibrary(db, OTHER)).toEqual({ savedAt: 0, library: null })
    expect(count('rss_feed', OTHER)).toBe(0)
  })

  it('carries a boolean as a boolean, not as the number it is stored in', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    const got = (await loadRssLibrary(db, USER)).library!
    expect(got.feeds[0].paused).toBe(true)
    expect(got.feeds[1].pinned).toBe(true)
    expect(got.feeds[0].pinned).toBe(false)
    expect(got.groups[1].collapsed).toBe(true)
    expect(got.groups[0].collapsed).toBe(false)
  })

  it('writes no rows a save did not change', async () => {
    const want = library()
    await storeRssLibrary(db, USER, want, 1)
    const again = await storeRssLibrary(db, USER, want, 2)
    expect(again.rowsWritten).toBe(1)
    expect(again.rowsDeleted).toBe(0)
    expect(again.pending).toHaveLength(1)
  })

  it('keeps a mark when the reader reshuffles the list it arrived in', async () => {
    const first = library()
    await storeRssLibrary(db, USER, first, 1)
    const shuffled = { ...first, favorites: [...first.favorites].reverse(), readIds: [...first.readIds].reverse() }
    const report = await storeRssLibrary(db, USER, shuffled, 2)
    expect(report.rowsWritten).toBe(1)
    expect(report.rowsDeleted).toBe(0)
  })

  it('drops the tag rows of a feed that is gone', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    expect(count('rss_feed_tag')).toBe(2)
    const fewer = library()
    fewer.feeds = [fewer.feeds[1]!]
    fewer.groups = [fewer.groups[0]!]
    await storeRssLibrary(db, USER, fewer, 2)
    expect(count('rss_feed')).toBe(1)
    expect(count('rss_feed_tag')).toBe(0)
    expect(count('rss_group')).toBe(1)
    const got = (await loadRssLibrary(db, USER)).library!
    expect(got.feeds.map(feed => feed.id)).toEqual(['f2'])
  })

  it('loses a saved-note key that names no note kind', async () => {
    const bad = library()
    bad.savedNotes['e3|bogus'] = 'n3'
    await storeRssLibrary(db, USER, bad, 1)
    const got = (await loadRssLibrary(db, USER)).library!
    expect(got.savedNotes).toEqual({ 'e1|note': 'n1', 'e2|copy': 'n2' })
    expect(count('rss_mark')).toBe(10)
  })

  it('moves the state row last, so a save that dies cannot read as an empty library', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    const fewer = library()
    fewer.feeds = [fewer.feeds[0]!]
    const report = await storeRssLibrary(db, USER, fewer, 2)
    expect(report.pending.length).toBeGreaterThan(1)
    expect(report.pending.at(-1)!.sql).toMatch(/^INSERT OR REPLACE INTO rss_state/)
    expect(report.pending.slice(0, -1).every(statement => !statement.sql.includes('rss_state'))).toBe(true)
  })

  it('stores the decisions and none of the reading', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    const columns = ['rss_feed', 'rss_feed_tag', 'rss_group', 'rss_mark', 'rss_state']
      .flatMap(table => select<{ name: string }>(`PRAGMA table_info(${table})`).map(row => `${table}.${row.name}`))
    expect(columns.filter(name => /content|summary|body|entry_title|article/i.test(name))).toEqual([])
  })

  it('stays inside the D1 ceilings with a full library', async () => {
    const big = emptyLibrary()
    big.readIds = Array.from({ length: RSS_LIMITS.readIds }, (_unused, index) => `e${index}`)
    big.favorites = Array.from({ length: RSS_LIMITS.favorites }, (_unused, index) => `s${index}`)
    big.hiddenIds = Array.from({ length: RSS_LIMITS.hiddenIds }, (_unused, index) => `h${index}`)
    big.opened = Object.fromEntries(Array.from({ length: RSS_LIMITS.openedRecords }, (_unused, index) => [`o${index}`, index]))
    for (let index = 0; index < RSS_LIMITS.feeds; index++) {
      const feed = newFeed(`f${index}`, `https://feed${index}.test/rss`, `Feed ${index}`, index)
      feed.tags = ['one', 'two', 'three']
      big.feeds.push(feed)
    }
    const report = await storeRssLibrary(db, USER, big, 3)
    expect(Math.max(...report.pending.map(statement => statement.params.length))).toBeLessThanOrEqual(90)
    const got = (await loadRssLibrary(db, USER)).library!
    expect(got.feeds).toHaveLength(RSS_LIMITS.feeds)
    expect(got.readIds).toHaveLength(RSS_LIMITS.readIds)
    expect(got.favorites).toHaveLength(RSS_LIMITS.favorites)
    expect(Object.keys(got.opened)).toHaveLength(RSS_LIMITS.openedRecords)
  })
})

describe('the legacy column', () => {
  function seed(rss: string | null, userId = USER): void {
    sqlite.prepare('UPDATE users SET rss = ? WHERE id = ?').run(rss, userId)
  }

  it('splits a stored blob into rows on the first read', async () => {
    seed(JSON.stringify({ savedAt: 4242, version: 2, library: library() }))
    const got = await loadRssLibrary(db, USER)
    expect(got.savedAt).toBe(4242)
    expect(got.library).toEqual(library())
    expect(count('rss_feed')).toBe(2)
    expect(count('rss_group')).toBe(2)
    expect(count('rss_mark')).toBe(10)
    expect(sqlite.prepare('SELECT rss FROM users WHERE id = ?').get(USER)).toEqual({ rss: null })
  })

  it('keeps the order a blob spelled out with position', async () => {
    const old = library()
    old.readIds = ['c', 'a', 'b']
    seed(JSON.stringify({ savedAt: 1, version: 2, library: old }))
    const got = (await loadRssLibrary(db, USER)).library!
    expect(got.readIds).toEqual(['c', 'a', 'b'])
    const times = select<{ entry_id: string; at: number }>('SELECT entry_id, at FROM rss_mark WHERE kind = ?1', 'read')
      .map(row => `${row.entry_id}:${row.at}`).sort()
    expect(times).toEqual(['a:-1', 'b:-2', 'c:0'])
  })

  it('does not run the split twice', async () => {
    seed(JSON.stringify({ savedAt: 7, version: 2, library: library() }))
    await loadRssLibrary(db, USER)
    const again = await storeRssLibrary(db, USER, library(), 7)
    expect(again.rowsWritten).toBe(0)
    expect(count('rss_state')).toBe(1)
  })

  it('preserves a corrupt blob and reports that it could not be migrated', async () => {
    seed('{ not json')
    await expect(loadRssLibrary(db, USER)).rejects.toThrow(/legacy data was left untouched/)
    expect(sqlite.prepare('SELECT rss FROM users WHERE id = ?').get(USER)).toEqual({ rss: '{ not json' })
    expect(count('rss_state')).toBe(0)
  })

  it('preserves a legacy library that would lose data during migration', async () => {
    const old = library()
    old.favorites = Array.from({ length: RSS_LIMITS.favorites + 1 }, (_, index) => `saved-${index}`)
    const raw = JSON.stringify({ savedAt: 1, version: 2, library: old })
    seed(raw)
    await expect(loadRssLibrary(db, USER)).rejects.toThrow(/without losing data/)
    expect(sqlite.prepare('SELECT rss FROM users WHERE id = ?').get(USER)).toEqual({ rss: raw })
    expect(count('rss_state')).toBe(0)
  })

  it('leaves an account that never had a blob alone', async () => {
    expect(await loadRssLibrary(db, OTHER)).toEqual({ savedAt: 0, library: null })
    expect(count('rss_state', OTHER)).toBe(0)
  })

  it('migrates only its own account', async () => {
    seed(JSON.stringify({ savedAt: 9, version: 2, library: library() }), OTHER)
    expect(await loadRssLibrary(db, USER)).toEqual({ savedAt: 0, library: null })
    const got = await loadRssLibrary(db, OTHER)
    expect(got.savedAt).toBe(9)
    expect(count('rss_feed', USER)).toBe(0)
    expect(count('rss_feed', OTHER)).toBe(2)
  })
})

describe('the server article store', () => {
  it('moves legacy assistant snapshots into article rows and drops the duplicate table', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    sqlite.exec(`CREATE TABLE rss_reading_entry (
      user_id TEXT NOT NULL, feed_id TEXT NOT NULL, entry_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', published_ts INTEGER,
      image_url TEXT NOT NULL DEFAULT '', audio_url TEXT NOT NULL DEFAULT '', captured_at INTEGER NOT NULL DEFAULT 0
    )`)
    sqlite.prepare(`INSERT INTO rss_reading_entry
      (user_id, feed_id, entry_id, title, link, author, content, summary, published_ts, captured_at)
      VALUES (?, 'f1', 'legacy', 'Legacy', 'https://example.test/legacy', 'Rae', 'Legacy body', '', 10, 20)`)
      .run(USER)
    const migration = SCHEMA_MIGRATIONS.find(item => item.version === 478)
    expect(migration).toBeDefined()
    for (const statement of migration!.statements) sqlite.exec(statement)
    expect((await queryServerRssArticles(db, USER, { feedId: 'f1' })).entries[0]).toMatchObject({ id: 'legacy', content: 'Legacy body' })
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rss_reading_entry'").get()).toBeUndefined()
  })

  function entry(id: string, feedId: string, publishedTs: number, author = 'Rae') {
    return { id, feedId, title: `Title ${id}`, link: `https://example.test/${id}`, author, publishedTs, summary: `Summary ${id}`, content: `Body ${id}`, imageUrl: '', audioUrl: '' }
  }

  it('queries fields, authors, dates and marks without crossing accounts', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    await saveServerRssArticles(db, USER, 'f1', [entry('a', 'f1', 100), entry('b', 'f1', 200, 'Kai')], 2)
    await saveServerRssArticles(db, OTHER, 'f1', [entry('other', 'f1', 300)], 3)
    expect((await queryServerRssArticles(db, USER, { field: 'author', author: 'Kai' })).entries.map(item => item.id)).toEqual(['b'])
    expect((await queryServerRssArticles(db, USER, { from: 150, to: 250 })).entries.map(item => item.id)).toEqual(['b'])
    expect((await queryServerRssArticles(db, USER, { query: 'Body a', field: 'content' })).total).toBe(1)
    expect((await queryServerRssArticles(db, USER, { mark: 'unread' })).total).toBe(2)
    expect((await queryServerRssArticles(db, USER, { query: 'other' })).total).toBe(0)
  })

  it('keeps each feed inside its own article ceiling', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    await Promise.all([
      saveServerRssArticles(db, USER, 'f1', [entry('a', 'f1', 1)], 1),
      saveServerRssArticles(db, USER, 'f2', [entry('b', 'f2', 2)], 2),
    ])
    expect((await queryServerRssArticles(db, USER, { feedId: 'f1' })).entries.map(item => item.id)).toEqual(['a'])
    expect((await queryServerRssArticles(db, USER, { feedId: 'f2' })).entries.map(item => item.id)).toEqual(['b'])
  })

  it('keeps starred and later articles ahead of ordinary rows at the per-feed limit', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    sqlite.prepare("INSERT INTO rss_mark (user_id, kind, entry_id, value, at) VALUES (?, 'star', 'old-star', '', 1)").run(USER)
    sqlite.prepare("INSERT INTO rss_mark (user_id, kind, entry_id, value, at) VALUES (?, 'later', 'old-later', '', 1)").run(USER)
    const ordinary = Array.from({ length: RSS_LIMITS.entriesPerFeed }, (_, index) => entry(`ordinary-${index}`, 'f1', index + 100))
    await saveServerRssArticles(db, USER, 'f1', [entry('old-star', 'f1', 1), entry('old-later', 'f1', 2), ...ordinary], 3)
    const stored = await loadServerRssArticles(db, USER, 'f1')
    expect(stored).toHaveLength(RSS_LIMITS.entriesPerFeed)
    expect(stored.map(item => item.id)).toContain('old-star')
    expect(stored.map(item => item.id)).toContain('old-later')
    expect(stored.map(item => item.id)).not.toContain('ordinary-0')
  })

  it('releases protected bodies over the byte budget while keeping their summaries', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    for (const id of ['protected-a', 'protected-b', 'protected-c']) {
      sqlite.prepare("INSERT INTO rss_mark (user_id, kind, entry_id, value, at) VALUES (?, 'star', ?, '', 1)").run(USER, id)
    }
    const body = 'x'.repeat(100_000)
    await saveServerRssArticles(db, USER, 'f1', [
      { ...entry('protected-a', 'f1', 3), content: body },
      { ...entry('protected-b', 'f1', 2), content: body },
      { ...entry('protected-c', 'f1', 1), content: body },
    ], 4)
    const stored = await loadServerRssArticles(db, USER, 'f1')
    expect(stored.map(item => item.id)).toEqual(['protected-a', 'protected-b', 'protected-c'])
    expect(stored[0]?.content).toHaveLength(100_000)
    expect(stored[1]?.content).toHaveLength(100_000)
    expect(stored[2]).toMatchObject({ content: '', contentReleased: true, summary: 'Summary protected-c' })
  })

  it('still evicts ordinary articles that exceed the byte budget', async () => {
    await storeRssLibrary(db, USER, library(), 1)
    const body = 'x'.repeat(100_000)
    await saveServerRssArticles(db, USER, 'f1', [
      { ...entry('large-a', 'f1', 3), content: body },
      { ...entry('large-b', 'f1', 2), content: body },
      { ...entry('large-c', 'f1', 1), content: body },
    ], 4)
    expect((await loadServerRssArticles(db, USER, 'f1')).map(item => item.id)).toEqual(['large-a', 'large-b'])
  })
})
