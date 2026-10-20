/**
 * The page's half of the wire: one worker, several runs, and a failure value instead of a rejection.
 *
 * A rejection a caller forgot to catch becomes an unhandled promise rejection, which in this app means a
 * template that silently did nothing. So every path out of here resolves: `{ ok: true, output }` when the
 * run rendered, `{ ok: false, code, detail }` when it did not. That is the same shape
 * `../../dataview/js.ts` uses for the same reason, and it is what lets a save path treat a failed template
 * as a result rather than as an exception it has to remember to trap.
 *
 * Runs are addressed by `runId`, and several are in flight at once: one template sits in a modal waiting for
 * the reader while another starts beside it. `../../dataview/js.ts` keeps a single `onmessage` slot per
 * worker and one reply per call, which cannot express either, so this client routes messages into a map and
 * owns the reply to every host call the worker asks about. The cost is that replies must be matched rather
 * than assumed, and that a run has to be released on exactly one terminal message — which is what
 * `finish` and the `settled` flag below are for.
 *
 * Two clocks, because they answer different questions. A run that stops producing anything for
 * `IDLE_GUARD_MS` means the thread is wedged or gone: the worker is terminated and every live run fails,
 * because a page that cannot hear from its interpreter has nothing better to do. A run that has been alive
 * for `MAX_RUN_WALL_MS` — answering prompts happily the whole time — is a template that will not finish, and
 * only that run is cancelled. Killing a sibling run for a slow one would be the wrong medicine.
 */
import type { HostCall, HostResult, RunRequest, WorkerMessage, WorkerRequest } from '../protocol'
import { IDLE_GUARD_MS, MAX_RUN_WALL_MS } from './limits'

/** The part of a `Worker` this client needs, so a test can hand it a scripted pair instead. */
export interface WorkerPort {
  postMessage: (data: WorkerRequest) => void
  terminate: () => void
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** What one run ends with. Never a rejection. */
export type TemplaterRunOutcome =
  | { ok: true; output: string; durationMs: number }
  | { ok: false; code: string; detail: string }

/** The page's answer to one thing the interpreter asked for. */
export type HostCallHandler = (call: HostCall) => Promise<HostResult>

export interface TemplaterClient {
  /** Start one run and resolve with what it produced. */
  run: (request: RunRequest) => Promise<TemplaterRunOutcome>
  /** Stop one run. Resolves that run's `run()` as a cancellation rather than leaving it hanging. */
  cancel: (runId: string) => void
  /** Ask one run's registered callbacks to fire. They cannot cross the wire, so only the worker can. */
  runHooks: (runId: string) => void
  /** How many runs are live, for a caller that wants to wait for a batch. */
  live: () => number
  /** Stop the worker and fail everything still in flight. */
  terminate: () => void
}

export interface TemplaterClientOptions {
  /** The page's implementation of `HOST_METHODS`, and the second capability check. */
  onHostCall: HostCallHandler
  /** Defaults to a module worker built from this file's sibling. Injected so the routing is testable. */
  spawn?: () => WorkerPort
  /** Notified when a run registered hooks, before its `done` arrives. */
  onHooksArmed?: (runId: string, count: number) => void
  timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>
}

/** One run the page is waiting on. */
interface LiveRun {
  resolve: (outcome: TemplaterRunOutcome) => void
  /** Set on the first terminal event, so a late second one cannot resolve twice. */
  settled: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  wallTimer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_SPAWN = (): WorkerPort =>
  new Worker(new URL('./templater.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerPort

export function createTemplaterClient(options: TemplaterClientOptions): TemplaterClient {
  const spawn = options.spawn ?? DEFAULT_SPAWN
  const timers = options.timers ?? globalThis
  const runs = new Map<string, LiveRun>()
  // Runs whose callbacks are still in the worker. Kept apart from `runs` because a run stops being a run the
  // moment its text arrives, while the interpreter holding its hooks does not.
  const armed = new Set<string>()
  let port: WorkerPort | null = null
  /** Why the worker is gone, if it is: reported against every run that was still in flight. */
  let lost: { code: string; detail: string } | null = null

  function attach(): WorkerPort | null {
    if (port) return port
    if (lost) return null
    try {
      port = spawn()
    } catch (error) {
      // A worker that would not start is the app's failure, not the template's, and it is remembered: a
      // thread that cannot be created will not be created again by every subsequent run.
      lost = { code: 'sandbox-unavailable', detail: error instanceof Error ? error.message : String(error) }
      return null
    }
    port.onmessage = (event) => receive(event.data)
    port.onerror = (event) => {
      // An uncaught error inside the worker means the thread is not running anything any more. Everything
      // waiting on it is failed at once, with the worker's own report kept as the detail.
      lost = { code: 'sandbox-unavailable', detail: describeError(event) }
      failAll(lost)
      closePort()
    }
    return port
  }

  function send(request: WorkerRequest): boolean {
    const worker = attach()
    if (!worker) return false
    try {
      worker.postMessage(request)
    } catch (error) {
      // A message the browser refused to clone is the page's bug rather than the template's, and posting it
      // again from another run would fail the same way: the worker is gone for this batch.
      lost = { code: 'render-failed', detail: error instanceof Error ? error.name : 'postMessage' }
      failAll(lost)
      closePort()
      return false
    }
    return true
  }

  function closePort(): void {
    if (!port) return
    try {
      port.terminate()
    } catch (error) {
      // Terminating a thread that already died is not worth a failure the reader cannot act on: the runs are
      // already resolved, and the reason is in the log.
      globalThis.console.warn(`[templater] worker already gone: ${String(error)}`)
    }
    port.onmessage = null
    port.onerror = null
    port = null
  }

  function finish(runId: string, outcome: TemplaterRunOutcome): void {
    const live = runs.get(runId)
    if (!live || live.settled) return
    // `done` after `hooks-armed` is only the first half of the run: the callbacks are still in the worker.
    // The caller still gets its text now, because waiting for a phase that may never be asked for would hold
    // up the write the reader is looking at.
    live.settled = true
    clearTimers(live)
    runs.delete(runId)
    live.resolve(outcome)
  }

  function clearTimers(live: LiveRun): void {
    if (live.idleTimer !== null) timers.clearTimeout(live.idleTimer)
    if (live.wallTimer !== null) timers.clearTimeout(live.wallTimer)
    live.idleTimer = null
    live.wallTimer = null
  }

  /**
   * Arm the two clocks for one more stretch of evidence.
   *
   * The idle guard is re-armed on *any* message about the run, which is what makes it a silence detector
   * rather than a budget: a template that has been in a dialog for four minutes and then posts its next host
   * call has shown it is alive. The wall clock is armed once, at the start, and never re-armed.
   */
  function arm(runId: string, live: LiveRun): void {
    if (live.idleTimer !== null) timers.clearTimeout(live.idleTimer)
    live.idleTimer = timers.setTimeout(() => {
      // Nothing has come from the thread at all. It cannot be asked to stop politely, because politeness is
      // also a message; the worker is terminated and every live run fails.
      const failure = { code: 'sandbox-timeout', detail: `idle:${IDLE_GUARD_MS}` }
      lost = failure
      failAll(failure)
      closePort()
    }, IDLE_GUARD_MS)
    if (!live.wallTimer) {
      live.wallTimer = timers.setTimeout(() => {
        const worker = port
        if (worker) worker.postMessage({ kind: 'cancel', runId })
        finish(runId, { ok: false, code: 'sandbox-timeout', detail: `wall:${MAX_RUN_WALL_MS}` })
      }, MAX_RUN_WALL_MS)
    }
  }

  function failAll(failure: { code: string; detail: string }): void {
    for (const live of [...runs.values()]) {
      clearTimers(live)
      if (live.settled) continue
      live.settled = true
      live.resolve({ ok: false, ...failure })
    }
    runs.clear()
    armed.clear()
  }

  function receive(message: WorkerMessage): void {
    if (!message || typeof message !== 'object') {
      // A message this build cannot read says nothing about a run, and pretending otherwise would fail a
      // template that is still running. Reported on the page's own console, where it can be found.
      globalThis.console.error('[templater] malformed message from worker')
      return
    }
    // `host-call` carries its run inside the call; the other three name it directly. Both halves of the
    // union are frozen, so this is a shape read rather than a guess.
    const runId = message.kind === 'host-call' ? message.call.runId : message.runId
    const live = runs.get(runId)
    if (live) arm(runId, live)
    if (message.kind === 'host-call') {
      askPage(message.call)
      return
    }
    if (!live) return
    if (message.kind === 'hooks-armed') {
      // Remembered past the run itself: `done` releases the run, and its callbacks are still in the worker.
      armed.add(runId)
      options.onHooksArmed?.(runId, message.count)
      return
    }
    if (message.kind === 'done') {
      finish(runId, { ok: true, output: message.output, durationMs: message.durationMs })
      return
    }
    finish(runId, { ok: false, code: message.code, detail: message.detail ?? '' })
  }

  /**
   * One thing the interpreter asked for, handed to the page and answered back.
   *
   * The answer is posted even when the run has stopped caring: the worker's own drop of a reply for a
   * cancelled run is what makes that harmless rather than a leak, and the page host is the authority on the
   * capability a second time. A handler that rejects is turned into a failure code rather than a lost reply,
   * because a template awaiting a promise nobody settles would sit until the idle guard fired.
   */
  function askPage(call: HostCall): void {
    void options
      .onHostCall(call)
      .then((result) => {
        send({ kind: 'host-reply', result })
      })
      .catch((error: unknown) => {
        send({
          kind: 'host-reply',
          result: {
            runId: call.runId,
            callId: call.callId,
            ok: false,
            code: 'render-failed',
            detail: error instanceof Error ? error.message : String(error),
          },
        })
      })
  }

  return {
    run(request) {
      const runId = request.runId
      const existing = runs.get(runId)
      if (existing) {
        // A caller that started a run under an id already in use would otherwise have two promises for one
        // interpreter and no way to tell which answer was whose.
        return Promise.resolve({
          ok: false as const,
          code: 'render-failed',
          detail: `duplicate:${runId}`,
        })
      }
      if (lost) return Promise.resolve({ ok: false as const, ...lost })
      return new Promise<TemplaterRunOutcome>((resolve) => {
        const live: LiveRun = { resolve, settled: false, idleTimer: null, wallTimer: null }
        runs.set(runId, live)
        arm(runId, live)
        if (!send(request)) {
          // The message never reached the worker — no thread to send it to, or a clone the browser refused.
          // Nothing is coming, so the run is answered now rather than waiting for a guard.
          finish(runId, { ok: false, code: lost?.code ?? 'sandbox-unavailable', detail: lost?.detail ?? 'post' })
        }
      })
    },
    cancel(runId) {
      const live = runs.get(runId)
      if (!live) return
      send({ kind: 'cancel', runId })
      finish(runId, { ok: false, code: 'render-failed', detail: 'cancelled' })
    },
    runHooks(runId) {
      // Only a run the worker said it armed has callbacks to ask for. Forgetting to call this is not a leak:
      // the worker holds the interpreter for `HOOKS_WAIT_MS`, then reports the wait as a failure.
      if (!armed.delete(runId)) return
      send({ kind: 'run-hooks', runId })
    },
    live: () => runs.size,
    terminate() {
      failAll({ code: 'render-failed', detail: 'terminated' })
      closePort()
    },
  }
}

/** The worker's own error event, read into something a caller can put in `detail`. */
function describeError(event: unknown): string {
  const record = event as { message?: unknown; filename?: unknown; lineno?: unknown } | null
  if (record && typeof record.message === 'string') return record.message
  if (typeof event === 'string') return event
  return 'worker-error'
}
