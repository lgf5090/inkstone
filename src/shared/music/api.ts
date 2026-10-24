/** Wire shapes for `/api/music`. The worker returns camelCase; D1 rows never leave the worker. */
import type {
  MusicAccount,
  MusicDownload,
  MusicHistoryEntry,
  MusicLyric,
  MusicPlaylist,
  MusicRecentEntry,
  MusicSettings,
  MusicSubscription,
  MusicTrack,
  MusicUpload,
} from './model'


export interface MusicAlistEntry {
  name: string
  path: string
  isDirectory: boolean
  sizeBytes: number
  modifiedAt: number | null
  isMedia: boolean
}

export interface MusicAlistListing {
  path: string
  entries: MusicAlistEntry[]
  truncated: boolean
}

export interface MusicAlistMountInput {
  name: string
  baseUrl: string
  rootPath?: string
  token: string
}

export interface MusicAlistMountPatch {
  name?: string
  baseUrl?: string
  rootPath?: string
  /** Absent keeps the saved token; an empty string clears it. */
  token?: string
}

export interface MusicPage<T> {
  items: T[]
  total: number
  hasMore: boolean
}

export interface MusicPlaylistSummary {
  id: string
  provider: 'local' | 'netease'
  providerId: string
  name: string
  description: string
  coverUrl: string
  trackCount: number
  creator?: string
}

export interface MusicAlbumSummary {
  id: string
  name: string
  coverUrl: string
  artists: string[]
  publishTime: number
  trackCount: number
}

export interface MusicArtistSummary {
  id: string
  name: string
  coverUrl: string
  albumCount: number
  followCount: number
}

export interface MusicMvSummary {
  id: string
  name: string
  coverUrl: string
  artist: string
  durationMs: number
  playCount: number
}

export interface MusicRadioSummary {
  id: string
  name: string
  coverUrl: string
  description: string
  programCount: number
  subscriberCount: number
}

export interface MusicRadioCategory {
  id: string
  name: string
}

export interface MusicHome {
  dailyTracks: MusicTrack[]
  fmEnabled: boolean
  recommendedPlaylists: MusicPlaylistSummary[]
  hotArtists: MusicArtistSummary[]
  newAlbums: MusicAlbumSummary[]
  newTracks: MusicTrack[]
}

export interface MusicSearchResult {
  type: 'song' | 'album' | 'playlist' | 'mv' | 'radio'
  tracks: MusicTrack[]
  albums: MusicAlbumSummary[]
  playlists: MusicPlaylistSummary[]
  mvs: MusicMvSummary[]
  radios: MusicRadioSummary[]
  total: number
  hasMore: boolean
}

export interface MusicPlaylistDetail {
  playlist: MusicPlaylistSummary
  tracks: MusicTrack[]
  total: number
  hasMore: boolean
}

export interface MusicAlbumDetail {
  album: MusicAlbumSummary
  description: string
  tracks: MusicTrack[]
  total: number
  hasMore: boolean
}

export interface MusicArtistDetail {
  artist: MusicArtistSummary
  description: string
  hotTracks: MusicTrack[]
  albums: MusicAlbumSummary[]
  albumTotal: number
  albumHasMore: boolean
}

export interface MusicToplistSummary {
  id: string
  name: string
  coverUrl: string
  description: string
  trackCount: number
}

export interface MusicMvDetail {
  mv: MusicMvSummary
  description: string
  publishTime: number
}

export interface MusicRadioDetail {
  radio: MusicRadioSummary
  programs: MusicTrack[]
  total: number
  hasMore: boolean
}

export interface MusicUserProfile {
  id: string
  nickname: string
  avatarUrl: string
  signature: string
  follows: number
  followers: number
  playlists: MusicPlaylistSummary[]
}

export interface MusicLyricPayload {
  lyric: MusicLyric | null
  hasTranslation: boolean
  hasWordByWord: boolean
}

export interface MusicAccountStatus {
  account: MusicAccount | null
  qr?: { key: string; url: string; expiresAt: number }
}

export interface MusicHealth {
  provider: 'native' | 'external'
  storage: 'r2' | 'none'
  netease: boolean
  upstream: boolean
  account?: { netease: boolean }
}

export interface MusicUploadInit {
  uploadId: string
  partSize: number
  uploadedParts: number[]
}

export interface MusicUploadPartResult {
  partNumber: number
  etag: string
}

export interface MusicDownloadRequest {
  quality: MusicSettings['downloadQuality']
  format: MusicSettings['downloadFormat']
}

export interface MusicLibrary {
  playlists: MusicPlaylist[]
  favorites: MusicTrack[]
  history: MusicHistoryEntry[]
  recent: MusicRecentEntry[]
  downloads: MusicDownload[]
  uploads: MusicUpload[]
  subscriptions: MusicSubscription[]
}

export interface MusicLibraryPayload {
  tracks: MusicTrack[]
  playlists: MusicPlaylist[]
  favorites: MusicTrack[]
  history: Array<MusicHistoryEntry & { track: MusicTrack | null }>
  recent: MusicRecentEntry[]
  downloads: Array<MusicDownload & { track: MusicTrack | null }>
  uploads: MusicUpload[]
  subscriptions: MusicSubscription[]
}

export interface MusicDownloadListPayload {
  items: Array<MusicDownload & { track: MusicTrack | null }>
}

export interface MusicLyricResponse {
  lrc: string
  tlyric: string
  yrc: string
  source: string
  fetchedAt: number
}

/** The largest file one WebDAV upload request may carry, envelope included. */
export const MUSIC_DRIVE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024
/** The most paths one import call may name; the response reports each one's fate. */
export const MUSIC_DRIVE_IMPORT_MAX_PATHS = 50

/**
 * Why one path in an import was left alone. `missing` covers a file deleted between listing and
 * import; `path_too_long` is a reference whose encoded id would not fit the library's provider field.
 */
export type MusicDriveSkipReason = 'missing' | 'directory' | 'unsupported' | 'path_too_long'

export interface MusicDriveSkip {
  path: string
  reason: MusicDriveSkipReason
}

export interface MusicDriveImportResult {
  tracks: MusicTrack[]
  skipped: MusicDriveSkip[]
}

export interface MusicDriveUploadResult {
  path: string
  size: number
}

export interface MusicDriveDeleteResult {
  ok: true
  removed: boolean
}
