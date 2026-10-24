// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MUSIC_LIMITS } from '../src/shared/music/constants'
import { DEFAULT_MUSIC_SETTINGS, type MusicSettings } from '../src/shared/music/model'
import {
  MUSIC_LYRIC_TTL_MS,
  MUSIC_PAGE_MAX,
  MusicStore,
  musicPageOffset,
  normalizeMusicLimit,
  normalizeMusicPage,
  type MusicTrackInput,
} from '../src/worker/music/store'
import { MUSIC_SCHEMA_STATEMENTS } from '../src/worker/music/schema'
import { makeD1 } from './doubles/d1-sqlite'

let sqlite: DatabaseSync
let store: MusicStore
let other: MusicStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of MUSIC_SCHEMA_STATEMENTS) sqlite.exec(statement)
  const db = makeD1(sqlite)
  store = new MusicStore(db, 'u1')
  other = new MusicStore(db, 'u2')
})

afterEach(() => {
  sqlite.close()
})

function count(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}

function trackInput(overrides: Partial<MusicTrackInput> = {}): MusicTrackInput {
  return {
    provider: 'netease',
    providerId: '42',
    title: 'Song',
    artists: [{ id: '1', name: 'Artist' }],
    album: 'Album',
    ...overrides,
  }
}

async function createTrack(overrides: Partial<MusicTrackInput> = {}) {
  return store.upsertTrack(trackInput(overrides))
}

describe('music track snapshots', () => {
  it('upsert by provider id, keeping the library id stable', async () => {
    const first = await createTrack()
    expect(first.id).toHaveLength(26)
    expect(first.provider).toBe('netease')
    expect(first.artists).toEqual([{ id: '1', name: 'Artist' }])

    const second = await createTrack({ title: 'Renamed' })
    expect(second.id).toBe(first.id)
    expect(second.title).toBe('Renamed')
    expect(count('music_track')).toBe(1)
  })

  it('keeps storage columns a metadata refresh omits', async () => {
    const key = 'music/mp3/u1/t1-original.mp3'
    const first = await createTrack({ r2Key: key, format: 'mp3', size: 1024, sha256: 'abc' })
    const second = await createTrack({ title: 'Refreshed' })
    expect(second.r2Key).toBe(key)
    expect(second.format).toBe('mp3')
    expect(second.size).toBe(1024)
    expect(second.sha256).toBe('abc')
  })

  it('never answers another account', async () => {
    const track = await createTrack()
    expect(await other.getTrack(track.id)).toBeNull()
    expect(await other.findTrack('netease', '42')).toBeNull()
    expect(await other.getTracks([track.id])).toEqual([])
    expect((await other.deleteTrack(track.id)).deleted).toBe(false)
    expect(await store.getTrack(track.id)).not.toBeNull()
  })

  it('resolves a set in the caller order', async () => {
    const first = await createTrack({ providerId: '1' })
    const second = await createTrack({ providerId: '2' })
    const resolved = await store.getTracks([second.id, 'missing', first.id])
    expect(resolved.map((track) => track.id)).toEqual([second.id, first.id])
  })
})

describe('music playlists', () => {
  it('creates, lists and updates a local playlist', async () => {
    const playlist = await store.createPlaylist({ name: 'Morning' })
    expect(playlist.trackCount).toBe(0)
    expect((await store.listPlaylists()).map((entry) => entry.id)).toEqual([playlist.id])

    const updated = await store.updatePlaylist(playlist.id, { name: 'Evening', description: 'Calm' })
    expect(updated).toMatchObject({ name: 'Evening', description: 'Calm' })
    expect(await other.getPlaylist(playlist.id)).toBeNull()
    expect(await other.updatePlaylist(playlist.id, { name: 'No' })).toBeNull()
    expect(await other.deletePlaylist(playlist.id)).toBe(false)
  })

  it('adds, orders, reorders and removes items', async () => {
    const playlist = await store.createPlaylist({ name: 'List' })
    const first = await createTrack({ providerId: '1' })
    const second = await createTrack({ providerId: '2' })

    expect(await store.addPlaylistItem(playlist.id, first.id)).toMatchObject({ position: 1 })
    expect(await store.addPlaylistItem(playlist.id, second.id)).toMatchObject({ position: 2 })
    expect(await store.addPlaylistItem(playlist.id, first.id)).toMatchObject({ position: 1 })
    expect(count('music_playlist_item')).toBe(2)

    const page = await store.listPlaylistItems(playlist.id)
    expect(page?.items.map((item) => item.track.id)).toEqual([first.id, second.id])
    expect(page?.total).toBe(2)

    await store.reorderPlaylistItems(playlist.id, [second.id, first.id])
    const reordered = await store.listPlaylistItems(playlist.id)
    expect(reordered?.items.map((item) => item.track.id)).toEqual([second.id, first.id])

    expect(await store.removePlaylistItem(playlist.id, second.id)).toBe(true)
    const remaining = await store.listPlaylistItems(playlist.id)
    expect(remaining?.items.map((item) => item.position)).toEqual([1])
    expect(await store.removePlaylistItem(playlist.id, second.id)).toBe(false)
  })

  it('adds a batch without duplicates and without tracks from another account', async () => {
    const playlist = await store.createPlaylist({ name: 'List' })
    const first = await createTrack({ providerId: '1' })
    const second = await createTrack({ providerId: '2' })
    await other.upsertTrack(trackInput({ providerId: '3' }))

    expect(await store.addPlaylistItems(playlist.id, [first.id, second.id, first.id, 'missing'])).toBe(2)
    expect(await store.addPlaylistItems(playlist.id, [first.id])).toBe(0)
    expect(await other.addPlaylistItems(playlist.id, [second.id])).toBeNull()
    expect(await store.listPlaylistItems(playlist.id)).toMatchObject({ total: 2 })
  })

  it('reorders the shelf and deletes a playlist with its items', async () => {
    const first = await store.createPlaylist({ name: 'One' })
    const second = await store.createPlaylist({ name: 'Two' })
    expect((await store.listPlaylists()).map((entry) => entry.id)).toEqual([first.id, second.id])

    await store.reorderPlaylists([second.id, first.id])
    expect((await store.listPlaylists()).map((entry) => entry.id)).toEqual([second.id, first.id])

    const track = await createTrack()
    await store.addPlaylistItem(first.id, track.id)
    expect(await store.deletePlaylist(first.id)).toBe(true)
    expect(count('music_playlist')).toBe(1)
    expect(count('music_playlist_item')).toBe(0)
  })
})

describe('music favourites', () => {
  it('adds idempotently, lists newest first and removes', async () => {
    const first = await createTrack({ providerId: '1' })
    const second = await createTrack({ providerId: '2' })
    expect(await store.addFavorite(first.id)).toBe(true)
    expect(await store.addFavorite(first.id)).toBe(true)
    expect(await store.addFavorite(second.id)).toBe(true)
    expect(count('music_favorite')).toBe(2)

    const page = await store.listFavorites({ limit: 1 })
    expect(page.total).toBe(2)
    expect(page.items).toHaveLength(1)
    expect(page.hasMore).toBe(true)

    expect(await store.removeFavorite(first.id)).toBe(true)
    expect(await store.removeFavorite(first.id)).toBe(false)
    expect(await store.isFavorite(first.id)).toBe(false)
  })

  it('refuses a track another account owns', async () => {
    const foreign = await other.upsertTrack(trackInput())
    expect(await store.addFavorite(foreign.id)).toBe(false)
    expect(await other.listFavorites()).toMatchObject({ total: 0, items: [] })
  })
})

describe('music history', () => {
  it('records a play and lists the newest entries with their track', async () => {
    const track = await createTrack()
    const early = await store.recordHistory({ trackId: track.id, playedAt: 1000 })
    const late = await store.recordHistory({ trackId: track.id, playedAt: 2000, completed: true })
    expect(early).not.toBeNull()
    expect(late?.completed).toBe(true)

    const page = await store.listHistory({ limit: 1 })
    expect(page.total).toBe(2)
    expect(page.items[0]).toMatchObject({ playedAt: 2000, track: { id: track.id } })
  })

  it('refuses another account and trims to the ceiling', async () => {
    const track = await createTrack()
    expect(await other.recordHistory({ trackId: track.id })).toBeNull()

    const insert = sqlite.prepare(
      `INSERT INTO music_history
         (user_id, id, track_id, played_at, duration_played, completed, context_type, context_id)
       VALUES (?, ?, ?, ?, 0, 0, '', '')`,
    )
    sqlite.exec('BEGIN')
    try {
      for (let index = 1; index <= MUSIC_LIMITS.historyEntries; index++) {
        insert.run('u1', `h${index}`, track.id, index)
      }
      sqlite.exec('COMMIT')
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
    expect(count('music_history')).toBe(MUSIC_LIMITS.historyEntries)

    await store.recordHistory({ trackId: track.id, playedAt: MUSIC_LIMITS.historyEntries + 1 })
    expect(count('music_history')).toBe(MUSIC_LIMITS.historyEntries)
    expect(sqlite.prepare(`SELECT MIN(played_at) AS oldest FROM music_history`).get()).toEqual({ oldest: 2 })
  })
})

describe('music recent containers', () => {
  it('upserts a visit and counts repeats', async () => {
    const first = await store.touchRecent({ kind: 'album', providerId: 'a1', name: 'Album' })
    const second = await store.touchRecent({ kind: 'album', providerId: 'a1', name: 'Album renamed' })
    expect(second.id).toBe(first.id)
    expect(second.playCount).toBe(2)
    expect(second.name).toBe('Album renamed')
    expect(await store.listRecent()).toHaveLength(1)
  })

  it('keeps the newest 500 containers', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO music_recent
         (user_id, id, kind, provider_id, name, cover_url, last_played_at, play_count)
       VALUES (?, ?, 'album', ?, 'Old', '', ?, 1)`,
    )
    sqlite.exec('BEGIN')
    try {
      for (let index = 1; index <= MUSIC_LIMITS.recentEntries; index++) {
        insert.run('u1', `r${index}`, `p${index}`, index)
      }
      sqlite.exec('COMMIT')
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }

    await store.touchRecent({ kind: 'radio', providerId: 'new', name: 'New', lastPlayedAt: 10_000 })
    expect(count('music_recent')).toBe(MUSIC_LIMITS.recentEntries)
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM music_recent WHERE provider_id = 'p1'`,
    ).get()).toEqual({ count: 0 })
    expect((await store.listRecent(1))[0]).toMatchObject({ providerId: 'new' })
  })
})

describe('music settings', () => {
  it('round-trips the settings row', async () => {
    expect(await store.getSettings()).toBeNull()
    const settings: MusicSettings = { ...DEFAULT_MUSIC_SETTINGS, quality: 'lossless' }
    await store.saveSettings(settings)
    expect(await store.getSettings()).toEqual(settings)
    expect(await other.getSettings()).toBeNull()

    await store.saveSettings({ ...settings, quality: 'hires' })
    expect((await store.getSettings())?.quality).toBe('hires')
  })

  it('accepts a large document and refuses one past 64 KB', async () => {
    const large: MusicSettings = {
      ...DEFAULT_MUSIC_SETTINGS,
      customResolverUrl: `https://example.test/${'x'.repeat(60 * 1024)}`,
    }
    await expect(store.saveSettings(large)).resolves.toBeTruthy()

    const tooLarge: MusicSettings = {
      ...DEFAULT_MUSIC_SETTINGS,
      customResolverUrl: `https://example.test/${'x'.repeat(70 * 1024)}`,
    }
    await expect(store.saveSettings(tooLarge)).rejects.toThrow(/64 KB/)
  })
})

describe('music accounts', () => {
  it('stores the cookie ciphertext without returning it from the profile', async () => {
    const saved = await store.saveAccount({
      accountId: 'a1',
      nickname: 'Listener',
      avatarUrl: 'https://example.test/avatar.jpg',
      cookieCiphertext: 'ciphertext',
    })
    expect(saved).toMatchObject({ provider: 'netease', accountId: 'a1', status: 'connected' })
    expect('cookieCiphertext' in saved).toBe(false)
    expect(await store.getAccountCookie()).toBe('ciphertext')
    expect(await other.getAccount()).toBeNull()
    expect(await other.getAccountCookie()).toBeNull()
  })

  it('keeps the ciphertext when a profile update omits it', async () => {
    await store.saveAccount({
      accountId: 'a1',
      nickname: 'Listener',
      avatarUrl: '',
      cookieCiphertext: 'ciphertext',
    })
    await store.saveAccount({ accountId: 'a1', nickname: 'Listener 2', avatarUrl: '' })
    expect(await store.getAccountCookie()).toBe('ciphertext')
    expect((await store.getAccount())?.nickname).toBe('Listener 2')
  })

  it('marks an expiry and disconnects', async () => {
    await store.saveAccount({ accountId: 'a1', nickname: 'Listener', avatarUrl: '' })
    expect(await store.markAccountStatus('expired')).toBe(true)
    expect((await store.getAccount())?.status).toBe('expired')
    expect(await other.markAccountStatus('expired')).toBe(false)
    expect(await store.deleteAccount()).toBe(true)
    expect(await store.getAccount()).toBeNull()
    expect(await store.deleteAccount()).toBe(false)
  })
})

describe('music lyrics', () => {
  it('caches by track key and treats an expired entry as a miss', async () => {
    const key = 'netease:42'
    await store.saveLyric({ trackKey: key, lrc: '[00:01.00]line', tlyric: '[00:01.00]translation' })
    expect(await store.getLyric(key)).toMatchObject({ trackKey: key, lrc: '[00:01.00]line' })
    expect(await other.getLyric(key)).toBeNull()

    sqlite.prepare(`UPDATE music_lyric SET fetched_at = ? WHERE user_id = ?`).run(Date.now() - MUSIC_LYRIC_TTL_MS - 1, 'u1')
    expect(await store.getLyric(key)).toBeNull()
  })

  it('prunes only the calling account and enforces the size ceiling', async () => {
    await store.saveLyric({ trackKey: 'netease:1', lrc: 'one' })
    await other.saveLyric({ trackKey: 'netease:1', lrc: 'one' })
    sqlite.prepare(`UPDATE music_lyric SET fetched_at = 1`).run()

    expect(await store.pruneLyrics()).toBe(1)
    expect(count('music_lyric')).toBe(1)
    expect(await other.getLyric('netease:1', { maxAgeMs: Number.MAX_SAFE_INTEGER })).not.toBeNull()

    await expect(store.saveLyric({
      trackKey: 'netease:2',
      lrc: 'x'.repeat(MUSIC_LIMITS.lyricMaxBytes + 1),
    })).rejects.toThrow(/256 KB/)
  })
})

describe('music source overrides', () => {
  it('round-trips, lists and deletes one key', async () => {
    const key = 'netease:42'
    const saved = await store.saveSourceOverride({
      trackKey: key,
      source: 'custom',
      config: { url: 'https://example.test/resolve' },
    })
    expect(saved.config).toEqual({ url: 'https://example.test/resolve' })
    expect(await store.getSourceOverride(key)).toEqual(saved)
    expect(await store.listSourceOverrides()).toEqual([saved])
    expect(await other.getSourceOverride(key)).toBeNull()
    expect(await other.deleteSourceOverride(key)).toBe(false)
    expect(await store.deleteSourceOverride(key)).toBe(true)
    expect(await store.getSourceOverride(key)).toBeNull()
  })
})

describe('music subscriptions', () => {
  it('creates idempotently by kind and provider id, then updates and removes', async () => {
    const first = await store.createSubscription({ kind: 'artist', providerId: 'ar1', name: 'Artist' })
    const second = await store.createSubscription({ kind: 'artist', providerId: 'ar1', name: 'Artist 2' })
    expect(second.id).toBe(first.id)
    expect(second.name).toBe('Artist 2')
    expect(await store.listSubscriptions()).toHaveLength(1)
    expect(await other.getSubscription(first.id)).toBeNull()

    const updated = await store.updateSubscription(first.id, { name: 'Artist 3', coverUrl: 'https://example.test/c.jpg' })
    expect(updated).toMatchObject({ name: 'Artist 3', coverUrl: 'https://example.test/c.jpg' })
    expect(await other.updateSubscription(first.id, { name: 'No' })).toBeNull()
    expect(await store.deleteSubscription(first.id)).toBe(true)
    expect(await store.deleteSubscription(first.id)).toBe(false)
  })
})

describe('music object ledger', () => {
  it('sums one row per object, not one row per registration', async () => {
    await store.registerObject({ r2Key: 'k1', format: 'mp3', quality: 'original', size: 100 })
    await store.registerObject({ r2Key: 'k2', format: 'flac', quality: 'lossless', size: 200 })
    expect(await store.quotaUsage()).toEqual({ bytes: 300, count: 2 })

    await store.registerObject({ r2Key: 'k1', format: 'mp3', quality: 'original', size: 150 })
    expect(await store.quotaUsage()).toEqual({ bytes: 350, count: 2 })
    expect(await other.quotaUsage()).toEqual({ bytes: 0, count: 0 })
    expect((await store.listObjects()).map((entry) => entry.r2Key)).toEqual(['k1', 'k2'])
  })

  it('counts track and download references before releasing an object', async () => {
    const track = await createTrack({ r2Key: 'k1' })
    await store.registerObject({ r2Key: 'k1', trackId: track.id, format: 'mp3', quality: 'original', size: 100 })
    expect(await store.objectReferenceCount('k1')).toBe(1)
    expect(await store.isObjectReferenced('k1')).toBe(true)
    expect(await store.removeObject('k1')).toBe(false)

    sqlite.prepare(
      `INSERT INTO music_download (user_id, id, track_id, quality, format, r2_key, created_at, updated_at)
       VALUES ('u1', 'd1', ?, 'original', 'mp3', 'k2', 1, 1)`,
    ).run(track.id)
    expect(await store.objectReferenceCount('k2')).toBe(1)
    expect(await store.removeObject('k2')).toBe(false)
  })

  it('queues a key once and drops it after the object is gone', async () => {
    expect(await store.queueCleanup(['k1', 'k1'])).toBe(1)
    expect(await store.queueCleanup('k1')).toBe(0)
    expect(await store.listCleanup()).toMatchObject([{ objectKey: 'k1', userId: 'u1' }])
    expect(await other.listCleanup()).toEqual([])
    expect(await other.dropCleanup('k1')).toBe(false)
    expect(await store.dropCleanup('k1')).toBe(true)
  })

  it('releases an unreferenced ledger row and queues its object', async () => {
    await store.registerObject({ r2Key: 'k1', format: 'mp3', quality: 'original', size: 100 })
    expect(await store.removeObject('k1')).toBe(true)
    expect(await store.quotaUsage()).toEqual({ bytes: 0, count: 0 })
    expect((await store.listCleanup()).map((entry) => entry.objectKey)).toEqual(['k1'])
  })
})

describe('deleting a track', () => {
  it('removes every row that names the track and queues its objects', async () => {
    const audioKey = 'music/mp3/u1/t1-original.mp3'
    const coverKey = 'music/covers/u1/t1.jpg'
    const track = await createTrack({ r2Key: audioKey, coverKey })
    const trackKey = 'netease:42'
    await store.registerObject({ r2Key: audioKey, trackId: track.id, format: 'mp3', quality: 'original', size: 100 })

    const playlist = await store.createPlaylist({ name: 'List' })
    await store.addPlaylistItem(playlist.id, track.id)
    await store.addFavorite(track.id)
    await store.recordHistory({ trackId: track.id })
    await store.saveLyric({ trackKey, lrc: '[00:01.00]line' })
    await store.saveSourceOverride({ trackKey, source: 'custom' })

    const result = await store.deleteTrack(track.id)
    expect(result.deleted).toBe(true)
    expect(new Set(result.queuedObjects)).toEqual(new Set([audioKey, coverKey]))
    expect(await store.getTrack(track.id)).toBeNull()
    expect(count('music_playlist_item')).toBe(0)
    expect(count('music_favorite')).toBe(0)
    expect(count('music_history')).toBe(0)
    expect(count('music_lyric')).toBe(0)
    expect(count('music_source_override')).toBe(0)
    expect(await store.quotaUsage()).toEqual({ bytes: 0, count: 0 })
    expect(new Set((await store.listCleanup()).map((entry) => entry.objectKey)))
      .toEqual(new Set([audioKey, coverKey]))
  })

  it('leaves a shared object until the last track naming it is gone', async () => {
    const key = 'music/mp3/u1/shared-original.mp3'
    const first = await createTrack({ providerId: '1', r2Key: key })
    const second = await createTrack({ providerId: '2', r2Key: key })
    await store.registerObject({ r2Key: key, trackId: first.id, format: 'mp3', quality: 'original', size: 100 })

    const firstDelete = await store.deleteTrack(first.id)
    expect(firstDelete.queuedObjects).toEqual([])
    expect(await store.objectReferenceCount(key)).toBe(1)
    expect(await store.quotaUsage()).toEqual({ bytes: 100, count: 1 })

    const secondDelete = await store.deleteTrack(second.id)
    expect(secondDelete.queuedObjects).toEqual([key])
    expect(await store.quotaUsage()).toEqual({ bytes: 0, count: 0 })
  })

  it('keeps an object a download still names', async () => {
    const key = 'music/mp3/u1/t1-original.mp3'
    const track = await createTrack({ r2Key: key })
    await store.registerObject({ r2Key: key, trackId: track.id, format: 'mp3', quality: 'original', size: 100 })
    sqlite.prepare(
      `INSERT INTO music_download (user_id, id, track_id, quality, format, r2_key, created_at, updated_at)
       VALUES ('u1', 'd1', ?, 'original', 'mp3', ?, 1, 1)`,
    ).run(track.id, key)

    const result = await store.deleteTrack(track.id)
    expect(result.queuedObjects).toEqual([])
    expect(await store.objectReferenceCount(key)).toBe(1)
    expect(await store.quotaUsage()).toEqual({ bytes: 100, count: 1 })
    expect(await store.removeObject(key)).toBe(false)
  })
})

describe('music pins', () => {
  it('sorts pinned favourites ahead of newer unpinned ones and is idempotent', async () => {
    const older = await createTrack({ providerId: 'pin-1', title: 'Older' })
    const newer = await createTrack({ providerId: 'pin-2', title: 'Newer' })
    await store.addFavorite(older.id)
    await store.addFavorite(newer.id)
    const before = await store.listFavorites()
    expect(before.items.map((entry) => entry.title)).toEqual(['Newer', 'Older'])

    const pinned = await store.setFavoritePinned(older.id, true)
    const firstPin = pinned?.pinnedAt
    expect(typeof firstPin).toBe('number')
    await store.setFavoritePinned(older.id, true)
    expect((await store.listFavorites()).items.find((entry) => entry.id === older.id)?.pinnedAt).toBe(firstPin)

    const after = await store.listFavorites()
    expect(after.items.map((entry) => entry.title)).toEqual(['Older', 'Newer'])
    expect(after.items[0]?.pinnedAt).toBe(Number(firstPin))
    expect(after.items[1]?.pinnedAt).toBeNull()
  })

  it('refuses to pin a favourite another account owns or a missing track', async () => {
    const track = await createTrack()
    await store.addFavorite(track.id)
    expect(await other.setFavoritePinned(track.id, true)).toBeNull()
    expect(await store.setFavoritePinned('missing', true)).toBeNull()
  })

  it('sorts pinned playlists ahead of the shelf order and unpins them', async () => {
    const first = await store.createPlaylist({ name: 'First' })
    const second = await store.createPlaylist({ name: 'Second' })
    expect((await store.listPlaylists()).map((entry) => entry.name)).toEqual(['First', 'Second'])

    await store.setPlaylistPinned(second.id, true)
    expect((await store.listPlaylists()).map((entry) => entry.name)).toEqual(['Second', 'First'])
    expect((await store.getPlaylist(second.id))?.pinnedAt).not.toBeNull()

    await store.setPlaylistPinned(second.id, false)
    expect((await store.listPlaylists()).map((entry) => entry.name)).toEqual(['First', 'Second'])
    expect(await other.setPlaylistPinned(second.id, true)).toBeNull()
    expect(first.id).not.toBe(second.id)
  })
})

describe('music AI lyric cache', () => {
  it('round-trips one layer and lets a changed source hash replace it', async () => {
    const saved = await store.putAiLyric({
      trackKey: 'netease:42',
      lang: 'zh-CN',
      sourceHash: 'hash-1',
      payload: JSON.stringify([{ index: 0, text: 'translated' }]),
      model: 'deepseek-chat',
    })
    expect(saved).toMatchObject({ kind: 'translation', lang: 'zh-CN', sourceHash: 'hash-1' })
    expect((await store.getAiLyric('netease:42', 'translation', 'zh-CN'))?.payload).toBe(saved.payload)

    await store.putAiLyric({
      trackKey: 'netease:42',
      lang: 'zh-CN',
      sourceHash: 'hash-2',
      payload: JSON.stringify([{ index: 0, text: 'new translation' }]),
    })
    expect((await store.getAiLyric('netease:42', 'translation', 'zh-CN'))?.sourceHash).toBe('hash-2')
  })

  it('isolates accounts and removes every language when the track is deleted', async () => {
    const track = await createTrack()
    const key = `netease:${track.providerId}`
    await store.putAiLyric({ trackKey: key, lang: 'zh-CN', sourceHash: 'h', payload: '[]' })
    await store.putAiLyric({ trackKey: key, lang: 'en-US', sourceHash: 'h', payload: '[]' })
    expect(await other.getAiLyric(key, 'translation', 'zh-CN')).toBeNull()

    expect(await store.deleteAiLyricsForTrack(key)).toBe(2)
    expect(await store.getAiLyric(key, 'translation', 'zh-CN')).toBeNull()

    await store.putAiLyric({ trackKey: key, lang: 'zh-CN', sourceHash: 'h', payload: '[]' })
    await store.deleteTrack(track.id)
    expect(await store.getAiLyric(key, 'translation', 'zh-CN')).toBeNull()
  })
})

describe('music cloud mounts', () => {
  it('stores a mount without returning its secret and isolates accounts', async () => {
    const mount = await store.createMount({
      name: 'Drive',
      baseUrl: 'https://alist.example.com',
      rootPath: '/music',
      secret: 'ciphertext',
    })
    expect(mount).toMatchObject({ kind: 'alist', name: 'Drive', hasSecret: true })
    expect('secret' in mount).toBe(false)
    expect(await store.getMountSecret(mount.id)).toBe('ciphertext')
    expect(await other.getMount(mount.id)).toBeNull()
    expect(await other.getMountSecret(mount.id)).toBeNull()
  })

  it('keeps the stored secret on a patch that omits it and clears it on an empty string', async () => {
    const mount = await store.createMount({
      name: 'Drive',
      baseUrl: 'https://alist.example.com',
      secret: 'ciphertext',
    })
    const renamed = await store.updateMount(mount.id, { name: 'Renamed' })
    expect(renamed).toMatchObject({ name: 'Renamed', hasSecret: true })
    expect(await store.getMountSecret(mount.id)).toBe('ciphertext')

    const cleared = await store.updateMount(mount.id, { secret: '' })
    expect(cleared?.hasSecret).toBe(false)
    expect(await store.getMountSecret(mount.id)).toBe('')
  })

  it('lists, deletes and refuses another account', async () => {
    const mount = await store.createMount({ name: 'Drive', baseUrl: 'https://alist.example.com' })
    expect((await store.listMounts()).map((entry) => entry.id)).toEqual([mount.id])
    expect(await other.deleteMount(mount.id)).toBe(false)
    expect(await store.deleteMount(mount.id)).toBe(true)
    expect(await store.listMounts()).toEqual([])
  })
})

describe('music pagination', () => {
  it('clamps page numbers and sizes parsed from query strings', () => {
    expect(normalizeMusicPage(undefined)).toBe(1)
    expect(normalizeMusicPage('3')).toBe(3)
    expect(normalizeMusicPage('0')).toBe(1)
    expect(normalizeMusicPage('999999')).toBe(MUSIC_PAGE_MAX)

    expect(normalizeMusicLimit(undefined)).toBe(MUSIC_LIMITS.libraryPageSize)
    expect(normalizeMusicLimit('0')).toBe(1)
    expect(normalizeMusicLimit('1000')).toBe(100)
    expect(normalizeMusicLimit('20', 50, 30)).toBe(20)
    expect(normalizeMusicLimit('80', 50, 30)).toBe(30)

    expect(musicPageOffset(1, 50)).toBe(0)
    expect(musicPageOffset(3, 20)).toBe(40)
    expect(musicPageOffset(0, 0)).toBe(0)
  })
})
