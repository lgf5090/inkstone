/** The music app's only door to `/api/music`; pages and stores never call fetch directly. */
import { request } from '../../lib/api'
import { uploadWithProgress } from '../../lib/transfer'
import type {
  MusicAccountStatus,
  MusicAlbumDetail,
  MusicAlbumSummary,
  MusicAlistEntry,
  MusicAlistListing,
  MusicAlistMountInput,
  MusicAlistMountPatch,
  MusicArtistDetail,
  MusicDownloadListPayload,
  MusicDriveDeleteResult,
  MusicDriveImportResult,
  MusicDriveUploadResult,
  MusicHealth,
  MusicHistorySummary,
  MusicHome,
  MusicLibraryPayload,
  MusicLyricResponse,
  MusicMvDetail,
  MusicMvSummary,
  MusicPage,
  MusicPlaylistDetail,
  MusicPlaylistSummary,
  MusicRadioCategory,
  MusicRadioDetail,
  MusicRadioSummary,
  MusicSearchResult,
  MusicToplistSummary,
  MusicUploadInit,
  MusicUploadPartResult,
  MusicUserProfile,
  MusicPublicPlaylistPayload,
  MusicDriveBatchResult,
  MusicDriveR2Listing,
  MusicDriveR2UploadResult,
  MusicTrackDeleteResult,
} from '@shared/music/api'
import type {
  MusicAccount,
  MusicMount,
  MusicDownload,
  MusicFavorite,
  MusicFavoriteTrack,
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
  driveR2: () => request<MusicDriveR2Listing>('/api/music/drive/r2'),
  driveR2Upload: (file: File, metadata: unknown) => {
    const form = new FormData()
    form.append('file', file, file.name)
    form.append('metadata', JSON.stringify(metadata))
    return request<MusicDriveR2UploadResult>('/api/music/drive/r2/upload', { method: 'POST', formData: form })
  },
  driveR2Delete: (keys: string[]) =>
    request<MusicDriveBatchResult>('/api/music/drive/r2/delete', { method: 'POST', body: { keys } }),
  alistMounts: () => request<{ mounts: MusicMount[] }>('/api/music/drive/alist'),
  createAlistMount: (input: MusicAlistMountInput) =>
    request<{ mount: MusicMount }>('/api/music/drive/alist', { method: 'POST', body: input }),
  updateAlistMount: (id: string, patch: MusicAlistMountPatch) =>
    request<{ mount: MusicMount }>(`/api/music/drive/alist/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  deleteAlistMount: (id: string) =>
    request<{ ok: true }>(`/api/music/drive/alist/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  alistList: (id: string, path = '') =>
    request<{ mount: MusicMount, listing: MusicAlistListing }>(`/api/music/drive/alist/${encodeURIComponent(id)}/list${query({ path })}`),
  alistSearch: (id: string, keywords: string) =>
    request<{ mount: MusicMount, entries: MusicAlistEntry[] }>(`/api/music/drive/alist/${encodeURIComponent(id)}/search${query({ keywords })}`),
  alistImport: (id: string, paths: string[]) =>
    request<MusicDriveImportResult>(`/api/music/drive/alist/${encodeURIComponent(id)}/import`, {
      method: 'POST',
      body: { paths },
    }),
  alistUpload: (id: string, dir: string, file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return request<MusicDriveUploadResult>(
      `/api/music/drive/alist/${encodeURIComponent(id)}/upload${query({ path: dir })}`,
      { method: 'POST', formData: form },
    )
  },
  alistDelete: (id: string, paths: string[]) =>
    request<MusicDriveBatchResult>(`/api/music/drive/alist/${encodeURIComponent(id)}/delete`, {
      method: 'POST',
      body: { paths },
    }),
  testAlistMount: (id: string) =>
    request<{ ok: true }>(`/api/music/drive/alist/${encodeURIComponent(id)}/test`, { method: 'POST' }),
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
  driveWebdavDeleteMany: (paths: string[]) =>
    request<MusicDriveBatchResult>('/api/music/drive/webdav/delete', { method: 'POST', body: { paths } }),
  attachImportedMetadata: (
    trackId: string,
    metadata: {
      title: string
      artists: string[]
      album: string
      durationMs: number
      bitrate: number | null
      lyrics: string
      cover: Blob | null
    },
  ) => {
    const form = new FormData()
    form.append('metadata', JSON.stringify({
      title: metadata.title,
      artists: metadata.artists,
      album: metadata.album,
      durationMs: metadata.durationMs,
      bitrate: metadata.bitrate,
      lyrics: metadata.lyrics,
    }))
    if (metadata.cover) form.append('cover', metadata.cover, 'cover')
    return request<{ track: MusicTrack }>(
      `/api/music/drive/imported/${encodeURIComponent(trackId)}/metadata`,
      { method: 'POST', formData: form },
    )
  },
  transferTrack: (trackId: string, target: 'webdav' | 'alist') =>
    request<{ track: MusicTrack; target: 'webdav' | 'alist'; path: string; mountName?: string }>(
      '/api/music/drive/transfer',
      { method: 'POST', body: { trackId, target } },
    ),

  home: () => request<MusicHome>('/api/music/home'),
  daily: () => request<{ tracks: MusicTrack[] }>('/api/music/daily'),
  fm: () => request<{ tracks: MusicTrack[] }>('/api/music/home/fm'),

  search: (type: MusicSearchType, keywords: string, page = 1, limit = 30) =>
    request<MusicSearchResult>(`/api/music/search${query({ type, q: keywords, page, limit })}`),
  suggest: (keywords: string) => request<{ items: string[] }>(`/api/music/search/suggest${query({ q: keywords })}`),
  hot: () => request<{ items: string[] }>('/api/music/search/hot'),

  playlistSquare: (page = 1, limit = 30, cat = '', order = 'hot') =>
    request<MusicPage<MusicPlaylistSummary>>(`/api/music/playlists${query({ page, limit, cat, order })}`),
  playlistCategories: () => request<{ items: Array<{ name: string; hot: boolean }> }>('/api/music/playlists/categories'),
  playlist: (id: string, provider: 'netease' | 'local' = 'netease', page = 1, limit = 100) =>
    request<MusicPlaylistDetail>(`/api/music/playlists/${encodeURIComponent(id)}${query({ provider, page, limit })}`),
  publicPlaylist: (slug: string) =>
    request<MusicPublicPlaylistPayload>(`/api/public/music/playlists/${encodeURIComponent(slug)}`),

  newAlbums: (area = 'ALL', page = 1, limit = 30) =>
    request<MusicPage<MusicAlbumSummary>>(`/api/music/albums/new${query({ area, page, limit })}`),
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
    request<MusicPage<MusicMvSummary>>(`/api/music/mvs${query({ area, page, limit })}`),
  mv: (id: string) => request<MusicMvDetail>(`/api/music/mvs/${encodeURIComponent(id)}`),

  radioCategories: () =>
    request<{ items: MusicRadioCategory[] }>('/api/music/podcasts/categories'),
  radioRecommend: () =>
    request<{ items: MusicRadioSummary[] }>('/api/music/podcasts/recommend'),
  radioHot: (category = '', page = 1, limit = 30) =>
    request<MusicPage<MusicRadioSummary>>(`/api/music/podcasts${query({ cat: category, page, limit })}`),
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
  track: (id: string) => request<{ track: MusicTrack }>(`/api/music/library/tracks/${encodeURIComponent(id)}`),
  tracks: (provider: 'upload' | 'webdav' | 'alist' | 'download') => request<{ items: MusicTrack[] }>(`/api/music/library/tracks${query({ provider })}`),
  updateTrackMetadata: (trackId: string, patch: { title?: string; artists?: Array<{ id: string; name: string }>; album?: string; coverUrl?: string }) =>
    request<{ track: MusicTrack }>(`/api/music/library/tracks/${encodeURIComponent(trackId)}`, { method: 'PATCH', body: patch }),
  upsertTracks: (tracks: MusicTrack[]) =>
    request<{ tracks: MusicTrack[] }>('/api/music/library/tracks', { method: 'POST', body: { tracks } }),
  deleteTracks: (ids: string[]) =>
    request<MusicTrackDeleteResult>('/api/music/library/tracks/delete', {
      method: 'POST',
      body: { ids },
    }),
  favorites: () => request<{ items: MusicFavoriteTrack[] }>('/api/music/library/favorites'),
  addFavorite: (track: MusicTrack) =>
    request<{ ok: true }>('/api/music/library/favorites', { method: 'POST', body: { track } }),
  removeFavorite: (trackId: string) =>
    request<{ ok: true }>(`/api/music/library/favorites/${encodeURIComponent(trackId)}`, { method: 'DELETE' }),
  pinFavorite: (trackId: string, pinned: boolean) =>
    request<MusicFavorite>(`/api/music/library/favorites/${encodeURIComponent(trackId)}`, { method: 'PATCH', body: { pinned } }),
  playlists: () => request<{ items: MusicPlaylist[] }>('/api/music/library/playlists'),
  createPlaylist: (name: string) =>
    request<MusicPlaylist>('/api/music/library/playlists', { method: 'POST', body: { name } }),
  updatePlaylist: (id: string, patch: { name?: string; description?: string; coverUrl?: string; pinned?: boolean }) =>
    request<MusicPlaylist>(`/api/music/library/playlists/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  deletePlaylist: (id: string) =>
    request<{ ok: true }>(`/api/music/library/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  playlistItems: (id: string, page = 1, limit = 100) =>
    request<{ items: MusicTrack[]; total: number; hasMore: boolean }>(
      `/api/music/library/playlists/${encodeURIComponent(id)}/items${query({ page, limit })}`,
    ),
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
  historySummary: () => request<MusicHistorySummary>(
    `/api/music/library/history/summary${query({ tzOffset: -new Date().getTimezoneOffset() })}`,
  ),
  deleteHistory: (id: string) =>
    request<{ ok: true }>(`/api/music/library/history/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearHistory: () =>
    request<{ ok: true; removed: number }>('/api/music/library/history', { method: 'DELETE' }),
  recordHistory: (entry: Pick<MusicHistoryEntry, 'trackId' | 'durationPlayed' | 'completed' | 'contextType' | 'contextId'>) =>
    request<{ ok: true }>('/api/music/library/history', { method: 'POST', body: entry }),
  recent: () => request<{ items: Array<Record<string, unknown>> }>('/api/music/library/recent'),

  downloads: () => request<MusicDownloadListPayload>('/api/music/downloads'),
  removeDownload: (id: string) =>
    request<{ ok: true }>(`/api/music/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
