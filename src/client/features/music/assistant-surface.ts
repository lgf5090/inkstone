/**
 * What the music assistant is told about the screen it is docked beside.
 *
 * This is a pointer, not a payload: the current track's identity and the page kind are enough for
 * "pause this" or "what album is this"; lyrics and credentials stay out. The dock re-attaches the
 * context when the page or track changes, and the reader can remove the chip.
 */
import type { MusicAssistantContext, MusicAssistantPage } from '@shared/music/assistant-context'
import { selectCurrentTrack, useMusicPlayer } from './store/player'
import type { MusicPage } from './music-address'

const PAGE_KIND: Record<MusicPage['kind'], MusicAssistantPage> = {
  home: 'home',
  search: 'search',
  playlist: 'playlist',
  album: 'album',
  albums: 'albums',
  playlists: 'playlists',
  toplists: 'toplists',
  artist: 'artist',
  toplist: 'toplist',
  mv: 'mv',
  mvDetail: 'mvDetail',
  podcast: 'podcast',
  podcastDetail: 'podcastDetail',
  favorites: 'favorites',
  history: 'history',
  heatmap: 'heatmap',
  uploads: 'uploads',
  downloads: 'downloads',
  cloud: 'cloud',
  local: 'local',
  me: 'user',
  user: 'user',
  login: 'login',
  settings: 'settings',
  notFound: 'notFound',
}

export function useMusicAssistantContext(page: MusicPage): MusicAssistantContext {
  const current = useMusicPlayer(selectCurrentTrack)
  const queueLength = useMusicPlayer((state) => state.queue.tracks.length)
  return {
    page: PAGE_KIND[page.kind],
    ...(current
      ? {
          trackRef: current.id,
          trackTitle: current.title,
          artists: current.artists.map((artist) => artist.name).filter(Boolean),
        }
      : {}),
    ...(page.kind === 'playlist' ? { playlistId: page.id } : {}),
    queueLength,
  }
}
