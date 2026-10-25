/**
 * The account's own library: saved track snapshots, favourites, playlists, history, recent
 * containers and subscriptions.
 *
 * All persistence goes through `MusicStore`, whose queries carry the session's user id. A row that
 * belongs to another account therefore answers 404 from every handler here: confirming that an id
 * exists but is not yours is a leak, so "not found" is the only refusal this surface gives.
 *
 * Track snapshots are display metadata plus an upstream identity. Storage columns (`r2Key`,
 * `coverKey`, `sha256`, `size`) are deliberately not read from the request: an R2 key names an object
 * that this deployment serves by key, and accepting one from a client would let a caller point a
 * track row at another account's bytes. Those columns are written only by the upload and download
 * flows, and `upsertTrack` preserves them across a metadata refresh.
 */
import { Hono } from 'hono'
import type { MusicLibraryPayload } from '@shared/music/api'
import { parseMusicAiTranslateBody } from '@shared/music/lyrics-ai'
import type {
  MusicArtist,
  MusicHistoryEntry,
  MusicPlaylist,
  MusicProviderId,
  MusicTrack,
  MusicTrackKind,
} from '@shared/music/model'
import { MUSIC_PROVIDERS, MUSIC_SUBSCRIPTION_KINDS, MUSIC_TRACK_KINDS } from '@shared/music/model'
import { MUSIC_LIMITS, MUSIC_MAX_HISTORY_PLAYED_AT } from '@shared/music/constants'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { newSlug } from '../lib/id'
import { readFormDataWithinLimit, readJson } from '../lib/request'
import {
  deleteMusicObjects,
  discardMusicObjects,
  musicCoverKeyFor,
  putMusicObject,
} from '../music/storage'
import {
  MUSIC_PAGE_LIMIT_MAX,
  MusicStore,
  normalizeMusicLimit,
  normalizeMusicPage,
  type MusicHistoryInput,
  type MusicTrackInput,
} from '../music/store'
import { listMusicUploads } from '../music/upload-store'
import { inspectMusicCover } from '../music/metadata'
import { translateMusicLyrics } from '../music/lyrics-ai'

const TITLE_MAX = 500
const NAME_MAX = 200
const DESCRIPTION_MAX = 2_000
const URL_MAX = 2_048
const PROVIDER_ID_MAX = 128
const ARTISTS_MAX = 20
const ARTIST_NAME_MAX = 200
const FORMAT_MAX = 16
const TRACK_BATCH_MAX = MUSIC_LIMITS.trackBatchMax
const TRACK_BODY_LIMIT = 512 * 1024
const SMALL_BODY_LIMIT = 16 * 1024
const FAVORITE_BODY_LIMIT = 64 * 1024
const DURATION_MAX_MS = 24 * 60 * 60 * 1000
const BITRATE_MAX = 10_000_000
const RECENT_KINDS = ['playlist', 'album', 'radio', 'artist'] as const

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, max: number, field: string, required = false): string {
  if (value === undefined) {
    if (required) throw ApiError.badRequest(`${field} is required`)
    return ''
  }
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be text`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw ApiError.badRequest(`${field} is longer than ${max} characters`)
  if (required && !trimmed) throw ApiError.badRequest(`${field} is required`)
  return trimmed
}

function integer(value: unknown, min: number, max: number, fallback: number, field: string): number {
  if (value === undefined) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw ApiError.badRequest(`${field} must be a number`)
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function historyPlayedAt(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MUSIC_MAX_HISTORY_PLAYED_AT) {
    throw ApiError.badRequest('Played time is outside the supported range')
  }
  return Math.trunc(parsed)
}

function isProviderId(value: unknown): value is MusicProviderId {
  return typeof value === 'string' && (MUSIC_PROVIDERS as readonly string[]).includes(value)
}

function isTrackKind(value: unknown): value is MusicTrackKind {
  return typeof value === 'string' && (MUSIC_TRACK_KINDS as readonly string[]).includes(value)
}

function isRecentKind(value: unknown): value is (typeof RECENT_KINDS)[number] {
  return typeof value === 'string' && (RECENT_KINDS as readonly string[]).includes(value)
}

function isSubscriptionKind(value: unknown): value is (typeof MUSIC_SUBSCRIPTION_KINDS)[number] {
  return typeof value === 'string' && (MUSIC_SUBSCRIPTION_KINDS as readonly string[]).includes(value)
}

function coverUrl(value: unknown): string {
  const url = text(value, URL_MAX, 'Cover URL')
  // A playlist cover this deployment stores is addressed as a same-origin media route; a provider
  // cover stays an HTTP(S) address. Anything else (javascript:, data:, //host) is refused.
  if (url && !/^https?:\/\//i.test(url) && !/^\/api\/music\//.test(url)) {
    throw ApiError.badRequest('The cover URL must use HTTP, HTTPS or the music media route')
  }
  return url
}

function artistsOf(value: unknown): MusicArtist[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw ApiError.badRequest('Artists must be a list')
  if (value.length > ARTISTS_MAX) throw ApiError.badRequest(`At most ${ARTISTS_MAX} artists are accepted`)
  return value.map((entry) => {
    const raw = record(entry, 'Each artist')
    const name = text(raw.name, ARTIST_NAME_MAX, 'Artist name', true)
    const id = raw.id === undefined || raw.id === null ? '' : String(raw.id)
    if (id.length > PROVIDER_ID_MAX) throw ApiError.badRequest('An artist id is too long')
    return { id, name }
  })
}

/** Read the display snapshot a client may save. Upstream identity and metadata only. */
function trackInputOf(value: unknown): MusicTrackInput {
  const raw = record(value, 'Each track')
  if (!isProviderId(raw.provider)) throw ApiError.badRequest('That track provider is not supported')
  const providerIdRaw = raw.providerId
  const providerId = typeof providerIdRaw === 'string' || typeof providerIdRaw === 'number'
    ? String(providerIdRaw).trim()
    : ''
  if (!providerId) throw ApiError.badRequest('A track provider id is required')
  if (providerId.length > PROVIDER_ID_MAX) throw ApiError.badRequest('That track provider id is too long')
  const kind = raw.kind === undefined ? 'song' : raw.kind
  if (!isTrackKind(kind)) throw ApiError.badRequest('That track kind is not supported')
  const bitrateRaw = raw.bitrate
  const bitrate = bitrateRaw === undefined || bitrateRaw === null
    ? null
    : integer(bitrateRaw, 0, BITRATE_MAX, 0, 'Bitrate')

  return {
    provider: raw.provider,
    providerId,
    kind,
    title: text(raw.title, TITLE_MAX, 'Track title', true),
    artists: artistsOf(raw.artists),
    album: text(raw.album, TITLE_MAX, 'Album'),
    albumId: text(raw.albumId, PROVIDER_ID_MAX, 'Album id'),
    coverUrl: coverUrl(raw.coverUrl),
    durationMs: integer(raw.durationMs, 0, DURATION_MAX_MS, 0, 'Duration'),
    format: text(raw.format, FORMAT_MAX, 'Format'),
    bitrate,
    updatedAt: raw.updatedAt === undefined ? 0 : integer(raw.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0, 'Track version'),
  }
}

async function saveTracks(store: MusicStore, inputs: readonly MusicTrackInput[]): Promise<MusicTrack[]> {
  const saved: MusicTrack[] = []
  for (const input of inputs) saved.push(await store.upsertTrack(input))
  return saved
}

export const musicLibraryRoutes = new Hono<AppBindings>()

musicLibraryRoutes.get('/', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const [playlists, favorites, history, recent, uploads, subscriptions] = await Promise.all([
    store.listPlaylists(),
    store.listFavorites({ page: 1, limit: MUSIC_PAGE_LIMIT_MAX }),
    store.listHistory({ page: 1, limit: MUSIC_PAGE_LIMIT_MAX }),
    store.listRecent(MUSIC_PAGE_LIMIT_MAX),
    listMusicUploads(c.env, c.get('userId')),
    store.listSubscriptions(),
  ])
  const known = new Map<string, MusicTrack>()
  for (const track of favorites.items) known.set(track.id, track)
  for (const entry of history.items) known.set(entry.track.id, entry.track)

  const payload: MusicLibraryPayload = {
    tracks: [...known.values()],
    playlists,
    favorites: favorites.items,
    history: history.items,
    recent,
    // Downloads are owned by the download queue and its own route; this aggregate reports none
    // rather than reading a table whose lifecycle it does not control.
    downloads: [],
    uploads,
    subscriptions,
  }
  return c.json(payload)
})

musicLibraryRoutes.post('/tracks', async (c) => {
  const body = await readJson<{ tracks?: unknown }>(c, TRACK_BODY_LIMIT)
  if (!Array.isArray(body.tracks)) throw ApiError.badRequest('tracks must be a list')
  if (body.tracks.length > TRACK_BATCH_MAX) {
    throw ApiError.badRequest(`At most ${TRACK_BATCH_MAX} tracks may be saved at once`)
  }
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const tracks = await saveTracks(store, body.tracks.map(trackInputOf))
  return c.json({ tracks })
})

/**
 * Translate one track's provider lyric with the reader's own assistant model.
 *
 * Only an explicit request from the reader reaches this path: the lyric is sent to the model
 * provider they configured, and the answer is cached under the lyric's own hash so a second open is
 * free. Failures are separated by what the reader can do about them — activate a model, wait for the
 * daily ceiling, try a track that has lyrics, or retry the provider.
 */
musicLibraryRoutes.post('/lyrics/:trackId/ai-translate', async (c) => {
  const body = parseMusicAiTranslateBody(await readJson<unknown>(c, SMALL_BODY_LIMIT))
  if (!body.ok) throw ApiError.badRequest(body.error)
  const trackId = c.req.param('trackId') ?? ''
  if (!trackId || trackId.length > PROVIDER_ID_MAX) throw ApiError.notFound('That track does not exist')
  const answer = await translateMusicLyrics({
    env: c.env,
    userId: c.get('userId'),
    trackId,
    targetLang: body.targetLang,
    force: body.force,
  })
  return c.json(answer)
})

/** Snapshot shelves for the local/cloud library: uploads today, WebDAV files beside them. */
musicLibraryRoutes.get('/tracks', async (c) => {
  const provider = c.req.query('provider') ?? 'upload'
  if (provider !== 'upload' && provider !== 'webdav' && provider !== 'alist' && provider !== 'download') {
    throw ApiError.badRequest('provider must be upload, webdav, alist or download')
  }
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const page = normalizeMusicPage(c.req.query('page'))
  const limit = normalizeMusicLimit(c.req.query('limit'), MUSIC_LIMITS.trackListMax, MUSIC_LIMITS.trackListMax)
  const offset = (page - 1) * limit
  if (provider === 'download') {
    const [items, total] = await Promise.all([
      store.listDownloadedTracks(limit, offset),
      store.countDownloadedTracks(),
    ])
    return c.json({ items, total, hasMore: offset + items.length < total, page })
  }
  const [items, total] = await Promise.all([
    store.listTracksByProvider(provider, limit, offset),
    store.countTracksByProvider(provider),
  ])
  return c.json({ items, total, hasMore: offset + items.length < total, page })
})

/**
 * One library snapshot by id. The uploads page keeps only the task row, so this is how a finished
 * upload becomes a playable track without listing the whole library on that screen.
 */
musicLibraryRoutes.get('/tracks/:trackId', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const track = await store.getTrack(c.req.param('trackId') ?? '')
  if (!track) throw ApiError.notFound('That track does not exist')
  return c.json({ track })
})

musicLibraryRoutes.patch('/tracks/:trackId', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SMALL_BODY_LIMIT)
  const patch: { title?: string; artists?: ReturnType<typeof artistsOf>; album?: string; coverUrl?: string } = {}
  if (body.title !== undefined) patch.title = text(body.title, TITLE_MAX, 'Track title', true)
  if (body.artists !== undefined) patch.artists = artistsOf(body.artists)
  if (body.album !== undefined) patch.album = text(body.album, TITLE_MAX, 'Album')
  if (body.coverUrl !== undefined) patch.coverUrl = coverUrl(body.coverUrl)
  if (Object.keys(patch).length === 0) throw ApiError.badRequest('Name at least one field to change')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const track = await store.updateTrackMetadata(c.req.param('trackId') ?? '', patch)
  if (!track) throw ApiError.notFound('That track does not exist')
  return c.json({ track })
})

/**
 * Remove library snapshots in one batch.
 *
 * Removing a snapshot is not deleting a remote file: a WebDAV or Alist reference only loses the row
 * that named it, while an R2 upload releases its object through the same ledger rule a single delete
 * uses. A foreign or already-gone id is reported as a skip so a page can select a mixed batch without
 * treating another account's id as an error it caused.
 */
musicLibraryRoutes.post('/tracks/delete', async (c) => {
  const body = await readJson<{ ids?: unknown }>(c, TRACK_BODY_LIMIT)
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    throw ApiError.badRequest('Name at least one track to remove')
  }
  if (body.ids.length > TRACK_BATCH_MAX) {
    throw ApiError.badRequest(`Remove at most ${TRACK_BATCH_MAX} tracks at a time`)
  }
  const ids = [...new Set(body.ids
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 128))]
  if (ids.length === 0) throw ApiError.badRequest('Name at least one track to remove')

  const store = new MusicStore(c.env.DB, c.get('userId'))
  const result = await store.deleteTracks(ids)
  if (result.queuedObjects.length > 0) {
    try {
      await deleteMusicObjects(c.env, store, result.queuedObjects)
      for (const key of result.queuedObjects) {
        await store.dropCleanup(key).catch((error: unknown) => {
          console.warn('[inkstone] Removed track cleanup could not be marked done:', error)
        })
      }
    } catch (error) {
      console.warn('[inkstone] Removed tracks left objects for the cleanup queue:', error)
    }
  }
  return c.json({ removed: result.removed, skipped: result.skipped })
})

musicLibraryRoutes.get('/favorites', async (c) => {
  const page = normalizeMusicPage(c.req.query('page'))
  const limit = normalizeMusicLimit(c.req.query('limit'))
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json(await store.listFavorites({ page, limit }))
})

musicLibraryRoutes.post('/favorites', async (c) => {
  const body = await readJson<{ track?: unknown; trackId?: unknown }>(c, FAVORITE_BODY_LIMIT)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const trackId = body.track !== undefined
    ? (await store.upsertTrack(trackInputOf(body.track))).id
    : text(body.trackId, PROVIDER_ID_MAX, 'Track id', true)
  if (!(await store.addFavorite(trackId))) throw ApiError.notFound('That track does not exist')
  return c.json({ ok: true, trackId })
})

musicLibraryRoutes.delete('/favorites/:trackId', async (c) => {
  const trackId = c.req.param('trackId') ?? ''
  const store = new MusicStore(c.env.DB, c.get('userId'))
  if (!(await store.getTrack(trackId))) throw ApiError.notFound('That track does not exist')
  await store.removeFavorite(trackId)
  return c.json({ ok: true })
})

musicLibraryRoutes.patch('/favorites/:trackId', async (c) => {
  const body = await readJson<{ pinned?: unknown }>(c, SMALL_BODY_LIMIT)
  if (typeof body.pinned !== 'boolean') throw ApiError.badRequest('pinned must be a boolean')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const favorite = await store.setFavoritePinned(c.req.param('trackId') ?? '', body.pinned)
  if (!favorite) throw ApiError.notFound('That favourite does not exist')
  return c.json(favorite)
})

musicLibraryRoutes.get('/playlists', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ items: await store.listPlaylists() })
})

musicLibraryRoutes.post('/playlists', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SMALL_BODY_LIMIT)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const playlist = await store.createPlaylist({
    name: text(body.name, NAME_MAX, 'Playlist name', true),
    description: text(body.description, DESCRIPTION_MAX, 'Description'),
    coverUrl: coverUrl(body.coverUrl),
  })
  return c.json(playlist, 201)
})

musicLibraryRoutes.patch('/playlists/:id', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SMALL_BODY_LIMIT)
  const patch: {
    name?: string
    description?: string
    coverUrl?: string
    coverKey?: string
    sortOrder?: number
  } = {}
  let pinned: boolean | undefined
  if (body.name !== undefined) patch.name = text(body.name, NAME_MAX, 'Playlist name', true)
  if (body.description !== undefined) patch.description = text(body.description, DESCRIPTION_MAX, 'Description')
  if (body.coverUrl !== undefined) patch.coverUrl = coverUrl(body.coverUrl)
  if (body.sortOrder !== undefined) {
    patch.sortOrder = integer(body.sortOrder, 0, 1_000_000, 0, 'Sort order')
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') throw ApiError.badRequest('Pinned must be true or false')
    pinned = body.pinned
  }
  if (Object.keys(patch).length === 0 && pinned === undefined) {
    throw ApiError.badRequest('Name at least one field to change')
  }

  const id = c.req.param('id')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const current = await store.getPlaylist(id)
  if (!current) throw ApiError.notFound('That playlist does not exist')
  let playlist: MusicPlaylist = current
  if (Object.keys(patch).length > 0) {
    const previousCoverKey = patch.coverUrl === undefined ? null : await store.getPlaylistCoverKey(id)
    if (patch.coverUrl !== undefined) patch.coverKey = ''
    const updated = await store.updatePlaylist(id, patch)
    if (!updated) throw ApiError.notFound('That playlist does not exist')
    playlist = updated
    if (previousCoverKey) {
      if (await discardMusicObjects(c.env, store, [previousCoverKey])) {
        await store.unregisterObject(previousCoverKey)
      }
    }
  }
  if (pinned !== undefined) {
    const updated = await store.setPlaylistPinned(id, pinned)
    if (!updated) throw ApiError.notFound('That playlist does not exist')
    playlist = updated
  }
  return c.json(playlist)
})

musicLibraryRoutes.post('/playlists/:id/share', async (c) => {
  const id = c.req.param('id')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  let playlist = await store.getPlaylist(id)
  if (!playlist) throw ApiError.notFound('That playlist does not exist')
  if (!playlist.shareSlug) {
    const updated = await store.setPlaylistShare(id, newSlug())
    if (!updated) throw ApiError.notFound('That playlist does not exist')
    playlist = updated
  }
  return c.json({
    playlist,
    url: `${new URL(c.req.url).origin}/m/${playlist.shareSlug}`,
  })
})

musicLibraryRoutes.delete('/playlists/:id/share', async (c) => {
  const playlist = await new MusicStore(c.env.DB, c.get('userId'))
    .setPlaylistShare(c.req.param('id'), null)
  if (!playlist) throw ApiError.notFound('That playlist does not exist')
  return c.json({ playlist })
})

/** Replace the cover with one image. The bytes are sniffed, never trusted from the filename. */
musicLibraryRoutes.post('/playlists/:id/cover', async (c) => {
  const id = c.req.param('id')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const current = await store.getPlaylist(id)
  if (!current) throw ApiError.notFound('That playlist does not exist')

  const form = await readFormDataWithinLimit(c.req, MUSIC_LIMITS.coverMaxBytes + 1024 * 1024)
  const file = form.get('cover')
  if (!(file instanceof File)) throw ApiError.badRequest('Attach one image in the "cover" field.')
  if (file.size <= 0) throw ApiError.badRequest('That image is empty.')
  if (file.size > MUSIC_LIMITS.coverMaxBytes) {
    throw ApiError.tooLarge(`Covers must be ${Math.round(MUSIC_LIMITS.coverMaxBytes / (1024 * 1024))} MB or smaller.`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const image = inspectMusicCover(bytes, file.type)

  const key = musicCoverKeyFor({ userId: c.get('userId'), trackId: id, extension: image.extension })
  await putMusicObject(c.env, key, bytes, {
    contentType: image.mime,
    userId: c.get('userId'),
    trackId: id,
    kind: 'cover',
  })
  await store.registerObject({
    r2Key: key,
    trackId: id,
    format: 'cover',
    quality: 'original',
    size: bytes.byteLength,
  })
  const previous = await store.getPlaylistCoverKey(id)
  const playlist = await store.updatePlaylist(id, {
    coverKey: key,
    coverUrl: `/api/music/media/cover/playlist/${id}?v=${Date.now()}`,
  })
  if (!playlist) throw ApiError.notFound('That playlist does not exist')
  if (previous && previous !== key) {
    if (await discardMusicObjects(c.env, store, [previous])) {
      await store.unregisterObject(previous)
    }
  }
  return c.json({ playlist })
})

musicLibraryRoutes.delete('/playlists/:id/cover', async (c) => {
  const id = c.req.param('id')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const current = await store.getPlaylist(id)
  if (!current) throw ApiError.notFound('That playlist does not exist')
  const previous = await store.getPlaylistCoverKey(id)
  const playlist = await store.updatePlaylist(id, { coverUrl: '', coverKey: '' })
  if (!playlist) throw ApiError.notFound('That playlist does not exist')
  if (previous) {
    if (await discardMusicObjects(c.env, store, [previous])) await store.unregisterObject(previous)
  }
  return c.json({ playlist })
})

musicLibraryRoutes.delete('/playlists/:id', async (c) => {
  const id = c.req.param('id')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const coverKey = await store.getPlaylistCoverKey(id)
  if (!(await store.deletePlaylist(id))) throw ApiError.notFound('That playlist does not exist')
  // The cover is a ledger object like audio; its row is the last reference, so drop the bytes and
  // the ledger row together.
  if (coverKey) {
    if (await discardMusicObjects(c.env, store, [coverKey])) await store.unregisterObject(coverKey)
  }
  return c.json({ ok: true })
})

musicLibraryRoutes.get('/playlists/:id/items', async (c) => {
  const page = normalizeMusicPage(c.req.query('page'))
  const limit = normalizeMusicLimit(c.req.query('limit'))
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const items = await store.listPlaylistItems(c.req.param('id'), { page, limit })
  if (!items) throw ApiError.notFound('That playlist does not exist')
  return c.json({
    items: items.items.map((item) => item.track),
    total: items.total,
    hasMore: items.hasMore,
  })
})

musicLibraryRoutes.post('/playlists/:id/items', async (c) => {
  const body = await readJson<{ tracks?: unknown; trackIds?: unknown }>(c, TRACK_BODY_LIMIT)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const playlistId = c.req.param('id')

  let trackIds: string[]
  if (body.tracks !== undefined) {
    if (!Array.isArray(body.tracks)) throw ApiError.badRequest('tracks must be a list')
    if (body.tracks.length > TRACK_BATCH_MAX) {
      throw ApiError.badRequest(`At most ${TRACK_BATCH_MAX} tracks may be added at once`)
    }
    trackIds = (await saveTracks(store, body.tracks.map(trackInputOf))).map((track) => track.id)
  } else {
    if (!Array.isArray(body.trackIds)) throw ApiError.badRequest('tracks must be a list')
    if (body.trackIds.length > TRACK_BATCH_MAX) {
      throw ApiError.badRequest(`At most ${TRACK_BATCH_MAX} tracks may be added at once`)
    }
    trackIds = body.trackIds
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  }
  if (await store.addPlaylistItems(playlistId, trackIds) === null) {
    throw ApiError.notFound('That playlist does not exist')
  }

  const items = await store.listPlaylistItems(playlistId, { page: 1, limit: MUSIC_PAGE_LIMIT_MAX })
  if (!items) throw ApiError.notFound('That playlist does not exist')
  return c.json({
    items: items.items.map((item) => item.track),
    total: items.total,
    hasMore: items.hasMore,
  })
})

musicLibraryRoutes.put('/playlists/:id/items/order', async (c) => {
  const body = await readJson<{ trackIds?: unknown }>(c, TRACK_BODY_LIMIT)
  if (!Array.isArray(body.trackIds)) throw ApiError.badRequest('trackIds must be a list')
  if (body.trackIds.length > MUSIC_LIMITS.playlistItems) {
    throw ApiError.badRequest(`At most ${MUSIC_LIMITS.playlistItems} tracks may be reordered at once`)
  }
  const trackIds = body.trackIds
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  if (await store.reorderPlaylistItems(c.req.param('id'), trackIds) === null) {
    throw ApiError.notFound('That playlist does not exist')
  }
  return c.json({ ok: true })
})

musicLibraryRoutes.delete('/playlists/:id/items/:trackId', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  if (!(await store.removePlaylistItem(c.req.param('id'), c.req.param('trackId')))) {
    throw ApiError.notFound('That playlist item does not exist')
  }
  return c.json({ ok: true })
})

musicLibraryRoutes.get('/history', async (c) => {
  const page = normalizeMusicPage(c.req.query('page'))
  const limit = normalizeMusicLimit(c.req.query('limit'))
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json(await store.listHistory({ page, limit }))
})

musicLibraryRoutes.get('/history/summary', async (c) => {
  const timezoneOffset = integer(c.req.query('tzOffset'), -840, 840, 0, 'Timezone offset')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json(await store.historySummary(timezoneOffset))
})

musicLibraryRoutes.delete('/history/track/:trackId', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ ok: true, removed: await store.deleteHistoryForTrack(c.req.param('trackId') ?? '') })
})

musicLibraryRoutes.delete('/history/:id', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  if (!(await store.deleteHistory(c.req.param('id')))) {
    throw ApiError.notFound('That play does not exist')
  }
  return c.json({ ok: true })
})

musicLibraryRoutes.delete('/history', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ ok: true, removed: await store.clearHistory() })
})

musicLibraryRoutes.post('/history', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SMALL_BODY_LIMIT)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const trackId = body.track !== undefined
    ? (await store.upsertTrack(trackInputOf(body.track))).id
    : text(body.trackId, PROVIDER_ID_MAX, 'Track id', true)
  const input: MusicHistoryInput = {
    trackId,
    playedAt: historyPlayedAt(body.playedAt),
    durationPlayed: integer(body.durationPlayed, 0, DURATION_MAX_MS, 0, 'Played duration'),
    completed: body.completed === true,
    contextType: text(body.contextType, 32, 'Context type'),
    contextId: text(body.contextId, PROVIDER_ID_MAX, 'Context id'),
  }
  const entry: MusicHistoryEntry | null = await store.recordHistory(input)
  if (!entry) throw ApiError.notFound('That track does not exist')
  return c.json({ ok: true, entry })
})

musicLibraryRoutes.get('/recent', async (c) => {
  const limit = normalizeMusicLimit(c.req.query('limit'), MUSIC_PAGE_LIMIT_MAX)
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ items: await store.listRecent(limit) })
})

musicLibraryRoutes.post('/recent', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SMALL_BODY_LIMIT)
  if (!isRecentKind(body.kind)) throw ApiError.badRequest('That recent kind is not supported')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const entry = await store.touchRecent({
    kind: body.kind,
    providerId: text(body.providerId, PROVIDER_ID_MAX, 'Provider id', true),
    name: text(body.name, TITLE_MAX, 'Name', true),
    coverUrl: coverUrl(body.coverUrl),
  })
  return c.json({ ok: true, entry })
})

musicLibraryRoutes.get('/subscriptions', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  return c.json({ items: await store.listSubscriptions() })
})

musicLibraryRoutes.post('/subscriptions', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SMALL_BODY_LIMIT)
  if (!isSubscriptionKind(body.kind)) throw ApiError.badRequest('That subscription kind is not supported')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const subscription = await store.createSubscription({
    kind: body.kind,
    providerId: text(body.providerId, PROVIDER_ID_MAX, 'Provider id', true),
    name: text(body.name, NAME_MAX, 'Name', true),
    coverUrl: coverUrl(body.coverUrl),
  })
  return c.json(subscription, 201)
})

musicLibraryRoutes.patch('/subscriptions/:id', async (c) => {
  const body = await readJson<Record<string, unknown>>(c, SMALL_BODY_LIMIT)
  const patch: { name?: string; coverUrl?: string } = {}
  if (body.name !== undefined) patch.name = text(body.name, NAME_MAX, 'Name', true)
  if (body.coverUrl !== undefined) patch.coverUrl = coverUrl(body.coverUrl)
  if (Object.keys(patch).length === 0) throw ApiError.badRequest('Name at least one field to change')
  const store = new MusicStore(c.env.DB, c.get('userId'))
  const subscription = await store.updateSubscription(c.req.param('id'), patch)
  if (!subscription) throw ApiError.notFound('That subscription does not exist')
  return c.json(subscription)
})

musicLibraryRoutes.delete('/subscriptions/:id', async (c) => {
  const store = new MusicStore(c.env.DB, c.get('userId'))
  if (!(await store.deleteSubscription(c.req.param('id')))) {
    throw ApiError.notFound('That subscription does not exist')
  }
  return c.json({ ok: true })
})
