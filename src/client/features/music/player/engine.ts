/**
 * The one audio element the music app plays through.
 *
 * It lives outside React on purpose. The element holds a decoded stream, a playback position and a
 * media session; a component that owned it would lose all three whenever the tree remounts, which in
 * StrictMode is every mount in development. Subscriptions belong to callers, the element does not.
 *
 * `play` resolves when the track is audible, rejects with {@link MusicAutoplayBlockedError} when the
 * browser wants a gesture, and with {@link MusicPlaybackError} after the one retry has also failed.
 */
import { musicEqualizer } from './eq'

export interface MusicEngineFailure {
  code: number | null
  message: string
}

export interface MusicEngineTime {
  positionMs: number
  durationMs: number
  /** How much of the track the element has buffered, 0..1. */
  bufferedFraction: number
}

interface EngineEvents {
  play: void
  pause: void
  ended: void
  timeupdate: MusicEngineTime
  durationchange: MusicEngineTime
  seeked: MusicEngineTime
  waiting: void
  playing: void
  error: MusicEngineFailure
}

export type MusicEngineEventName = keyof EngineEvents

type Listener<T> = (payload: T) => void

export interface MusicEngineLoadRequest {
  url: string
  autoplay: boolean
  /** Where to start, in milliseconds. Omitted means "wherever the element already is". */
  startAtMs?: number
  volume: number
  muted: boolean
  rate: number
  /** Capture the element into Web Audio only when the equalizer, leveling or normalizing is on. */
  equalizer?: boolean
  /** False when a HEAD probe showed the stream redirecting off-origin; captured audio would be silent. */
  graphAllowed?: boolean
  /** Linear gain from Netease's measured loudness; 1 leaves the track alone. */
  normalizationGain?: number
}

export class MusicPlaybackError extends Error {
  readonly code: number | null

  constructor(message: string, code: number | null = null) {
    super(message)
    this.name = 'MusicPlaybackError'
    this.code = code
  }
}

/** The browser refused to start without a user gesture. Not a broken track, so it must not skip. */
export class MusicAutoplayBlockedError extends MusicPlaybackError {
  constructor(message = 'Autoplay was refused until the reader interacts with the page') {
    super(message)
    this.name = 'MusicAutoplayBlockedError'
  }
}

/** No `Audio` constructor at all: a server render, a test harness, or a locked-down webview. */
export class MusicUnavailableError extends MusicPlaybackError {
  constructor(message = 'This environment has no audio element') {
    super(message)
    this.name = 'MusicUnavailableError'
  }
}

export function isAutoplayBlockedError(error: unknown): boolean {
  return error instanceof MusicAutoplayBlockedError
}

export function isAudioUnavailableError(error: unknown): boolean {
  return error instanceof MusicUnavailableError
}

const MAX_LOAD_ATTEMPTS = 2
const RETRY_DELAY_MS = 250
const LOAD_TIMEOUT_MS = 20_000
const FADE_IN_MS = 260
const FADE_OUT_MS = 180

function failureFrom(error: MediaError | null): MusicEngineFailure {
  return {
    code: error?.code ?? null,
    message: error?.message || 'The audio element stopped with an unknown media error',
  }
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0, value))
}

function clampRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(4, Math.max(0.25, value))
}

function absoluteUrl(url: string): string {
  if (typeof window === 'undefined') return url
  try {
    return new URL(url, window.location.href).href
  } catch {
    return url
  }
}

export class MusicAudioEngine {
  private audio: HTMLAudioElement | null = null
  private listeners = new Map<MusicEngineEventName, Set<Listener<unknown>>>()
  private loadGeneration = 0
  private loading = false
  private pendingCancel: ((error: Error) => void) | null = null
  private volume = 1
  private muted = false
  private rate = 1
  private fadeGeneration = 0
  private fadeFrame = 0

  subscribe<K extends MusicEngineEventName>(name: K, listener: Listener<EngineEvents[K]>): () => void {
    let set = this.listeners.get(name)
    if (!set) {
      set = new Set()
      this.listeners.set(name, set)
    }
    set.add(listener as Listener<unknown>)
    return () => {
      set?.delete(listener as Listener<unknown>)
    }
  }

  currentTimeMs(): number {
    return this.audio ? this.audio.currentTime * 1000 : 0
  }

  durationMs(): number {
    const duration = this.audio?.duration
    return Number.isFinite(duration) && duration && duration > 0 ? duration * 1000 : 0
  }

  bufferedFraction(): number {
    const audio = this.audio
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return 0
    let end = 0
    for (let index = 0; index < audio.buffered.length; index += 1) {
      const rangeEnd = audio.buffered.end(index)
      if (rangeEnd > end) end = rangeEnd
    }
    return Math.min(1, Math.max(0, end / audio.duration))
  }

  hasSource(): boolean {
    return Boolean(this.audio?.src)
  }

  /** Attach the graph to the element that is already playing, when EQ is switched on mid-track. */
  enableEqualizer(): void {
    if (!this.audio?.src) return
    musicEqualizer.connect(this.audio, this.audio.src)
  }

  /** Resume the graph on the press, before any stream fetch spends the activation. */
  prepareEqualizer(): void {
    musicEqualizer.prepare()
  }

  setNormalizationGain(gain: number): void {
    musicEqualizer.setNormalizationGain(gain)
  }

  async play(request: MusicEngineLoadRequest): Promise<void> {
    const audio = this.element()
    const generation = ++this.loadGeneration
    this.cancelFade()
    this.volume = clampVolume(request.volume)
    this.muted = request.muted
    this.rate = clampRate(request.rate)
    audio.muted = this.muted
    audio.playbackRate = this.rate

    // Capture is a one-way door: if the response later redirects to another origin, Web Audio would
    // render silence. Only attach the graph when the reader actually asked for EQ or leveling.
    if (request.equalizer && request.graphAllowed !== false) {
      musicEqualizer.connect(audio, request.url)
      musicEqualizer.setNormalizationGain(request.normalizationGain ?? 1)
    }

    const source = absoluteUrl(request.url)
    const sameSource = audio.src === source && !audio.error && audio.readyState > 0
    if (sameSource) {
      if (request.startAtMs !== undefined) this.seek(request.startAtMs)
      await this.start(audio, request.autoplay, generation)
      return
    }

    audio.volume = this.volume
    await this.loadSource(audio, source, generation)
    if (generation !== this.loadGeneration) throw this.replacedError()
    if (request.startAtMs !== undefined) this.seek(request.startAtMs)
    await this.start(audio, request.autoplay, generation)
  }

  pause(): void {
    this.loadGeneration++
    this.cancelPending(this.replacedError())
    this.loading = false
    const audio = this.audio
    if (!audio) return
    this.cancelFade()
    if (audio.paused) return
    this.fadeTo(audio, 0, FADE_OUT_MS, () => {
      if (this.audio === audio) audio.pause()
    })
  }

  /** Stop and release the stream. The element stays for the next track. */
  stop(): void {
    this.loadGeneration++
    this.cancelPending(this.replacedError())
    this.loading = false
    this.cancelFade()
    const audio = this.audio
    if (!audio) return
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }

  seek(positionMs: number): void {
    const audio = this.audio
    if (!audio || !audio.src || !Number.isFinite(positionMs)) return
    const duration = audio.duration
    const seconds = Math.max(0, positionMs) / 1000
    const target = Number.isFinite(duration) && duration > 0 ? Math.min(duration, seconds) : seconds
    try {
      audio.currentTime = target
    } catch {
      // A seek before metadata exists is rejected by the element; the next load supplies a position.
    }
  }

  setVolume(volume: number): void {
    this.volume = clampVolume(volume)
    this.cancelFade()
    if (this.audio) this.audio.volume = this.volume
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.audio) this.audio.muted = muted
  }

  setRate(rate: number): void {
    this.rate = clampRate(rate)
    if (this.audio) this.audio.playbackRate = this.rate
  }

  private element(): HTMLAudioElement {
    if (this.audio) return this.audio
    if (typeof Audio === 'undefined') throw new MusicUnavailableError()
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.volume = this.volume
    audio.muted = this.muted
    audio.playbackRate = this.rate
    audio.addEventListener('play', () => {
      if (audio.paused) return
      this.emit('play', undefined)
    })
    audio.addEventListener('pause', () => {
      if (!audio.paused || audio.ended) return
      this.emit('pause', undefined)
    })
    audio.addEventListener('ended', () => this.emit('ended', undefined))
    audio.addEventListener('timeupdate', () => this.emit('timeupdate', this.time()))
    audio.addEventListener('durationchange', () => this.emit('durationchange', this.time()))
    audio.addEventListener('seeked', () => this.emit('seeked', this.time()))
    audio.addEventListener('waiting', () => this.emit('waiting', undefined))
    audio.addEventListener('playing', () => this.emit('playing', undefined))
    audio.addEventListener('error', () => {
      // A load failure is answered by the promise `loadSource` returns; emitting it here as well
      // would make the player count one failure twice.
      if (this.loading) return
      this.emit('error', failureFrom(audio.error))
    })
    this.audio = audio
    return audio
  }

  private time(): MusicEngineTime {
    return {
      positionMs: this.currentTimeMs(),
      durationMs: this.durationMs(),
      bufferedFraction: this.bufferedFraction(),
    }
  }

  private cancelFade(): void {
    this.fadeGeneration++
    if (this.fadeFrame) {
      window.cancelAnimationFrame(this.fadeFrame)
      this.fadeFrame = 0
    }
  }

  private fadeTo(audio: HTMLAudioElement, to: number, durationMs: number, done?: () => void): void {
    const from = audio.volume
    if (Math.abs(from - to) < 0.001 || durationMs <= 0) {
      audio.volume = to
      done?.()
      return
    }
    const generation = ++this.fadeGeneration
    let finished = false
    const finish = (): void => {
      if (finished || generation !== this.fadeGeneration) return
      finished = true
      audio.volume = to
      this.fadeFrame = 0
      done?.()
    }
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const step = (): void => {
      if (finished || generation !== this.fadeGeneration) return
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const progress = Math.min(1, (now - start) / durationMs)
      audio.volume = from + (to - from) * (0.5 - 0.5 * Math.cos(Math.PI * progress))
      if (progress < 1) {
        this.fadeFrame = window.requestAnimationFrame(step)
        return
      }
      finish()
    }
    this.fadeFrame = window.requestAnimationFrame(step)
    // A hidden tab pauses animation frames; without this the element would stay at the fade's
    // starting volume (often zero) for as long as the tab stays out of sight.
    window.setTimeout(finish, durationMs + 120)
  }

  private async loadSource(audio: HTMLAudioElement, source: string, generation: number): Promise<void> {
    this.loading = true
    try {
      let lastError: unknown
      for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
        try {
          await this.loadOnce(audio, source, generation)
          return
        } catch (error) {
          lastError = error
          if (generation !== this.loadGeneration) throw this.replacedError()
          if (attempt < MAX_LOAD_ATTEMPTS) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS))
            if (generation !== this.loadGeneration) throw this.replacedError()
          }
        }
      }
      throw lastError instanceof Error ? lastError : new MusicPlaybackError('The audio source could not be loaded')
    } finally {
      if (generation === this.loadGeneration) this.loading = false
    }
  }

  private loadOnce(audio: HTMLAudioElement, source: string, generation: number): Promise<void> {
    this.cancelPending(this.replacedError())
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timer = 0
      const cleanup = (): void => {
        window.clearTimeout(timer)
        audio.removeEventListener('loadedmetadata', onReady)
        audio.removeEventListener('canplay', onReady)
        audio.removeEventListener('error', onError)
        if (this.pendingCancel === cancel) this.pendingCancel = null
      }
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const cancel = (error: Error): void => finish(error)
      const onReady = (): void => {
        if (generation !== this.loadGeneration) finish(this.replacedError())
        else finish()
      }
      const onError = (): void => {
        if (generation !== this.loadGeneration) {
          finish(this.replacedError())
          return
        }
        const failure = failureFrom(audio.error)
        finish(new MusicPlaybackError(failure.message, failure.code))
      }
      this.pendingCancel = cancel
      timer = window.setTimeout(
        () => finish(new MusicPlaybackError('The audio source did not become playable in time')),
        LOAD_TIMEOUT_MS,
      )
      // `preload='metadata'` promises metadata, not `canplay`. Readiness is either signal; the play
      // call below buffers the rest and reports its own failure if the stream cannot continue.
      audio.addEventListener('loadedmetadata', onReady)
      audio.addEventListener('canplay', onReady)
      audio.addEventListener('error', onError)
      try {
        audio.src = source
        audio.load()
      } catch (error) {
        finish(error instanceof Error ? error : new MusicPlaybackError('The audio source could not be assigned'))
      }
    })
  }

  private async start(audio: HTMLAudioElement, autoplay: boolean, generation: number): Promise<void> {
    if (generation !== this.loadGeneration) throw this.replacedError()
    await musicEqualizer.resume()
    if (generation !== this.loadGeneration) throw this.replacedError()
    if (!autoplay) {
      audio.volume = this.volume
      audio.pause()
      return
    }
    const canFade = typeof document === 'undefined' || !document.hidden
    audio.volume = canFade ? 0 : this.volume
    try {
      await audio.play()
    } catch (error) {
      if (generation !== this.loadGeneration) throw this.replacedError()
      if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
        throw new MusicAutoplayBlockedError(error.message)
      }
      throw error instanceof MusicPlaybackError
        ? error
        : new MusicPlaybackError(error instanceof Error ? error.message : 'The browser refused to play the track')
    }
    if (generation === this.loadGeneration) {
      if (canFade) this.fadeTo(audio, this.volume, FADE_IN_MS)
      else audio.volume = this.volume
    }
  }

  private cancelPending(error: Error): void {
    const cancel = this.pendingCancel
    this.pendingCancel = null
    cancel?.(error)
  }

  private replacedError(): MusicPlaybackError {
    return new MusicPlaybackError('The audio load was replaced by a newer request')
  }

  private emit<K extends MusicEngineEventName>(name: K, payload: EngineEvents[K]): void {
    const set = this.listeners.get(name)
    if (!set) return
    for (const listener of set) {
      try {
        listener(payload)
      } catch {
        // One subscriber failing must not stop the others or the audio element's own event handler.
      }
    }
  }
}

export const musicAudioEngine = new MusicAudioEngine()
