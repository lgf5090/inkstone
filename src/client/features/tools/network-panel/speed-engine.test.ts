/**
 * The measurement loop, driven by a stream the test owns.
 *
 * A fake reader and a fake clock are the whole surface: what is pinned is the contract the panel
 * relies on — one request per thread, a cap that stops the run, a failure streak that gives up, and a
 * stop that reports what actually arrived.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSpeedEngine, type SpeedEngineOutcome } from './speed-engine'
import type { StopReason } from '@shared/tools/network-panel/types'

function endlessResponse(chunkBytes: number, limit = 400): Response {
  let produced = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= limit) {
        controller.close()
        return
      }
      produced += 1
      controller.enqueue(new Uint8Array(chunkBytes))
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
}

function harness(
  fetchImpl: typeof fetch,
  now: () => number,
  sleep: (ms: number) => Promise<void> = async () => {},
) {
  const stops: Array<{ reason: StopReason; outcome: SpeedEngineOutcome }> = []
  const errors: string[] = []
  const buildUrl = vi.fn((thread: number, nonce: number) => `/api/tools/network-panel/download?t=${thread}&n=${nonce}`)
  const engine = createSpeedEngine({
    fetchImpl,
    buildUrl,
    now,
    sleep,
    onProgress: () => {},
    onSample: () => {},
    onStop: (outcome, reason) => stops.push({ reason, outcome }),
    onError: (error) => errors.push(error),
  })
  return { engine, stops, errors, buildUrl }
}

describe('speed engine', () => {
  it('stops itself at the data ceiling and reports the bytes it counted', async () => {
    const { engine, stops } = harness(
      (async () => endlessResponse(64)) as typeof fetch,
      () => 0,
    )
    engine.start({ threads: 1, maxBytes: 128, maxSpeedBps: 0 })
    await vi.waitFor(() => expect(stops).toHaveLength(1), { timeout: 2_000 })
    expect(stops[0]).toMatchObject({ reason: 'data_cap' })
    expect(stops[0]!.outcome.bytesUsed).toBeGreaterThanOrEqual(128)
    expect(engine.isRunning()).toBe(false)
  })

  it('raises a thread count while running and asks it for its own stream', async () => {
    const { engine, buildUrl } = harness(
      (async () => endlessResponse(8)) as typeof fetch,
      () => 0,
    )
    engine.start({ threads: 1, maxBytes: 0, maxSpeedBps: 0 })
    engine.updateThreads(2)
    await vi.waitFor(() => expect(buildUrl.mock.calls.some(([, nonce]) => nonce >= 1)).toBe(true), { timeout: 2_000 })
    const threads = buildUrl.mock.calls.map(([thread]) => thread)
    expect(threads).toContain(1)
    engine.stop('manual')
  })

  it('ends a manual stop with the elapsed time it measured', async () => {
    let clock = 1_000
    const { engine, stops } = harness(
      (async () => endlessResponse(64)) as typeof fetch,
      () => (clock += 500),
    )
    engine.start({ threads: 1, maxBytes: 0, maxSpeedBps: 0 })
    engine.stop('manual')
    expect(stops).toHaveLength(1)
    expect(stops[0]!.reason).toBe('manual')
    expect(stops[0]!.outcome.durationMs).toBeGreaterThan(0)
    expect(engine.isRunning()).toBe(false)
  })

  it('gives up after attempts keep failing and no bytes have arrived', async () => {
    let clock = 0
    const { engine, stops, errors } = harness(
      (async () => new Response(null, { status: 503 })) as typeof fetch,
      () => clock,
      async (ms) => { clock += ms },
    )
    engine.start({ threads: 1, maxBytes: 0, maxSpeedBps: 0 })
    await vi.waitFor(() => expect(stops).toHaveLength(1), { timeout: 3_000 })
    expect(stops[0]!.reason).toBe('failed')
    expect(errors).toEqual(['http_error'])
    expect(clock).toBeGreaterThanOrEqual(5_000)
  })

  it('retries a transient failure without surfacing an error or stopping', async () => {
    let calls = 0
    const { engine, stops, errors } = harness(
      (async () => {
        calls += 1
        if (calls <= 2) throw new TypeError('connection reset')
        return endlessResponse(64)
      }) as typeof fetch,
      () => 0,
    )
    engine.start({ threads: 1, maxBytes: 256, maxSpeedBps: 0 })
    await vi.waitFor(() => expect(stops).toHaveLength(1), { timeout: 2_000 })
    expect(stops[0]!.reason).toBe('data_cap')
    expect(errors).toEqual([])
  })

  it('does not count the aborts a manual stop performs', async () => {
    const { engine, stops, errors } = harness(
      (async () => endlessResponse(64)) as typeof fetch,
      () => 0,
    )
    engine.start({ threads: 2, maxBytes: 0, maxSpeedBps: 0 })
    await vi.waitFor(() => expect(engine.isRunning()).toBe(true), { timeout: 1_000 })
    engine.stop('manual')
    expect(stops[0]!.reason).toBe('manual')
    expect(errors).toEqual([])
  })

  it('does not turn a burst of failed threads into a failed run while bytes keep arriving', async () => {
    let failures = 0
    const { engine, stops, errors } = harness(
      (async (input: RequestInfo | URL) => {
        // Yield to the timer queue so the test runner can observe the loop.
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (String(input).includes('t=1')) {
          failures += 1
          throw new TypeError('connection reset')
        }
        return endlessResponse(64)
      }) as typeof fetch,
      () => 0,
    )
    engine.start({ threads: 2, maxBytes: 0, maxSpeedBps: 0 })
    await vi.waitFor(() => expect(failures).toBeGreaterThanOrEqual(8), { timeout: 2_000 })
    expect(engine.isRunning()).toBe(true)
    expect(errors).toEqual([])
    engine.stop('manual')
    await vi.waitFor(() => expect(stops).toHaveLength(1), { timeout: 1_000 })
    expect(stops[0]!.reason).toBe('manual')
  })

  it('holds the counted bytes under the bandwidth ceiling', async () => {
    let clock = 0
    const { engine, stops } = harness(
      (async () => endlessResponse(64 * 1024)) as typeof fetch,
      () => clock,
      async (ms) => { clock += ms },
    )
    engine.start({ threads: 2, maxBytes: 400_000, maxSpeedBps: 32_000 })
    await vi.waitFor(() => expect(stops).toHaveLength(1), { timeout: 3_000 })
    const outcome = stops[0]!.outcome
    const average = (outcome.bytesUsed / Math.max(1, outcome.durationMs)) * 1000
    expect(average).toBeLessThanOrEqual(32_000 * 1.05)
    expect(outcome.bytesUsed).toBeGreaterThanOrEqual(400_000)
  })

  it('treats a stream with no body as a failure rather than a zero-byte success', async () => {
    let clock = 0
    const { engine, stops, errors } = harness(
      (async () => new Response(null, { status: 204 })) as typeof fetch,
      () => clock,
      async (ms) => { clock += ms },
    )
    engine.start({ threads: 1, maxBytes: 0, maxSpeedBps: 0 })
    await vi.waitFor(() => expect(stops).toHaveLength(1), { timeout: 3_000 })
    expect(stops[0]!.reason).toBe('failed')
    expect(errors).toEqual(['empty_response'])
    expect(engine.isRunning()).toBe(false)
  })
})
