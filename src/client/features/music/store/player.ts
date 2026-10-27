/**
 * The player: queue, transport state and the bridge to the one audio element.
 *
 * The store never touches an `<audio>` node directly. It asks `musicAudioEngine` to load, pause, seek
 * and change volume, and listens to the engine's events for what actually happened. That split is
 * what lets the whole transport be tested without sound, and what keeps a StrictMode remount from
 * creating a second element.
 *
 * Queue arithmetic lives in `player/queue.ts`; this file only applies its answers and sequences the
 * effects (load, persist, media session).
 */
import { create } from 'zustand'
import { musicArtistNames } from '@shared/music/format'
import type { MusicPlayMode, MusicTrack } from '@shared/music/model'
import { IS_DEMO_MODE } from '../../../lib/runtime'
import { musicApi } from '../api'
import {
  MAX_CONSECUTIVE_FAILURES,
  RESTART_THRESHOLD_MS,
  addNextTrack,
  appendTrack,
  createQueue,
  currentTrack,
  emptyQueue,
  failureLimitReached,
  nextInQueue,
  previousInQueue,
  removeTrackFromQueue,
  restoreQueue,
  setQueueMode,
  type MusicQueue,
  type QueueReason,
} from '../player/queue'
import {
  MusicPlaybackError,
  isAudioUnavailableError,
  isAutoplayBlockedError,
  musicAudioEngine,
  type MusicEngineFailure,
} from '../player/engine'
import {
  bindMediaSessionHandlers,
  updateMediaSessionMetadata,
  updateMediaSessionPlaybackState,
  updateMediaSessionPosition,
} from '../player/media-session'
import { MUSIC_RATE_RANGE, MUSIC_VOLUME_RANGE, useMusicSettings } from './settings'
import { useMusicLibrary } from './library'

const STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.music.player' : 'inkstone.music.player'

/**
 * A queue longer than this is not written to localStorage. A 5,000-track playlist would approach the
 * origin's quota, and a queue that fails to persist is better than a write that evicts other state.
 */
const MAX_PERSISTED_QUEUE_TRACKS = 500

export type MusicPlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export const MUSIC_PLAYER_ERROR_KEYS = {
  playback: 'music.player.error.playback',
  autoplay: 'music.player.error.autoplay',
  unsupported: 'music.player.error.unsupported',
} as const

export interface MusicPlaybackErrorState {
  key: string
  detail: string | null
}

export interface SetQueueOptions {
  startIndex?: number
  startTrackId?: string
  mode?: MusicPlayMode
  autoplay?: boolean
  /** Where the first track starts, in milliseconds. */
  startAtMs?: number
}

export interface PlayTrackOptions {
  /** The list the track was picked from. Passing it replaces the queue with that context. */
  queue?: readonly MusicTrack[]
  /** A URL the caller already resolved. Omitted means the server's streaming route. */
  sourceUrl?: string
}

/** `ended` is the engine's natural finish; `user` is a press; `failure` is a load that gave up. */
export type MusicNextReason = 'user' | 'ended' | 'failure'

export interface MusicPlayerState {
  queue: MusicQueue
  status: MusicPlaybackStatus
  positionMs: number
  durationMs: number
  volume: number
  muted: boolean
  rate: number
  /** An i18n key, or null. The detail below is for logs and is never rendered as copy. */
  error: string | null
  errorDetail: string | null
  consecutiveFailures: number
  /** A restored queue waits for a press: autoplay policy is not a failure to hide. */
  awaitingGesture: boolean
  /** The provider only offered a trial clip for the current track. */
  preview: boolean
  /** The level the stream actually served, for the quality badge. */
  streamQuality: string
  /** ReplayGain in dB and the track's peak; 0 when the provider did not measure them. */
  streamGain: number
  streamPeak: number
  /** How much of the current stream the element has buffered, 0..1. */
  bufferedFraction: number
  /** The URL the current track is (or would be) loaded from. */
  sourceUrl: string
  setQueue: (tracks: readonly MusicTrack[], options?: SetQueueOptions) => MusicTrack | null
  playTrack: (track: MusicTrack, options?: PlayTrackOptions) => Promise<boolean>
  next: (reason?: MusicNextReason) => Promise<boolean>
  prev: () => Promise<boolean>
  toggle: () => Promise<boolean>
  pause: () => void
  seek: (positionMs: number) => void
  setMode: (mode: MusicPlayMode) => void
  setVolume: (volume: number) => void
  setMuted: (muted: boolean) => void
  toggleMute: () => void
  setRate: (rate: number) => void
  removeFromQueue: (trackId: string) => Promise<boolean>
  /** Replace a queue row after its snapshot changed, such as when an imported file's tags were read. */
  updateTrackSnapshot: (track: MusicTrack) => void
  addNext: (track: MusicTrack) => void
  appendToQueue: (track: MusicTrack) => void
  restore: () => boolean
}

export function selectCurrentTrack(state: Pick<MusicPlayerState, 'queue'>): MusicTrack | null {
  return currentTrack(state.queue)
}

function streamUrlFor(track: MusicTrack): string {
  return `/api/music/media/stream/${encodeURIComponent(track.id)}`
}

function coverUrlFor(track: MusicTrack): string {
  return `/api/music/media/cover/${encodeURIComponent(track.id)}`
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** NetEase brings normalised tracks to the quiet ReplayGain level; lift them before the peak guard. */
export const NORMALIZATION_PREAMP_DB = 4

/** The linear gain that brings a measured track as loud as others without clipping its peak. */
export function normalizationGainFrom(gainDb: number, peak: number): number {
  if (!Number.isFinite(gainDb) || (!gainDb && (!Number.isFinite(peak) || peak <= 0))) return 1
  let gain = Math.pow(10, (gainDb + NORMALIZATION_PREAMP_DB) / 20)
  if (Number.isFinite(peak) && peak > 0) gain = Math.min(gain, 1 / peak)
  return Math.max(0.1, Math.min(4, gain))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function playbackErrorKey(error: unknown): string {
  if (isAutoplayBlockedError(error)) return MUSIC_PLAYER_ERROR_KEYS.autoplay
  if (isAudioUnavailableError(error)) return MUSIC_PLAYER_ERROR_KEYS.unsupported
  return MUSIC_PLAYER_ERROR_KEYS.playback
}

interface PersistedPlayer {
  version: 1
  queue: MusicQueue
  positionMs: number
}

function persistPlayer(queue: MusicQueue, positionMs: number): void {
  if (typeof localStorage === 'undefined') return
  if (queue.tracks.length > MAX_PERSISTED_QUEUE_TRACKS) return
  const snapshot: PersistedPlayer = { version: 1, queue, positionMs }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Private mode or a full origin quota. Playback continues; the next launch simply starts with
    // an empty queue instead of the one this session had.
  }
}

function readPlayerSnapshot(): PersistedPlayer | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedPlayer>
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed.queue as MusicQueue | undefined)?.tracks)) {
      return null
    }
    return {
      version: 1,
      queue: parsed.queue as MusicQueue,
      positionMs: typeof parsed.positionMs === 'number' ? parsed.positionMs : 0,
    }
  } catch {
    // A half-written record is discarded; restore falls back to the saved preferences.
    return null
  }
}

function mediaPlaybackState(status: MusicPlaybackStatus): 'none' | 'paused' | 'playing' {
  if (status === 'playing') return 'playing'
  if (status === 'idle') return 'none'
  return 'paused'
}

function syncMediaSession(state: Pick<MusicPlayerState, 'queue' | 'status' | 'positionMs' | 'durationMs' | 'rate'>): void {
  const track = currentTrack(state.queue)
  if (!track) {
    updateMediaSessionMetadata(null)
    updateMediaSessionPlaybackState('none')
    return
  }
  updateMediaSessionMetadata({
    title: track.title,
    artist: musicArtistNames(track),
    album: track.album,
    artworkUrl: coverUrlFor(track),
  })
  updateMediaSessionPlaybackState(mediaPlaybackState(state.status))
  updateMediaSessionPosition(state.positionMs, state.durationMs || track.durationMs, state.rate)
}

export const useMusicPlayer = create<MusicPlayerState>((set, get) => {
  /** Increments whenever the track the element should hold changes; stale loads compare against it. */
  let generation = 0

  const handleFailure = async (error: unknown): Promise<boolean> => {
    const state = get()
    const detail = describe(error)
    if (isAutoplayBlockedError(error)) {
      set({ status: 'paused', awaitingGesture: true, error: MUSIC_PLAYER_ERROR_KEYS.autoplay, errorDetail: detail })
      syncMediaSession(get())
      return false
    }
    if (isAudioUnavailableError(error)) {
      set({ status: 'error', error: MUSIC_PLAYER_ERROR_KEYS.unsupported, errorDetail: detail })
      syncMediaSession(get())
      return false
    }
    const failures = state.consecutiveFailures + 1
    set({
      status: 'error',
      error: playbackErrorKey(error),
      errorDetail: detail,
      consecutiveFailures: failures,
    })
    if (failureLimitReached(failures)) {
      syncMediaSession(get())
      return false
    }
    const step = nextInQueue(state.queue, 'failure')
    if (step.at === 'end') {
      syncMediaSession(get())
      return false
    }
    const nextTrack = currentTrack(step.queue)
    set({
      queue: step.queue,
      status: 'loading',
      positionMs: 0,
      durationMs: 0,
      sourceUrl: nextTrack ? streamUrlFor(nextTrack) : '',
      error: null,
      errorDetail: null,
    })
    persistPlayer(step.queue, 0)
    syncMediaSession(get())
    return playCurrent()
  }

  const playCurrent = async (startAtMs?: number): Promise<boolean> => {
    const state = get()
    const track = currentTrack(state.queue)
    if (!track) {
      set({ status: 'idle', sourceUrl: '', error: null, errorDetail: null })
      return false
    }
    const sourceUrl = state.sourceUrl || streamUrlFor(track)
    const request = ++generation
    set({
      status: 'loading',
      sourceUrl,
      error: null,
      errorDetail: null,
      awaitingGesture: false,
      preview: false,
      streamQuality: track.sourceQuality || track.format || '',
      streamGain: 0,
      streamPeak: 0,
      bufferedFraction: 0,
    })
    // A track opened from discovery has no library id yet; saving the snapshot is what lets the
    // stream and cover routes find it. An already-saved track is not written again: the queue's copy
    // may be older than the reader's edited metadata, and preservation is the server's default then.
    if (track.updatedAt === 0) {
      try {
        await musicApi.upsertTracks([track])
      } catch (error) {
        console.warn('[inkstone] Music track metadata could not be saved before playback:', error)
      }
    }
    if (request !== generation) return false
    let quality = track.sourceQuality || track.format || ''
    let gainDb = 0
    let peak = 0
    let preview = false
    if (track.provider === 'netease' && !track.r2Key) {
      try {
        // The audio element cannot read response headers, so a HEAD names the real level and the
        // loudness before the first frame; an answer that fails only leaves the defaults.
        const response = await fetch(sourceUrl, { method: 'HEAD' })
        quality = response.headers.get('x-music-quality') || quality
        gainDb = Number(response.headers.get('x-music-gain') ?? 0)
        peak = Number(response.headers.get('x-music-peak') ?? 0)
        preview = response.headers.get('x-music-free-trial') === '1'
      } catch (error) {
        console.warn('[inkstone] Music preview probe failed:', error)
      }
    }
    if (request !== generation) return false
    const prefs = useMusicSettings.getState().local
    set({ streamQuality: quality, streamGain: gainDb, streamPeak: peak, preview })
    try {
      await musicAudioEngine.play({
        url: sourceUrl,
        autoplay: true,
        startAtMs,
        volume: get().volume,
        muted: get().muted,
        rate: get().rate,
        equalizer: prefs.eq.enabled || prefs.eq.leveling || prefs.normalize,
        normalizationGain: prefs.normalize ? normalizationGainFrom(gainDb, peak) : 1,
      })
      if (request !== generation) return false
      set({ status: 'playing', consecutiveFailures: 0, error: null, errorDetail: null })
      // One place records a play, so leaving and re-entering the music tab (or the floating player
      // remounting) cannot append the same listen again. The library still deduplicates within 30s.
      void useMusicLibrary.getState().recordHistory({ track, contextType: 'player' })
      syncMediaSession(get())
      return true
    } catch (error) {
      if (request !== generation) return false
      return handleFailure(error)
    }
  }

  const applyStep = (step: ReturnType<typeof nextInQueue>, resetFailures: boolean): Promise<boolean> => {
    if (step.at === 'end') {
      if (step.queue.tracks.length === 0) set({ status: 'idle' })
      syncMediaSession(get())
      return Promise.resolve(false)
    }
    const track = currentTrack(step.queue)
    generation++
    set({
      queue: step.queue,
      status: 'loading',
      positionMs: 0,
      durationMs: 0,
      sourceUrl: track ? streamUrlFor(track) : '',
      error: null,
      errorDetail: null,
      awaitingGesture: false,
      ...(resetFailures ? { consecutiveFailures: 0 } : {}),
    })
    persistPlayer(step.queue, 0)
    syncMediaSession(get())
    return playCurrent(step.at === 'restart' ? 0 : undefined)
  }

  musicAudioEngine.subscribe('timeupdate', ({ positionMs, durationMs, bufferedFraction }) => {
    set({ positionMs, durationMs, bufferedFraction })
  })
  musicAudioEngine.subscribe('durationchange', ({ positionMs, durationMs, bufferedFraction }) => {
    set({ positionMs, durationMs, bufferedFraction })
  })
  musicAudioEngine.subscribe('seeked', ({ positionMs, durationMs, bufferedFraction }) => {
    set({ positionMs, durationMs, bufferedFraction })
    syncMediaSession(get())
  })
  musicAudioEngine.subscribe('play', () => {
    if (get().status === 'idle') return
    set({ status: 'playing', awaitingGesture: false, error: null, errorDetail: null })
    syncMediaSession(get())
  })
  musicAudioEngine.subscribe('playing', () => {
    if (get().status === 'idle') return
    set({ status: 'playing', awaitingGesture: false })
    syncMediaSession(get())
  })
  musicAudioEngine.subscribe('waiting', () => {
    if (get().status === 'playing' || get().status === 'loading') set({ status: 'loading' })
  })
  musicAudioEngine.subscribe('pause', () => {
    const status = get().status
    if (status === 'loading' || status === 'ended' || status === 'error' || status === 'idle') return
    set({ status: 'paused' })
    syncMediaSession(get())
  })
  musicAudioEngine.subscribe('ended', () => {
    void get().next('ended')
  })
  musicAudioEngine.subscribe('error', (failure: MusicEngineFailure) => {
    if (!currentTrack(get().queue)) return
    const status = get().status
    if (status === 'playing' || status === 'loading') {
      void handleFailure(new MusicPlaybackError(failure.message, failure.code))
      return
    }
    set({
      status: 'error',
      error: MUSIC_PLAYER_ERROR_KEYS.playback,
      errorDetail: failure.message,
    })
    syncMediaSession(get())
  })

  bindMediaSessionHandlers({
    play: () => {
      const status = get().status
      if (status !== 'playing' && status !== 'loading') void get().toggle()
    },
    pause: () => {
      const status = get().status
      if (status === 'playing' || status === 'loading') void get().toggle()
    },
    stop: () => {
      generation++
      musicAudioEngine.pause()
      set({ status: get().status === 'idle' ? 'idle' : 'paused', awaitingGesture: false })
      syncMediaSession(get())
    },
    next: () => { void get().next('user') },
    previous: () => { void get().prev() },
    seek: (positionMs) => get().seek(positionMs),
    seekBy: (deltaMs) => get().seek(get().positionMs + deltaMs),
  })

  return {
    queue: emptyQueue(useMusicSettings.getState().local.mode),
    status: 'idle',
    positionMs: 0,
    durationMs: 0,
    volume: useMusicSettings.getState().local.volume,
    muted: useMusicSettings.getState().local.muted,
    rate: useMusicSettings.getState().local.rate,
    error: null,
    errorDetail: null,
    consecutiveFailures: 0,
    awaitingGesture: false,
    preview: false,
    streamQuality: '',
    streamGain: 0,
    streamPeak: 0,
    bufferedFraction: 0,
    sourceUrl: '',

    setQueue(tracks, options = {}) {
      const state = get()
      const mode = options.mode ?? state.queue.mode
      const queue = createQueue({
        tracks,
        mode,
        index: options.startIndex,
        trackId: options.startTrackId,
      })
      const track = currentTrack(queue)
      generation++
      if (!options.autoplay) musicAudioEngine.stop()
      set({
        queue,
        status: track ? (options.autoplay ? 'loading' : 'paused') : 'idle',
        positionMs: 0,
        durationMs: track?.durationMs ?? 0,
        sourceUrl: track ? streamUrlFor(track) : '',
        error: null,
        errorDetail: null,
        preview: false,
        streamQuality: '',
        streamGain: 0,
        streamPeak: 0,
        bufferedFraction: 0,
        consecutiveFailures: 0,
        awaitingGesture: false,
      })
      if (mode !== state.queue.mode) useMusicSettings.getState().setMode(mode)
      persistPlayer(queue, 0)
      syncMediaSession(get())
      if (options.autoplay && track) void playCurrent(options.startAtMs)
      return track
    },

    async playTrack(track, options = {}) {
      if (!track || !track.id) return false
      const state = get()
      const preferences = useMusicSettings.getState().server
      let queue: MusicQueue
      if (options.queue) {
        // A page can hand the list it rendered with a track that arrived later (a recommendation,
        // a search row). The track has to be in the queue it starts, or the bar and the sound
        // would name different songs.
        const list = options.queue.some((entry) => entry.id === track.id)
          ? options.queue
          : [...options.queue, track]
        queue = createQueue({ tracks: list, mode: state.queue.mode, trackId: track.id })
      } else if (state.queue.tracks.some((entry) => entry.id === track.id)) {
        queue = {
          ...state.queue,
          index: state.queue.tracks.findIndex((entry) => entry.id === track.id),
        }
      } else if (preferences.singleTrackMode === 'append') {
        const appended = appendTrack(state.queue, track)
        queue = { ...appended, index: Math.max(0, appended.tracks.findIndex((entry) => entry.id === track.id)) }
      } else {
        queue = createQueue({ tracks: [track], mode: state.queue.mode, trackId: track.id })
      }
      generation++
      if (!preferences.autoPlay) musicAudioEngine.stop()
      set({
        queue,
        status: preferences.autoPlay ? 'loading' : 'paused',
        positionMs: 0,
        durationMs: track.durationMs,
        sourceUrl: options.sourceUrl ?? streamUrlFor(track),
        error: null,
        errorDetail: null,
        consecutiveFailures: 0,
        awaitingGesture: !preferences.autoPlay,
        preview: false,
        streamQuality: '',
        streamGain: 0,
        streamPeak: 0,
        bufferedFraction: 0,
      })
      persistPlayer(queue, 0)
      syncMediaSession(get())
      return preferences.autoPlay ? playCurrent() : false
    },

    async next(reason = 'user') {
      const state = get()
      if (state.queue.tracks.length === 0) return false
      if (reason === 'user') set({ consecutiveFailures: 0 })
      const queueReason: QueueReason = reason === 'ended' ? 'auto' : reason
      const step = nextInQueue(state.queue, queueReason)
      if (step.at === 'end') {
        if (reason === 'ended') {
          set({ status: 'ended', positionMs: state.durationMs })
          persistPlayer(state.queue, state.durationMs)
          syncMediaSession(get())
        }
        return false
      }
      return applyStep(step, reason === 'user')
    },

    async prev() {
      const state = get()
      if (state.queue.tracks.length === 0) return false
      if (state.positionMs > RESTART_THRESHOLD_MS) {
        get().seek(0)
        return true
      }
      set({ consecutiveFailures: 0 })
      return applyStep(previousInQueue(state.queue), true)
    },

    async toggle() {
      const state = get()
      if (!currentTrack(state.queue)) return false
      if (state.status === 'playing' || state.status === 'loading') {
        generation++
        musicAudioEngine.pause()
        set({ status: 'paused', awaitingGesture: false })
        syncMediaSession(get())
        persistPlayer(get().queue, get().positionMs)
        return true
      }
      set({ consecutiveFailures: 0, error: null, errorDetail: null })
      // A restored queue is paused with its position saved but no element source yet; pressing play
      // has to start where the reader left off, not at zero.
      const resumeAt = !musicAudioEngine.hasSource() && state.positionMs > 0 ? state.positionMs : undefined
      return playCurrent(resumeAt)
    },

    pause() {
      if (!currentTrack(get().queue)) return
      generation++
      musicAudioEngine.pause()
      set({ status: 'paused', awaitingGesture: false })
      syncMediaSession(get())
      persistPlayer(get().queue, get().positionMs)
    },

    seek(positionMs) {
      const state = get()
      if (!currentTrack(state.queue)) return
      const duration = state.durationMs > 0 ? state.durationMs : currentTrack(state.queue)?.durationMs ?? 0
      const target = duration > 0 ? clamp(positionMs, 0, duration) : Math.max(0, positionMs)
      musicAudioEngine.seek(target)
      set({ positionMs: target })
      syncMediaSession(get())
    },

    setMode(mode) {
      const state = get()
      if (mode === state.queue.mode) return
      const queue = setQueueMode(state.queue, mode)
      set({ queue })
      useMusicSettings.getState().setMode(mode)
      persistPlayer(queue, state.positionMs)
      syncMediaSession(get())
    },

    setVolume(volume) {
      const state = get()
      const next = clamp(volume, MUSIC_VOLUME_RANGE.min, MUSIC_VOLUME_RANGE.max)
      musicAudioEngine.setVolume(next)
      set({ volume: next, ...(next > 0 && state.muted ? { muted: false } : {}) })
      if (next > 0 && state.muted) musicAudioEngine.setMuted(false)
      useMusicSettings.getState().setVolume(next)
    },

    setMuted(muted) {
      musicAudioEngine.setMuted(muted)
      set({ muted })
      useMusicSettings.getState().setMuted(muted)
    },

    toggleMute() {
      get().setMuted(!get().muted)
    },

    setRate(rate) {
      const next = clamp(rate, MUSIC_RATE_RANGE.min, MUSIC_RATE_RANGE.max)
      musicAudioEngine.setRate(next)
      set({ rate: next })
      useMusicSettings.getState().setRate(next)
    },

    async removeFromQueue(trackId) {
      const state = get()
      const removal = removeTrackFromQueue(state.queue, trackId)
      if (!removal.found) return false
      const wasActive = state.status === 'playing' || state.status === 'loading'
      if (!removal.queue.tracks.length) {
        generation++
        musicAudioEngine.stop()
        set({
          queue: removal.queue,
          status: 'idle',
          positionMs: 0,
          durationMs: 0,
          sourceUrl: '',
          error: null,
          errorDetail: null,
          awaitingGesture: false,
        })
        persistPlayer(removal.queue, 0)
        syncMediaSession(get())
        return false
      }
      const track = currentTrack(removal.queue)
      if (removal.removedCurrent) {
        generation++
        musicAudioEngine.stop()
        set({
          queue: removal.queue,
          status: wasActive ? 'loading' : 'paused',
          positionMs: 0,
          durationMs: track?.durationMs ?? 0,
          sourceUrl: track ? streamUrlFor(track) : '',
          error: null,
          errorDetail: null,
        })
        persistPlayer(removal.queue, 0)
        syncMediaSession(get())
        if (wasActive) return playCurrent()
        return true
      }
      set({ queue: removal.queue })
      persistPlayer(removal.queue, state.positionMs)
      syncMediaSession(get())
      return true
    },

    updateTrackSnapshot(track) {
      const state = get()
      const index = state.queue.tracks.findIndex((entry) => entry.id === track.id)
      const existing = state.queue.tracks[index]
      if (!existing || existing.updatedAt === track.updatedAt) return
      const tracks = state.queue.tracks.slice()
      tracks[index] = track
      const queue = { ...state.queue, tracks }
      const isCurrent = currentTrack(state.queue)?.id === track.id
      set({
        queue,
        ...(isCurrent && state.durationMs === 0 && track.durationMs > 0
          ? { durationMs: track.durationMs }
          : {}),
      })
      persistPlayer(queue, state.positionMs)
      if (isCurrent) syncMediaSession(get())
    },

    appendToQueue(track) {
      const state = get()
      const wasEmpty = state.queue.tracks.length === 0
      const queue = appendTrack(state.queue, track)
      if (queue === state.queue) return
      const current = currentTrack(queue)
      if (wasEmpty) {
        set({
          queue,
          status: 'paused',
          sourceUrl: current ? streamUrlFor(current) : '',
          positionMs: 0,
          durationMs: current?.durationMs ?? 0,
        })
      } else {
        set({ queue })
      }
      persistPlayer(queue, wasEmpty ? 0 : state.positionMs)
      syncMediaSession(get())
    },

    addNext(track) {
      const state = get()
      const wasEmpty = state.queue.tracks.length === 0
      const queue = addNextTrack(state.queue, track)
      if (queue === state.queue) return
      const current = currentTrack(queue)
      set({
        queue,
        ...(wasEmpty
          ? {
              status: 'paused',
              sourceUrl: current ? streamUrlFor(current) : '',
              positionMs: 0,
              durationMs: current?.durationMs ?? 0,
            }
          : {}),
      })
      persistPlayer(queue, get().positionMs)
      if (wasEmpty) syncMediaSession(get())
    },

    restore() {
      if (get().queue.tracks.length > 0) return false
      const local = useMusicSettings.getState().local
      musicAudioEngine.setVolume(local.volume)
      musicAudioEngine.setMuted(local.muted)
      musicAudioEngine.setRate(local.rate)
      const snapshot = readPlayerSnapshot()
      if (!snapshot) {
        set({
          queue: emptyQueue(local.mode),
          volume: local.volume,
          muted: local.muted,
          rate: local.rate,
          status: 'idle',
          preview: false,
        })
        return false
      }
      const queue = restoreQueue(snapshot.queue, local.mode)
      const track = currentTrack(queue)
      const duration = track?.durationMs ?? 0
      const position = duration > 0 ? clamp(snapshot.positionMs, 0, duration) : Math.max(0, snapshot.positionMs)
      set({
        queue,
        volume: local.volume,
        muted: local.muted,
        rate: local.rate,
        status: track ? 'paused' : 'idle',
        positionMs: track ? position : 0,
        durationMs: track ? duration : 0,
        sourceUrl: track ? streamUrlFor(track) : '',
        error: null,
        errorDetail: null,
        consecutiveFailures: 0,
        awaitingGesture: Boolean(track),
        preview: false,
        streamQuality: track?.sourceQuality || '',
        streamGain: 0,
        streamPeak: 0,
        bufferedFraction: 0,
      })
      useMusicSettings.getState().setMode(queue.mode)
      syncMediaSession(get())
      return Boolean(track)
    },
  }
})

/**
 * Write the queue one last time when the document is going away.
 *
 * A named listener rather than an inline arrow: the leave-page guard documents every handler and
 * why it exists, and the pagehide event has no other place to persist a position in flight.
 */
function persistOnPageHide(): void {
  const state = useMusicPlayer.getState()
  persistPlayer(state.queue, musicAudioEngine.currentTimeMs() || state.positionMs)
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', persistOnPageHide)
}

/** The number the player uses to stop a queue of dead tracks, re-exported for panels. */
export { MAX_CONSECUTIVE_FAILURES }
