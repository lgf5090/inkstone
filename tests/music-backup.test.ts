// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MUSIC_LIMITS } from '../src/shared/music/constants'
import {
  DEFAULT_MUSIC_SETTINGS,
  type MusicArtist,
  type MusicSettings,
  type MusicTrack,
} from '../src/shared/music/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  applyBackupMusic,
  MUSIC_BACKUP_VERSION,
  readBackupMusic,
  type MusicBackupDocument,
  type MusicBackupObject,
} from '../src/worker/music/backup'
import { MusicStore } from '../src/worker/music/store'
import { makeD1 } from './doubles/d1-sqlite'

/**
 * `music.json`, and what it must and must not carry.
 *
 * The interesting claims are not "it round-trips": a backup leaves the server, so the file must never
 * hold the encrypted Netease cookie or cached lyrics; a restore is external input, so a version it
 * does not know, a table-shaped array it cannot use, an oversized library, or an R2 key from another
 * account's namespace must be refused before a single row is written.
 */

const USER = 'u1'
const OTHER = 'u2'
const BACKED_UP_TABLES = [
  'music_track',
  'music_playlist',
  'music_playlist_item',
  'music_favorite',
  'music_history',
  'music_recent',
  'music_object',
  'music_source_override',
  'music_subscription',
  'music_mount',
  'music_setting',
] as const

let sqlite: DatabaseSync
let db: D1Database
let store: MusicStore
let other: MusicStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  db = makeD1(sqlite)
  store = new MusicStore(db, USER)
  other = new MusicStore(db, OTHER)
})

afterEach(() => {
  sqlite.close()
})

function count(table: string, userId = USER): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userId) as {
    count: number
  }).count
}

function counts(): Record<string, number> {
  return Object.fromEntries(BACKED_UP_TABLES.map((table) => [table, count(table)]))
}

function artists(): MusicArtist[] {
  return [{ id: 'ar1', name: 'Artist' }]
}

function track(id = 'track-1', overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id,
    provider: 'netease',
    providerId: `provider-${id}`,
    kind: 'song',
    title: `Title ${id}`,
    artists: artists(),
    album: 'Album',
    albumId: 'album-1',
    coverUrl: 'https://example.test/cover.jpg',
    coverKey: '',
    durationMs: 180_000,
    format: 'mp3',
    bitrate: 320_000,
    size: 1_024,
    sha256: '',
    r2Key: null,
    source: 'netease',
    sourceQuality: '',
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  }
}

function object(r2Key: string, trackId: string | null = null): MusicBackupObject {
  return { r2Key, trackId, format: 'mp3', quality: 'original', size: 1_024, sha256: '', createdAt: 1_000 }
}

function document(overrides: Partial<MusicBackupDocument> = {}): MusicBackupDocument {
  return {
    version: MUSIC_BACKUP_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    settings: null,
    tracks: [],
    playlists: [],
    playlistItems: [],
    favorites: [],
    history: [],
    recent: [],
    objects: [],
    sourceOverrides: [],
    subscriptions: [],
    mounts: [],
    ...overrides,
  }
}

function serialized(overrides: Partial<MusicBackupDocument> = {}): string {
  return JSON.stringify(document(overrides))
}

async function badRequest(work: Promise<unknown>): Promise<void> {
  await expect(work).rejects.toMatchObject({ status: 400, code: 'bad_request' })
}

function wipeLibrary(userId = USER): void {
  for (const table of BACKED_UP_TABLES) {
    sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId)
  }
}

/** A library that uses every table the backup carries, including an R2 object and a cover key. */
async function seedFullLibrary(): Promise<{ trackId: string; playlistId: string }> {
  const saved = await store.upsertTrack({
    provider: 'netease',
    providerId: '42',
    title: 'Saved song',
    artists: artists(),
    album: 'Album',
    coverKey: 'music/covers/u1/cover.jpg',
    r2Key: 'music/mp3/u1/track-original.mp3',
    format: 'mp3',
    size: 1_024,
    sha256: 'a'.repeat(64),
    bitrate: 320_000,
  })
  const playlist = await store.createPlaylist({ name: 'Morning', description: 'Slow start' })
  await store.addPlaylistItem(playlist.id, saved.id)
  await store.addFavorite(saved.id)
  await store.recordHistory({
    trackId: saved.id,
    playedAt: 5_000,
    durationPlayed: 3_000,
    completed: true,
    contextType: 'playlist',
    contextId: playlist.id,
  })
  await store.touchRecent({ kind: 'album', providerId: 'album-1', name: 'Album', lastPlayedAt: 6_000 })
  await store.saveSettings({ ...DEFAULT_MUSIC_SETTINGS, quality: 'lossless', downloadConcurrency: 4 })
  await store.saveSourceOverride({
    trackKey: 'netease:42',
    source: 'custom',
    config: { url: 'https://example.test/resolve', apiKey: 'SECRET-SOURCE-KEY' },
  })
  await store.createSubscription({ kind: 'artist', providerId: 'ar1', name: 'Artist' })
  await store.createMount({
    kind: 'alist',
    name: 'Office drive',
    baseUrl: 'https://alist.example.test',
    rootPath: '/music',
    secret: 'SECRET-MOUNT-TOKEN',
  })
  await store.registerObject({
    r2Key: 'music/mp3/u1/track-original.mp3',
    trackId: saved.id,
    format: 'mp3',
    quality: 'original',
    size: 1_024,
    sha256: 'a'.repeat(64),
  })
  return { trackId: saved.id, playlistId: playlist.id }
}

async function plantExcludedData(): Promise<void> {
  await store.saveAccount({
    accountId: 'netease-1',
    nickname: 'Listener',
    avatarUrl: '',
    cookieCiphertext: 'SECRET-COOKIE-CIPHERTEXT',
  })
  await store.saveLyric({ trackKey: 'netease:42', lrc: 'SECRET-LYRICS' })
  sqlite.prepare(
    `INSERT INTO music_upload (user_id, id, filename, mime, size, format, created_at, updated_at)
     VALUES (?, 'upload-1', 'SECRET-UPLOAD.mp3', 'audio/mpeg', 10, 'mp3', 1, 1)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO music_download (user_id, id, track_id, quality, format, error, created_at, updated_at)
     VALUES (?, 'download-1', 'missing', 'original', 'mp3', 'SECRET-DOWNLOAD', 1, 1)`,
  ).run(USER)
  sqlite.prepare(
    `INSERT INTO music_cleanup (object_key, user_id, created_at)
     VALUES ('music/mp3/u1/SECRET-CLEANUP.mp3', ?, 1)`,
  ).run(USER)
}

describe('export', () => {
  it('answers null when the account has nothing the backup carries', async () => {
    expect(await readBackupMusic(db, USER)).toBeNull()

    await plantExcludedData()
    expect(await readBackupMusic(db, USER)).toBeNull()
  })

  it('carries the library fields and never the account, lyric, upload, download or cleanup tables', async () => {
    await seedFullLibrary()
    await plantExcludedData()

    const text = (await readBackupMusic(db, USER))!
    const payload = JSON.parse(text) as Record<string, unknown>

    expect(payload.version).toBe(MUSIC_BACKUP_VERSION)
    expect(Object.keys(payload).sort()).toEqual([
      'exportedAt',
      'favorites',
      'history',
      'mounts',
      'objects',
      'playlistItems',
      'playlists',
      'recent',
      'settings',
      'sourceOverrides',
      'subscriptions',
      'tracks',
      'version',
    ].sort())
    expect((payload.settings as { quality: string }).quality).toBe('lossless')
    expect(payload.tracks).toHaveLength(1)
    expect(payload.playlists).toHaveLength(1)
    expect(payload.playlistItems).toHaveLength(1)
    expect(payload.favorites).toHaveLength(1)
    expect(payload.history).toHaveLength(1)
    expect(payload.recent).toHaveLength(1)
    expect(payload.objects).toHaveLength(1)
    expect(payload.sourceOverrides).toEqual([
      expect.objectContaining({ trackKey: 'netease:42', source: 'custom', config: {} }),
    ])
    expect(payload.subscriptions).toHaveLength(1)
    expect(payload.mounts).toEqual([expect.objectContaining({
      kind: 'alist',
      name: 'Office drive',
      baseUrl: 'https://alist.example.test',
      rootPath: '/music',
    })])

    for (const secret of [
      'SECRET-COOKIE-CIPHERTEXT',
      'SECRET-LYRICS',
      'SECRET-UPLOAD',
      'SECRET-DOWNLOAD',
      'SECRET-CLEANUP',
      'SECRET-MOUNT-TOKEN',
      'SECRET-SOURCE-KEY',
      'cookie_ciphertext',
    ]) {
      expect(text).not.toContain(secret)
    }
    for (const table of ['account', 'lyrics', 'uploads', 'downloads', 'cleanup']) {
      expect(payload[table]).toBeUndefined()
    }
  })

  it('still produces a document when the only row is a settings row', async () => {
    await store.saveSettings(DEFAULT_MUSIC_SETTINGS)
    const payload = JSON.parse((await readBackupMusic(db, USER))!) as MusicBackupDocument
    expect(payload.settings).toEqual(DEFAULT_MUSIC_SETTINGS)
    expect(payload.tracks).toEqual([])
  })

  it('leaves the custom resolver coordinates out of the file', async () => {
    await store.saveSettings({
      ...DEFAULT_MUSIC_SETTINGS,
      quality: 'hires',
      customResolverEnabled: true,
      customResolverUrl: 'https://resolver.test/resolve?key=SECRET-RESOLVER-KEY',
      customResolverParams: { apiKey: 'SECRET-RESOLVER-KEY' },
    })

    const text = (await readBackupMusic(db, USER))!
    expect(text).not.toContain('SECRET-RESOLVER-KEY')
    const payload = JSON.parse(text) as MusicBackupDocument
    expect(payload.settings).toMatchObject({
      quality: 'hires',
      customResolverUrl: '',
      customResolverParams: {},
    })

    wipeLibrary()
    await applyBackupMusic(db, USER, text)
    const restored = await store.getSettings()
    expect(restored).toMatchObject({ quality: 'hires', customResolverUrl: '', customResolverParams: {} })

    // A hand-edited file cannot configure the resolver either.
    await applyBackupMusic(db, USER, serialized({
      settings: {
        ...DEFAULT_MUSIC_SETTINGS,
        customResolverUrl: 'https://attacker.test/resolve',
        customResolverParams: { apiKey: 'SECRET-RESOLVER-KEY' },
      },
    }))
    expect(await store.getSettings()).toMatchObject({ customResolverUrl: '', customResolverParams: {} })
  })
})

describe('restore', () => {
  it('round-trips every carried table and the settings', async () => {
    await seedFullLibrary()
    const before = (await readBackupMusic(db, USER))!
    const beforePayload = JSON.parse(before) as Record<string, unknown>

    wipeLibrary()
    const summary = await applyBackupMusic(db, USER, before)
    expect(summary).toEqual({
      tracks: 1,
      playlists: 1,
      items: 1,
      favorites: 1,
      history: 1,
      recent: 1,
      objects: 1,
      overrides: 1,
      subscriptions: 1,
      mounts: 1,
    })

    const after = (await readBackupMusic(db, USER))!
    const afterPayload = JSON.parse(after) as Record<string, unknown>
    delete beforePayload.exportedAt
    delete afterPayload.exportedAt
    expect(afterPayload).toEqual(beforePayload)
  })

  it('is idempotent: importing the same document twice changes nothing', async () => {
    await seedFullLibrary()
    const text = (await readBackupMusic(db, USER))!
    wipeLibrary()

    const first = await applyBackupMusic(db, USER, text)
    const once = counts()
    const second = await applyBackupMusic(db, USER, text)
    expect(second).toEqual(first)
    expect(counts()).toEqual(once)
  })

  it('restores a version 1 document and exports version 2 with its pin order intact', async () => {
    const saved = track('legacy')
    const legacy = {
      ...document({
        tracks: [saved],
        favorites: [{ trackId: saved.id, createdAt: 1_000, pinnedAt: 2_000 }],
      }),
      version: 1,
    }

    const summary = await applyBackupMusic(db, USER, JSON.stringify(legacy))
    expect(summary.mounts).toBe(0)
    const payload = JSON.parse((await readBackupMusic(db, USER))!) as MusicBackupDocument
    expect(payload.version).toBe(2)
    expect(payload.mounts).toEqual([])
    expect(payload.favorites[0]?.pinnedAt).toBe(2_000)

    const favorites = await store.listFavorites({ page: 1, limit: 10 })
    expect(favorites.items[0]?.pinnedAt).toBe(2_000)
  })

  it('restores mounts without their credential so the reader can re-enter it', async () => {
    await seedFullLibrary()
    const text = (await readBackupMusic(db, USER))!
    wipeLibrary()

    await applyBackupMusic(db, USER, text)
    const mounts = await store.listMounts()
    expect(mounts).toHaveLength(1)
    expect(mounts[0]).toMatchObject({
      kind: 'alist',
      name: 'Office drive',
      baseUrl: 'https://alist.example.test',
      rootPath: '/music',
      hasSecret: false,
    })
    expect(sqlite.prepare('SELECT secret FROM music_mount WHERE user_id = ?').get(USER)).toEqual({ secret: '' })
  })

  it('refuses a mount address that would send a token in the clear', async () => {
    await badRequest(applyBackupMusic(db, USER, serialized({
      mounts: [{
        id: 'mount-1',
        kind: 'alist',
        name: 'Drive',
        baseUrl: 'http://alist.example.test',
        rootPath: '/',
        status: 'active',
        createdAt: 1_000,
        updatedAt: 1_000,
      }],
    })))
    expect(count('music_mount')).toBe(0)
  })

  it('maps a document track to the account row that already owns the provider identity', async () => {
    const saved = await store.upsertTrack({ provider: 'netease', providerId: '42', title: 'Original' })
    const doc = document({
      tracks: [track('backup-id', { providerId: '42', title: 'From backup' })],
      playlists: [{
        id: 'playlist-1',
        name: 'List',
        description: '',
        coverUrl: '',
        provider: 'local',
        providerId: '',
        kind: 'manual',
        sortOrder: 0,
        pinnedAt: null,
        createdAt: 1_000,
        updatedAt: 1_000,
      }],
      playlistItems: [{ playlistId: 'playlist-1', trackId: 'backup-id', position: 1, addedAt: 1_000 }],
      favorites: [{ trackId: 'backup-id', createdAt: 1_000, pinnedAt: null }],
    })

    await applyBackupMusic(db, USER, JSON.stringify(doc))
    expect(count('music_track')).toBe(1)
    expect((await store.getTrack(saved.id))?.title).toBe('Original')
    expect(sqlite.prepare(
      `SELECT track_id FROM music_playlist_item WHERE user_id = ?`,
    ).get(USER)).toEqual({ track_id: saved.id })
    expect(sqlite.prepare(
      `SELECT track_id FROM music_favorite WHERE user_id = ?`,
    ).get(USER)).toEqual({ track_id: saved.id })
  })

  it('restores another account metadata without writing rows into the exporting account', async () => {
    const saved = await store.upsertTrack({ provider: 'netease', providerId: '7', title: 'Streamed' })
    const playlist = await store.createPlaylist({ name: 'Shared' })
    await store.addPlaylistItem(playlist.id, saved.id)
    await store.addFavorite(saved.id)
    await store.recordHistory({ trackId: saved.id })
    await store.touchRecent({ kind: 'artist', providerId: 'ar1', name: 'Artist' })
    await store.createSubscription({ kind: 'artist', providerId: 'ar1', name: 'Artist' })
    await store.saveSettings(DEFAULT_MUSIC_SETTINGS)

    const payload = JSON.parse((await readBackupMusic(db, USER))!) as Record<string, unknown>
    // An old or hand-edited file may carry the exporting account's column. It must be ignored.
    ;(payload.tracks as Array<Record<string, unknown>>)[0]!.user_id = USER
    ;(payload.playlists as Array<Record<string, unknown>>)[0]!.user_id = USER

    const before = counts()
    await applyBackupMusic(db, OTHER, JSON.stringify(payload))

    expect(counts()).toEqual(before)
    expect(count('music_track', OTHER)).toBe(1)
    expect(count('music_playlist', OTHER)).toBe(1)
    expect(count('music_playlist_item', OTHER)).toBe(1)
    expect(count('music_favorite', OTHER)).toBe(1)
    expect(count('music_history', OTHER)).toBe(1)
    expect(count('music_recent', OTHER)).toBe(1)
    expect(count('music_subscription', OTHER)).toBe(1)
    expect(await other.getTrack(saved.id)).not.toBeNull()
    expect(await store.getTrack(saved.id)).not.toBeNull()
  })

  it('keeps only the newest history and recent rows after a large restore', async () => {
    const savedTrack = track('track-1')
    const history = Array.from({ length: MUSIC_LIMITS.historyEntries + 1 }, (_, index) => ({
      id: `history-${index + 1}`,
      trackId: savedTrack.id,
      playedAt: index + 1,
      durationPlayed: 0,
      completed: false,
      contextType: '',
      contextId: '',
    }))
    const recent = Array.from({ length: MUSIC_LIMITS.recentEntries + 1 }, (_, index) => ({
      id: `recent-${index + 1}`,
      kind: 'album' as const,
      providerId: `album-${index + 1}`,
      name: `Album ${index + 1}`,
      coverUrl: '',
      lastPlayedAt: index + 1,
      playCount: 1,
    }))

    const summary = await applyBackupMusic(db, USER, serialized({
      tracks: [savedTrack],
      history,
      recent,
    }))
    expect(summary.history).toBe(MUSIC_LIMITS.historyEntries + 1)
    expect(summary.recent).toBe(MUSIC_LIMITS.recentEntries + 1)
    expect(count('music_history')).toBe(MUSIC_LIMITS.historyEntries)
    expect(sqlite.prepare(
      `SELECT MIN(played_at) AS oldest FROM music_history WHERE user_id = ?`,
    ).get(USER)).toEqual({ oldest: 2 })
    expect(count('music_recent')).toBe(MUSIC_LIMITS.recentEntries)
    expect(sqlite.prepare(
      `SELECT MIN(last_played_at) AS oldest FROM music_recent WHERE user_id = ?`,
    ).get(USER)).toEqual({ oldest: 2 })
  })

  it('refuses a document it cannot honour, without touching the database', async () => {
    const saved = await store.upsertTrack({ provider: 'netease', providerId: '1', title: 'Kept' })
    const before = counts()

    await badRequest(applyBackupMusic(db, USER, 'not json'))
    await badRequest(applyBackupMusic(db, USER, serialized({ version: 99 } as unknown as Record<string, unknown>)))
    await badRequest(applyBackupMusic(db, USER, JSON.stringify({
      version: MUSIC_BACKUP_VERSION,
      tracks: 'nope',
    })))
    await badRequest(applyBackupMusic(db, USER, serialized({
      tracks: [track('duplicate'), track('duplicate', { providerId: 'other' })],
    })))
    await badRequest(applyBackupMusic(db, USER, serialized({
      favorites: [{ trackId: 'missing', createdAt: 1, pinnedAt: null }],
    })))
    await badRequest(applyBackupMusic(db, USER, serialized({
      tracks: [track('track-1')],
      playlistItems: [{ playlistId: 'missing', trackId: 'track-1', position: 1, addedAt: 1 }],
    })))
    await badRequest(applyBackupMusic(db, USER, serialized({
      settings: [] as unknown as MusicSettings,
    })))

    expect(counts()).toEqual(before)
    expect(await store.getTrack(saved.id)).not.toBeNull()
  })

  it('refuses arrays over the personal-library ceilings', async () => {
    function emptyRows<T>(length: number): T[] {
      return Array.from({ length }, () => ({})) as T[]
    }
    const oversized: Array<Partial<MusicBackupDocument>> = [
      { tracks: emptyRows<MusicTrack>(20_001) },
      { objects: emptyRows<MusicBackupObject>(50_001) },
      { history: emptyRows<MusicBackupDocument['history'][number]>(50_001) },
      { playlistItems: emptyRows<MusicBackupDocument['playlistItems'][number]>(50_001) },
    ]
    for (const value of oversized) {
      await badRequest(applyBackupMusic(db, USER, serialized(value)))
    }
    expect(counts()).toEqual(Object.fromEntries(BACKED_UP_TABLES.map((table) => [table, 0])))
  })

  it('refuses settings over the 64 KB ceiling', async () => {
    await badRequest(applyBackupMusic(db, USER, serialized({
      settings: {
        ...DEFAULT_MUSIC_SETTINGS,
        customResolverUrl: `https://example.test/${'x'.repeat(MUSIC_LIMITS.settingsMaxBytes)}`,
      },
    })))
  })
})

describe('R2 key namespace', () => {
  it('accepts only keys under music/ that name this account', async () => {
    const accepted = serialized({ objects: [object('music/mp3/u1/track-original.mp3')] })
    await applyBackupMusic(db, USER, accepted)
    expect(count('music_object')).toBe(1)

    for (const key of [
      'music/mp3/u2/track-original.mp3',
      'music/mp3/u2/u1/track-original.mp3',
      'music/mp3/xu1/track-original.mp3',
      'music/mp3/u1/../../u2/track-original.mp3',
      'attachments/u1/track-original.mp3',
      'music//u1/track-original.mp3',
      'music/u1/track-original.mp3',
      'music/mp3/u1',
    ]) {
      await badRequest(applyBackupMusic(db, USER, serialized({ objects: [object(key)] })))
    }
    expect(count('music_object')).toBe(1)
  })

  it('refuses a track or cover key from another account', async () => {
    await badRequest(applyBackupMusic(db, USER, serialized({
      tracks: [track('track-1', { r2Key: 'music/mp3/u2/track-original.mp3' })],
    })))
    await badRequest(applyBackupMusic(db, USER, serialized({
      tracks: [track('track-1', { coverKey: 'music/covers/u2/cover.jpg' })],
    })))
    expect(count('music_track')).toBe(0)
  })

  it('keeps an account-owned track key and object key for a later missing marker', async () => {
    const key = 'music/mp3/u1/track-original.mp3'
    await applyBackupMusic(db, USER, serialized({
      tracks: [track('track-1', { r2Key: key })],
      objects: [object(key, 'track-1')],
    }))
    expect((await store.getTrack('track-1'))?.r2Key).toBe(key)
    expect((await store.listObjects())[0]).toMatchObject({ r2Key: key, trackId: 'track-1' })
  })
})
