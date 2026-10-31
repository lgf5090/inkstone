/**
 * The blog's music card.
 *
 * Playback is the music app's own queue store and audio engine; this file only turns the blog's public
 * track list into that model, points the stream resolver at the published URLs, and draws the small
 * transport the sidebar has room for.
 */
import './music.css'
import '../client/features/music/music.css'
import { useEffect, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { formatDuration, musicArtistNames } from '@shared/music/format'
import type { MusicTrack } from '@shared/music/model'
import type { BlogMusicConfig, BlogMusicTrack } from '@shared/blog/model'
import { BLOG_RENDERER_VERSION } from '@shared/blog/renderer'
import { useMusicPlayer, selectCurrentTrack } from '../client/features/music/store/player'
import { setMusicLibraryIntegration, setMusicSourceOverrides } from '../client/features/music/player/source-overrides'
import { FloatingMusicPlayer } from '../client/features/music/components/FloatingMusicPlayer'
import { useMusicSettings } from '../client/features/music/store/settings'
import { useMusicLibrary } from '../client/features/music/store/library'
import { initI18nForReading } from '../client/lib/i18n'

export interface BlogMusicLabels {
  title: string
  play: string
  pause: string
  previous: string
  next: string
  mode: string
  modeSequence: string
  modeRepeatOne: string
  modeShuffle: string
  progress: string
  volume: string
  mute: string
  unmute: string
  playlist: string
  empty: string
  loading: string
  error: string
  nowPlaying: string
}

export interface BlogMusicMountOptions {
  container: HTMLElement
  music: BlogMusicConfig
  labels: BlogMusicLabels
  locale?: string
}

export interface BlogMusicHandle {
  unmount: () => void
}

interface MetingSong {
  id?: number | string
  name?: string
  title?: string
  artist?: string
  author?: string
  duration?: number | string
  pic?: string
  url?: string
}

const DEFAULT_METING_API = 'https://api.injahow.cn/meting/?server=:server&type=:type&id=:id&r=:r'
let initialized = false
let metingLoadedFor = ''

function metingUrl(music: BlogMusicConfig): string | null {
  const meting = music.meting
  if (!meting?.id) return null
  const template = meting.api?.trim() || DEFAULT_METING_API
  return template
    .replace(':server', encodeURIComponent(meting.server))
    .replace(':type', encodeURIComponent(meting.type))
    .replace(':id', encodeURIComponent(meting.id))
    .replace(':auth', '')
    .replace(':r', String(Date.now()))
}

async function fetchMeting(music: BlogMusicConfig): Promise<BlogMusicTrack[]> {
  const url = metingUrl(music)
  if (!url) return []
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`Meting HTTP ${response.status}`)
  const rows = await response.json() as MetingSong[]
  if (!Array.isArray(rows)) return []
  const server = music.meting?.server ?? 'netease'
  return rows.flatMap((row, index) => {
    const title = (row.name ?? row.title ?? '').trim()
    const source = (row.url ?? '').trim()
    if (!title || !source || !(/^https?:\/\//i.test(source) || source.startsWith('/'))) return []
    let duration: number | undefined
    const raw = typeof row.duration === 'number' ? row.duration : Number.parseInt(String(row.duration ?? ''), 10)
    if (Number.isFinite(raw) && raw > 0) duration = raw > 10000 ? Math.floor(raw / 1000) : Math.floor(raw)
    return [{
      id: `meting-${server}-${row.id ?? index}`,
      title,
      ...(row.artist || row.author ? { artist: (row.artist ?? row.author)!.trim() } : {}),
      source,
      ...(row.pic && (/^https?:\/\//i.test(row.pic) || row.pic.startsWith('/')) ? { cover: row.pic } : {}),
      ...(duration ? { duration } : {}),
    }]
  })
}

function toMusicTrack(track: BlogMusicTrack): MusicTrack {
  return {
    id: `blog:${track.id}`,
    provider: 'custom',
    providerId: track.id,
    kind: 'podcast',
    title: track.title,
    artists: track.artist ? [{ id: `blog:${track.id}:artist`, name: track.artist }] : [],
    album: '',
    albumId: '',
    coverUrl: track.cover ?? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    coverKey: '',
    durationMs: (track.duration ?? 0) * 1000,
    format: '',
    bitrate: null,
    size: null,
    sha256: '',
    r2Key: null,
    source: 'blog',
    sourceQuality: '',
    createdAt: 0,
    updatedAt: Date.now(),
  }
}

function playMode(mode: BlogMusicConfig['defaultMode']): 'order' | 'repeatOne' | 'shuffle' {
  return mode === 'repeat-one' ? 'repeatOne' : mode === 'shuffle' ? 'shuffle' : 'order'
}

function formatClock(ms: number): string {
  return formatDuration(Number.isFinite(ms) && ms > 0 ? ms : 0)
}

function MusicCard({ music, labels }: { music: BlogMusicConfig; labels: BlogMusicLabels }) {
  const tracks = useMemo(() => music.tracks.map(toMusicTrack), [music])
  const sources = useMemo(() => Object.fromEntries(tracks.map((track, index) => [track.id, music.tracks[index]!.source])), [tracks, music.tracks])
  const [ready, setReady] = useState(false)
  const [metingError, setMetingError] = useState('')
  const [playlistOpen, setPlaylistOpen] = useState(false)
  const current = useMusicPlayer(selectCurrentTrack)
  const queue = useMusicPlayer((state) => state.queue)
  const status = useMusicPlayer((state) => state.status)
  const positionMs = useMusicPlayer((state) => state.positionMs)
  const durationMs = useMusicPlayer((state) => state.durationMs)
  const volume = useMusicPlayer((state) => state.volume)
  const muted = useMusicPlayer((state) => state.muted)
  const playing = status === 'playing'
  const mode = queue.mode

  useEffect(() => {
    setMusicSourceOverrides(sources)
    setMusicLibraryIntegration(false)
    if (!initialized) {
      const player = useMusicPlayer.getState()
      player.setVolume(music.defaultVolume)
      player.setMuted(false)
      player.setMode(playMode(music.defaultMode))
      player.setQueue(tracks, { autoplay: false, mode: playMode(music.defaultMode) })
      initialized = true
    }
    setReady(true)
    const metingKey = `${music.provider}:${music.meting?.server ?? ''}:${music.meting?.type ?? ''}:${music.meting?.id ?? ''}:${music.meting?.api ?? ''}`
    if ((music.provider === 'meting' || music.provider === 'mixed') && metingLoadedFor !== metingKey) {
      metingLoadedFor = metingKey
      void fetchMeting(music).then((remote) => {
        if (remote.length === 0) return
        const merged = [...music.tracks, ...remote].map(toMusicTrack)
        const mergedSources = { ...sources, ...Object.fromEntries(merged.map((track, index) => [track.id, (index < music.tracks.length ? music.tracks[index] : remote[index - music.tracks.length])!.source])) }
        setMusicSourceOverrides(mergedSources)
        useMusicPlayer.getState().setQueue(merged, { autoplay: false, mode: playMode(music.defaultMode) })
      }).catch((error) => {
        metingLoadedFor = ''
        setMetingError(error instanceof Error ? error.message : String(error))
      })
    }
    // Navigation replaces the card but must not stop the station; the engine and queue outlive it.
  }, [music, sources, tracks])

  const start = () => {
    if (!current) return
    void useMusicPlayer.getState().toggle()
  }

  const choose = (track: MusicTrack) => {
    void useMusicPlayer.getState().playTrack(track, { queue: queue.tracks, sourceUrl: sources[track.id] }).then(() => {
      if (useMusicPlayer.getState().status !== 'playing') void useMusicPlayer.getState().toggle()
    })
  }

  const step = (direction: 'prev' | 'next') => {
    const state = useMusicPlayer.getState()
    const action = direction === 'prev' ? state.prev : state.next
    void action.call(state).then(() => {
      if (useMusicPlayer.getState().status !== 'playing') void useMusicPlayer.getState().toggle()
    })
  }

  const cycleMode = () => {
    useMusicPlayer.getState().setMode(mode === 'order' ? 'repeatOne' : mode === 'repeatOne' ? 'shuffle' : 'order')
  }

  const modeLabel = mode === 'repeatOne' ? labels.modeRepeatOne : mode === 'shuffle' ? labels.modeShuffle : labels.modeSequence
  const total = durationMs || current?.durationMs || 0
  const progress = total > 0 ? Math.min(total, Math.max(0, positionMs)) : 0

  return (
    <div className="blog-music">
      <div className="blog-music__track">
        <span className="blog-music__cover" aria-hidden="true">
          {current?.coverUrl ? <img src={current.coverUrl} alt="" loading="lazy" /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>}
        </span>
        <span className="blog-music__meta">
          <strong>{current?.title ?? labels.empty}</strong>
          <span>{current ? `${musicArtistNames(current)} · ${formatClock(total)}` : labels.nowPlaying}</span>
        </span>
      </div>

      <div className="blog-music__controls">
        <button type="button" className="blog-music__button" aria-label={labels.previous} title={labels.previous} onClick={() => step('prev')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14l-10-7z" /></svg>
        </button>
        <button type="button" className="blog-music__button blog-music__button--primary" aria-label={playing ? labels.pause : labels.play} title={playing ? labels.pause : labels.play} onClick={start} disabled={!ready || !current}>
          {playing ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>}
        </button>
        <button type="button" className="blog-music__button" aria-label={labels.next} title={labels.next} onClick={() => step('next')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l10-7z" /></svg>
        </button>
        <button type="button" className="blog-music__button" aria-label={labels.mode} title={`${labels.mode}: ${modeLabel}`} onClick={cycleMode} aria-pressed={mode !== 'order'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m17 2 4 4-4 4" /><path d="M3 7h14a4 4 0 0 1 4 4" /><path d="m7 22-4-4 4-4" /><path d="M21 17H7a4 4 0 0 1-4-4" /></svg>
        </button>
        <button type="button" className="blog-music__button" aria-label={labels.playlist} title={labels.playlist} aria-expanded={playlistOpen} onClick={() => setPlaylistOpen((open) => !open)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></svg>
        </button>
      </div>

      <div className="blog-music__row">
        <input className="blog-music__range" type="range" min={0} max={total || 1} step={250} value={progress} aria-label={labels.progress} onChange={(event) => useMusicPlayer.getState().seek(Number(event.target.value))} />
        <span className="blog-music__time">{formatClock(progress)}</span>
      </div>

      <div className="blog-music__row">
        <button type="button" className="blog-music__button" aria-label={muted ? labels.unmute : labels.mute} title={muted ? labels.unmute : labels.mute} onClick={() => useMusicPlayer.getState().toggleMute()}>
          {muted ? <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9zM16 9l5 6M21 9l-5 6" stroke="currentColor" strokeWidth="1.8" /></svg> : <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9zM16 8a5 5 0 0 1 0 8" stroke="currentColor" strokeWidth="1.8" fill="none" /></svg>}
        </button>
        <input className="blog-music__range" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label={labels.volume} onChange={(event) => useMusicPlayer.getState().setVolume(Number(event.target.value))} />
      </div>

      {!ready && <p className="blog-music__status" role="status">{labels.loading}</p>}
      {metingError && <p className="blog-music__status blog-music__error" role="status">{labels.error}</p>}
      {status === 'error' && <p className="blog-music__status blog-music__error" role="status">{labels.error}</p>}
      <span className="sr-only" aria-live="polite">{current ? `${labels.nowPlaying}: ${current.title}` : ''}</span>

      {playlistOpen && (
        <ol className="blog-music__playlist" aria-label={labels.playlist}>
          {queue.tracks.map((track) => (
            <li key={track.id}>
              <button type="button" aria-current={current?.id === track.id} onClick={() => choose(track)}>
                {track.title}{track.artists.length ? ` — ${musicArtistNames(track)}` : ''}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

async function mount(options: BlogMusicMountOptions): Promise<BlogMusicHandle> {
  const root: Root = createRoot(options.container)
  root.render(createElement(MusicCard, { music: options.music, labels: options.labels }))
  return { unmount: () => root.unmount() }
}

async function mountFloating(options: BlogMusicMountOptions): Promise<BlogMusicHandle> {
  await initI18nForReading(options.locale?.startsWith('zh') ? 'zh-CN' : 'en-US')
  const tracks = options.music.tracks.map(toMusicTrack)
  const sources = Object.fromEntries(tracks.map((track, index) => [track.id, options.music.tracks[index]!.source]))
  setMusicSourceOverrides(sources)
  setMusicLibraryIntegration(false)
  useMusicSettings.setState({ serverStatus: 'error' })
  useMusicLibrary.setState({ status: 'ready' })
  if (!initialized) {
    const player = useMusicPlayer.getState()
    player.setVolume(options.music.defaultVolume)
    player.setMuted(false)
    player.setMode(playMode(options.music.defaultMode))
    player.setQueue(tracks, { autoplay: false, mode: playMode(options.music.defaultMode) })
    initialized = true
    const metingKey = `${options.music.provider}:${options.music.meting?.server ?? ''}:${options.music.meting?.type ?? ''}:${options.music.meting?.id ?? ''}:${options.music.meting?.api ?? ''}`
    if ((options.music.provider === 'meting' || options.music.provider === 'mixed') && metingLoadedFor !== metingKey) {
      metingLoadedFor = metingKey
      void fetchMeting(options.music).then((remote) => {
        if (remote.length === 0) return
        const merged = [...options.music.tracks, ...remote].map(toMusicTrack)
        const mergedSources = { ...sources, ...Object.fromEntries(merged.map((track, index) => [track.id, (index < options.music.tracks.length ? options.music.tracks[index] : remote[index - options.music.tracks.length])!.source])) }
        setMusicSourceOverrides(mergedSources)
        useMusicPlayer.getState().setQueue(merged, { autoplay: false, mode: playMode(options.music.defaultMode) })
      }).catch((error) => {
        metingLoadedFor = ''
        console.warn('[blog] meting load failed', error)
      })
    }
  }
  const host = document.createElement('div')
  host.dataset.blogFloatingMusic = ''
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  root.render(createElement(FloatingMusicPlayer))
  return {
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

;(globalThis as typeof globalThis & {
  InkstoneBlogMusic?: { version: string; mount: (options: BlogMusicMountOptions) => Promise<BlogMusicHandle>; mountFloating: (options: BlogMusicMountOptions) => Promise<BlogMusicHandle> }
}).InkstoneBlogMusic = { version: BLOG_RENDERER_VERSION, mount, mountFloating }
