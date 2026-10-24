/**
 * The account's music library as this device last saw it.
 *
 * Reads follow the planned `/api/music/library/*` routes; writes are optimistic and rolled back when
 * the Worker refuses them. The server is still the authority: a successful write replaces the local
 * row with whatever came back, and a reload replaces the whole cache.
 *
 * The endpoints and answer shapes are the port's contract. No Worker route is implemented here; a
 * missing route surfaces as the same error a failed one does, which is what the three-state pages
 * need while the backend catches up.
 */
import { create } from 'zustand'
import { CLIENT_HEADER } from '@shared/constants'
import { MUSIC_LIMITS } from '@shared/music/constants'
import type { MusicDownloadListPayload } from '@shared/music/api'
import type {
  MusicDownload,
  MusicHistoryEntry,
  MusicPlaylist,
  MusicRecentEntry,
  MusicSettings,
  MusicTrack,
  MusicUpload,
} from '@shared/music/model'

export type MusicHistoryItem = MusicHistoryEntry & { track: MusicTrack | null }
export type MusicDownloadItem = MusicDownload & { track: MusicTrack | null }

export interface MusicLibraryPlaylistInput {
  name: string
  description?: string
}

export interface MusicHistoryInput {
  track: MusicTrack
  durationPlayed?: number
  completed?: boolean
  contextType?: string
  contextId?: string
}

export interface MusicRecentInput {
  kind: MusicRecentEntry['kind']
  providerId: string
  name: string
  coverUrl: string
}

export const MUSIC_LIBRARY_ERROR_KEYS = {
  load: 'music.library.error.load',
  favorite: 'music.library.error.favorite',
  history: 'music.library.error.history',
  recent: 'music.library.error.recent',
  playlist: 'music.library.error.playlist',
  download: 'music.library.error.download',
} as const

/** A history write for the same track inside this window is dropped: playing on repeat is not 30 rows. */
export const HISTORY_WRITE_WINDOW_MS = 30_000

const ENDPOINTS = {
  favorites: '/api/music/library/favorites',
  history: '/api/music/library/history',
  recent: '/api/music/library/recent',
  playlists: '/api/music/library/playlists',
  downloads: '/api/music/downloads',
  uploads: '/api/music/uploads',
} as const

interface ItemsAnswer<T> {
  items: T[]
}

interface PlaylistAnswer {
  playlist?: MusicPlaylist
}

interface PlaylistItemsAnswer {
  items: MusicTrack[]
}

interface DownloadAnswer {
  download?: MusicDownload
}

export class MusicLibraryError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'MusicLibraryError'
    this.status = status
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function musicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    [CLIENT_HEADER]: '1',
    Accept: 'application/json',
  }
  if (init?.body !== undefined && init.body !== null) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  })
  if (!response.ok) {
    // Reading the body is diagnostic only: a failure to read it must not hide the status.
    const text = await response.text().catch(() => '')
    throw new MusicLibraryError(response.status, text.slice(0, 300) || response.statusText)
  }
  if (response.status === 204) return undefined as T
  try {
    return await response.json() as T
  } catch (error) {
    throw new MusicLibraryError(response.status, `The library answer could not be read: ${describe(error)}`)
  }
}

function requestBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}

function patchBody(body: unknown): RequestInit {
  return { method: 'PATCH', body: JSON.stringify(body) }
}

function itemsOf<T>(answer: ItemsAnswer<T> | undefined): T[] | null {
  return answer && Array.isArray(answer.items) ? answer.items : null
}

/** The planned routes differ on whether a row comes back bare or wrapped; accept either. */
function unwrapPlaylist(answer: MusicPlaylist | PlaylistAnswer): MusicPlaylist | null {
  const wrapped = (answer as PlaylistAnswer).playlist
  if (wrapped && typeof wrapped.id === 'string') return wrapped
  const direct = answer as MusicPlaylist
  return typeof direct.id === 'string' ? direct : null
}

function unwrapDownload(answer: MusicDownload | DownloadAnswer): MusicDownload | null {
  const wrapped = (answer as DownloadAnswer).download
  if (wrapped && typeof wrapped.id === 'string') return wrapped
  const direct = answer as MusicDownload
  return typeof direct.id === 'string' ? direct : null
}

function recentId(input: MusicRecentInput): string {
  return `${input.kind}:${input.providerId}`
}

function touchedRecent(list: readonly MusicRecentEntry[], input: MusicRecentInput, at: number): MusicRecentEntry[] {
  const id = recentId(input)
  const existing = list.find((entry) => entry.id === id)
  const entry: MusicRecentEntry = {
    id,
    kind: input.kind,
    providerId: input.providerId,
    name: input.name,
    coverUrl: input.coverUrl,
    lastPlayedAt: at,
    playCount: (existing?.playCount ?? 0) + 1,
  }
  return [entry, ...list.filter((one) => one.id !== id)].slice(0, MUSIC_LIMITS.recentEntries)
}

function downloadStatus(action: 'pause' | 'resume' | 'retry' | 'cancel'): MusicDownload['status'] {
  if (action === 'pause') return 'paused'
  if (action === 'cancel') return 'canceled'
  if (action === 'retry') return 'queued'
  return 'running'
}

export interface MusicLibraryState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  errorDetail: string | null
  favorites: MusicTrack[]
  history: MusicHistoryItem[]
  recent: MusicRecentEntry[]
  playlists: MusicPlaylist[]
  downloads: MusicDownloadItem[]
  uploads: MusicUpload[]
  loadedAt: number
  load: () => Promise<void>
  reset: () => void
  isFavorite: (trackId: string) => boolean
  toggleFavorite: (track: MusicTrack) => Promise<boolean>
  recordHistory: (input: MusicHistoryInput) => Promise<void>
  touchRecent: (input: MusicRecentInput) => Promise<void>
  createPlaylist: (input: MusicLibraryPlaylistInput) => Promise<MusicPlaylist | null>
  updatePlaylist: (id: string, patch: { name?: string; description?: string }) => Promise<void>
  deletePlaylist: (id: string) => Promise<void>
  addPlaylistTracks: (id: string, tracks: readonly MusicTrack[]) => Promise<void>
  removePlaylistTrack: (id: string, trackId: string) => Promise<void>
  requestDownload: (
    track: MusicTrack,
    quality: MusicSettings['downloadQuality'],
    format: MusicSettings['downloadFormat'],
  ) => Promise<void>
  controlDownload: (id: string, action: 'pause' | 'resume' | 'retry' | 'cancel') => Promise<void>
  upsertDownload: (download: MusicDownload) => void
  upsertUpload: (upload: MusicUpload) => void
  removeUpload: (id: string) => void
}

const lastHistoryWrite = new Map<string, number>()

export const useMusicLibrary = create<MusicLibraryState>((set, get) => ({
  status: 'idle',
  error: null,
  errorDetail: null,
  favorites: [],
  history: [],
  recent: [],
  playlists: [],
  downloads: [],
  uploads: [],
  loadedAt: 0,

  async load() {
    set({ status: 'loading', error: null, errorDetail: null })
    try {
      const [favorites, history, recent, playlists, downloads, uploads] = await Promise.all([
        musicRequest<ItemsAnswer<MusicTrack>>(ENDPOINTS.favorites),
        musicRequest<ItemsAnswer<MusicHistoryItem>>(ENDPOINTS.history),
        musicRequest<ItemsAnswer<MusicRecentEntry>>(ENDPOINTS.recent),
        musicRequest<ItemsAnswer<MusicPlaylist>>(ENDPOINTS.playlists),
        musicRequest<MusicDownloadListPayload>(ENDPOINTS.downloads),
        musicRequest<ItemsAnswer<MusicUpload>>(ENDPOINTS.uploads),
      ])
      set({
        status: 'ready',
        error: null,
        errorDetail: null,
        favorites: itemsOf(favorites) ?? [],
        history: itemsOf(history) ?? [],
        recent: itemsOf(recent) ?? [],
        playlists: itemsOf(playlists) ?? [],
        downloads: Array.isArray(downloads.items) ? downloads.items : [],
        uploads: itemsOf(uploads) ?? [],
        loadedAt: Date.now(),
      })
    } catch (error) {
      set({
        status: 'error',
        error: MUSIC_LIBRARY_ERROR_KEYS.load,
        errorDetail: describe(error),
      })
    }
  },

  reset() {
    lastHistoryWrite.clear()
    set({
      status: 'idle',
      error: null,
      errorDetail: null,
      favorites: [],
      history: [],
      recent: [],
      playlists: [],
      downloads: [],
      uploads: [],
      loadedAt: 0,
    })
  },

  isFavorite(trackId) {
    return get().favorites.some((track) => track.id === trackId)
  },

  async toggleFavorite(track) {
    const before = get().favorites
    const exists = before.some((entry) => entry.id === track.id)
    const optimistic = exists ? before.filter((entry) => entry.id !== track.id) : [track, ...before]
    set({ favorites: optimistic, error: null, errorDetail: null })
    try {
      if (exists) {
        await musicRequest<{ ok: true }>(
          `${ENDPOINTS.favorites}/${encodeURIComponent(track.id)}`,
          { method: 'DELETE' },
        )
        set({ favorites: get().favorites.filter((entry) => entry.id !== track.id) })
      } else {
        await musicRequest<{ ok: true }>(ENDPOINTS.favorites, requestBody({ track }))
        // The write answers with `ok`, not the row; the local copy is the same track the server
        // stored, so the optimistic list is what stays.
        set({ favorites: [
          track,
          ...get().favorites.filter((entry) => entry.id !== track.id),
        ] })
      }
      return !exists
    } catch (error) {
      set({
        favorites: before,
        error: MUSIC_LIBRARY_ERROR_KEYS.favorite,
        errorDetail: describe(error),
      })
      return exists
    }
  },

  async recordHistory(input) {
    const now = Date.now()
    const previous = lastHistoryWrite.get(input.track.id) ?? 0
    if (now - previous < HISTORY_WRITE_WINDOW_MS) return
    lastHistoryWrite.set(input.track.id, now)
    try {
      // Provider tracks carry the upstream id in `id`; the server upserts the snapshot and answers
      // with the library row, which is the id its history foreign key can actually point at.
      const answer = await musicRequest<{ ok: true; entry: MusicHistoryEntry }>(ENDPOINTS.history, requestBody({
        track: input.track,
        playedAt: now,
        durationPlayed: input.durationPlayed ?? 0,
        completed: input.completed ?? false,
        contextType: input.contextType ?? '',
        contextId: input.contextId ?? '',
      }))
      const entry: MusicHistoryItem = { ...answer.entry, track: input.track }
      set({ history: [entry, ...get().history].slice(0, MUSIC_LIMITS.historyEntries) })
    } catch (error) {
      // The window is cleared so the next real play can try again rather than being dropped as a
      // duplicate of a write that never happened.
      lastHistoryWrite.delete(input.track.id)
      set({ error: MUSIC_LIBRARY_ERROR_KEYS.history, errorDetail: describe(error) })
    }
  },

  async touchRecent(input) {
    const before = get().recent
    const at = Date.now()
    set({ recent: touchedRecent(before, input, at), error: null, errorDetail: null })
    try {
      await musicRequest<{ ok: true }>(ENDPOINTS.recent, requestBody({
        kind: input.kind,
        providerId: input.providerId,
        name: input.name,
        coverUrl: input.coverUrl,
      }))
    } catch (error) {
      set({
        recent: before,
        error: MUSIC_LIBRARY_ERROR_KEYS.recent,
        errorDetail: describe(error),
      })
    }
  },

  async createPlaylist(input) {
    try {
      const answer = await musicRequest<PlaylistAnswer | MusicPlaylist>(ENDPOINTS.playlists, requestBody({
        name: input.name,
        description: input.description ?? '',
      }))
      const playlist = unwrapPlaylist(answer)
      if (!playlist) throw new MusicLibraryError(200, 'The created playlist was not returned')
      set({ playlists: [...get().playlists, playlist], error: null, errorDetail: null })
      return playlist
    } catch (error) {
      set({ error: MUSIC_LIBRARY_ERROR_KEYS.playlist, errorDetail: describe(error) })
      return null
    }
  },

  async updatePlaylist(id, patch) {
    const before = get().playlists
    const optimistic = before.map((playlist) => (
      playlist.id === id ? { ...playlist, ...patch, updatedAt: Date.now() } : playlist
    ))
    set({ playlists: optimistic, error: null, errorDetail: null })
    try {
      const answer = await musicRequest<PlaylistAnswer | MusicPlaylist>(
        `${ENDPOINTS.playlists}/${encodeURIComponent(id)}`,
        patchBody(patch),
      )
      const playlist = unwrapPlaylist(answer)
      if (playlist) {
        set({ playlists: get().playlists.map((entry) => (entry.id === id ? playlist : entry)) })
      }
    } catch (error) {
      set({ playlists: before, error: MUSIC_LIBRARY_ERROR_KEYS.playlist, errorDetail: describe(error) })
    }
  },

  async deletePlaylist(id) {
    const before = get().playlists
    set({ playlists: before.filter((playlist) => playlist.id !== id), error: null, errorDetail: null })
    try {
      await musicRequest<{ ok: true }>(
        `${ENDPOINTS.playlists}/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      )
    } catch (error) {
      set({ playlists: before, error: MUSIC_LIBRARY_ERROR_KEYS.playlist, errorDetail: describe(error) })
    }
  },

  async addPlaylistTracks(id, tracks) {
    if (tracks.length === 0) return
    const before = get().playlists
    const ids = new Set(tracks.map((track) => track.id))
    set({
      playlists: before.map((playlist) => (
        playlist.id === id
          ? { ...playlist, trackCount: playlist.trackCount + ids.size }
          : playlist
      )),
      error: null,
      errorDetail: null,
    })
    try {
      const answer = await musicRequest<PlaylistItemsAnswer>(
        `${ENDPOINTS.playlists}/${encodeURIComponent(id)}/items`,
        requestBody({ tracks }),
      )
      const items = itemsOf(answer)
      if (items) {
        set({
          playlists: get().playlists.map((playlist) => (
            playlist.id === id ? { ...playlist, trackCount: items.length } : playlist
          )),
        })
      }
    } catch (error) {
      set({ playlists: before, error: MUSIC_LIBRARY_ERROR_KEYS.playlist, errorDetail: describe(error) })
    }
  },

  async removePlaylistTrack(id, trackId) {
    const before = get().playlists
    set({
      playlists: before.map((playlist) => (
        playlist.id === id
          ? { ...playlist, trackCount: Math.max(0, playlist.trackCount - 1) }
          : playlist
      )),
      error: null,
      errorDetail: null,
    })
    try {
      await musicRequest<{ ok: true }>(
        `${ENDPOINTS.playlists}/${encodeURIComponent(id)}/items/${encodeURIComponent(trackId)}`,
        { method: 'DELETE' },
      )
    } catch (error) {
      set({ playlists: before, error: MUSIC_LIBRARY_ERROR_KEYS.playlist, errorDetail: describe(error) })
    }
  },

  async requestDownload(track, quality, format) {
    try {
      const answer = await musicRequest<DownloadAnswer | MusicDownload>(ENDPOINTS.downloads, requestBody({
        track,
        quality,
        format,
      }))
      const download = unwrapDownload(answer)
      if (!download) throw new MusicLibraryError(200, 'The download was not returned')
      set({
        downloads: [{ ...download, track }, ...get().downloads.filter((entry) => entry.id !== download.id)],
        error: null,
        errorDetail: null,
      })
    } catch (error) {
      set({ error: MUSIC_LIBRARY_ERROR_KEYS.download, errorDetail: describe(error) })
    }
  },

  async controlDownload(id, action) {
    const before = get().downloads
    const optimistic = before.map((entry) => (
      entry.id === id ? { ...entry, status: downloadStatus(action) } : entry
    ))
    set({ downloads: optimistic, error: null, errorDetail: null })
    try {
      const answer = await musicRequest<DownloadAnswer | MusicDownload>(
        `${ENDPOINTS.downloads}/${encodeURIComponent(id)}`,
        patchBody({ action }),
      )
      const download = unwrapDownload(answer)
      if (download) {
        set({
          downloads: get().downloads.map((entry) => (
            entry.id === id ? { ...download, track: entry.track } : entry
          )),
        })
      }
    } catch (error) {
      set({ downloads: before, error: MUSIC_LIBRARY_ERROR_KEYS.download, errorDetail: describe(error) })
    }
  },

  upsertDownload(download) {
    const existing = get().downloads.find((entry) => entry.id === download.id)
    set({
      downloads: [
        { ...download, track: existing?.track ?? null },
        ...get().downloads.filter((entry) => entry.id !== download.id),
      ],
    })
  },

  upsertUpload(upload) {
    const before = get().uploads
    const exists = before.some((entry) => entry.id === upload.id)
    set({ uploads: exists ? before.map((entry) => (entry.id === upload.id ? upload : entry)) : [upload, ...before] })
  },

  removeUpload(id) {
    set({ uploads: get().uploads.filter((entry) => entry.id !== id) })
  },
}))
