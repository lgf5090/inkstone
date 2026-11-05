/**
 * The download test, as an object rather than a screen.
 *
 * A test is N loops reading one response stream each, restarting the request when a stream ends, and
 * counting the bytes that arrived. The reader owns the fetch and the clock so the loop can be driven
 * with a fake stream in a test; the arithmetic it shares with the panel lives in the shared engine.
 *
 * None of this touches React. The panel subscribes through callbacks, which is what lets a test keep
 * running while another screen is open.
 */
import {
  SpeedSeries,
  capWaitMs,
} from '@shared/tools/network-panel/engine'
import type { SpeedSeriesPoint, StopReason } from '@shared/tools/network-panel/types'

export type SpeedEngineError = 'fetch_failed' | 'empty_response' | 'http_error'

export interface SpeedEngineConfig {
  threads: number
  /** `0` means no data ceiling. */
  maxBytes: number
  /** Bytes per second; `0` means no bandwidth ceiling. */
  maxSpeedBps: number
}

export interface SpeedEngineSample {
  speedBps: number
  bytesUsed: number
  elapsedMs: number
  series: SpeedSeriesPoint[]
}

export interface SpeedEngineOutcome {
  bytesUsed: number
  durationMs: number
  avgSpeedBps: number
}

export interface SpeedEngineDeps {
  buildUrl: (thread: number, nonce: number) => string
  onProgress: (bytesUsed: number, elapsedMs: number) => void
  onSample: (sample: SpeedEngineSample) => void
  onStop: (outcome: SpeedEngineOutcome, reason: StopReason) => void
  onError: (error: SpeedEngineError) => void
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const PROGRESS_INTERVAL_MS = 100
const FAILURE_LIMIT = 6
const RETRY_DELAY_MS = 400

export function createSpeedEngine(deps: SpeedEngineDeps) {
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const now = deps.now ?? (() => performance.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const series = new SpeedSeries()
  const controllers = new Set<AbortController>()

  let running = false
  let threads = 0
  let bytesUsed = 0
  let startedAt = 0
  let lastEmit = 0
  let lastSampleAt = 0
  let lastSampleBytes = 0
  let failureStreak = 0
  let nonce = 0
  let sampleTimer = 0
  let config: SpeedEngineConfig = { threads: 0, maxBytes: 0, maxSpeedBps: 0 }

  const progress = (force: boolean) => {
    const at = now()
    if (!force && at - lastEmit < PROGRESS_INTERVAL_MS) return
    lastEmit = at
    deps.onProgress(bytesUsed, Math.max(0, at - startedAt))
  }

  const sample = () => {
    const at = now()
    const deltaMs = at - lastSampleAt
    const speedBps = deltaMs > 0 ? ((bytesUsed - lastSampleBytes) / deltaMs) * 1000 : 0
    lastSampleAt = at
    lastSampleBytes = bytesUsed
    series.push(at / 1000, Math.max(0, speedBps))
    deps.onSample({
      speedBps: Math.max(0, speedBps),
      bytesUsed,
      elapsedMs: Math.max(0, at - startedAt),
      series: series.snapshot(),
    })
  }

  const noteFailure = (error: SpeedEngineError) => {
    failureStreak += 1
    deps.onError(error)
    if (failureStreak >= FAILURE_LIMIT && running) stop('failed')
  }

  async function loop(index: number) {
    let immediateFailures = 0
    while (running && index < config.threads) {
      if (config.maxBytes > 0 && bytesUsed >= config.maxBytes) {
        stop('data_cap')
        return
      }
      const controller = new AbortController()
      controllers.add(controller)
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      try {
        const response = await fetchImpl(deps.buildUrl(index, nonce++), {
          cache: 'no-store',
          credentials: 'same-origin',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (!response.ok) {
          noteFailure('http_error')
          await sleep(RETRY_DELAY_MS)
          continue
        }
        if (!response.body) {
          noteFailure('empty_response')
          await sleep(RETRY_DELAY_MS)
          continue
        }
        failureStreak = 0
        immediateFailures = 0
        let received = 0
        reader = response.body.getReader()
        while (running && index < config.threads) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value || value.length === 0) continue
          received += value.length
          // The browser delivers bytes in whatever sizes it likes, so a chunk can be far larger than one
          // second's budget. Waiting once per chunk is not a cap: the loop re-asks until the shared
          // budget covers the whole chunk, and only then does it count the bytes it just accepted.
          while (running && config.maxSpeedBps > 0) {
            const wait = capWaitMs(config.maxSpeedBps, bytesUsed + value.length, Math.max(0, now() - startedAt))
            if (wait <= 0) break
            await sleep(wait)
          }
          if (!running) return
          bytesUsed += value.length
          progress(false)
          if (config.maxBytes > 0 && bytesUsed >= config.maxBytes) {
            stop('data_cap')
            return
          }
        }
        // A server that answers with an empty stream would otherwise be re-requested in a hot loop.
        if (received === 0) await sleep(RETRY_DELAY_MS)
      } catch {
        if (!running) return
        noteFailure('fetch_failed')
        immediateFailures += 1
        if (immediateFailures >= 3) await sleep(RETRY_DELAY_MS)
      } finally {
        controllers.delete(controller)
        if (reader) {
          try {
            await reader.cancel()
          } catch {
            // A reader whose stream is already closed refuses the cancel; the loop is done either way.
          }
        }
      }
    }
  }

  function stop(reason: StopReason) {
    if (!running) return
    running = false
    window.clearInterval(sampleTimer)
    sampleTimer = 0
    for (const controller of controllers) controller.abort()
    controllers.clear()
    const durationMs = Math.max(0, now() - startedAt)
    const avgSpeedBps = durationMs > 0 ? (bytesUsed / durationMs) * 1000 : 0
    progress(true)
    deps.onStop({ bytesUsed, durationMs, avgSpeedBps }, reason)
  }

  return {
    start(next: SpeedEngineConfig) {
      if (running) return
      config = {
        threads: Math.max(1, Math.min(64, Math.floor(next.threads))),
        maxBytes: Math.max(0, Math.floor(next.maxBytes)),
        maxSpeedBps: Math.max(0, Math.floor(next.maxSpeedBps)),
      }
      running = true
      threads = config.threads
      bytesUsed = 0
      failureStreak = 0
      nonce = 0
      series.reset()
      startedAt = now()
      lastEmit = 0
      lastSampleAt = startedAt
      lastSampleBytes = 0
      for (let index = 0; index < threads; index += 1) {
        void loop(index)
      }
      progress(true)
      sampleTimer = window.setInterval(sample, 1000)
    },

    /** The reference panel's slider: adding threads starts loops, removing them lets loops retire. */
    updateThreads(next: number) {
      const clamped = Math.max(1, Math.min(64, Math.floor(next)))
      const previous = threads
      threads = clamped
      config.threads = clamped
      if (!running || clamped <= previous) return
      for (let index = previous; index < clamped; index += 1) {
        void loop(index)
      }
    },

    stop,
    isRunning: () => running,
    snapshot: () => ({ bytesUsed, elapsedMs: running ? Math.max(0, now() - startedAt) : 0 }),
  }
}
