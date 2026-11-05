// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { publicBlogSite, mergeBlogSettings } from '../src/shared/blog/settings'
import {
  issueBlogMediaToken,
  listBlogMusicLibrary,
  resolvePublicBlogMusic,
  verifyBlogMediaToken,
} from '../src/worker/blog/music-library'
import { makeD1 } from './doubles/d1-sqlite'

const counts = { posts: 0, categories: 0, tags: 0, series: 0, views: 0 }
const secretEnv = { BLOG_UNLOCK_SECRET: 'blog-music-test-secret-0123456789' } as unknown as Env

async function installed(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(':memory:')
  await initializeDatabase({ ...secretEnv, DB: makeD1(sqlite) } as unknown as Env)
  return sqlite
}

function dbOf(sqlite: DatabaseSync): D1Database {
  return makeD1(sqlite) as unknown as D1Database
}

function track(
  sqlite: DatabaseSync,
  input: {
    userId: string
    id: string
    title: string
    r2Key?: string | null
    coverKey?: string
    update?: number
  },
): void {
  sqlite.prepare(
    `INSERT INTO music_track
       (user_id, id, provider, provider_id, title, artists, album, album_id, cover_url, cover_key,
        duration_ms, format, size, sha256, r2_key, source, source_quality, created_at, updated_at)
     VALUES (?1, ?2, 'upload', ?2, ?3, ?4, '', '', '', ?5, 125000, 'mp3', 1, '', ?6, '', '', ?7, ?7)`,
  ).run(
    input.userId,
    input.id,
    input.title,
    JSON.stringify([{ id: `${input.id}-a`, name: 'Fixture Artist' }]),
    input.coverKey ?? '',
    input.r2Key === undefined ? `music/mp3/${input.userId}/${input.id}-standard.mp3` : input.r2Key,
    input.update ?? 1,
  )
}

function playlist(sqlite: DatabaseSync, userId: string, id: string, name: string): void {
  sqlite.prepare(
    `INSERT INTO music_playlist
       (user_id, id, name, description, cover_url, cover_key, provider, provider_id, kind, sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, '', '', '', 'local', '', 'manual', 0, 1, 1)`,
  ).run(userId, id, name)
}

function item(sqlite: DatabaseSync, userId: string, playlistId: string, trackId: string, position: number): void {
  sqlite.prepare(
    `INSERT INTO music_playlist_item (user_id, playlist_id, track_id, position, added_at)
     VALUES (?1, ?2, ?3, ?4, 1)`,
  ).run(userId, playlistId, trackId, position)
}

function librarySettings(scope: 'all' | 'playlist', playlistId?: string) {
  return mergeBlogSettings([{
    key: 'music',
    value: JSON.stringify({ provider: 'library', libraryScope: scope, ...(playlistId ? { libraryPlaylistId: playlistId } : {}) }),
  }])
}

describe('the blog music library projection', () => {
  it('counts only the owner R2 tracks and never another account playlist', async () => {
    const sqlite = await installed()
    track(sqlite, { userId: 'u1', id: 'r2-1', title: 'Owner playable' })
    track(sqlite, { userId: 'u1', id: 'meta-1', title: 'Owner metadata only', r2Key: null })
    track(sqlite, { userId: 'u2', id: 'other-1', title: 'Other account' })
    playlist(sqlite, 'u1', 'p-owner', 'Owner playlist')
    playlist(sqlite, 'u2', 'p-other', 'Other playlist')
    item(sqlite, 'u1', 'p-owner', 'r2-1', 0)
    item(sqlite, 'u1', 'p-owner', 'meta-1', 1)
    item(sqlite, 'u2', 'p-other', 'other-1', 0)

    const summary = await listBlogMusicLibrary(dbOf(sqlite), 'u1')
    expect(summary.total).toBe(1)
    expect(summary.playlists.map((entry) => entry.id)).toEqual(['p-owner'])
    expect(summary.playlists[0]).toMatchObject({ trackCount: 2, playableCount: 1, hasCover: false })
  })

  it('resolves all-tracks scope to owner R2 tracks with verifiable short tokens', async () => {
    const sqlite = await installed()
    track(sqlite, { userId: 'u1', id: 'r2-1', title: 'Owner playable', coverKey: 'music/covers/u1/r2-1.jpg' })
    track(sqlite, { userId: 'u1', id: 'meta-1', title: 'Owner metadata only', r2Key: null })
    track(sqlite, { userId: 'u2', id: 'other-1', title: 'Other account' })

    const site = await resolvePublicBlogMusic(secretEnv, dbOf(sqlite), 'u1', publicBlogSite(librarySettings('all'), counts))
    expect(site.integrations.music.enabled).toBe(true)
    expect(site.integrations.music.tracks).toHaveLength(1)
    const resolved = site.integrations.music.tracks[0]!
    expect(resolved.id).toBe('r2-1')
    expect(resolved.title).toBe('Owner playable')
    expect(resolved.artist).toBe('Fixture Artist')
    expect(resolved.duration).toBe(125)
    expect(resolved.source).toMatch(/^\/_blog\/music\/audio\/r2-1\?t=/)
    expect(resolved.cover).toMatch(/^\/_blog\/music\/cover\/r2-1\?t=/)

    const audioToken = decodeURIComponent(resolved.source.split('t=')[1]!)
    expect(await verifyBlogMediaToken(secretEnv, 'audio', 'u1', 'r2-1', audioToken)).toBe(true)
    expect(await verifyBlogMediaToken(secretEnv, 'cover', 'u1', 'r2-1', audioToken)).toBe(false)
    expect(await verifyBlogMediaToken(secretEnv, 'audio', 'u2', 'r2-1', audioToken)).toBe(false)
    expect(await verifyBlogMediaToken(secretEnv, 'audio', 'u1', 'other-1', audioToken)).toBe(false)
  })

  it('filters a playlist in position order and refuses another account playlist', async () => {
    const sqlite = await installed()
    track(sqlite, { userId: 'u1', id: 'r2-a', title: 'A', update: 1 })
    track(sqlite, { userId: 'u1', id: 'r2-b', title: 'B', update: 2 })
    track(sqlite, { userId: 'u1', id: 'meta-c', title: 'C metadata only', r2Key: null })
    playlist(sqlite, 'u1', 'p-owner', 'Owner playlist')
    item(sqlite, 'u1', 'p-owner', 'r2-b', 0)
    item(sqlite, 'u1', 'p-owner', 'meta-c', 1)
    item(sqlite, 'u1', 'p-owner', 'r2-a', 2)
    playlist(sqlite, 'u2', 'p-other', 'Other playlist')
    item(sqlite, 'u2', 'p-other', 'r2-a', 0)

    const site = await resolvePublicBlogMusic(secretEnv, dbOf(sqlite), 'u1', publicBlogSite(librarySettings('playlist', 'p-owner'), counts))
    expect(site.integrations.music.tracks.map((entry) => entry.id)).toEqual(['r2-b', 'r2-a'])

    const foreign = await resolvePublicBlogMusic(secretEnv, dbOf(sqlite), 'u1', publicBlogSite(librarySettings('playlist', 'p-other'), counts))
    expect(foreign.integrations.music.enabled).toBe(false)
    expect(foreign.integrations.music.tracks).toEqual([])

    const unnamed = await resolvePublicBlogMusic(secretEnv, dbOf(sqlite), 'u1', publicBlogSite(librarySettings('playlist'), counts))
    expect(unnamed.integrations.music.enabled).toBe(false)
    expect(unnamed.integrations.music.tracks).toEqual([])
  })

  it('keeps the entrance data when the library is empty', async () => {
    const sqlite = await installed()
    const site = await resolvePublicBlogMusic(secretEnv, dbOf(sqlite), 'u1', publicBlogSite(librarySettings('all'), counts))
    expect(site.integrations.music.provider).toBe('library')
    expect(site.integrations.music.enabled).toBe(false)
    expect(site.integrations.music.tracks).toEqual([])
  })

  it('refuses expired tokens and, outside development, deployments without a signing secret', async () => {
    vi.stubEnv('DEV', false)
    expect(await issueBlogMediaToken({} as Env, 'audio', 'u1', 'r2-1')).toBeNull()
    const token = await issueBlogMediaToken(secretEnv, 'audio', 'u1', 'r2-1', 0)
    expect(token).toBeTruthy()
    expect(await verifyBlogMediaToken(secretEnv, 'audio', 'u1', 'r2-1', token, 3 * 60 * 60 * 1000)).toBe(false)
  })

  it('signs local development links even when the deployment has no proxy secret', async () => {
    vi.unstubAllEnvs()
    const token = await issueBlogMediaToken({} as Env, 'audio', 'u1', 'r2-1')
    expect(token).toBeTruthy()
    expect(await verifyBlogMediaToken({} as Env, 'audio', 'u1', 'r2-1', token)).toBe(true)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})
