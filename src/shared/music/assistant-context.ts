/**
 * What the assistant may know about the music screen the reader is looking at.
 *
 * The dock sits beside the music app the same way it sits beside mail: the page and the thing under
 * the reader's eyes make "play this" or "what is this album" answerable without them naming it. Every
 * string is bounded here because the value crosses the wire from a page to a prompt, and the cap is
 * part of the contract rather than something the worker has to remember to apply.
 *
 * The context is a pointer, not a payload: no lyrics, no credentials and no hidden default target for
 * a write. Tools that change something still take an explicit trackRef or id.
 */

/** The screens a music turn may say it was asked beside. */
export const MUSIC_ASSISTANT_PAGES = [
  'home',
  'search',
  'library',
  'playlist',
  'album',
  'artist',
  'toplists',
  'playlists',
  'albums',
  'toplist',
  'mv',
  'mvDetail',
  'podcast',
  'podcastDetail',
  'favorites',
  'history',
  'uploads',
  'downloads',
  'cloud',
  'local',
  'settings',
  'user',
  'login',
  'notFound',
] as const

export type MusicAssistantPage = (typeof MUSIC_ASSISTANT_PAGES)[number]

/** The drives a cloud screen can name. A mount id is meaningful only beside its source. */
export const MUSIC_ASSISTANT_CLOUD_SOURCES = ['r2', 'webdav', 'alist'] as const
export type MusicAssistantCloudSource = (typeof MUSIC_ASSISTANT_CLOUD_SOURCES)[number]

export const MAX_MUSIC_CONTEXT_TRACK_REF = 200
export const MAX_MUSIC_CONTEXT_TRACK_TITLE = 300
export const MAX_MUSIC_CONTEXT_ARTISTS = 10
export const MAX_MUSIC_CONTEXT_ARTIST = 120
export const MAX_MUSIC_CONTEXT_PLAYLIST_ID = 64
export const MAX_MUSIC_CONTEXT_MOUNT_ID = 64
export const MAX_MUSIC_CONTEXT_CLOUD_PATH = 1_024
/** A queue longer than this is not a queue number worth carrying; it is a runaway counter. */
export const MAX_MUSIC_CONTEXT_QUEUE_LENGTH = 100_000

export interface MusicAssistantContext {
  page: MusicAssistantPage
  /** "netease:123" or an internal track id. */
  trackRef?: string
  trackTitle?: string
  artists?: string[]
  playlistId?: string
  cloudSource?: MusicAssistantCloudSource
  mountId?: string
  /** Shown to the model as a location; a tool still takes the path it acts on explicitly. */
  cloudPath?: string
  queueLength?: number
}
