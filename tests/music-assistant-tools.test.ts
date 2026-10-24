// @vitest-environment node
/**
 * The library tools: what the model may name, what the tools write, and what another account cannot.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { ALL_TOOLS, ToolError, assertToolsMatchSpecs, validateArgs, type ToolContext } from '../src/worker/assistant/tools'
import { MusicStore } from '../src/worker/music/store'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const ALICE = '0123456789abcdefghjkmnpqrs'
const BOB = 'ssssssssssssssssssssssssss'

let sqlite: DatabaseSync
let env: ReturnType<typeof testBindings>
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  db = env.DB as D1Database
})

afterEach(() => vi.unstubAllGlobals())

function context(userId = ALICE): ToolContext {
  const store = new AssistantStore(db, userId, env)
  return {
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: DEFAULT_ASSISTANT_SETTINGS,
    timezone: 'UTC',
    dayEnd: 0,
    mode: 'chat',
  } as unknown as ToolContext
}

async function runTool(name: string, args: Record<string, unknown>, ctx = context()): Promise<Record<string, unknown>> {
  const definition = ALL_TOOLS.find((entry) => entry.name === name)
  if (!definition || !('run' in definition)) throw new Error(`missing immediate tool ${name}`)
  return await definition.run(args, ctx) as Record<string, unknown>
}

async function seedTracks(userId = ALICE): Promise<{ first: { id: string, trackRef: string }, second: { id: string, trackRef: string } }> {
  const store = new MusicStore(db, userId)
  const first = await store.upsertTrack({
    provider: 'netease', providerId: '101', title: 'First', artists: [{ id: '1', name: 'Artist' }], durationMs: 120_000,
  })
  const second = await store.upsertTrack({
    provider: 'netease', providerId: '102', title: 'Second', artists: [{ id: '1', name: 'Artist' }], durationMs: 90_000,
  })
  return {
    first: { id: first.id, trackRef: `netease:${first.providerId}` },
    second: { id: second.id, trackRef: `netease:${second.providerId}` },
  }
}

describe('music library tools', () => {
  it('is in the shared spec list with the same permissions', () => {
    expect(() => assertToolsMatchSpecs()).not.toThrow()
    for (const name of ['music_search', 'music_favorite', 'music_pin', 'music_playlist_create']) {
      expect(ALL_TOOLS.some((entry) => entry.name === name)).toBe(true)
    }
  })

  it('validates declarations through the same FieldSpec the provider sees', () => {
    const definition = ALL_TOOLS.find((entry) => entry.name === 'music_playlist_create')!
    expect(() => validateArgs(definition.fields, { name: 'Focus' })).not.toThrow()
    expect(() => validateArgs(definition.fields, { name: '' })).toThrow()
    const capped = validateArgs(definition.fields, { name: 'x', trackRefs: Array.from({ length: 101 }, () => 'a') })
    expect(capped.trackRefs).toHaveLength(100)
  })

  it('favourites idempotently and keeps the first pin position', async () => {
    const tracks = await seedTracks()
    await runTool('music_favorite', { trackRefs: [tracks.first.trackRef] })
    await runTool('music_favorite', { trackRefs: [tracks.first.trackRef] })
    const store = new MusicStore(db, ALICE)
    const favorites = await store.listFavorites({ page: 1, limit: 10 })
    expect(favorites.total).toBe(1)

    const firstPin = await runTool('music_pin', { kind: 'track', id: tracks.first.trackRef })
    expect(firstPin).toMatchObject({ ok: true, pinned: true, addedToFavorites: false })
    const pinnedAt = (await store.listFavorites({ page: 1, limit: 10 })).items[0]!.pinnedAt
    expect(pinnedAt).not.toBeNull()

    await runTool('music_pin', { kind: 'track', id: tracks.first.trackRef })
    expect((await store.listFavorites({ page: 1, limit: 10 })).items[0]!.pinnedAt).toBe(pinnedAt)

    await runTool('music_pin', { kind: 'track', id: tracks.first.trackRef, pinned: false })
    expect((await store.listFavorites({ page: 1, limit: 10 })).items[0]!.pinnedAt).toBeNull()
  })

  it('favourites a track that was never saved when it is pinned, and says so', async () => {
    const tracks = await seedTracks()
    const result = await runTool('music_pin', { kind: 'track', id: tracks.second.trackRef })
    expect(result).toMatchObject({ ok: true, favorite: true, addedToFavorites: true, pinned: true })
    expect(await new MusicStore(db, ALICE).isFavorite(tracks.second.id)).toBe(true)
  })

  it('refuses a provider ref the music app has not saved, with the step that fixes it', async () => {
    const tracks = await seedTracks()
    const store = new MusicStore(db, ALICE)
    await store.deleteTrack(tracks.first.id)
    await expect(runTool('music_favorite', { trackRefs: [tracks.first.trackRef] }))
      .rejects.toThrow(/Play or favourite this track in the music app once/)
  })

  it('cannot touch another account\'s library', async () => {
    const tracks = await seedTracks(ALICE)
    await expect(runTool('music_favorite', { trackRefs: [tracks.first.id] }, context(BOB)))
      .rejects.toBeInstanceOf(ToolError)
  })

  it('creates a playlist from internal and provider refs, de-duplicated, and totals its duration', async () => {
    const tracks = await seedTracks()
    const result = await runTool('music_playlist_create', {
      name: 'Focus',
      description: 'Thirty minutes',
      trackRefs: [tracks.first.trackRef, tracks.first.id, tracks.second.trackRef],
    })
    expect(result).toMatchObject({ ok: true, trackCount: 2, durationMs: 210_000 })
    const playlist = result.playlist as { id: string, name: string }
    const items = await new MusicStore(db, ALICE).listPlaylistItems(playlist.id, { page: 1, limit: 10 })
    expect(items?.total).toBe(2)
  })

  it('refuses an unknown internal id instead of creating an empty playlist', async () => {
    await expect(runTool('music_playlist_create', { name: 'Focus', trackRefs: ['not-a-track'] }))
      .rejects.toBeInstanceOf(ToolError)
  })

  it('searches the provider and returns compact refs without saving rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 200,
      result: {
        songCount: 1,
        songs: [{
          id: 777,
          name: 'Found song',
          ar: [{ id: 5, name: 'Singer' }],
          al: { id: 9, name: 'Record', picUrl: '' },
          dt: 180_000,
        }],
      },
    }), { headers: { 'content-type': 'application/json' } })))

    const result = await runTool('music_search', { query: 'found', limit: 5 })
    expect(result).toMatchObject({
      scope: 'song',
      items: [{ trackRef: 'netease:777', title: 'Found song', artists: ['Singer'], album: 'Record', durationMs: 180_000 }],
    })
    expect((await new MusicStore(db, ALICE).listFavorites({ page: 1, limit: 10 })).total).toBe(0)
  })
})
