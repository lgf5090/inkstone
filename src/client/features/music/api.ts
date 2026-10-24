/** The music app's only door to `/api/music`; pages and stores never call fetch directly. */
import { request } from '../../lib/api'
import { uploadWithProgress } from '../../lib/transfer'
import type {
  MusicAccountStatus,
  MusicAlbumDetail,
  MusicArtistDetail,
  MusicDownloadListPayload,
  MusicDriveDeleteResult,
  MusicDriveImportResult,
  MusicDriveUploadResult,
  MusicHealth,
  MusicHome,
  MusicLibraryPayload,
  MusicLyricResponse,
  MusicMvDetail,
  MusicPage,
  MusicPlaylistDetail,
  MusicPlaylistSummary,
  MusicRadioDetail,
  MusicSearchResult,
  MusicToplistSummary,
  MusicUploadInit,
  MusicUploadPartResult,
  MusicUserProfile,
} from '@shared/music/api'
import type {
  MusicAccount,
  MusicDownload,
  MusicHistoryEntry,
  MusicPlaylist,
  MusicSearchType,
  MusicSettings,
  MusicSubscription,
  MusicTrack,
  MusicUpload,
} from '@shared/music/model'

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}


export interface MusicCloudEntry {
  name: string
  path: string
  isDirectory: boolean
  sizeBytes: number
  mime: string | null
  modifiedAt: number | null
  isMedia: boolean
}

export interface MusicDriveSummary {
  r2: { bytes: number; objects: number }
  webdav: { configured: boolean }
  mounts: number
}

export interface MusicWebdavListing {
  configured: boolean
  dir: string
  path: string
  entries: MusicCloudEntry[]
  truncated: boolean
  reason: string | null
}

export const musicApi = {
  health: () => request<MusicHealth>('/api/music/health'),

  drive: () => request<MusicDriveSummary>('/api/music/drive'),
  driveWebdav: (path = '') => request<MusicWebdavListing>(`/api/music/drive/webdav${query({ path })}`),
  driveWebdavImport: (paths: string[], targetPlaylistId?: string) =>
    request<MusicDriveImportResult>('/api/music/drive/webdav/import', {
      method: 'POST',
      body: targetPlaylistId ? { paths, targetPlaylistId } : { paths },
    }),
  driveWebdavUpload: (dir: string, file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return request<MusicDriveUploadResult>(`/api/music/drive/webdav/upload${query({ path: dir })}`, {
      method: 'POST',
      formData: form,
    })
  },
  driveWebdavDelete: (path: string) =>
    request<MusicDriveDeleteResult>(`/api/music/drive/webdav/object${query({ path })}`, { method: 'DELETE' }),

  home: () => request<MusicHome>('/api/music/home'),
  fm: () => request<{ tracks: MusicTrack[] }>('/api/music/home/fm'),
  fmTrash: (trackId: string) => request<{ ok: true }>('/api/music/home/fm/trash', { method: 'POST', body: { trackId } }),

  search: (type: MusicSearchType, keywords: string, page = 1, limit = 30) =>
    request<MusicSearchResult>(`/api/music/search${query({ type, q: keywords, page, limit })}`),
  suggest: (keywords: string) => request<{ items: string[] }>(`/api/music/search/suggest${query({ q: keywords })}`),
  hot: () => request<{ items: string[] }>('/api/music/search/hot'),

  playlistSquare: (page = 1, limit = 30, cat = '', order = 'hot') =>
    request<MusicPage<MusicPlaylistSummary>>(`/api/music/playlists${query({ page, limit, cat, order })}`),
  playlistCategories: () => request<{ items: Array<{ name: string; hot: boolean }> }>('/api/music/playlists/categories'),
  playlist: (id: string, provider: 'netease' | 'local' = 'netease', page = 1, limit = 100) =>
    request<MusicPlaylistDetail>(`/api/music/playlists/${encodeURIComponent(id)}${query({ provider, page, limit })}`),

  newAlbums: (area = 'ALL', page = 1, limit = 30) =>
    request<MusicPage<MusicPlaylistSummary>>(`/api/music/albums/new${query({ area, page, limit })}`),
  album: (id: string, page = 1, limit = 100) =>
    request<MusicAlbumDetail>(`/api/music/albums/${encodeURIComponent(id)}${query({ page, limit })}`),

  artist: (id: string) => request<MusicArtistDetail>(`/api/music/artists/${encodeURIComponent(id)}`),
  artistSongs: (id: string, page = 1, limit = 50) =>
    request<MusicPage<MusicTrack>>(`/api/music/artists/${encodeURIComponent(id)}/songs${query({ page, limit })}`),
  artistAlbums: (id: string, page = 1, limit = 30) =>
    request<MusicPage<MusicPlaylistSummary>>(`/api/music/artists/${encodeURIComponent(id)}/albums${query({ page, limit })}`),

  toplists: () => request<{ items: MusicToplistSummary[] }>('/api/music/toplists'),
  toplist: (id: string, page = 1, limit = 100) =>
    request<MusicPlaylistDetail>(`/api/music/toplists/${encodeURIComponent(id)}${query({ page, limit })}`),

  mvs: (area = 'ALL', page = 1, limit = 30) =>
    request<MusicPage<MusicPlaylistSummary>>(`/api/music/mvs${query({ area, page, limit })}`),
  mv: (id: string) => request<MusicMvDetail>(`/api/music/mvs/${encodeURIComponent(id)}`),

  radios: (page = 1, limit = 30) =>
    request<MusicPage<MusicPlaylistSummary>>(`/api/music/podcasts${query({ page, limit })}`),
  radio: (id: string, page = 1, limit = 30) =>
    request<MusicRadioDetail>(`/api/music/podcasts/${encodeURIComponent(id)}${query({ page, limit })}`),
  subscribeRadio: (id: string, subscribe: boolean) =>
    request<{ ok: true }>(`/api/music/podcasts/${encodeURIComponent(id)}/subscribe`, {
      method: 'POST',
      body: { subscribe },
    }),

  account: () => request<MusicAccountStatus>('/api/music/account/netease'),
  createQr: () => request<MusicAccountStatus['qr']>('/api/music/account/netease/qr', { method: 'POST' }),
  checkQr: (key: string) => request<MusicAccountStatus>(`/api/music/account/netease/qr/${encodeURIComponent(key)}`),
  loginCookie: (cookie: string) =>
    request<MusicAccount>('/api/music/account/netease/cookie', { method: 'PUT', body: { cookie } }),
  logoutAccount: () => request<{ ok: true }>('/api/music/account/netease', { method: 'DELETE' }),
  user: (id: string) => request<MusicUserProfile>(`/api/music/user/${encodeURIComponent(id)}`),

  library: () => request<MusicLibraryPayload>('/api/music/library'),
  upsertTracks: (tracks: MusicTrack[]) =>
    request<{ tracks: MusicTrack[] }>('/api/music/library/tracks', { method: 'POST', body: { tracks } }),
  favorites: () => request<{ items: MusicTrack[] }>('/api/music/library/favorites'),
  addFavorite: (track: MusicTrack) =>
    request<{ ok: true }>('/api/music/library/favorites', { method: 'POST', body: { track } }),
  removeFavorite: (trackId: string) =>
    request<{ ok: true }>(`/api/music/library/favorites/${encodeURIComponent(trackId)}`, { method: 'DELETE' }),
  playlists: () => request<{ items: MusicPlaylist[] }>('/api/music/library/playlists'),
  createPlaylist: (name: string) =>
    request<MusicPlaylist>('/api/music/library/playlists', { method: 'POST', body: { name } }),
  updatePlaylist: (id: string, patch: { name?: string; description?: string }) =>
    request<MusicPlaylist>(`/api/music/library/playlists/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  deletePlaylist: (id: string) =>
    request<{ ok: true }>(`/api/music/library/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  playlistItems: (id: string) =>
    request<{ items: MusicTrack[] }>(`/api/music/library/playlists/${encodeURIComponent(id)}/items`),
  addPlaylistItems: (id: string, tracks: MusicTrack[]) =>
    request<{ items: MusicTrack[] }>(`/api/music/library/playlists/${encodeURIComponent(id)}/items`, {
      method: 'POST',
      body: { tracks },
    }),
  removePlaylistItem: (id: string, trackId: string) =>
    request<{ ok: true }>(`/api/music/library/playlists/${encodeURIComponent(id)}/items/${encodeURIComponent(trackId)}`, { method: 'DELETE' }),
  reorderPlaylist: (id: string, trackIds: string[]) =>
    request<{ ok: true }>(`/api/music/library/playlists/${encodeURIComponent(id)}/items/order`, {
      method: 'PUT',
      body: { trackIds },
    }),

  history: (limit = 100) => request<{ items: Array<MusicHistoryEntry & { track: MusicTrack | null }> }>(`/api/music/library/history${query({ limit })}`),
  recordHistory: (entry: Pick<MusicHistoryEntry, 'trackId' | 'durationPlayed' | 'completed' | 'contextType' | 'contextId'>) =>
    request<{ ok: true }>('/api/music/library/history', { method: 'POST', body: entry }),
  recent: () => request<{ items: Array<Record<string, unknown>> }>('/api/music/library/recent'),

  downloads: () => request<MusicDownloadListPayload>('/api/music/downloads'),
  enqueueDownload: (track: MusicTrack, quality: MusicSettings['downloadQuality'], format: MusicSettings['downloadFormat']) =>
    request<MusicDownload>('/api/music/downloads', { method: 'POST', body: { track, quality, format } }),
  updateDownload: (id: string, action: 'pause' | 'resume' | 'retry' | 'cancel') =>
    request<MusicDownload>(`/api/music/downloads/${encodeURIComponent(id)}`, { method: 'PATCH', body: { action } }),

  uploads: () => request<{ items: MusicUpload[] }>('/api/music/uploads'),
  initUpload: (input: { filename: string; mime: string; size: number; format: string; metadata?: Record<string, unknown> }) =>
    request<MusicUploadInit>('/api/music/uploads', { method: 'POST', body: input }),
  uploadPart: (uploadId: string, partNumber: number, chunk: Blob, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal) =>
    uploadWithProgress<MusicUploadPartResult>(
      `/api/music/uploads/${encodeURIComponent(uploadId)}/parts/${partNumber}`,
      chunk,
      chunk.size,
      onProgress,
      signal,
    ),
  uploadCover: (uploadId: string, cover: Blob, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal) =>
    uploadWithProgress<{ key: string }>(
      `/api/music/uploads/${encodeURIComponent(uploadId)}/cover`,
      cover,
      cover.size,
      onProgress,
      signal,
    ),
  completeUpload: (uploadId: string) =>
    request<{ track: MusicTrack; upload: MusicUpload }>(`/api/music/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST' }),
  abortUpload: (uploadId: string) =>
    request<{ ok: true }>(`/api/music/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }),

  lyrics: (trackId: string) => request<MusicLyricResponse>(`/api/music/library/lyrics/${encodeURIComponent(trackId)}`),
  settings: () => request<{ settings: MusicSettings }>('/api/music/settings'),
  saveSettings: (settings: MusicSettings) =>
    request<{ settings: MusicSettings }>('/api/music/settings', { method: 'PUT', body: { settings } }),

  subscriptions: () => request<{ items: MusicSubscription[] }>('/api/music/library/subscriptions'),
  streamUrl: (trackId: string) => `/api/music/media/stream/${encodeURIComponent(trackId)}`,
  coverUrl: (trackId: string) => `/api/music/media/cover/${encodeURIComponent(trackId)}`,
}
