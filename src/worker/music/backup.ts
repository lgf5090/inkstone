/**
 * The music library as a backup can carry it.
 *
 * A backup is a file that leaves the server, so the document holds only the library a listener would
 * miss: saved track snapshots, playlists and their order, favourites, play history, recent containers,
 * the R2 object ledger, per-track source choices and podcast/artist/album subscriptions. Audio bytes
 * are not copied — the deployment backs up the `music/` prefix separately — and the object keys stay in
 * the document so a restored track can be marked missing when its bytes are not in the bucket.
 *
 * The excluded tables are deliberate:
 *
 *  - `music_account`, because its columns include the encrypted Netease cookie. A backup that carried
 *    the ciphertext would put every connected account one stolen archive away from a stranger.
 *  - `music_lyric`, because cached lyrics are third-party content and can be fetched again.
 *  - `music_upload`, `music_download` and `music_cleanup`, because they are transient job state rather
 *    than a library, and restoring a half-finished download would invent a queue entry that never ran.
 *
 * The restore is additive and idempotent: an account that already owns a row keeps it, and importing
 * the same document twice leaves the same rows. That is what makes a restore safe to retry after a
 * partial network failure, and it is why every insert is `INSERT OR IGNORE` rather than a delete and
 * rewrite. Anything that cannot be understood is refused before the first write, with the same 400 a
 * malformed request gets — a backup is external input and gets the same trust boundary.
 */
import { MUSIC_LIMITS } from '@shared/music/constants'
import {
  MUSIC_PROVIDERS,
  MUSIC_SUBSCRIPTION_KINDS,
  MUSIC_TRACK_KINDS,
  type MusicArtist,
  type MusicFavorite,
  type MusicHistoryEntry,
  type MusicPlaylist,
  type MusicPlaylistItem,
  type MusicProviderId,
  type MusicRecentEntry,
  type MusicSettings,
  type MusicSourceOverride,
  type MusicSubscription,
  type MusicTrack,
  type MusicTrackKind,
} from '@shared/music/model'
import { utf8ByteLength } from '@shared/text-utils'
import { MAX_BATCH_STATEMENTS } from '../db/writes'
import { ApiError } from '../lib/errors'
import { MusicStore } from './store'

export const MUSIC_BACKUP_VERSION = 1 as const

/** Ceilings on a restore. Above these the file is not a personal music library. */
const MAX_TRACKS = 20_000
const MAX_PLAYLISTS = 5_000
const MAX_PLAYLIST_ITEMS = 50_000
const MAX_FAVORITES = 50_000
const MAX_HISTORY = 50_000
const MAX_RECENT = 5_000
const MAX_OBJECTS = 50_000
const MAX_SOURCE_OVERRIDES = 50_000
const MAX_SUBSCRIPTIONS = 50_000

/** The field ceilings the library routes already use for their own writes. */
const TITLE_MAX = 500
const NAME_MAX = 200
const DESCRIPTION_MAX = 2_000
const URL_MAX = 2_048
const PROVIDER_ID_MAX = 128
const ID_MAX = 128
const ARTISTS_MAX = 20
const ARTIST_NAME_MAX = 200
const FORMAT_MAX = 16
const SOURCE_MAX = 32
const TRACK_KEY_MAX = 200
const OBJECT_KEY_MAX = 1_024
const DURATION_MAX_MS = 7 * 24 * 60 * 60 * 1_000
const BITRATE_MAX = 10_000_000
const SOURCE_CONFIG_MAX_BYTES = 16 * 1024
const TIMESTAMP_MAX = 8_640_000_000_000_000

/**
 * Rows per `json_each` statement.
 *
 * A document may carry fifty thousand history entries. One prepared statement per row would spend
 * hundreds of D1 subrequests before the restore finished, so each statement inserts a window of rows
 * through a single bound JSON array. The window stays small enough that the JSON text is comfortably
 * below D1's statement payload limit even for the widest table here.
 */
const TRACK_CHUNK = 50
const PLAYLIST_CHUNK = 100
const PLAYLIST_ITEM_CHUNK = 500
const FAVORITE_CHUNK = 500
const HISTORY_CHUNK = 200
const RECENT_CHUNK = 100
const OBJECT_CHUNK = 200
const SOURCE_OVERRIDE_CHUNK = 100
const SUBSCRIPTION_CHUNK = 100

export type MusicBackupPlaylist = Omit<MusicPlaylist, 'trackCount'>

export interface MusicBackupObject {
  r2Key: string
  trackId: string | null
  format: string
  quality: string
  size: number
  sha256: string
  createdAt: number
}

export interface MusicBackupDocument {
  version: typeof MUSIC_BACKUP_VERSION
  exportedAt: string
  settings: MusicSettings | null
  tracks: MusicTrack[]
  playlists: MusicBackupPlaylist[]
  playlistItems: MusicPlaylistItem[]
  favorites: MusicFavorite[]
  history: MusicHistoryEntry[]
  recent: MusicRecentEntry[]
  objects: MusicBackupObject[]
  sourceOverrides: MusicSourceOverride[]
  subscriptions: MusicSubscription[]
}

export interface MusicBackupSummary {
  tracks: number
  playlists: number
  items: number
  favorites: number
  history: number
  recent: number
  objects: number
  overrides: number
  subscriptions: number
}

interface TrackBackupRow {
  id: string
  provider: string
  provider_id: string
  kind: string
  title: string
  artists: string
  album: string
  album_id: string
  cover_url: string
  cover_key: string
  duration_ms: number
  format: string
  bitrate: number | null
  size: number | null
  sha256: string
  r2_key: string | null
  source: string
  source_quality: string
  created_at: number
  updated_at: number
}

interface PlaylistBackupRow {
  id: string
  name: string
  description: string
  cover_url: string
  provider: string
  provider_id: string
  kind: string
  sort_order: number
  pinned_at: number | null
  created_at: number
  updated_at: number
}

interface PlaylistItemBackupRow {
  playlist_id: string
  track_id: string
  position: number
  added_at: number
}

interface FavoriteBackupRow {
  track_id: string
  created_at: number
  pinned_at: number | null
}

interface HistoryBackupRow {
  id: string
  track_id: string
  played_at: number
  duration_played: number
  completed: number
  context_type: string
  context_id: string
}

interface RecentBackupRow {
  id: string
  kind: string
  provider_id: string
  name: string
  cover_url: string
  last_played_at: number
  play_count: number
}

interface ObjectBackupRow {
  r2_key: string
  track_id: string | null
  format: string
  quality: string
  size: number
  sha256: string
  created_at: number
}

interface SourceOverrideBackupRow {
  track_key: string
  source: string
  config: string
  updated_at: number
}

interface SubscriptionBackupRow {
  id: string
  kind: string
  provider_id: string
  name: string
  cover_url: string
  created_at: number
}

interface ExistingTrackIdentity {
  id: string
  provider: string
  provider_id: string
}

/**
 * The account's music library as JSON, or null when the account has none of the data a backup carries.
 *
 * Null rather than an empty document: a listener who never opened the music app should not grow a
 * `music.json` that a restore then treats as "this account has no library". The document is a snapshot
 * of the tables the app owns, in a stable order, so two exports of an unchanged library differ only in
 * `exportedAt`.
 */
export async function readBackupMusic(db: D1Database, userId: string): Promise<string | null> {
  const [tracks, playlists, playlistItems, favorites, history, recent, objects, sourceOverrides, subscriptions, settingRow] =
    await Promise.all([
      db.prepare(
        `SELECT id, provider, provider_id, kind, title, artists, album, album_id, cover_url,
                cover_key, duration_ms, format, bitrate, size, sha256, r2_key, source,
                source_quality, created_at, updated_at
           FROM music_track WHERE user_id = ?1 ORDER BY created_at, id`,
      ).bind(userId).all<TrackBackupRow>(),
      db.prepare(
        `SELECT id, name, description, cover_url, provider, provider_id, kind, sort_order,
                pinned_at, created_at, updated_at
           FROM music_playlist WHERE user_id = ?1 ORDER BY sort_order, created_at, id`,
      ).bind(userId).all<PlaylistBackupRow>(),
      db.prepare(
        `SELECT playlist_id, track_id, position, added_at
           FROM music_playlist_item WHERE user_id = ?1
          ORDER BY playlist_id, position, track_id`,
      ).bind(userId).all<PlaylistItemBackupRow>(),
      db.prepare(
        `SELECT track_id, created_at, pinned_at FROM music_favorite
          WHERE user_id = ?1 ORDER BY created_at, track_id`,
      ).bind(userId).all<FavoriteBackupRow>(),
      db.prepare(
        `SELECT id, track_id, played_at, duration_played, completed, context_type, context_id
           FROM music_history WHERE user_id = ?1 ORDER BY played_at, id`,
      ).bind(userId).all<HistoryBackupRow>(),
      db.prepare(
        `SELECT id, kind, provider_id, name, cover_url, last_played_at, play_count
           FROM music_recent WHERE user_id = ?1 ORDER BY last_played_at, id`,
      ).bind(userId).all<RecentBackupRow>(),
      db.prepare(
        `SELECT r2_key, track_id, format, quality, size, sha256, created_at
           FROM music_object WHERE user_id = ?1 ORDER BY created_at, r2_key`,
      ).bind(userId).all<ObjectBackupRow>(),
      db.prepare(
        `SELECT track_key, source, config, updated_at
           FROM music_source_override WHERE user_id = ?1 ORDER BY updated_at, track_key`,
      ).bind(userId).all<SourceOverrideBackupRow>(),
      db.prepare(
        `SELECT id, kind, provider_id, name, cover_url, created_at
           FROM music_subscription WHERE user_id = ?1 ORDER BY created_at, id`,
      ).bind(userId).all<SubscriptionBackupRow>(),
      db.prepare('SELECT settings FROM music_setting WHERE user_id = ?1')
        .bind(userId).first<{ settings: string }>(),
    ])

  const settings = settingRow
    ? readStoredObject(settingRow.settings, 'music settings') as unknown as MusicSettings
    : null
  const total = tracks.results.length + playlists.results.length + playlistItems.results.length
    + favorites.results.length + history.results.length + recent.results.length
    + objects.results.length + sourceOverrides.results.length + subscriptions.results.length
  if (total === 0 && settings === null) return null

  const document: MusicBackupDocument = {
    version: MUSIC_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: settings === null ? null : sanitizeResolverSettings(settings),
    tracks: tracks.results.map(toBackupTrack),
    playlists: playlists.results.map(toBackupPlaylist),
    playlistItems: playlistItems.results.map(toBackupPlaylistItem),
    favorites: favorites.results.map((row) => ({
      trackId: row.track_id,
      createdAt: row.created_at,
      pinnedAt: row.pinned_at,
    })),
    history: history.results.map(toBackupHistory),
    recent: recent.results.map(toBackupRecent),
    objects: objects.results.map(toBackupObject),
    sourceOverrides: sourceOverrides.results.map(toBackupSourceOverride),
    subscriptions: subscriptions.results.map(toBackupSubscription),
  }
  return JSON.stringify(document)
}

/**
 * Put a carried music document back into the account.
 *
 * The whole document is validated before the first write, including every R2 key: a track row is
 * served and deleted by its key alone, so a key that names another account's object would turn a
 * backup into a way to read or destroy someone else's bytes. Only keys under `music/` with the
 * restoring account's own id as a path segment are accepted.
 *
 * Tracks are merged by id first and by provider identity second. A track this account already owns
 * under the same `(provider, provider_id)` keeps its existing library id, and playlist items,
 * favourites and history that named the document's id are remapped to it — otherwise a second import
 * would leave the references pointing at an id that was ignored.
 */
export async function applyBackupMusic(
  db: D1Database,
  userId: string,
  text: string,
): Promise<MusicBackupSummary> {
  const document = parseDocument(text, userId)
  const store = new MusicStore(db, userId)

  const existingTracks = await db.prepare(
    'SELECT id, provider, provider_id FROM music_track WHERE user_id = ?1',
  ).bind(userId).all<ExistingTrackIdentity>()
  const { trackInserts, trackIdMap } = planTracks(document.tracks, existingTracks.results)
  const playlistItems = resolvePlaylistItems(document.playlistItems, trackIdMap)
  const favorites = resolveFavorites(document.favorites, trackIdMap)
  const history = resolveHistory(document.history, trackIdMap)
  const objects = resolveObjects(document.objects, trackIdMap)

  const statements: D1PreparedStatement[] = [
    ...trackStatements(db, userId, trackInserts),
    ...playlistStatements(db, userId, document.playlists),
    ...playlistItemStatements(db, userId, playlistItems),
    ...favoriteStatements(db, userId, favorites),
    ...historyStatements(db, userId, history),
    ...recentStatements(db, userId, document.recent),
    ...objectStatements(db, userId, objects),
    ...sourceOverrideStatements(db, userId, document.sourceOverrides),
    ...subscriptionStatements(db, userId, document.subscriptions),
  ]
  if (document.history.length) statements.push(trimHistoryStatement(db, userId))
  if (document.recent.length) statements.push(trimRecentStatement(db, userId))

  for (let offset = 0; offset < statements.length; offset += MAX_BATCH_STATEMENTS) {
    await db.batch(statements.slice(offset, offset + MAX_BATCH_STATEMENTS))
  }
  if (document.settings) await store.saveSettings(document.settings)

  return {
    tracks: document.tracks.length,
    playlists: document.playlists.length,
    items: playlistItems.length,
    favorites: favorites.length,
    history: document.history.length,
    recent: document.recent.length,
    objects: document.objects.length,
    overrides: document.sourceOverrides.length,
    subscriptions: document.subscriptions.length,
  }
}

// Parsing ---------------------------------------------------------------------------------------

function parseDocument(text: string, userId: string): MusicBackupDocument {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw ApiError.badRequest('The music backup is not valid JSON')
  }
  const source = asRecord(value, 'The music backup')
  if (source.version !== MUSIC_BACKUP_VERSION) {
    throw ApiError.badRequest(`Unsupported music backup version: ${String(source.version)}`)
  }

  const tracks = rowsOf(source.tracks, MAX_TRACKS, 'tracks').map((row, index) => parseTrack(row, index, userId))
  const playlists = rowsOf(source.playlists, MAX_PLAYLISTS, 'playlists')
    .map((row, index) => parsePlaylist(row, index))
  const playlistItems = rowsOf(source.playlistItems, MAX_PLAYLIST_ITEMS, 'playlist items')
    .map((row, index) => parsePlaylistItem(row, index))
  const favorites = rowsOf(source.favorites, MAX_FAVORITES, 'favourites')
    .map((row, index) => parseFavorite(row, index))
  const history = rowsOf(source.history, MAX_HISTORY, 'history')
    .map((row, index) => parseHistory(row, index))
  const recent = rowsOf(source.recent, MAX_RECENT, 'recent containers')
    .map((row, index) => parseRecent(row, index))
  const objects = rowsOf(source.objects, MAX_OBJECTS, 'objects')
    .map((row, index) => parseObject(row, index, userId))
  const sourceOverrides = rowsOf(source.sourceOverrides, MAX_SOURCE_OVERRIDES, 'source overrides')
    .map((row, index) => parseSourceOverride(row, index))
  const subscriptions = rowsOf(source.subscriptions, MAX_SUBSCRIPTIONS, 'subscriptions')
    .map((row, index) => parseSubscription(row, index))

  assertUnique(tracks.map((row) => row.id), 'track id')
  assertUnique(tracks.map((row) => `${row.provider}\u0000${row.providerId}`), 'track provider identity')
  assertUnique(playlists.map((row) => row.id), 'playlist id')
  assertUnique(playlistItems.map((row) => `${row.playlistId}\u0000${row.trackId}`), 'playlist item')
  assertUnique(favorites.map((row) => row.trackId), 'favourite track')
  assertUnique(history.map((row) => row.id), 'history id')
  assertUnique(recent.map((row) => row.id), 'recent id')
  assertUnique(recent.map((row) => `${row.kind}\u0000${row.providerId}`), 'recent container')
  assertUnique(objects.map((row) => row.r2Key), 'object key')
  assertUnique(sourceOverrides.map((row) => row.trackKey), 'source override key')
  assertUnique(subscriptions.map((row) => row.id), 'subscription id')
  assertUnique(subscriptions.map((row) => `${row.kind}\u0000${row.providerId}`), 'subscription identity')

  const trackIds = new Set(tracks.map((row) => row.id))
  const playlistIds = new Set(playlists.map((row) => row.id))
  for (const item of playlistItems) {
    if (!playlistIds.has(item.playlistId)) {
      throw ApiError.badRequest(`A playlist item names an unknown playlist: ${item.playlistId}`)
    }
    if (!trackIds.has(item.trackId)) {
      throw ApiError.badRequest(`A playlist item names an unknown track: ${item.trackId}`)
    }
  }
  for (const favorite of favorites) {
    if (!trackIds.has(favorite.trackId)) {
      throw ApiError.badRequest(`A favourite names an unknown track: ${favorite.trackId}`)
    }
  }
  for (const entry of history) {
    if (!trackIds.has(entry.trackId)) {
      throw ApiError.badRequest(`A history entry names an unknown track: ${entry.trackId}`)
    }
  }
  for (const object of objects) {
    if (object.trackId !== null && !trackIds.has(object.trackId)) {
      throw ApiError.badRequest(`An object names an unknown track: ${object.trackId}`)
    }
  }

  return {
    version: MUSIC_BACKUP_VERSION,
    exportedAt: optionalText(source.exportedAt, 64, 'exportedAt'),
    settings: parseSettings(source.settings),
    tracks,
    playlists,
    playlistItems,
    favorites,
    history,
    recent,
    objects,
    sourceOverrides,
    subscriptions,
  }
}

function parseTrack(value: unknown, index: number, userId: string): MusicTrack {
  const row = asRecord(value, `Track ${index + 1}`)
  const r2Key = row.r2Key === undefined || row.r2Key === null || row.r2Key === ''
    ? null
    : ownedMusicKey(row.r2Key, `Track ${index + 1} r2Key`, userId)
  const coverKey = optionalText(row.coverKey, OBJECT_KEY_MAX, `Track ${index + 1} coverKey`)
  if (coverKey) ownedMusicKey(coverKey, `Track ${index + 1} coverKey`, userId)
  return {
    id: requiredText(row.id, ID_MAX, `Track ${index + 1} id`),
    provider: oneOf(row.provider, MUSIC_PROVIDERS, `Track ${index + 1} provider`) as MusicProviderId,
    providerId: requiredText(row.providerId, PROVIDER_ID_MAX, `Track ${index + 1} providerId`),
    kind: oneOf(row.kind ?? 'song', MUSIC_TRACK_KINDS, `Track ${index + 1} kind`) as MusicTrackKind,
    title: requiredText(row.title, TITLE_MAX, `Track ${index + 1} title`),
    artists: parseArtists(row.artists, `Track ${index + 1} artists`),
    album: optionalText(row.album, TITLE_MAX, `Track ${index + 1} album`),
    albumId: optionalText(row.albumId, PROVIDER_ID_MAX, `Track ${index + 1} albumId`),
    coverUrl: optionalUrl(row.coverUrl, `Track ${index + 1} coverUrl`),
    coverKey,
    durationMs: optionalInteger(row.durationMs, 0, DURATION_MAX_MS, `Track ${index + 1} durationMs`, 0),
    format: optionalText(row.format, FORMAT_MAX, `Track ${index + 1} format`),
    bitrate: optionalNullableInteger(row.bitrate, 0, BITRATE_MAX, `Track ${index + 1} bitrate`),
    size: optionalNullableInteger(row.size, 0, Number.MAX_SAFE_INTEGER, `Track ${index + 1} size`),
    sha256: optionalHash(row.sha256, `Track ${index + 1} sha256`),
    r2Key,
    source: optionalText(row.source, SOURCE_MAX, `Track ${index + 1} source`),
    sourceQuality: optionalText(row.sourceQuality, SOURCE_MAX, `Track ${index + 1} sourceQuality`),
    createdAt: optionalTimestamp(row.createdAt, `Track ${index + 1} createdAt`),
    updatedAt: optionalTimestamp(row.updatedAt, `Track ${index + 1} updatedAt`),
  }
}

function parsePlaylist(value: unknown, index: number): MusicBackupPlaylist {
  const row = asRecord(value, `Playlist ${index + 1}`)
  return {
    id: requiredText(row.id, ID_MAX, `Playlist ${index + 1} id`),
    name: requiredText(row.name, NAME_MAX, `Playlist ${index + 1} name`),
    description: optionalText(row.description, DESCRIPTION_MAX, `Playlist ${index + 1} description`),
    coverUrl: optionalUrl(row.coverUrl, `Playlist ${index + 1} coverUrl`),
    provider: oneOf(row.provider ?? 'local', ['local', 'netease'] as const, `Playlist ${index + 1} provider`),
    providerId: optionalText(row.providerId, PROVIDER_ID_MAX, `Playlist ${index + 1} providerId`),
    kind: oneOf(row.kind ?? 'manual', ['manual', 'imported', 'favorites'] as const, `Playlist ${index + 1} kind`),
    sortOrder: optionalInteger(row.sortOrder, 0, Number.MAX_SAFE_INTEGER, `Playlist ${index + 1} sortOrder`, 0),
    pinnedAt: optionalNullableInteger(row.pinnedAt, 0, TIMESTAMP_MAX, `Playlist ${index + 1} pinnedAt`),
    createdAt: optionalTimestamp(row.createdAt, `Playlist ${index + 1} createdAt`),
    updatedAt: optionalTimestamp(row.updatedAt, `Playlist ${index + 1} updatedAt`),
  }
}

function parsePlaylistItem(value: unknown, index: number): MusicPlaylistItem {
  const row = asRecord(value, `Playlist item ${index + 1}`)
  return {
    playlistId: requiredText(row.playlistId, ID_MAX, `Playlist item ${index + 1} playlistId`),
    trackId: requiredText(row.trackId, ID_MAX, `Playlist item ${index + 1} trackId`),
    position: optionalInteger(row.position, 0, Number.MAX_SAFE_INTEGER, `Playlist item ${index + 1} position`, 0),
    addedAt: optionalTimestamp(row.addedAt, `Playlist item ${index + 1} addedAt`),
  }
}

function parseFavorite(value: unknown, index: number): MusicFavorite {
  const row = asRecord(value, `Favourite ${index + 1}`)
  return {
    trackId: requiredText(row.trackId, ID_MAX, `Favourite ${index + 1} trackId`),
    createdAt: optionalTimestamp(row.createdAt, `Favourite ${index + 1} createdAt`),
    // A version 1 file written before pinning simply has no field, and unpinned is what it meant.
    pinnedAt: optionalNullableInteger(row.pinnedAt, 0, TIMESTAMP_MAX, `Favourite ${index + 1} pinnedAt`),
  }
}

function parseHistory(value: unknown, index: number): MusicHistoryEntry {
  const row = asRecord(value, `History entry ${index + 1}`)
  return {
    id: requiredText(row.id, ID_MAX, `History entry ${index + 1} id`),
    trackId: requiredText(row.trackId, ID_MAX, `History entry ${index + 1} trackId`),
    playedAt: optionalTimestamp(row.playedAt, `History entry ${index + 1} playedAt`),
    durationPlayed: optionalInteger(
      row.durationPlayed,
      0,
      DURATION_MAX_MS,
      `History entry ${index + 1} durationPlayed`,
      0,
    ),
    completed: optionalBoolean(row.completed, `History entry ${index + 1} completed`, false),
    contextType: optionalText(row.contextType, SOURCE_MAX, `History entry ${index + 1} contextType`),
    contextId: optionalText(row.contextId, PROVIDER_ID_MAX, `History entry ${index + 1} contextId`),
  }
}

function parseRecent(value: unknown, index: number): MusicRecentEntry {
  const row = asRecord(value, `Recent container ${index + 1}`)
  return {
    id: requiredText(row.id, ID_MAX, `Recent container ${index + 1} id`),
    kind: oneOf(
      row.kind,
      ['playlist', 'album', 'radio', 'artist'] as const,
      `Recent container ${index + 1} kind`,
    ),
    providerId: requiredText(row.providerId, PROVIDER_ID_MAX, `Recent container ${index + 1} providerId`),
    name: requiredText(row.name, NAME_MAX, `Recent container ${index + 1} name`),
    coverUrl: optionalUrl(row.coverUrl, `Recent container ${index + 1} coverUrl`),
    lastPlayedAt: optionalTimestamp(row.lastPlayedAt, `Recent container ${index + 1} lastPlayedAt`),
    playCount: optionalInteger(
      row.playCount,
      0,
      Number.MAX_SAFE_INTEGER,
      `Recent container ${index + 1} playCount`,
      1,
    ),
  }
}

function parseObject(value: unknown, index: number, userId: string): MusicBackupObject {
  const row = asRecord(value, `Object ${index + 1}`)
  const trackId = row.trackId === undefined || row.trackId === null
    ? null
    : requiredText(row.trackId, ID_MAX, `Object ${index + 1} trackId`)
  return {
    r2Key: ownedMusicKey(row.r2Key, `Object ${index + 1} r2Key`, userId),
    trackId,
    format: requiredText(row.format, FORMAT_MAX, `Object ${index + 1} format`),
    quality: requiredText(row.quality, FORMAT_MAX, `Object ${index + 1} quality`),
    size: requiredInteger(row.size, 0, Number.MAX_SAFE_INTEGER, `Object ${index + 1} size`),
    sha256: optionalHash(row.sha256, `Object ${index + 1} sha256`),
    createdAt: optionalTimestamp(row.createdAt, `Object ${index + 1} createdAt`),
  }
}

function parseSourceOverride(value: unknown, index: number): MusicSourceOverride {
  const row = asRecord(value, `Source override ${index + 1}`)
  return {
    trackKey: requiredText(row.trackKey, TRACK_KEY_MAX, `Source override ${index + 1} trackKey`),
    source: requiredText(row.source, SOURCE_MAX, `Source override ${index + 1} source`),
    config: parsePlainObject(row.config, `Source override ${index + 1} config`),
    updatedAt: optionalTimestamp(row.updatedAt, `Source override ${index + 1} updatedAt`),
  }
}

function parseSubscription(value: unknown, index: number): MusicSubscription {
  const row = asRecord(value, `Subscription ${index + 1}`)
  return {
    id: requiredText(row.id, ID_MAX, `Subscription ${index + 1} id`),
    kind: oneOf(row.kind, MUSIC_SUBSCRIPTION_KINDS, `Subscription ${index + 1} kind`),
    providerId: requiredText(row.providerId, PROVIDER_ID_MAX, `Subscription ${index + 1} providerId`),
    name: requiredText(row.name, NAME_MAX, `Subscription ${index + 1} name`),
    coverUrl: optionalUrl(row.coverUrl, `Subscription ${index + 1} coverUrl`),
    createdAt: optionalTimestamp(row.createdAt, `Subscription ${index + 1} createdAt`),
  }
}

function parseSettings(value: unknown): MusicSettings | null {
  if (value === undefined || value === null) return null
  const row = asRecord(value, 'Music backup settings')
  const json = JSON.stringify(row)
  if (utf8ByteLength(json) > MUSIC_LIMITS.settingsMaxBytes) {
    throw ApiError.badRequest(
      `Music backup settings exceed the ${MUSIC_LIMITS.settingsMaxBytes / 1024} KB limit`,
    )
  }
  // The resolver coordinates never travel through a backup, so a hand-edited file cannot point this
  // account's worker at an address the reader did not configure on this deployment.
  return sanitizeResolverSettings(row as unknown as MusicSettings)
}

function parseArtists(value: unknown, label: string): MusicArtist[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw ApiError.badRequest(`${label} must be a list`)
  if (value.length > ARTISTS_MAX) throw ApiError.badRequest(`${label} carries more than ${ARTISTS_MAX} artists`)
  return value.map((entry, index) => {
    const row = asRecord(entry, `${label} entry ${index + 1}`)
    return {
      id: optionalText(row.id, PROVIDER_ID_MAX, `${label} entry ${index + 1} id`),
      name: requiredText(row.name, ARTIST_NAME_MAX, `${label} entry ${index + 1} name`),
    }
  })
}

// Planning --------------------------------------------------------------------------------------

/**
 * Map every document track id to the id it will have in this account, and list what must be inserted.
 *
 * The provider identity is the second key the table enforces. When this account already saved the same
 * upstream track under a different id, the document's id is remapped to the existing one instead of
 * being inserted and rejected by the unique index, so a playlist item written from the same backup
 * still resolves to a row.
 */
function planTracks(
  tracks: readonly MusicTrack[],
  existing: readonly ExistingTrackIdentity[],
): { trackInserts: MusicTrack[]; trackIdMap: Map<string, string> } {
  const byId = new Map(existing.map((row) => [row.id, row]))
  const byProvider = new Map(existing.map((row) => [trackIdentity(row.provider, row.provider_id), row.id]))
  const trackIdMap = new Map<string, string>()
  const trackInserts: MusicTrack[] = []

  for (const track of tracks) {
    const sameId = byId.get(track.id)
    if (sameId) {
      if (sameId.provider !== track.provider || sameId.provider_id !== track.providerId) {
        throw ApiError.badRequest(
          `Track ${track.id} already belongs to a different provider identity in this account`,
        )
      }
      trackIdMap.set(track.id, track.id)
      continue
    }
    const existingId = byProvider.get(trackIdentity(track.provider, track.providerId))
    if (existingId) {
      trackIdMap.set(track.id, existingId)
      continue
    }
    trackIdMap.set(track.id, track.id)
    byProvider.set(trackIdentity(track.provider, track.providerId), track.id)
    trackInserts.push(track)
  }
  return { trackInserts, trackIdMap }
}

interface PlaylistItemInsert {
  playlistId: string
  trackId: string
  position: number
  addedAt: number
}

function resolvePlaylistItems(
  items: readonly MusicPlaylistItem[],
  trackIdMap: ReadonlyMap<string, string>,
): PlaylistItemInsert[] {
  const planned: PlaylistItemInsert[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const trackId = mappedTrackId(trackIdMap, item.trackId)
    const key = `${item.playlistId}\u0000${trackId}`
    if (seen.has(key)) continue
    seen.add(key)
    planned.push({
      playlistId: item.playlistId,
      trackId,
      position: item.position,
      addedAt: item.addedAt,
    })
  }
  return planned
}

function resolveFavorites(
  favorites: readonly MusicFavorite[],
  trackIdMap: ReadonlyMap<string, string>,
): MusicFavorite[] {
  const planned: MusicFavorite[] = []
  const seen = new Set<string>()
  for (const favorite of favorites) {
    const trackId = mappedTrackId(trackIdMap, favorite.trackId)
    if (seen.has(trackId)) continue
    seen.add(trackId)
    planned.push({ trackId, createdAt: favorite.createdAt, pinnedAt: favorite.pinnedAt })
  }
  return planned
}

function resolveHistory(
  history: readonly MusicHistoryEntry[],
  trackIdMap: ReadonlyMap<string, string>,
): MusicHistoryEntry[] {
  return history.map((entry) => ({
    ...entry,
    trackId: mappedTrackId(trackIdMap, entry.trackId),
  }))
}

function resolveObjects(
  objects: readonly MusicBackupObject[],
  trackIdMap: ReadonlyMap<string, string>,
): MusicBackupObject[] {
  return objects.map((object) => ({
    ...object,
    trackId: object.trackId === null ? null : mappedTrackId(trackIdMap, object.trackId),
  }))
}

function mappedTrackId(map: ReadonlyMap<string, string>, id: string): string {
  const mapped = map.get(id)
  if (!mapped) throw ApiError.badRequest(`The music backup references an unknown track: ${id}`)
  return mapped
}

// Statements ------------------------------------------------------------------------------------

function trackStatements(
  db: D1Database,
  userId: string,
  rows: readonly MusicTrack[],
): D1PreparedStatement[] {
  return chunk(rows, TRACK_CHUNK).map((window) => db.prepare(
    `INSERT OR IGNORE INTO music_track (
       user_id, id, provider, provider_id, kind, title, artists, album, album_id, cover_url,
       cover_key, duration_ms, format, bitrate, size, sha256, r2_key, source, source_quality,
       created_at, updated_at
     )
     SELECT ?1,
       json_extract(j.value, '$.id'),
       json_extract(j.value, '$.provider'),
       json_extract(j.value, '$.providerId'),
       json_extract(j.value, '$.kind'),
       json_extract(j.value, '$.title'),
       json_extract(j.value, '$.artists'),
       json_extract(j.value, '$.album'),
       json_extract(j.value, '$.albumId'),
       json_extract(j.value, '$.coverUrl'),
       json_extract(j.value, '$.coverKey'),
       json_extract(j.value, '$.durationMs'),
       json_extract(j.value, '$.format'),
       json_extract(j.value, '$.bitrate'),
       json_extract(j.value, '$.size'),
       json_extract(j.value, '$.sha256'),
       json_extract(j.value, '$.r2Key'),
       json_extract(j.value, '$.source'),
       json_extract(j.value, '$.sourceQuality'),
       json_extract(j.value, '$.createdAt'),
       json_extract(j.value, '$.updatedAt')
       FROM json_each(?2) AS j`,
  ).bind(userId, JSON.stringify(window.map(trackJson))))
}

function playlistStatements(
  db: D1Database,
  userId: string,
  rows: readonly MusicBackupPlaylist[],
): D1PreparedStatement[] {
  return chunk(rows, PLAYLIST_CHUNK).map((window) => db.prepare(
    `INSERT OR IGNORE INTO music_playlist (
       user_id, id, name, description, cover_url, provider, provider_id, kind, sort_order,
       pinned_at, created_at, updated_at
     )
     SELECT ?1,
       json_extract(j.value, '$.id'),
       json_extract(j.value, '$.name'),
       json_extract(j.value, '$.description'),
       json_extract(j.value, '$.coverUrl'),
       json_extract(j.value, '$.provider'),
       json_extract(j.value, '$.providerId'),
       json_extract(j.value, '$.kind'),
       json_extract(j.value, '$.sortOrder'),
       json_extract(j.value, '$.pinnedAt'),
       json_extract(j.value, '$.createdAt'),
       json_extract(j.value, '$.updatedAt')
       FROM json_each(?2) AS j`,
  ).bind(userId, JSON.stringify(window)))
}

function playlistItemStatements(
  db: D1Database,
  userId: string,
  rows: readonly PlaylistItemInsert[],
): D1PreparedStatement[] {
  return chunk(rows, PLAYLIST_ITEM_CHUNK).map((window) => db.prepare(
    `INSERT OR IGNORE INTO music_playlist_item (user_id, playlist_id, track_id, position, added_at)
     SELECT ?1,
       json_extract(j.value, '$.playlistId'),
       json_extract(j.value, '$.trackId'),
       json_extract(j.value, '$.position'),
       json_extract(j.value, '$.addedAt')
       FROM json_each(?2) AS j`,
  ).bind(userId, JSON.stringify(window)))
}

function favoriteStatements(
  db: D1Database,
  userId: string,
  rows: readonly MusicFavorite[],
): D1PreparedStatement[] {
  return chunk(rows, FAVORITE_CHUNK).map((window) => db.prepare(
    `INSERT OR IGNORE INTO music_favorite (user_id, track_id, created_at, pinned_at)
     SELECT ?1,
       json_extract(j.value, '$.trackId'),
       json_extract(j.value, '$.createdAt'),
       json_extract(j.value, '$.pinnedAt')
       FROM json_each(?2) AS j`,
  ).bind(userId, JSON.stringify(window)))
}

function historyStatements(
  db: D1Database,
  userId: string,
  rows: readonly MusicHistoryEntry[],
): D1PreparedStatement[] {
  return chunk(rows, HISTORY_CHUNK).map((window) => db.prepare(
    `INSERT OR IGNORE INTO music_history (
       user_id, id, track_id, played_at, duration_played, completed, context_type, context_id
     )
     SELECT ?1,
       json_extract(j.value, '$.id'),
       json_extract(j.value, '$.trackId'),
       json_extract(j.value, '$.playedAt'),
       json_extract(j.value, '$.durationPlayed'),
       json_extract(j.value, '$.completed'),
       json_extract(j.value, '$.contextType'),
       json_extract(j.value, '$.contextId')
       FROM json_each(?2) AS j`,
  ).bind(userId, JSON.stringify(window.map(historyJson))))
}

function recentStatements(
  db: D1Database,
  userId: string,
  rows: readonly MusicRecentEntry[],
): D1PreparedStatement[] {
  return chunk(rows, RECENT_CHUNK).map((window) => db.prepare(
    `INSERT OR IGNORE INTO music_recent (
       user_id, id, kind, provider_id, name, cover_url, last_played_at, play_count
     )
     SELECT ?1,
       json_extract(j.value, '$.id'),
       json_extract(j.value, '$.kind'),
       json_extract(j.value, '$.providerId'),
       json_extract(j.value, '$.name'),
       json_extract(j.value, '$.coverUrl'),
       json_extract(j.value, '$.lastPlayedAt'),
       json_extract(j.value, '$.playCount')
       FROM json_each(?2) AS j`,
  ).bind(userId, JSON.stringify(window)))
}

function objectStatements(
  db: D1Database,
  userId: string,
  rows: readonly MusicBackupObject[],
): D1PreparedStatement[] {
  return chunk(rows, OBJECT_CHUNK).map((window) => db.prepare(
    `INSERT OR IGNORE INTO music_object (
       user_id, r2_key, track_id, format, quality, size, sha256, created_at
     )
     SELECT ?1,
       json_extract(j.value, '$.r2Key'),
       json_extract(j.value, '$.trackId'),
       json_extract(j.value, '$.format'),
       json_extract(j.value, '$.quality'),
       json_extract(j.value, '$.size'),
       json_extract(j.value, '$.sha256'),
       json_extract(j.value, '$.createdAt')
       FROM json_each(?2) AS j`,
  ).bind(userId, JSON.stringify(window)))
}

function sourceOverrideStatements(
  db: D1Database,
  userId: string,
  rows: readonly MusicSourceOverride[],
): D1PreparedStatement[] {
  return chunk(rows, SOURCE_OVERRIDE_CHUNK).map((window) => db.prepare(
    `INSERT OR IGNORE INTO music_source_override (user_id, track_key, source, config, updated_at)
     SELECT ?1,
       json_extract(j.value, '$.trackKey'),
       json_extract(j.value, '$.source'),
       json_extract(j.value, '$.config'),
       json_extract(j.value, '$.updatedAt')
       FROM json_each(?2) AS j`,
  ).bind(userId, JSON.stringify(window.map(overrideJson))))
}

function subscriptionStatements(
  db: D1Database,
  userId: string,
  rows: readonly MusicSubscription[],
): D1PreparedStatement[] {
  return chunk(rows, SUBSCRIPTION_CHUNK).map((window) => db.prepare(
    `INSERT OR IGNORE INTO music_subscription (
       user_id, id, kind, provider_id, name, cover_url, created_at
     )
     SELECT ?1,
       json_extract(j.value, '$.id'),
       json_extract(j.value, '$.kind'),
       json_extract(j.value, '$.providerId'),
       json_extract(j.value, '$.name'),
       json_extract(j.value, '$.coverUrl'),
       json_extract(j.value, '$.createdAt')
       FROM json_each(?2) AS j`,
  ).bind(userId, JSON.stringify(window)))
}

/** Trim to the same ceiling `MusicStore.recordHistory` enforces, keeping the newest plays. */
function trimHistoryStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare(
    `DELETE FROM music_history WHERE user_id = ?1 AND id NOT IN (
       SELECT id FROM music_history WHERE user_id = ?1
        ORDER BY played_at DESC, id DESC LIMIT ?2
     )`,
  ).bind(userId, MUSIC_LIMITS.historyEntries)
}

function trimRecentStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare(
    `DELETE FROM music_recent WHERE user_id = ?1 AND id NOT IN (
       SELECT id FROM music_recent WHERE user_id = ?1
        ORDER BY last_played_at DESC, id DESC LIMIT ?2
     )`,
  ).bind(userId, MUSIC_LIMITS.recentEntries)
}

// Row shaping -----------------------------------------------------------------------------------

function trackJson(row: MusicTrack): Record<string, unknown> {
  return { ...row, artists: JSON.stringify(row.artists) }
}

function historyJson(row: MusicHistoryEntry): Record<string, unknown> {
  return { ...row, completed: row.completed ? 1 : 0 }
}

function overrideJson(row: MusicSourceOverride): Record<string, unknown> {
  return { ...row, config: JSON.stringify(row.config) }
}

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const windows: T[][] = []
  for (let offset = 0; offset < rows.length; offset += size) {
    windows.push(rows.slice(offset, offset + size))
  }
  return windows
}

// Field validation ------------------------------------------------------------------------------

function rowsOf(value: unknown, limit: number, label: string): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw ApiError.badRequest(`The music backup's ${label} must be a list`)
  if (value.length > limit) {
    throw ApiError.badRequest(`The music backup carries ${value.length} ${label}, over the ${limit} limit`)
  }
  return value
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ApiError.badRequest(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function parsePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  const row = asRecord(value, label)
  if (utf8ByteLength(JSON.stringify(row)) > SOURCE_CONFIG_MAX_BYTES) {
    throw ApiError.badRequest(`${label} exceeds the ${SOURCE_CONFIG_MAX_BYTES / 1024} KB limit`)
  }
  return row
}

function requiredText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw ApiError.badRequest(`${label} must be a non-empty string`)
  }
  if (value.length > max) throw ApiError.badRequest(`${label} is longer than ${max} characters`)
  return value
}

function optionalText(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest(`${label} must be a string`)
  if (value.length > max) throw ApiError.badRequest(`${label} is longer than ${max} characters`)
  return value
}

function optionalUrl(value: unknown, label: string): string {
  const text = optionalText(value, URL_MAX, label)
  if (text && !/^https?:\/\//i.test(text)) throw ApiError.badRequest(`${label} must use HTTP or HTTPS`)
  return text
}

function optionalInteger(
  value: unknown,
  min: number,
  max: number,
  label: string,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback
  return requiredInteger(value, min, max, label)
}

function requiredInteger(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw ApiError.badRequest(`${label} must be an integer`)
  }
  if (value < min || value > max) throw ApiError.badRequest(`${label} must be between ${min} and ${max}`)
  return value
}

function optionalNullableInteger(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number | null {
  if (value === undefined || value === null) return null
  return requiredInteger(value, min, max, label)
}

function optionalBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw ApiError.badRequest(`${label} must be true or false`)
  return value
}

function optionalTimestamp(value: unknown, label: string): number {
  return optionalInteger(value, 0, TIMESTAMP_MAX, label, Date.now())
}

function optionalHash(value: unknown, label: string): string {
  const text = optionalText(value, 64, label)
  if (text && !/^[0-9a-f]{64}$/.test(text)) throw ApiError.badRequest(`${label} must be a SHA-256 hex digest`)
  return text
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw ApiError.badRequest(`${label} is not supported`)
  }
  return value as T
}

/**
 * An R2 key this account is allowed to name.
 *
 * The key must live under `music/`, and the owner segment must be the one the key layout puts there:
 * `music/{format}/{user}/{file}` for audio and `music/covers/{user}/{file}` for a cover. Checking for
 * the account id anywhere in the key would accept `music/mp3/other/user/file`, which is another
 * account's object with this account's id tucked into a subfolder. A track or ledger row is read and
 * deleted by key alone, so that distinction is the difference between a restore and a cross-account
 * read or delete.
 */
function ownedMusicKey(value: unknown, label: string, userId: string): string {
  if (typeof value !== 'string' || !value || value.length > OBJECT_KEY_MAX) {
    throw ApiError.badRequest(`${label} must be a music object key`)
  }
  if (value.includes('\\')) throw ApiError.badRequest(`${label} must use forward slashes`)
  const parts = value.split('/')
  if (parts[0] !== 'music') throw ApiError.badRequest(`${label} must live under the music/ prefix`)
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f]/.test(part))) {
    throw ApiError.badRequest(`${label} is not a safe object key`)
  }
  if (parts.length < 4 || parts[2] !== userId) {
    throw ApiError.badRequest(`${label} is outside this account's music namespace`)
  }
  return value
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw ApiError.badRequest(`The music backup repeats a ${label}: ${value}`)
    seen.add(value)
  }
}

function trackIdentity(provider: string, providerId: string): string {
  return `${provider}:${providerId}`
}

// Read helpers ----------------------------------------------------------------------------------

/**
 * The preferences a backup may carry.
 *
 * The custom resolver coordinates are deliberately blanked: the URL and its parameters are arbitrary
 * text a reader typed in, and the settings page itself warns that they must not hold credentials. A
 * backup is copied to buckets and mailed around, so a resolver that did hold a key must not travel
 * with it; the restoring account re-enters the URL, which is the same "not configured" state the app
 * already renders.
 */
function sanitizeResolverSettings(settings: MusicSettings): MusicSettings {
  const copy = { ...settings }
  // Only blank coordinates the document actually carries, so a minimal settings object restores
  // exactly as written instead of growing two fields the caller never mentioned.
  if ('customResolverUrl' in copy) copy.customResolverUrl = ''
  if ('customResolverParams' in copy) copy.customResolverParams = {}
  return copy
}

function toBackupTrack(row: TrackBackupRow): MusicTrack {
  return {
    id: row.id,
    provider: row.provider as MusicProviderId,
    providerId: row.provider_id,
    kind: row.kind as MusicTrackKind,
    title: row.title,
    artists: readStoredArtists(row.artists),
    album: row.album,
    albumId: row.album_id,
    coverUrl: row.cover_url,
    coverKey: row.cover_key,
    durationMs: row.duration_ms,
    format: row.format,
    bitrate: row.bitrate,
    size: row.size,
    sha256: row.sha256,
    r2Key: row.r2_key || null,
    source: row.source,
    sourceQuality: row.source_quality,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toBackupPlaylist(row: PlaylistBackupRow): MusicBackupPlaylist {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    coverUrl: row.cover_url,
    provider: row.provider as MusicPlaylist['provider'],
    providerId: row.provider_id,
    kind: row.kind as MusicPlaylist['kind'],
    sortOrder: row.sort_order,
    pinnedAt: row.pinned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toBackupPlaylistItem(row: PlaylistItemBackupRow): MusicPlaylistItem {
  return {
    playlistId: row.playlist_id,
    trackId: row.track_id,
    position: row.position,
    addedAt: row.added_at,
  }
}

function toBackupHistory(row: HistoryBackupRow): MusicHistoryEntry {
  return {
    id: row.id,
    trackId: row.track_id,
    playedAt: row.played_at,
    durationPlayed: row.duration_played,
    completed: row.completed === 1,
    contextType: row.context_type,
    contextId: row.context_id,
  }
}

function toBackupRecent(row: RecentBackupRow): MusicRecentEntry {
  return {
    id: row.id,
    kind: row.kind as MusicRecentEntry['kind'],
    providerId: row.provider_id,
    name: row.name,
    coverUrl: row.cover_url,
    lastPlayedAt: row.last_played_at,
    playCount: row.play_count,
  }
}

function toBackupObject(row: ObjectBackupRow): MusicBackupObject {
  return {
    r2Key: row.r2_key,
    trackId: row.track_id,
    format: row.format,
    quality: row.quality,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.created_at,
  }
}

function toBackupSourceOverride(row: SourceOverrideBackupRow): MusicSourceOverride {
  return {
    trackKey: row.track_key,
    source: row.source,
    config: readStoredObject(row.config, 'music source config'),
    updatedAt: row.updated_at,
  }
}

function toBackupSubscription(row: SubscriptionBackupRow): MusicSubscription {
  return {
    id: row.id,
    kind: row.kind as MusicSubscription['kind'],
    providerId: row.provider_id,
    name: row.name,
    coverUrl: row.cover_url,
    createdAt: row.created_at,
  }
}

function readStoredArtists(raw: string): MusicArtist[] {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error('Stored music artists are not valid JSON', { cause: error })
  }
  if (!Array.isArray(value)) throw new Error('Stored music artists are not a list')
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Stored music artists contain an invalid entry')
    }
    const row = entry as Record<string, unknown>
    if (typeof row.name !== 'string') throw new Error('Stored music artists contain an entry without a name')
    return {
      id: typeof row.id === 'string' ? row.id : row.id === undefined ? '' : String(row.id),
      name: row.name,
    }
  })
}

function readStoredObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`Stored ${label} are not valid JSON`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Stored ${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}
