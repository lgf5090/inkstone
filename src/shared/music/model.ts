/**
 * The music app's vocabulary, shared by the worker that stores it and the browser that draws it.
 *
 * Times cross the wire as epoch milliseconds. Provider ids stay strings because Netease mixes numeric
 * song ids with string program ids, and a numeric column would have to widen later.
 */

/**
 * `webdav` is a reference row rather than an upload: the audio stays on the reader's WebDAV server
 * and `r2Key` is null, so it costs no R2 quota. Alist and external links are not modelled yet.
 */
export const MUSIC_PROVIDERS = ['netease', 'upload', 'custom', 'webdav', 'alist'] as const
export type MusicProviderId = (typeof MUSIC_PROVIDERS)[number]

/**
 * The longest provider id the library routes accept in a client-sent track snapshot.
 *
 * A WebDAV reference encodes its backup target and its path in this one field, and the favourite and
 * playlist routes re-read that snapshot with this ceiling, so an import that exceeded it would save
 * a row the reader could never favourite or add to a playlist.
 */
export const MUSIC_PROVIDER_ID_MAX = 128

export const MUSIC_TRACK_KINDS = ['song', 'podcast', 'mv'] as const
export type MusicTrackKind = (typeof MUSIC_TRACK_KINDS)[number]

/** The quality ladder Netease accepts through `/song/url/v1`; `original` is ours for uploads. */
export const MUSIC_QUALITIES = [
  'original',
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'jymaster',
] as const
export type MusicQuality = (typeof MUSIC_QUALITIES)[number]

export const MUSIC_SEARCH_TYPES = ['song', 'album', 'playlist', 'mv', 'radio'] as const
export type MusicSearchType = (typeof MUSIC_SEARCH_TYPES)[number]

export const MUSIC_PLAY_MODES = ['order', 'repeat', 'repeatOne', 'shuffle', 'intelligence'] as const
export type MusicPlayMode = (typeof MUSIC_PLAY_MODES)[number]

export const MUSIC_DOWNLOAD_STATUSES = ['queued', 'running', 'paused', 'done', 'failed', 'canceled'] as const
export type MusicDownloadStatus = (typeof MUSIC_DOWNLOAD_STATUSES)[number]

export const MUSIC_UPLOAD_STATUSES = ['uploading', 'completed', 'failed', 'aborted'] as const
export type MusicUploadStatus = (typeof MUSIC_UPLOAD_STATUSES)[number]

export const MUSIC_SUBSCRIPTION_KINDS = ['radio', 'artist', 'album'] as const
export type MusicSubscriptionKind = (typeof MUSIC_SUBSCRIPTION_KINDS)[number]

/** Only translated lyrics exist for now; the kind column keeps the cache room to grow without a migration. */
export const MUSIC_AI_LYRIC_KINDS = ['translation'] as const
export type MusicAiLyricKind = (typeof MUSIC_AI_LYRIC_KINDS)[number]

/** The cloud drives a mount can stand for. Only Alist is modelled; WebDAV reuses a backup target. */
export const MUSIC_MOUNT_KINDS = ['alist'] as const
export type MusicMountKind = (typeof MUSIC_MOUNT_KINDS)[number]

/**
 * `active` is a mount whose last use answered; `error` is one the last test could not reach. The
 * credential is deliberately not part of this axis: a saved token that fails to authenticate is an
 * `error`, not a third state the reader has to interpret.
 */
export const MUSIC_MOUNT_STATUSES = ['active', 'error'] as const
export type MusicMountStatus = (typeof MUSIC_MOUNT_STATUSES)[number]

export interface MusicArtist {
  id: string
  name: string
}

export interface MusicAlbumRef {
  id: string
  name: string
}

export interface MusicTrack {
  id: string
  provider: MusicProviderId
  providerId: string
  kind: MusicTrackKind
  title: string
  artists: MusicArtist[]
  album: string
  albumId: string
  coverUrl: string
  coverKey: string
  durationMs: number
  format: string
  bitrate: number | null
  size: number | null
  sha256: string
  r2Key: string | null
  source: string
  sourceQuality: string
  createdAt: number
  updatedAt: number
}

export interface MusicPlaylist {
  id: string
  name: string
  description: string
  coverUrl: string
  provider: 'local' | 'netease'
  providerId: string
  kind: 'manual' | 'imported' | 'favorites'
  sortOrder: number
  /** When the reader pinned the playlist, or null. Pinned rows sort ahead of the shelf order. */
  pinnedAt: number | null
  trackCount: number
  createdAt: number
  updatedAt: number
}

export interface MusicPlaylistItem {
  playlistId: string
  trackId: string
  position: number
  addedAt: number
}

export interface MusicFavorite {
  trackId: string
  createdAt: number
  /** When the reader pinned the favourite, or null. A pinned track still has to be a favourite. */
  pinnedAt: number | null
}

/** A favourite as the library lists it: the saved track snapshot plus its pin state. */
export interface MusicFavoriteTrack extends MusicTrack {
  pinnedAt: number | null
}

export interface MusicHistoryEntry {
  id: string
  trackId: string
  playedAt: number
  durationPlayed: number
  completed: boolean
  contextType: string
  contextId: string
}

export interface MusicRecentEntry {
  id: string
  kind: 'playlist' | 'album' | 'radio' | 'artist'
  providerId: string
  name: string
  coverUrl: string
  lastPlayedAt: number
  playCount: number
}

export interface MusicDownload {
  id: string
  trackId: string
  quality: MusicQuality
  format: string
  status: MusicDownloadStatus
  progress: number
  size: number | null
  r2Key: string | null
  error: string
  attempts: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface MusicUpload {
  id: string
  filename: string
  mime: string
  size: number
  format: string
  status: MusicUploadStatus
  r2Key: string | null
  trackId: string | null
  coverKey: string | null
  error: string
  createdAt: number
  updatedAt: number
}

export interface MusicLyric {
  trackKey: string
  source: string
  lrc: string
  tlyric: string
  yrc: string
  fetchedAt: number
}

/**
 * One cached AI lyric layer.
 *
 * `payload` is opaque JSON text owned by the producer (the translation route), so the cache can carry
 * whatever line shape it later needs; `sourceHash` ties the entry to the lyric text it was made from,
 * and a reader that finds a different hash treats the row as a miss.
 */
export interface MusicAiLyric {
  trackKey: string
  kind: MusicAiLyricKind
  lang: string
  sourceHash: string
  payload: string
  model: string
  createdAt: number
  updatedAt: number
}

/**
 * A configured cloud drive. The credential lives in a separate column and never appears here: the
 * reader sees whether one is stored, not what it is.
 */
export interface MusicMount {
  id: string
  kind: MusicMountKind
  name: string
  baseUrl: string
  rootPath: string
  status: MusicMountStatus
  hasSecret: boolean
  createdAt: number
  updatedAt: number
}

export interface MusicAccount {
  provider: 'netease'
  accountId: string
  nickname: string
  avatarUrl: string
  status: 'connected' | 'expired'
  updatedAt: number
}

export interface MusicSourceOverride {
  trackKey: string
  source: string
  config: Record<string, unknown>
  updatedAt: number
}

export interface MusicSubscription {
  id: string
  kind: MusicSubscriptionKind
  providerId: string
  name: string
  coverUrl: string
  createdAt: number
}

export interface MusicSettings {
  quality: Exclude<MusicQuality, 'original'>
  downloadQuality: Exclude<MusicQuality, 'original'>
  downloadFormat: 'auto' | 'mp3' | 'flac' | 'm4a'
  downloadConcurrency: number
  downloadNameFormat: string
  exportLyrics: boolean
  autoPlay: boolean
  singleTrackMode: 'replace' | 'append'
  pureMode: boolean
  sourcePriority: Array<'official' | 'custom'>
  cacheLyrics: boolean
  customResolverEnabled: boolean
  customResolverUrl: string
  customResolverMethod: 'GET' | 'POST'
  customResolverParams: Record<string, string>
  customResolverResponsePath: string
  customResolverQualityMap: Record<string, string>
  /** A backup WebDAV target this account lets the music cloud browse; empty means not configured. */
  cloudWebdavTargetId: string
  /** The folder inside that target; relative to its root and never empty in the UI. */
  cloudWebdavDir: string
  storageQuotaBytes: number
}

export const DEFAULT_MUSIC_SETTINGS: MusicSettings = {
  quality: 'exhigh',
  downloadQuality: 'exhigh',
  downloadFormat: 'auto',
  downloadConcurrency: 3,
  downloadNameFormat: '{title} - {artist}',
  exportLyrics: true,
  autoPlay: true,
  singleTrackMode: 'replace',
  pureMode: false,
  sourcePriority: ['official', 'custom'],
  cacheLyrics: true,
  customResolverEnabled: false,
  customResolverUrl: '',
  customResolverMethod: 'GET',
  customResolverParams: {},
  customResolverResponsePath: '',
  customResolverQualityMap: {},
  cloudWebdavTargetId: '',
  cloudWebdavDir: 'music',
  storageQuotaBytes: 0,
}

export function musicTrackKey(provider: MusicProviderId, providerId: string): string {
  return `${provider}:${providerId}`
}

/**
 * A WebDAV reference's provider id: the backup target the file lives on, then its path inside the
 * music folder. Only the first colon splits the value, because a file name may contain one; the
 * target id is a generated id and never does. The path is relative to the configured music folder,
 * so moving that folder invalidates existing references — a re-import repairs them.
 */
export function musicWebdavProviderId(targetId: string, path: string): string {
  return `${targetId}:${path}`
}

export function parseMusicWebdavProviderId(providerId: string): { targetId: string, path: string } | null {
  const split = providerId.indexOf(':')
  if (split <= 0 || split === providerId.length - 1) return null
  return { targetId: providerId.slice(0, split), path: providerId.slice(split + 1) }
}

export function musicAlistProviderId(mountId: string, path: string): string {
  return `${mountId}:${path}`
}

export function parseMusicAlistProviderId(providerId: string): { mountId: string, path: string } | null {
  const split = providerId.indexOf(':')
  if (split <= 0 || split === providerId.length - 1) return null
  return { mountId: providerId.slice(0, split), path: providerId.slice(split + 1) }
}
