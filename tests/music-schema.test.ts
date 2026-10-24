// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MUSIC_REQUIRED_COLUMNS,
  MUSIC_REQUIRED_INDEXES,
  MUSIC_REQUIRED_TABLES,
  MUSIC_SCHEMA_STATEMENTS,
} from '../src/worker/music/schema'

let sqlite: DatabaseSync

function applyMusicSchema(): void {
  for (const statement of MUSIC_SCHEMA_STATEMENTS) sqlite.exec(statement)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  applyMusicSchema()
})

function tables(): Set<string> {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function indexes(): Set<string> {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function columns(table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function primaryKey(table: string): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
  return rows.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk).map((row) => row.name)
}

function insertTrack(userId: string, id: string, providerId: string): void {
  sqlite.prepare(
    `INSERT INTO music_track (user_id, id, provider, provider_id, title, created_at, updated_at)
     VALUES (?, ?, 'netease', ?, 'Song', 1, 1)`,
  ).run(userId, id, providerId)
}

describe('the music tables', () => {
  it('are created by the statements every boot runs', () => {
    const present = tables()
    for (const table of MUSIC_REQUIRED_TABLES) expect(present.has(table)).toBe(true)
  })

  it('create every index they claim', () => {
    const present = indexes()
    for (const index of MUSIC_REQUIRED_INDEXES) expect(present.has(index)).toBe(true)
  })

  it('carry every column the boot checks for', () => {
    for (const [table, required] of Object.entries(MUSIC_REQUIRED_COLUMNS)) {
      const present = columns(table)
      for (const column of required) expect(present.has(column)).toBe(true)
    }
  })

  it('scope every row to an account except the cleanup queue', () => {
    for (const table of MUSIC_REQUIRED_TABLES) {
      expect(columns(table).has('user_id')).toBe(true)
      const key = primaryKey(table)
      if (table === 'music_cleanup') {
        expect(key).toEqual(['object_key'])
      } else {
        expect(key[0], `${table} must lead its key with user_id`).toBe('user_id')
      }
    }
  })

  it('are idempotent and keep the rows already stored', () => {
    insertTrack('u1', 't1', '42')
    expect(() => applyMusicSchema()).not.toThrow()
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM music_track`).get()).toEqual({ count: 1 })
    expect(tables().size).toBeGreaterThanOrEqual(MUSIC_REQUIRED_TABLES.length)
  })

  it('keep one snapshot per provider id per account', () => {
    insertTrack('u1', 't1', '42')
    expect(() => insertTrack('u1', 't2', '42')).toThrow()
    expect(() => insertTrack('u2', 't2', '42')).not.toThrow()
  })

  it('keep one row per playlist item, favourite, recent container, download and subscription', () => {
    sqlite.prepare(
      `INSERT INTO music_playlist_item (user_id, playlist_id, track_id, position, added_at)
       VALUES ('u1', 'p1', 't1', 1, 1)`,
    ).run()
    expect(() => sqlite.prepare(
      `INSERT INTO music_playlist_item (user_id, playlist_id, track_id, position, added_at)
       VALUES ('u1', 'p1', 't1', 2, 2)`,
    ).run()).toThrow()

    sqlite.prepare(`INSERT INTO music_favorite (user_id, track_id, created_at) VALUES ('u1', 't1', 1)`).run()
    expect(() => sqlite.prepare(
      `INSERT INTO music_favorite (user_id, track_id, created_at) VALUES ('u1', 't1', 2)`,
    ).run()).toThrow()

    sqlite.prepare(
      `INSERT INTO music_recent (user_id, id, kind, provider_id, name, last_played_at)
       VALUES ('u1', 'r1', 'album', 'a1', 'Album', 1)`,
    ).run()
    expect(() => sqlite.prepare(
      `INSERT INTO music_recent (user_id, id, kind, provider_id, name, last_played_at)
       VALUES ('u1', 'r2', 'album', 'a1', 'Album', 2)`,
    ).run()).toThrow()

    sqlite.prepare(
      `INSERT INTO music_download (user_id, id, track_id, quality, format, created_at, updated_at)
       VALUES ('u1', 'd1', 't1', 'exhigh', 'mp3', 1, 1)`,
    ).run()
    expect(() => sqlite.prepare(
      `INSERT INTO music_download (user_id, id, track_id, quality, format, created_at, updated_at)
       VALUES ('u1', 'd2', 't1', 'exhigh', 'mp3', 2, 2)`,
    ).run()).toThrow()

    sqlite.prepare(
      `INSERT INTO music_subscription (user_id, id, kind, provider_id, name, created_at)
       VALUES ('u1', 's1', 'artist', 'ar1', 'Artist', 1)`,
    ).run()
    expect(() => sqlite.prepare(
      `INSERT INTO music_subscription (user_id, id, kind, provider_id, name, created_at)
       VALUES ('u1', 's2', 'artist', 'ar1', 'Artist', 2)`,
    ).run()).toThrow()
  })

  it('keep one row per account and provider for the account itself', () => {
    sqlite.prepare(
      `INSERT INTO music_account (user_id, provider, account_id, updated_at) VALUES ('u1', 'netease', 'a1', 1)`,
    ).run()
    expect(() => sqlite.prepare(
      `INSERT INTO music_account (user_id, provider, account_id, updated_at) VALUES ('u1', 'netease', 'a2', 2)`,
    ).run()).toThrow()
    expect(() => sqlite.prepare(
      `INSERT INTO music_account (user_id, provider, account_id, updated_at) VALUES ('u2', 'netease', 'a2', 2)`,
    ).run()).not.toThrow()
  })

  it('keep the cleanup queue global by object key', () => {
    sqlite.prepare(
      `INSERT INTO music_cleanup (object_key, user_id, created_at) VALUES ('music/mp3/u1/t1.mp3', 'u1', 1)`,
    ).run()
    expect(() => sqlite.prepare(
      `INSERT INTO music_cleanup (object_key, user_id, created_at) VALUES ('music/mp3/u1/t1.mp3', 'u2', 2)`,
    ).run()).toThrow()
  })

  it('let a minimal track rely on the declarative defaults', () => {
    insertTrack('u1', 't1', '42')
    expect(sqlite.prepare(
      `SELECT kind, artists, album, album_id, cover_url, cover_key, duration_ms, format, bitrate,
              size, sha256, r2_key, source, source_quality
         FROM music_track WHERE user_id = 'u1' AND id = 't1'`,
    ).get()).toEqual({
      kind: 'song',
      artists: '[]',
      album: '',
      album_id: '',
      cover_url: '',
      cover_key: '',
      duration_ms: 0,
      format: '',
      bitrate: null,
      size: null,
      sha256: '',
      r2_key: null,
      source: '',
      source_quality: '',
    })
  })

  it('allow the same id in two accounts but not twice in one', () => {
    insertTrack('u1', 'same', '1')
    insertTrack('u2', 'same', '1')
    expect(() => insertTrack('u1', 'same', '2')).toThrow()
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM music_track`).get()).toEqual({ count: 2 })
  })
})
