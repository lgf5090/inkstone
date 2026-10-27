// @vitest-environment jsdom
/**
 * The audio element's fade and gain arithmetic, and the buffered fraction a seek bar reads.
 *
 * A fake element is enough here: the browser's decoder and the Web Audio graph are separate concerns,
 * while the fade must not depend on them. Timers are faked so the test can observe both ends of a
 * fade without waiting on wall-clock time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MusicAudioEngine } from '../src/client/features/music/player/engine'
import { normalizationGainFrom } from '../src/client/features/music/store/player'

class FakeAudio {
  src = ''
  currentTime = 0
  duration = 120
  volume = 1
  muted = false
  playbackRate = 1
  paused = true
  readyState = 4
  error: MediaError | null = null
  preload = ''
  buffered = { length: 1, end: () => 30 }
  private listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  load(): void {
    queueMicrotask(() => this.emit('loadedmetadata'))
  }

  play(): Promise<void> {
    this.paused = false
    this.emit('play')
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
    this.emit('pause')
  }

  removeAttribute(): void {
    this.src = ''
  }
}

describe('the audio engine fade and gain', () => {
  const audio = new FakeAudio()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('Audio', function Audio() { return audio } as unknown as typeof Audio)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts at silence and fades in to the requested volume', async () => {
    const engine = new MusicAudioEngine()
    await engine.play({ url: '/api/music/media/stream/1', autoplay: true, volume: 0.8, muted: false, rate: 1 })
    expect(audio.volume).toBe(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(audio.volume).toBeCloseTo(0.8, 2)
    expect(engine.bufferedFraction()).toBeCloseTo(0.25, 2)
  })

  it('fades out before pausing', async () => {
    const engine = new MusicAudioEngine()
    await engine.play({ url: '/api/music/media/stream/1', autoplay: true, volume: 0.8, muted: false, rate: 1 })
    await vi.advanceTimersByTimeAsync(300)
    engine.pause()
    expect(audio.paused).toBe(false)
    await vi.advanceTimersByTimeAsync(220)
    expect(audio.paused).toBe(true)
    expect(audio.volume).toBeCloseTo(0, 2)
  })

  it('turns a measured gain into a peak-guarded linear gain', () => {
    expect(normalizationGainFrom(0, 0)).toBe(1)
    expect(normalizationGainFrom(0, 0.5)).toBeCloseTo(Math.pow(10, 4 / 20), 3)
    expect(normalizationGainFrom(-6, 0)).toBeCloseTo(Math.pow(10, -2 / 20), 3)
    expect(normalizationGainFrom(3, 0.5)).toBe(2)
  })
})
