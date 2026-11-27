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
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { diffLibrary } from '../src/shared/rss/patch'
import { loadRssLibrary, loadRssReading, rssFeedExists, rssMarkPatchFits, saveRssReadingFeed, storeRssLibrary, storeRssPatch } from '../src/worker/lib/rss-store'
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
    await saveRssReadingFeed(db, USER, 'f1', [{ id: 'e1', feedId: 'f1', title: 'One', link: 'https://example.com/1', author: '', content: 'Body', summary: '', publishedTs: 1, imageUrl: '', audioUrl: '' }], 1)
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(USER)
    for (const table of ['rss_feed', 'rss_feed_tag', 'rss_group', 'rss_mark', 'rss_state', 'rss_reading_entry', 'rss_article']) {
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

describe('the assistant reading cache', () => {
  function entry(id: string, feedId: string, publishedTs: number) {
    return { id, feedId, title: id, link: `https://example.test/${id}`, author: '', publishedTs, summary: '', content: id, imageUrl: '', audioUrl: '' }
  }

  it('keeps concurrent feed uploads in separate rows', async () => {
    await Promise.all([
      saveRssReadingFeed(db, USER, 'f1', [entry('a', 'f1', 1)], 1),
      saveRssReadingFeed(db, USER, 'f2', [entry('b', 'f2', 2)], 2),
    ])
    expect(Object.keys((await loadRssReading(db, USER))?.feeds ?? {}).sort()).toEqual(['f1', 'f2'])
  })

  it('keeps the newest feed when the account ceiling is reached', async () => {
    for (let feed = 0; feed < 6; feed++) {
      const rows = Array.from({ length: 40 }, (_unused, index) => entry(`e${feed}-${index}`, `f${feed}`, feed * 100 + index))
      await saveRssReadingFeed(db, USER, `f${feed}`, rows, feed + 1)
    }
    const snapshot = await loadRssReading(db, USER)
    expect(snapshot?.feeds.f5.entries).toHaveLength(40)
    expect(Object.values(snapshot?.feeds ?? {}).reduce((sum, feed) => sum + feed.entries.length, 0)).toBe(180)
  })
})
