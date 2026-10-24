/**
 * The music library's data layer.
 *
 * Every read and write here is scoped to the store's `user_id`: an id that belongs to another account
 * answers `null` or an empty page, never a 403, so a guessed id is indistinguishable from one that no
 * longer exists. Rows are snapshots rather than references to the provider — a track keeps the title
 * and artists it was saved with even after the upstream catalogue changes.
 *
 * The R2 object ledger is part of the same boundary. Deleting a track removes its rows in one batch and
 * queues the object keys that no track or download still names, so a failed delete is retried by the
 * maintenance sweep instead of leaking an unreachable object.
 */
import type {
  MusicAccount,
  MusicAiLyric,
  MusicAiLyricKind,
  MusicArtist,
  MusicFavorite,
  MusicFavoriteTrack,
  MusicHistoryEntry,
  MusicLyric,
  MusicMount,
  MusicMountKind,
  MusicMountStatus,
  MusicPlaylist,
  MusicPlaylistItem,
  MusicProviderId,
  MusicRecentEntry,
  MusicSettings,
  MusicSourceOverride,
  MusicSubscription,
  MusicTrack,
  MusicTrackKind,
} from '@shared/music/model'
import { musicTrackKey } from '@shared/music/model'
import { MUSIC_LIMITS } from '@shared/music/constants'
import type { MusicPage } from '@shared/music/api'
import { utf8ByteLength } from '@shared/text-utils'
import { idChunks, MAX_BATCH_STATEMENTS } from '../db/writes'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'

export const MUSIC_HISTORY_LIMIT = MUSIC_LIMITS.historyEntries
export const MUSIC_RECENT_LIMIT = MUSIC_LIMITS.recentEntries
/** A cached lyric is served for thirty days, then treated as a miss and pruned. */
export const MUSIC_LYRIC_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Route-level paging bounds, shared with the handlers that parse query strings. */
export const MUSIC_PAGE_MAX = 10_000
export const MUSIC_PAGE_LIMIT_MAX = 100

const TRACK_COLUMNS = `user_id, id, provider, provider_id, kind, title, artists, album, album_id,
  cover_url, cover_key, duration_ms, format, bitrate, size, sha256, r2_key, source, source_quality,
  created_at, updated_at`

const TRACK_COLUMNS_T = `t.user_id, t.id, t.provider, t.provider_id, t.kind, t.title, t.artists,
  t.album, t.album_id, t.cover_url, t.cover_key, t.duration_ms, t.format, t.bitrate, t.size,
  t.sha256, t.r2_key, t.source, t.source_quality, t.created_at, t.updated_at`

function toInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}

/** A page number from a query string, kept inside the range the SQLite offset can carry. */
export function normalizeMusicPage(value: unknown, fallback = 1): number {
  const parsed = toInteger(value)
  if (parsed === null) return fallback
  return Math.min(MUSIC_PAGE_MAX, Math.max(1, parsed))
}

/** A page size from a query string. `fallback` is clamped too, so a bad default cannot exceed the cap. */
export function normalizeMusicLimit(
  value: unknown,
  fallback: number = MUSIC_LIMITS.libraryPageSize,
  max: number = MUSIC_PAGE_LIMIT_MAX,
): number {
  const ceiling = Math.max(1, Math.trunc(max))
  const parsed = toInteger(value)
  if (parsed === null) return Math.min(ceiling, Math.max(1, fallback))
  return Math.min(ceiling, Math.max(1, parsed))
}

export function musicPageOffset(page: number, limit: number): number {
  return (Math.max(1, Math.trunc(page)) - 1) * Math.max(1, Math.trunc(limit))
}

export interface MusicListOptions {
  page?: number
  limit?: number
}

export interface MusicTrackInput {
  id?: string
  provider: MusicProviderId
  providerId: string
  kind?: MusicTrackKind
  title: string
  artists?: MusicArtist[]
  album?: string
  albumId?: string
  coverUrl?: string
  coverKey?: string
  durationMs?: number
  format?: string
  bitrate?: number | null
  size?: number | null
  sha256?: string
  r2Key?: string | null
  source?: string
  sourceQuality?: string
}

export interface MusicPlaylistInput {
  name: string
  description?: string
  coverUrl?: string
  provider?: MusicPlaylist['provider']
  providerId?: string
  kind?: MusicPlaylist['kind']
  sortOrder?: number
}

export interface MusicPlaylistPatch {
  name?: string
  description?: string
  coverUrl?: string
  sortOrder?: number
}

export interface MusicHistoryInput {
  trackId: string
  playedAt?: number
  durationPlayed?: number
  completed?: boolean
  contextType?: string
  contextId?: string
}

export interface MusicRecentInput {
  kind: MusicRecentEntry['kind']
  providerId: string
  name: string
  coverUrl?: string
  lastPlayedAt?: number
}

export interface MusicAccountInput {
  provider?: MusicAccount['provider']
  accountId: string
  nickname: string
  avatarUrl: string
  /** Absent leaves the stored ciphertext untouched; the store never decrypts it. */
  cookieCiphertext?: string
  status?: MusicAccount['status']
}

export interface MusicLyricInput {
  trackKey: string
  source?: string
  lrc?: string
  tlyric?: string
  yrc?: string
  fetchedAt?: number
}

export interface MusicAiLyricInput {
  trackKey: string
  kind?: MusicAiLyricKind
  lang: string
  sourceHash: string
  payload: string
  model?: string
}

export interface MusicMountInput {
  kind?: MusicMountKind
  name: string
  baseUrl: string
  rootPath?: string
  /** Ciphertext supplied by the caller; the store never encrypts or decrypts it. */
  secret?: string
  status?: MusicMountStatus
}

export interface MusicMountPatch {
  name?: string
  baseUrl?: string
  rootPath?: string
  /** Absent keeps the stored ciphertext; an empty string clears it. */
  secret?: string
  status?: MusicMountStatus
}

export interface MusicSourceOverrideInput {
  trackKey: string
  source: string
  config?: Record<string, unknown>
}

export interface MusicSubscriptionInput {
  kind: MusicSubscription['kind']
  providerId: string
  name: string
  coverUrl?: string
}

export interface MusicSubscriptionPatch {
  name?: string
  coverUrl?: string
}

export interface MusicObjectInput {
  r2Key: string
  trackId?: string | null
  format: string
  quality: string
  size: number
  sha256?: string
  createdAt?: number
}

export interface MusicCleanupEntry {
  objectKey: string
  userId: string
  createdAt: number
}

export interface MusicQuota {
  bytes: number
  count: number
}

export interface MusicTrackDeleteResult {
  deleted: boolean
  /** Object keys queued for R2 deletion; empty when another track or download still names them. */
  queuedObjects: string[]
}

export interface MusicPlaylistItemEntry extends MusicPlaylistItem {
  track: MusicTrack
}

export interface MusicHistoryEntryWithTrack extends MusicHistoryEntry {
  track: MusicTrack
}

interface TrackRow {
  user_id: string
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

interface PlaylistRow {
  user_id: string
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
  track_count?: number
}

interface PlaylistItemRow {
  playlist_id: string
  track_id: string
  position: number
  added_at: number
}

interface PlaylistItemTrackRow extends TrackRow, PlaylistItemRow {}

type FavoriteTrackRow = TrackRow

interface HistoryRow {
  history_id: string
  history_track_id: string
  played_at: number
  duration_played: number
  completed: number
  context_type: string
  context_id: string
}

interface HistoryTrackRow extends TrackRow, HistoryRow {}

interface RecentRow {
  user_id: string
  id: string
  kind: string
  provider_id: string
  name: string
  cover_url: string
  last_played_at: number
  play_count: number
}

interface AccountRow {
  user_id: string
  provider: string
  account_id: string
  nickname: string
  avatar_url: string
  cookie_ciphertext: string
  status: string
  updated_at: number
}

interface LyricRow {
  user_id: string
  track_key: string
  source: string
  lrc: string
  tlyric: string
  yrc: string
  fetched_at: number
}

interface FavoriteRow {
  track_id: string
  created_at: number
  pinned_at: number | null
}

interface AiLyricRow {
  user_id: string
  track_key: string
  kind: string
  lang: string
  source_hash: string
  payload: string
  model: string
  created_at: number
  updated_at: number
}

interface MountRow {
  user_id: string
  id: string
  kind: string
  name: string
  base_url: string
  root_path: string
  secret: string
  status: string
  created_at: number
  updated_at: number
}

interface SourceOverrideRow {
  user_id: string
  track_key: string
  source: string
  config: string
  updated_at: number
}

interface SubscriptionRow {
  user_id: string
  id: string
  kind: string
  provider_id: string
  name: string
  cover_url: string
  created_at: number
}

function parseArtists(raw: string): MusicArtist[] {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    // Display metadata written by an older build or a hand edit: a broken snapshot must not take the
    // whole library down, and the title still renders without its artist line.
    console.warn('[inkstone] music track artists are not valid JSON:', error)
    return []
  }
  if (!Array.isArray(value)) return []
  const artists: MusicArtist[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { id?: unknown; name?: unknown }
    if (typeof record.name !== 'string') continue
    artists.push({
      id: typeof record.id === 'string' ? record.id : record.id === undefined ? '' : String(record.id),
      name: record.name,
    })
  }
  return artists
}

function parseStoredObject<T extends object>(raw: string, label: string): T {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as T
}

function pageOf<T>(items: T[], total: number, offset: number): MusicPage<T> {
  return { items, total, hasMore: offset + items.length < total }
}

function toTrack(row: TrackRow): MusicTrack {
  return {
    id: row.id,
    provider: row.provider as MusicProviderId,
    providerId: row.provider_id,
    kind: row.kind as MusicTrackKind,
    title: row.title,
    artists: parseArtists(row.artists),
    album: row.album,
    albumId: row.album_id,
    coverUrl: row.cover_url,
    coverKey: row.cover_key,
    durationMs: row.duration_ms,
    format: row.format,
    bitrate: row.bitrate,
    size: row.size,
    sha256: row.sha256,
    r2Key: row.r2_key,
    source: row.source,
    sourceQuality: row.source_quality,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toPlaylist(row: PlaylistRow): MusicPlaylist {
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
    trackCount: row.track_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toFavorite(row: FavoriteRow): MusicFavorite {
  return { trackId: row.track_id, createdAt: row.created_at, pinnedAt: row.pinned_at }
}

function toAiLyric(row: AiLyricRow): MusicAiLyric {
  return {
    trackKey: row.track_key,
    kind: row.kind as MusicAiLyricKind,
    lang: row.lang,
    sourceHash: row.source_hash,
    payload: row.payload,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMount(row: MountRow): MusicMount {
  return {
    id: row.id,
    kind: row.kind as MusicMountKind,
    name: row.name,
    baseUrl: row.base_url,
    rootPath: row.root_path,
    status: row.status as MusicMountStatus,
    hasSecret: row.secret !== '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRecent(row: RecentRow): MusicRecentEntry {
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

function toAccount(row: AccountRow): MusicAccount {
  return {
    provider: row.provider as MusicAccount['provider'],
    accountId: row.account_id,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    status: row.status as MusicAccount['status'],
    updatedAt: row.updated_at,
  }
}

function toLyric(row: LyricRow): MusicLyric {
  return {
    trackKey: row.track_key,
    source: row.source,
    lrc: row.lrc,
    tlyric: row.tlyric,
    yrc: row.yrc,
    fetchedAt: row.fetched_at,
  }
}

export class MusicStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  // Tracks -------------------------------------------------------------------------------------

  async getTrack(id: string): Promise<MusicTrack | null> {
    const row = await this.trackRow(id)
    return row ? toTrack(row) : null
  }

  /** Resolve a set of ids in the caller's order, dropping ids this account does not own. */
  async getTracks(ids: readonly string[]): Promise<MusicTrack[]> {
    const unique = [...new Set(ids)].filter(Boolean)
    if (!unique.length) return []
    const found = new Map<string, MusicTrack>()
    for (const chunk of idChunks(unique)) {
      const marks = chunk.map((_, index) => `?${index + 2}`).join(', ')
      const { results } = await this.db.prepare(
        `SELECT ${TRACK_COLUMNS} FROM music_track WHERE user_id = ?1 AND id IN (${marks})`,
      ).bind(this.userId, ...chunk).all<TrackRow>()
      for (const row of results) found.set(row.id, toTrack(row))
    }
    return unique.flatMap((id) => {
      const track = found.get(id)
      return track ? [track] : []
    })
  }

  async findTrack(provider: MusicProviderId, providerId: string): Promise<MusicTrack | null> {
    const row = await this.trackRowByProvider(provider, providerId)
    return row ? toTrack(row) : null
  }

  /**
   * Save the snapshot a provider returned, or refresh the one already saved.
   *
   * The row is found by `(provider, provider_id)` before anything is written, because the unique key
   * is what makes a metadata refresh idempotent and keeps the library id stable for playlists and
   * favourites. Storage columns are merged from the existing row when the caller omits them: a
   * provider refresh must not forget which R2 object the account already downloaded.
   */
  async upsertTrack(input: MusicTrackInput): Promise<MusicTrack> {
    const existing = await this.trackRowByProvider(input.provider, input.providerId)
    const now = Date.now()

    if (existing) {
      const title = input.title
      const artists = input.artists ?? parseArtists(existing.artists)
      const album = input.album ?? existing.album
      const albumId = input.albumId ?? existing.album_id
      const coverUrl = input.coverUrl ?? existing.cover_url
      const coverKey = input.coverKey ?? existing.cover_key
      const durationMs = input.durationMs ?? existing.duration_ms
      const format = input.format ?? existing.format
      const bitrate = input.bitrate === undefined ? existing.bitrate : input.bitrate
      const size = input.size === undefined ? existing.size : input.size
      const sha256 = input.sha256 ?? existing.sha256
      const r2Key = input.r2Key === undefined ? existing.r2_key : input.r2Key
      const source = input.source ?? (existing.source || input.provider)
      const sourceQuality = input.sourceQuality ?? existing.source_quality
      await this.db.prepare(
        `UPDATE music_track SET
           kind = ?3, title = ?4, artists = ?5, album = ?6, album_id = ?7, cover_url = ?8,
           cover_key = ?9, duration_ms = ?10, format = ?11, bitrate = ?12, size = ?13,
           sha256 = ?14, r2_key = ?15, source = ?16, source_quality = ?17, updated_at = ?18
         WHERE user_id = ?1 AND id = ?2`,
      ).bind(
        this.userId,
        existing.id,
        input.kind ?? existing.kind,
        title,
        JSON.stringify(artists),
        album,
        albumId,
        coverUrl,
        coverKey,
        durationMs,
        format,
        bitrate,
        size,
        sha256,
        r2Key,
        source,
        sourceQuality,
        now,
      ).run()
      return (await this.getTrack(existing.id))!
    }

    const id = input.id ?? newId()
    await this.db.prepare(
      `INSERT INTO music_track (${TRACK_COLUMNS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
    ).bind(
      this.userId,
      id,
      input.provider,
      input.providerId,
      input.kind ?? 'song',
      input.title,
      JSON.stringify(input.artists ?? []),
      input.album ?? '',
      input.albumId ?? '',
      input.coverUrl ?? '',
      input.coverKey ?? '',
      input.durationMs ?? 0,
      input.format ?? '',
      input.bitrate ?? null,
      input.size ?? null,
      input.sha256 ?? '',
      input.r2Key ?? null,
      input.source ?? input.provider,
      input.sourceQuality ?? '',
      now,
      now,
    ).run()
    const created = await this.getTrack(id)
    if (!created) throw new Error('music_track_insert_failed')
    return created
  }

  /**
   * Delete one track and every row that names it.
   *
   * Playlist membership, favourites, history and the keyed caches (provider lyrics, AI lyrics and
   * source overrides) go with it. R2 objects are only released when no other track or download still
   * names the same key; the keys that qualify are put on the cleanup queue in the same transaction, so
   * a failed object delete is retried rather than forgotten. Recent containers are listed by
   * playlist/album/radio identity, not by track, so a track deletion leaves them alone.
   */
  async deleteTrack(id: string): Promise<MusicTrackDeleteResult> {
    const row = await this.trackRow(id)
    if (!row) return { deleted: false, queuedObjects: [] }

    const keys = new Set<string>()
    if (row.r2_key) keys.add(row.r2_key)
    const ledger = await this.db.prepare(
      `SELECT r2_key FROM music_object WHERE user_id = ?1 AND track_id = ?2`,
    ).bind(this.userId, id).all<{ r2_key: string }>()
    for (const entry of ledger.results) keys.add(entry.r2_key)

    const now = Date.now()
    const queued: string[] = []
    const statements: D1PreparedStatement[] = []

    for (const key of keys) {
      if (!key) continue
      const refs = await this.db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM music_track WHERE user_id = ?1 AND r2_key = ?2 AND id <> ?3) AS track_refs,
           (SELECT COUNT(*) FROM music_download WHERE user_id = ?1 AND r2_key = ?2) AS download_refs`,
      ).bind(this.userId, key, id).first<{ track_refs: number; download_refs: number }>()
      if ((refs?.track_refs ?? 0) > 0 || (refs?.download_refs ?? 0) > 0) continue
      queued.push(key)
      statements.push(
        this.db.prepare(
          `INSERT OR IGNORE INTO music_cleanup (object_key, user_id, created_at) VALUES (?1, ?2, ?3)`,
        ).bind(key, this.userId, now),
        this.db.prepare(`DELETE FROM music_object WHERE user_id = ?1 AND r2_key = ?2`).bind(this.userId, key),
      )
    }

    if (row.cover_key) {
      const coverRefs = await this.db.prepare(
        `SELECT COUNT(*) AS count FROM music_track WHERE user_id = ?1 AND cover_key = ?2 AND id <> ?3`,
      ).bind(this.userId, row.cover_key, id).first<{ count: number }>()
      if ((coverRefs?.count ?? 0) === 0) {
        queued.push(row.cover_key)
        statements.push(
          this.db.prepare(
            `INSERT OR IGNORE INTO music_cleanup (object_key, user_id, created_at) VALUES (?1, ?2, ?3)`,
          ).bind(row.cover_key, this.userId, now),
        )
      }
    }

    const trackKey = musicTrackKey(row.provider as MusicProviderId, row.provider_id)
    statements.push(
      this.db.prepare(`DELETE FROM music_playlist_item WHERE user_id = ?1 AND track_id = ?2`)
        .bind(this.userId, id),
      this.db.prepare(`DELETE FROM music_favorite WHERE user_id = ?1 AND track_id = ?2`)
        .bind(this.userId, id),
      this.db.prepare(`DELETE FROM music_history WHERE user_id = ?1 AND track_id = ?2`)
        .bind(this.userId, id),
      this.db.prepare(`DELETE FROM music_lyric WHERE user_id = ?1 AND track_key = ?2`)
        .bind(this.userId, trackKey),
      this.db.prepare(`DELETE FROM music_lyric_ai WHERE user_id = ?1 AND track_key = ?2`)
        .bind(this.userId, trackKey),
      this.db.prepare(`DELETE FROM music_source_override WHERE user_id = ?1 AND track_key = ?2`)
        .bind(this.userId, trackKey),
      // A retained object no longer names this track as its owner; the key still leads every lookup.
      this.db.prepare(`UPDATE music_object SET track_id = NULL WHERE user_id = ?1 AND track_id = ?2`)
        .bind(this.userId, id),
      this.db.prepare(`DELETE FROM music_track WHERE user_id = ?1 AND id = ?2`).bind(this.userId, id),
    )

    await this.runStatements(statements)
    return { deleted: true, queuedObjects: queued }
  }

  // Playlists ----------------------------------------------------------------------------------

  async listPlaylists(): Promise<MusicPlaylist[]> {
    const { results } = await this.db.prepare(
      `SELECT p.user_id, p.id, p.name, p.description, p.cover_url, p.provider, p.provider_id,
              p.kind, p.sort_order, p.pinned_at, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM music_playlist_item i
                WHERE i.user_id = p.user_id AND i.playlist_id = p.id) AS track_count
         FROM music_playlist p
        WHERE p.user_id = ?1
        ORDER BY (p.pinned_at IS NULL), p.pinned_at DESC, p.sort_order, p.created_at, p.id`,
    ).bind(this.userId).all<PlaylistRow>()
    return results.map(toPlaylist)
  }

  async getPlaylist(id: string): Promise<MusicPlaylist | null> {
    const row = await this.playlistRow(id)
    return row ? toPlaylist(row) : null
  }

  async createPlaylist(input: MusicPlaylistInput): Promise<MusicPlaylist> {
    const now = Date.now()
    let sortOrder = input.sortOrder
    if (sortOrder === undefined) {
      const row = await this.db.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM music_playlist WHERE user_id = ?1`,
      ).bind(this.userId).first<{ next: number }>()
      sortOrder = row?.next ?? 0
    }
    const id = newId()
    await this.db.prepare(
      `INSERT INTO music_playlist
         (user_id, id, name, description, cover_url, provider, provider_id, kind, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    ).bind(
      this.userId,
      id,
      input.name,
      input.description ?? '',
      input.coverUrl ?? '',
      input.provider ?? 'local',
      input.providerId ?? '',
      input.kind ?? 'manual',
      sortOrder,
      now,
    ).run()
    return (await this.getPlaylist(id))!
  }

  async updatePlaylist(id: string, patch: MusicPlaylistPatch): Promise<MusicPlaylist | null> {
    const result = await this.db.prepare(
      `UPDATE music_playlist SET
         name = COALESCE(?3, name),
         description = COALESCE(?4, description),
         cover_url = COALESCE(?5, cover_url),
         sort_order = COALESCE(?6, sort_order),
         updated_at = ?7
       WHERE user_id = ?1 AND id = ?2`,
    ).bind(
      this.userId,
      id,
      patch.name ?? null,
      patch.description ?? null,
      patch.coverUrl ?? null,
      patch.sortOrder ?? null,
      Date.now(),
    ).run()
    if (!(result.meta.changes ?? 0)) return null
    return this.getPlaylist(id)
  }

  /**
   * Pin or unpin one playlist. As with favourites, pinning keeps the first pin's timestamp so a repeat
   * call is idempotent; null means the playlist does not belong to this account.
   */
  async setPlaylistPinned(id: string, pinned: boolean): Promise<MusicPlaylist | null> {
    const now = Date.now()
    const result = await this.db.prepare(
      `UPDATE music_playlist SET
         pinned_at = CASE WHEN ?3 = 1 THEN COALESCE(pinned_at, ?4) ELSE NULL END,
         updated_at = ?5
       WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id, pinned ? 1 : 0, now, now).run()
    if (!(result.meta.changes ?? 0)) return null
    return this.getPlaylist(id)
  }

  async deletePlaylist(id: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`DELETE FROM music_playlist_item WHERE user_id = ?1 AND playlist_id = ?2`)
        .bind(this.userId, id),
      this.db.prepare(`DELETE FROM music_playlist WHERE user_id = ?1 AND id = ?2`)
        .bind(this.userId, id),
    ])
    return Boolean(results.at(-1)?.meta.changes)
  }

  /** Write the shelf order the reader dragged: the ids become positions zero through n. */
  async reorderPlaylists(ids: readonly string[]): Promise<number> {
    const unique = [...new Set(ids)].filter(Boolean)
    if (!unique.length) return 0
    const now = Date.now()
    const statements = unique.map((id, index) => this.db.prepare(
      `UPDATE music_playlist SET sort_order = ?3, updated_at = ?4 WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id, index, now))
    return this.runStatements(statements)
  }

  async listPlaylistItems(
    playlistId: string,
    options: MusicListOptions = {},
  ): Promise<MusicPage<MusicPlaylistItemEntry> | null> {
    if (!(await this.playlistExists(playlistId))) return null
    const page = normalizeMusicPage(options.page)
    const limit = normalizeMusicLimit(options.limit)
    const offset = musicPageOffset(page, limit)
    const totalRow = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM music_playlist_item WHERE user_id = ?1 AND playlist_id = ?2`,
    ).bind(this.userId, playlistId).first<{ count: number }>()
    const total = totalRow?.count ?? 0
    const { results } = await this.db.prepare(
      `SELECT i.playlist_id, i.track_id, i.position, i.added_at, ${TRACK_COLUMNS_T}
         FROM music_playlist_item i
         JOIN music_track t ON t.user_id = i.user_id AND t.id = i.track_id
        WHERE i.user_id = ?1 AND i.playlist_id = ?2
        ORDER BY i.position, i.track_id
        LIMIT ?3 OFFSET ?4`,
    ).bind(this.userId, playlistId, limit, offset).all<PlaylistItemTrackRow>()
    const items = results.map((row) => ({
      playlistId: row.playlist_id,
      trackId: row.track_id,
      position: row.position,
      addedAt: row.added_at,
      track: toTrack(row),
    }))
    return pageOf(items, total, offset)
  }

  async addPlaylistItem(playlistId: string, trackId: string): Promise<MusicPlaylistItem | null> {
    if (!(await this.playlistExists(playlistId))) return null
    if (!(await this.getTrack(trackId))) return null
    const existing = await this.playlistItemRow(playlistId, trackId)
    if (existing) return existing
    const countRow = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM music_playlist_item WHERE user_id = ?1 AND playlist_id = ?2`,
    ).bind(this.userId, playlistId).first<{ count: number }>()
    if ((countRow?.count ?? 0) >= MUSIC_LIMITS.playlistItems) {
      throw ApiError.badRequest('The playlist has reached its item limit')
    }
    const maxRow = await this.db.prepare(
      `SELECT COALESCE(MAX(position), 0) AS max FROM music_playlist_item WHERE user_id = ?1 AND playlist_id = ?2`,
    ).bind(this.userId, playlistId).first<{ max: number }>()
    const item: MusicPlaylistItem = {
      playlistId,
      trackId,
      position: (maxRow?.max ?? 0) + 1,
      addedAt: Date.now(),
    }
    await this.db.prepare(
      `INSERT INTO music_playlist_item (user_id, playlist_id, track_id, position, added_at)
       VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING`,
    ).bind(this.userId, playlistId, trackId, item.position, item.addedAt).run()
    return item
  }

  /**
   * Append a batch, dropping ids the account does not own and tracks already in the list.
   *
   * A full playlist is refused rather than silently taking the first few: the caller asked for all of
   * them, and a partial import reported as success is the kind of answer that hides data loss.
   */
  async addPlaylistItems(playlistId: string, trackIds: readonly string[]): Promise<number | null> {
    if (!(await this.playlistExists(playlistId))) return null
    const unique = [...new Set(trackIds)].filter(Boolean)
    if (!unique.length) return 0
    const owned = new Set((await this.getTracks(unique)).map((track) => track.id))
    const candidates = unique.filter((id) => owned.has(id))
    if (!candidates.length) return 0

    const existingRows = await this.db.prepare(
      `SELECT track_id FROM music_playlist_item WHERE user_id = ?1 AND playlist_id = ?2`,
    ).bind(this.userId, playlistId).all<{ track_id: string }>()
    const existing = new Set(existingRows.results.map((row) => row.track_id))
    const toAdd = candidates.filter((id) => !existing.has(id))
    if (!toAdd.length) return 0

    const countRow = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM music_playlist_item WHERE user_id = ?1 AND playlist_id = ?2`,
    ).bind(this.userId, playlistId).first<{ count: number }>()
    const count = countRow?.count ?? 0
    if (count + toAdd.length > MUSIC_LIMITS.playlistItems) {
      throw ApiError.badRequest('The playlist would exceed its item limit')
    }

    const maxRow = await this.db.prepare(
      `SELECT COALESCE(MAX(position), 0) AS max FROM music_playlist_item WHERE user_id = ?1 AND playlist_id = ?2`,
    ).bind(this.userId, playlistId).first<{ max: number }>()
    const base = maxRow?.max ?? 0
    const addedAt = Date.now()
    const statements = toAdd.map((trackId, index) => this.db.prepare(
      `INSERT INTO music_playlist_item (user_id, playlist_id, track_id, position, added_at)
       VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING`,
    ).bind(this.userId, playlistId, trackId, base + index + 1, addedAt))
    return this.runStatements(statements)
  }

  async removePlaylistItem(playlistId: string, trackId: string): Promise<boolean> {
    const item = await this.playlistItemRow(playlistId, trackId)
    if (!item) return false
    const results = await this.db.batch([
      this.db.prepare(
        `DELETE FROM music_playlist_item WHERE user_id = ?1 AND playlist_id = ?2 AND track_id = ?3`,
      ).bind(this.userId, playlistId, trackId),
      this.db.prepare(
        `UPDATE music_playlist_item SET position = position - 1
          WHERE user_id = ?1 AND playlist_id = ?2 AND position > ?3`,
      ).bind(this.userId, playlistId, item.position),
    ])
    return ((results[0]?.meta.changes as number | undefined) ?? 0) > 0
  }

  /** Rewrite positions to match the full order the reader dropped into place. Unknown ids are ignored. */
  async reorderPlaylistItems(playlistId: string, trackIds: readonly string[]): Promise<number | null> {
    if (!(await this.playlistExists(playlistId))) return null
    const unique = [...new Set(trackIds)].filter(Boolean)
    if (!unique.length) return 0
    const statements = unique.map((trackId, index) => this.db.prepare(
      `UPDATE music_playlist_item SET position = ?4
        WHERE user_id = ?1 AND playlist_id = ?2 AND track_id = ?3`,
    ).bind(this.userId, playlistId, trackId, index + 1))
    statements.push(
      this.db.prepare(`UPDATE music_playlist SET updated_at = ?3 WHERE user_id = ?1 AND id = ?2`)
        .bind(this.userId, playlistId, Date.now()),
    )
    // The playlist timestamp bumps too; the caller asked how many items moved.
    return Math.max(0, (await this.runStatements(statements)) - 1)
  }

  // Favourites ---------------------------------------------------------------------------------

  async isFavorite(trackId: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS hit FROM music_favorite WHERE user_id = ?1 AND track_id = ?2`,
    ).bind(this.userId, trackId).first<{ hit: number }>()
    return Boolean(row)
  }

  /** Idempotent: true means the track is a favourite afterwards, including when it already was. */
  async addFavorite(trackId: string): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT INTO music_favorite (user_id, track_id, created_at)
       SELECT ?1, ?2, ?3 WHERE EXISTS (
         SELECT 1 FROM music_track WHERE user_id = ?1 AND id = ?2
       )
       ON CONFLICT DO NOTHING`,
    ).bind(this.userId, trackId, Date.now()).run()
    if ((result.meta.changes ?? 0) > 0) return true
    return this.isFavorite(trackId)
  }

  async removeFavorite(trackId: string): Promise<boolean> {
    const result = await this.db.prepare(
      `DELETE FROM music_favorite WHERE user_id = ?1 AND track_id = ?2`,
    ).bind(this.userId, trackId).run()
    return (result.meta.changes ?? 0) > 0
  }

  async listFavorites(options: MusicListOptions = {}): Promise<MusicPage<MusicFavoriteTrack>> {
    const page = normalizeMusicPage(options.page)
    const limit = normalizeMusicLimit(options.limit)
    const offset = musicPageOffset(page, limit)
    const totalRow = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM music_favorite f
        JOIN music_track t ON t.user_id = f.user_id AND t.id = f.track_id
       WHERE f.user_id = ?1`,
    ).bind(this.userId).first<{ count: number }>()
    const total = totalRow?.count ?? 0
    const { results } = await this.db.prepare(
      `SELECT ${TRACK_COLUMNS_T}, f.pinned_at FROM music_favorite f
        JOIN music_track t ON t.user_id = f.user_id AND t.id = f.track_id
       WHERE f.user_id = ?1
       ORDER BY (f.pinned_at IS NULL), f.pinned_at DESC, f.created_at DESC, f.track_id DESC
       LIMIT ?2 OFFSET ?3`,
    ).bind(this.userId, limit, offset).all<FavoriteTrackRow & { pinned_at: number | null }>()
    return pageOf(results.map((row) => ({ ...toTrack(row), pinnedAt: row.pinned_at })), total, offset)
  }

  /**
   * Pin or unpin one favourite. Pinning keeps the first pin's timestamp, so calling it twice does not
   * reshuffle the list; null means the track is not a favourite of this account.
   */
  async setFavoritePinned(trackId: string, pinned: boolean): Promise<MusicFavorite | null> {
    const result = await this.db.prepare(
      `UPDATE music_favorite SET pinned_at = CASE WHEN ?3 = 1 THEN COALESCE(pinned_at, ?4) ELSE NULL END
        WHERE user_id = ?1 AND track_id = ?2`,
    ).bind(this.userId, trackId, pinned ? 1 : 0, Date.now()).run()
    if (!(result.meta.changes ?? 0)) return null
    const row = await this.db.prepare(
      `SELECT track_id, created_at, pinned_at FROM music_favorite WHERE user_id = ?1 AND track_id = ?2`,
    ).bind(this.userId, trackId).first<FavoriteRow>()
    return row ? toFavorite(row) : null
  }

  // History ------------------------------------------------------------------------------------

  /**
   * Append one play and trim the account back to its ceiling in the same batch.
   *
   * The trim is a `NOT IN` over the newest rows rather than a timestamp cutoff: several devices can
   * write the same millisecond, and a cutoff would either keep too many or drop rows that tie with the
   * five-thousandth one.
   */
  async recordHistory(input: MusicHistoryInput): Promise<MusicHistoryEntry | null> {
    if (!(await this.getTrack(input.trackId))) return null
    const playedAt = input.playedAt ?? Date.now()
    const entry: MusicHistoryEntry = {
      id: newId(),
      trackId: input.trackId,
      playedAt,
      durationPlayed: input.durationPlayed ?? 0,
      completed: input.completed ?? false,
      contextType: input.contextType ?? '',
      contextId: input.contextId ?? '',
    }
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO music_history
           (user_id, id, track_id, played_at, duration_played, completed, context_type, context_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        this.userId,
        entry.id,
        entry.trackId,
        entry.playedAt,
        entry.durationPlayed,
        entry.completed ? 1 : 0,
        entry.contextType,
        entry.contextId,
      ),
      this.trimHistoryStatement(),
    ])
    return entry
  }

  async listHistory(options: MusicListOptions = {}): Promise<MusicPage<MusicHistoryEntryWithTrack>> {
    const page = normalizeMusicPage(options.page)
    const limit = normalizeMusicLimit(options.limit)
    const offset = musicPageOffset(page, limit)
    const totalRow = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM music_history h
        JOIN music_track t ON t.user_id = h.user_id AND t.id = h.track_id
       WHERE h.user_id = ?1`,
    ).bind(this.userId).first<{ count: number }>()
    const total = totalRow?.count ?? 0
    const { results } = await this.db.prepare(
      `SELECT h.id AS history_id, h.track_id AS history_track_id, h.played_at, h.duration_played,
              h.completed, h.context_type, h.context_id, ${TRACK_COLUMNS_T}
         FROM music_history h
         JOIN music_track t ON t.user_id = h.user_id AND t.id = h.track_id
        WHERE h.user_id = ?1
        ORDER BY h.played_at DESC, h.id DESC
        LIMIT ?2 OFFSET ?3`,
    ).bind(this.userId, limit, offset).all<HistoryTrackRow>()
    const items = results.map((row) => ({
      id: row.history_id,
      trackId: row.history_track_id,
      playedAt: row.played_at,
      durationPlayed: row.duration_played,
      completed: row.completed === 1,
      contextType: row.context_type,
      contextId: row.context_id,
      track: toTrack(row),
    }))
    return pageOf(items, total, offset)
  }

  // Recent containers --------------------------------------------------------------------------

  /** Record a visit to a playlist, album, radio or artist; the account keeps the newest 500. */
  async touchRecent(input: MusicRecentInput): Promise<MusicRecentEntry> {
    const lastPlayedAt = input.lastPlayedAt ?? Date.now()
    const id = newId()
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO music_recent
           (user_id, id, kind, provider_id, name, cover_url, last_played_at, play_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
         ON CONFLICT(user_id, kind, provider_id) DO UPDATE SET
           name = excluded.name,
           cover_url = excluded.cover_url,
           last_played_at = excluded.last_played_at,
           play_count = music_recent.play_count + 1`,
      ).bind(
        this.userId,
        id,
        input.kind,
        input.providerId,
        input.name,
        input.coverUrl ?? '',
        lastPlayedAt,
      ),
      this.trimRecentStatement(),
    ])
    const row = await this.db.prepare(
      `SELECT user_id, id, kind, provider_id, name, cover_url, last_played_at, play_count
         FROM music_recent WHERE user_id = ?1 AND kind = ?2 AND provider_id = ?3`,
    ).bind(this.userId, input.kind, input.providerId).first<RecentRow>()
    if (!row) throw new Error('music_recent_upsert_failed')
    return toRecent(row)
  }

  async listRecent(limit: number = MUSIC_RECENT_LIMIT): Promise<MusicRecentEntry[]> {
    const capped = Math.max(1, Math.min(MUSIC_RECENT_LIMIT, Math.trunc(limit)))
    const { results } = await this.db.prepare(
      `SELECT user_id, id, kind, provider_id, name, cover_url, last_played_at, play_count
         FROM music_recent WHERE user_id = ?1
        ORDER BY last_played_at DESC, id DESC LIMIT ?2`,
    ).bind(this.userId, capped).all<RecentRow>()
    return results.map(toRecent)
  }

  // Settings -----------------------------------------------------------------------------------

  async getSettings(): Promise<MusicSettings | null> {
    const row = await this.db.prepare(
      `SELECT settings FROM music_setting WHERE user_id = ?1`,
    ).bind(this.userId).first<{ settings: string }>()
    return row ? parseStoredObject<MusicSettings>(row.settings, 'music settings') : null
  }

  async saveSettings(settings: MusicSettings): Promise<MusicSettings> {
    const json = JSON.stringify(settings)
    if (utf8ByteLength(json) > MUSIC_LIMITS.settingsMaxBytes) {
      throw ApiError.tooLarge(`Music settings exceed the ${MUSIC_LIMITS.settingsMaxBytes / 1024} KB limit`)
    }
    await this.db.prepare(
      `INSERT INTO music_setting (user_id, settings, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
    ).bind(this.userId, json, Date.now()).run()
    return settings
  }

  // Netease account ----------------------------------------------------------------------------

  async getAccount(provider: MusicAccount['provider'] = 'netease'): Promise<MusicAccount | null> {
    const row = await this.accountRow(provider)
    return row ? toAccount(row) : null
  }

  /** The ciphertext as stored. Only the provider request layer may ask for this, and it never leaves the worker. */
  async getAccountCookie(provider: MusicAccount['provider'] = 'netease'): Promise<string | null> {
    const row = await this.db.prepare(
      `SELECT cookie_ciphertext FROM music_account WHERE user_id = ?1 AND provider = ?2`,
    ).bind(this.userId, provider).first<{ cookie_ciphertext: string }>()
    return row?.cookie_ciphertext || null
  }

  async saveAccount(input: MusicAccountInput): Promise<MusicAccount> {
    const provider = input.provider ?? 'netease'
    const cookie = input.cookieCiphertext === undefined ? null : input.cookieCiphertext
    const status = input.status ?? null
    const now = Date.now()
    await this.db.prepare(
      `INSERT INTO music_account
         (user_id, provider, account_id, nickname, avatar_url, cookie_ciphertext, status, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, ''), COALESCE(?7, 'connected'), ?8)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         account_id = excluded.account_id,
         nickname = excluded.nickname,
         avatar_url = excluded.avatar_url,
         cookie_ciphertext = COALESCE(?6, music_account.cookie_ciphertext),
         status = COALESCE(?7, music_account.status),
         updated_at = excluded.updated_at`,
    ).bind(
      this.userId,
      provider,
      input.accountId,
      input.nickname,
      input.avatarUrl,
      cookie,
      status,
      now,
    ).run()
    const saved = await this.getAccount(provider)
    if (!saved) throw new Error('music_account_upsert_failed')
    return saved
  }

  async markAccountStatus(
    status: MusicAccount['status'],
    provider: MusicAccount['provider'] = 'netease',
  ): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE music_account SET status = ?3, updated_at = ?4 WHERE user_id = ?1 AND provider = ?2`,
    ).bind(this.userId, provider, status, Date.now()).run()
    return (result.meta.changes ?? 0) > 0
  }

  async deleteAccount(provider: MusicAccount['provider'] = 'netease'): Promise<boolean> {
    const result = await this.db.prepare(
      `DELETE FROM music_account WHERE user_id = ?1 AND provider = ?2`,
    ).bind(this.userId, provider).run()
    return (result.meta.changes ?? 0) > 0
  }

  // Lyrics -------------------------------------------------------------------------------------

  async saveLyric(input: MusicLyricInput): Promise<MusicLyric> {
    const lrc = input.lrc ?? ''
    const tlyric = input.tlyric ?? ''
    const yrc = input.yrc ?? ''
    const bytes = utf8ByteLength(lrc) + utf8ByteLength(tlyric) + utf8ByteLength(yrc)
    if (bytes > MUSIC_LIMITS.lyricMaxBytes) {
      throw ApiError.tooLarge(`Lyrics exceed the ${MUSIC_LIMITS.lyricMaxBytes / 1024} KB limit`)
    }
    const fetchedAt = input.fetchedAt ?? Date.now()
    await this.db.prepare(
      `INSERT INTO music_lyric (user_id, track_key, source, lrc, tlyric, yrc, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(user_id, track_key) DO UPDATE SET
         source = excluded.source,
         lrc = excluded.lrc,
         tlyric = excluded.tlyric,
         yrc = excluded.yrc,
         fetched_at = excluded.fetched_at`,
    ).bind(
      this.userId,
      input.trackKey,
      input.source ?? 'netease',
      lrc,
      tlyric,
      yrc,
      fetchedAt,
    ).run()
    return { trackKey: input.trackKey, source: input.source ?? 'netease', lrc, tlyric, yrc, fetchedAt }
  }

  /** A cache entry older than the TTL is a miss: the caller may refetch and overwrite it. */
  async getLyric(
    trackKey: string,
    options: { now?: number; maxAgeMs?: number } = {},
  ): Promise<MusicLyric | null> {
    const row = await this.db.prepare(
      `SELECT user_id, track_key, source, lrc, tlyric, yrc, fetched_at
         FROM music_lyric WHERE user_id = ?1 AND track_key = ?2`,
    ).bind(this.userId, trackKey).first<LyricRow>()
    if (!row) return null
    const now = options.now ?? Date.now()
    const maxAge = options.maxAgeMs ?? MUSIC_LYRIC_TTL_MS
    if (now - row.fetched_at > maxAge) return null
    return toLyric(row)
  }

  async pruneLyrics(now = Date.now()): Promise<number> {
    const result = await this.db.prepare(
      `DELETE FROM music_lyric WHERE user_id = ?1 AND fetched_at < ?2`,
    ).bind(this.userId, now - MUSIC_LYRIC_TTL_MS).run()
    return result.meta.changes ?? 0
  }

  async clearLyrics(): Promise<number> {
    const result = await this.db.prepare(
      `DELETE FROM music_lyric WHERE user_id = ?1`,
    ).bind(this.userId).run()
    return result.meta.changes ?? 0
  }

  // AI lyric cache -----------------------------------------------------------------------------

  /**
   * One cached AI layer. The caller compares `sourceHash` with the lyric text it has: a different
   * hash is a miss, and `putAiLyric` then overwrites the row instead of keeping a stale translation.
   */
  async getAiLyric(
    trackKey: string,
    kind: MusicAiLyricKind,
    lang: string,
  ): Promise<MusicAiLyric | null> {
    const row = await this.db.prepare(
      `SELECT user_id, track_key, kind, lang, source_hash, payload, model, created_at, updated_at
         FROM music_lyric_ai WHERE user_id = ?1 AND track_key = ?2 AND kind = ?3 AND lang = ?4`,
    ).bind(this.userId, trackKey, kind, lang).first<AiLyricRow>()
    return row ? toAiLyric(row) : null
  }

  async putAiLyric(input: MusicAiLyricInput): Promise<MusicAiLyric> {
    if (utf8ByteLength(input.payload) > MUSIC_LIMITS.lyricMaxBytes) {
      throw ApiError.tooLarge(`AI lyrics exceed the ${MUSIC_LIMITS.lyricMaxBytes / 1024} KB limit`)
    }
    const now = Date.now()
    await this.db.prepare(
      `INSERT INTO music_lyric_ai
         (user_id, track_key, kind, lang, source_hash, payload, model, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT(user_id, track_key, kind, lang) DO UPDATE SET
         source_hash = excluded.source_hash,
         payload = excluded.payload,
         model = excluded.model,
         updated_at = excluded.updated_at`,
    ).bind(
      this.userId,
      input.trackKey,
      input.kind ?? 'translation',
      input.lang,
      input.sourceHash,
      input.payload,
      input.model ?? '',
      now,
    ).run()
    const saved = await this.getAiLyric(input.trackKey, input.kind ?? 'translation', input.lang)
    if (!saved) throw new Error('music_lyric_ai_upsert_failed')
    return saved
  }

  /** Drop every language of every kind for one track. Returns the rows removed. */
  async deleteAiLyricsForTrack(trackKey: string): Promise<number> {
    const result = await this.db.prepare(
      `DELETE FROM music_lyric_ai WHERE user_id = ?1 AND track_key = ?2`,
    ).bind(this.userId, trackKey).run()
    return result.meta.changes ?? 0
  }

  // Source overrides ---------------------------------------------------------------------------

  async saveSourceOverride(input: MusicSourceOverrideInput): Promise<MusicSourceOverride> {
    const config = input.config ?? {}
    const updatedAt = Date.now()
    const json = JSON.stringify(config)
    await this.db.prepare(
      `INSERT INTO music_source_override (user_id, track_key, source, config, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(user_id, track_key) DO UPDATE SET
         source = excluded.source, config = excluded.config, updated_at = excluded.updated_at`,
    ).bind(this.userId, input.trackKey, input.source, json, updatedAt).run()
    return { trackKey: input.trackKey, source: input.source, config, updatedAt }
  }

  async getSourceOverride(trackKey: string): Promise<MusicSourceOverride | null> {
    const row = await this.db.prepare(
      `SELECT user_id, track_key, source, config, updated_at
         FROM music_source_override WHERE user_id = ?1 AND track_key = ?2`,
    ).bind(this.userId, trackKey).first<SourceOverrideRow>()
    return row ? this.toSourceOverride(row) : null
  }

  async listSourceOverrides(): Promise<MusicSourceOverride[]> {
    const { results } = await this.db.prepare(
      `SELECT user_id, track_key, source, config, updated_at
         FROM music_source_override WHERE user_id = ?1 ORDER BY updated_at DESC, track_key`,
    ).bind(this.userId).all<SourceOverrideRow>()
    return results.map((row) => this.toSourceOverride(row))
  }

  async deleteSourceOverride(trackKey: string): Promise<boolean> {
    const result = await this.db.prepare(
      `DELETE FROM music_source_override WHERE user_id = ?1 AND track_key = ?2`,
    ).bind(this.userId, trackKey).run()
    return (result.meta.changes ?? 0) > 0
  }

  // Subscriptions ------------------------------------------------------------------------------

  async createSubscription(input: MusicSubscriptionInput): Promise<MusicSubscription> {
    const id = newId()
    await this.db.prepare(
      `INSERT INTO music_subscription (user_id, id, kind, provider_id, name, cover_url, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(user_id, kind, provider_id) DO UPDATE SET
         name = excluded.name, cover_url = excluded.cover_url`,
    ).bind(
      this.userId,
      id,
      input.kind,
      input.providerId,
      input.name,
      input.coverUrl ?? '',
      Date.now(),
    ).run()
    const row = await this.db.prepare(
      `SELECT user_id, id, kind, provider_id, name, cover_url, created_at
         FROM music_subscription WHERE user_id = ?1 AND kind = ?2 AND provider_id = ?3`,
    ).bind(this.userId, input.kind, input.providerId).first<SubscriptionRow>()
    if (!row) throw new Error('music_subscription_upsert_failed')
    return this.toSubscription(row)
  }

  async listSubscriptions(): Promise<MusicSubscription[]> {
    const { results } = await this.db.prepare(
      `SELECT user_id, id, kind, provider_id, name, cover_url, created_at
         FROM music_subscription WHERE user_id = ?1 ORDER BY created_at DESC, id DESC`,
    ).bind(this.userId).all<SubscriptionRow>()
    return results.map((row) => this.toSubscription(row))
  }

  async getSubscription(id: string): Promise<MusicSubscription | null> {
    const row = await this.db.prepare(
      `SELECT user_id, id, kind, provider_id, name, cover_url, created_at
         FROM music_subscription WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<SubscriptionRow>()
    return row ? this.toSubscription(row) : null
  }

  async updateSubscription(id: string, patch: MusicSubscriptionPatch): Promise<MusicSubscription | null> {
    const result = await this.db.prepare(
      `UPDATE music_subscription SET
         name = COALESCE(?3, name),
         cover_url = COALESCE(?4, cover_url)
       WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id, patch.name ?? null, patch.coverUrl ?? null).run()
    if (!(result.meta.changes ?? 0)) return null
    return this.getSubscription(id)
  }

  async deleteSubscription(id: string): Promise<boolean> {
    const result = await this.db.prepare(
      `DELETE FROM music_subscription WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).run()
    return (result.meta.changes ?? 0) > 0
  }

  // Cloud mounts -------------------------------------------------------------------------------

  async listMounts(): Promise<MusicMount[]> {
    const { results } = await this.db.prepare(
      `SELECT user_id, id, kind, name, base_url, root_path, secret, status, created_at, updated_at
         FROM music_mount WHERE user_id = ?1 ORDER BY created_at, id`,
    ).bind(this.userId).all<MountRow>()
    return results.map(toMount)
  }

  /** The mount as a reader may see it: no secret, only whether one is stored. */
  async getMount(id: string): Promise<MusicMount | null> {
    const row = await this.mountRow(id)
    return row ? toMount(row) : null
  }

  /**
   * The stored ciphertext for one mount, for the layer that talks to the drive. The store never
   * decrypts it; null means the mount does not exist, while an empty string means no credential.
   */
  async getMountSecret(id: string): Promise<string | null> {
    const row = await this.db.prepare(
      `SELECT secret FROM music_mount WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<{ secret: string }>()
    return row ? row.secret : null
  }

  async createMount(input: MusicMountInput): Promise<MusicMount> {
    const id = newId()
    const now = Date.now()
    await this.db.prepare(
      `INSERT INTO music_mount
         (user_id, id, kind, name, base_url, root_path, secret, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    ).bind(
      this.userId,
      id,
      input.kind ?? 'alist',
      input.name,
      input.baseUrl,
      input.rootPath ?? '/',
      input.secret ?? '',
      input.status ?? 'active',
      now,
    ).run()
    const created = await this.getMount(id)
    if (!created) throw new Error('music_mount_insert_failed')
    return created
  }

  /** `secret` absent keeps the stored ciphertext, so a rename cannot silently drop the credential. */
  async updateMount(id: string, patch: MusicMountPatch): Promise<MusicMount | null> {
    const result = await this.db.prepare(
      `UPDATE music_mount SET
         name = COALESCE(?3, name),
         base_url = COALESCE(?4, base_url),
         root_path = COALESCE(?5, root_path),
         secret = COALESCE(?6, secret),
         status = COALESCE(?7, status),
         updated_at = ?8
       WHERE user_id = ?1 AND id = ?2`,
    ).bind(
      this.userId,
      id,
      patch.name ?? null,
      patch.baseUrl ?? null,
      patch.rootPath ?? null,
      patch.secret ?? null,
      patch.status ?? null,
      Date.now(),
    ).run()
    if (!(result.meta.changes ?? 0)) return null
    return this.getMount(id)
  }

  async deleteMount(id: string): Promise<boolean> {
    const result = await this.db.prepare(
      `DELETE FROM music_mount WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).run()
    return (result.meta.changes ?? 0) > 0
  }

  // R2 object ledger ---------------------------------------------------------------------------

  async registerObject(input: MusicObjectInput): Promise<void> {
    await this.db.prepare(
      `INSERT INTO music_object (user_id, r2_key, track_id, format, quality, size, sha256, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(user_id, r2_key) DO UPDATE SET
         track_id = excluded.track_id,
         format = excluded.format,
         quality = excluded.quality,
         size = excluded.size,
         sha256 = excluded.sha256`,
    ).bind(
      this.userId,
      input.r2Key,
      input.trackId ?? null,
      input.format,
      input.quality,
      input.size,
      input.sha256 ?? '',
      input.createdAt ?? Date.now(),
    ).run()
  }

  /** Usage across every format and quality; one row per object, so deduplicated content counts once. */
  async quotaUsage(): Promise<MusicQuota> {
    const row = await this.db.prepare(
      `SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM music_object WHERE user_id = ?1`,
    ).bind(this.userId).first<{ bytes: number; count: number }>()
    return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 }
  }

  async objectReferenceCount(r2Key: string): Promise<number> {
    const row = await this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM music_track WHERE user_id = ?1 AND r2_key = ?2) +
         (SELECT COUNT(*) FROM music_download WHERE user_id = ?1 AND r2_key = ?2) AS count`,
    ).bind(this.userId, r2Key).first<{ count: number }>()
    return row?.count ?? 0
  }

  async isObjectReferenced(r2Key: string): Promise<boolean> {
    return (await this.objectReferenceCount(r2Key)) > 0
  }

  async listObjects(limit = 100): Promise<Array<{ r2Key: string; trackId: string | null; size: number }>> {
    const capped = Math.max(1, Math.min(500, Math.trunc(limit)))
    const { results } = await this.db.prepare(
      `SELECT r2_key, track_id, size FROM music_object
        WHERE user_id = ?1 ORDER BY created_at, r2_key LIMIT ?2`,
    ).bind(this.userId, capped).all<{ r2_key: string; track_id: string | null; size: number }>()
    return results.map((row) => ({ r2Key: row.r2_key, trackId: row.track_id, size: row.size }))
  }

  /** Put object keys on the retry queue. Duplicate keys keep their original timestamp. */
  async queueCleanup(objectKeys: string | readonly string[], now = Date.now()): Promise<number> {
    const keys = (typeof objectKeys === 'string' ? [objectKeys] : [...objectKeys])
      .filter((key) => key.length > 0)
    const unique = [...new Set(keys)]
    if (!unique.length) return 0
    const statements = unique.map((key) => this.db.prepare(
      `INSERT OR IGNORE INTO music_cleanup (object_key, user_id, created_at) VALUES (?1, ?2, ?3)`,
    ).bind(key, this.userId, now))
    return this.runStatements(statements)
  }

  async listCleanup(limit = 200): Promise<MusicCleanupEntry[]> {
    const capped = Math.max(1, Math.min(500, Math.trunc(limit)))
    const { results } = await this.db.prepare(
      `SELECT object_key, user_id, created_at FROM music_cleanup
        WHERE user_id = ?1 ORDER BY created_at, object_key LIMIT ?2`,
    ).bind(this.userId, capped).all<{ object_key: string; user_id: string; created_at: number }>()
    return results.map((row) => ({ objectKey: row.object_key, userId: row.user_id, createdAt: row.created_at }))
  }

  async dropCleanup(objectKey: string): Promise<boolean> {
    const result = await this.db.prepare(
      `DELETE FROM music_cleanup WHERE object_key = ?1 AND user_id = ?2`,
    ).bind(objectKey, this.userId).run()
    return (result.meta.changes ?? 0) > 0
  }

  /**
   * Release a ledger row only when no track or download names its key, then queue the object.
   * False means the key is still referenced and the caller must not delete the R2 object.
   */
  async removeObject(r2Key: string): Promise<boolean> {
    if (await this.isObjectReferenced(r2Key)) return false
    await this.db.batch([
      this.db.prepare(`DELETE FROM music_object WHERE user_id = ?1 AND r2_key = ?2`)
        .bind(this.userId, r2Key),
      this.db.prepare(
        `INSERT OR IGNORE INTO music_cleanup (object_key, user_id, created_at) VALUES (?1, ?2, ?3)`,
      ).bind(r2Key, this.userId, Date.now()),
    ])
    return true
  }

  // Internals ----------------------------------------------------------------------------------

  private async trackRow(id: string): Promise<TrackRow | null> {
    return this.db.prepare(
      `SELECT ${TRACK_COLUMNS} FROM music_track WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<TrackRow>()
  }

  private async trackRowByProvider(provider: MusicProviderId, providerId: string): Promise<TrackRow | null> {
    return this.db.prepare(
      `SELECT ${TRACK_COLUMNS} FROM music_track WHERE user_id = ?1 AND provider = ?2 AND provider_id = ?3`,
    ).bind(this.userId, provider, providerId).first<TrackRow>()
  }

  private async playlistRow(id: string): Promise<PlaylistRow | null> {
    return this.db.prepare(
      `SELECT p.user_id, p.id, p.name, p.description, p.cover_url, p.provider, p.provider_id,
              p.kind, p.sort_order, p.pinned_at, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM music_playlist_item i
                WHERE i.user_id = p.user_id AND i.playlist_id = p.id) AS track_count
         FROM music_playlist p WHERE p.user_id = ?1 AND p.id = ?2`,
    ).bind(this.userId, id).first<PlaylistRow>()
  }

  private async playlistExists(id: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS hit FROM music_playlist WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<{ hit: number }>()
    return Boolean(row)
  }

  private async playlistItemRow(playlistId: string, trackId: string): Promise<MusicPlaylistItem | null> {
    const row = await this.db.prepare(
      `SELECT playlist_id, track_id, position, added_at FROM music_playlist_item
        WHERE user_id = ?1 AND playlist_id = ?2 AND track_id = ?3`,
    ).bind(this.userId, playlistId, trackId).first<PlaylistItemRow>()
    return row
      ? { playlistId: row.playlist_id, trackId: row.track_id, position: row.position, addedAt: row.added_at }
      : null
  }

  private async accountRow(provider: MusicAccount['provider']): Promise<AccountRow | null> {
    return this.db.prepare(
      `SELECT user_id, provider, account_id, nickname, avatar_url, cookie_ciphertext, status, updated_at
         FROM music_account WHERE user_id = ?1 AND provider = ?2`,
    ).bind(this.userId, provider).first<AccountRow>()
  }

  private async mountRow(id: string): Promise<MountRow | null> {
    return this.db.prepare(
      `SELECT user_id, id, kind, name, base_url, root_path, secret, status, created_at, updated_at
         FROM music_mount WHERE user_id = ?1 AND id = ?2`,
    ).bind(this.userId, id).first<MountRow>()
  }

  private toSourceOverride(row: SourceOverrideRow): MusicSourceOverride {
    return {
      trackKey: row.track_key,
      source: row.source,
      config: parseStoredObject<Record<string, unknown>>(row.config, 'music source config'),
      updatedAt: row.updated_at,
    }
  }

  private toSubscription(row: SubscriptionRow): MusicSubscription {
    return {
      id: row.id,
      kind: row.kind as MusicSubscription['kind'],
      providerId: row.provider_id,
      name: row.name,
      coverUrl: row.cover_url,
      createdAt: row.created_at,
    }
  }

  private trimHistoryStatement(): D1PreparedStatement {
    return this.db.prepare(
      `DELETE FROM music_history WHERE user_id = ?1 AND id NOT IN (
         SELECT id FROM music_history WHERE user_id = ?1
          ORDER BY played_at DESC, id DESC LIMIT ?2
       )`,
    ).bind(this.userId, MUSIC_HISTORY_LIMIT)
  }

  private trimRecentStatement(): D1PreparedStatement {
    return this.db.prepare(
      `DELETE FROM music_recent WHERE user_id = ?1 AND id NOT IN (
         SELECT id FROM music_recent WHERE user_id = ?1
          ORDER BY last_played_at DESC, id DESC LIMIT ?2
       )`,
    ).bind(this.userId, MUSIC_RECENT_LIMIT)
  }

  /** Run statements under the D1 batch ceiling, summing the rows each batch actually changed. */
  private async runStatements(statements: readonly D1PreparedStatement[]): Promise<number> {
    let changes = 0
    for (let offset = 0; offset < statements.length; offset += MAX_BATCH_STATEMENTS) {
      const results = await this.db.batch(statements.slice(offset, offset + MAX_BATCH_STATEMENTS))
      for (const result of results) changes += result.meta.changes ?? 0
    }
    return changes
  }
}
