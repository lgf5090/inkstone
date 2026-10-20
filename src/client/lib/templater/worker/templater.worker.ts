/**
 * The worker thread: several runs at once, one message handler, no page.
 *
 * This file is deliberately thin. Its whole job is to keep `runId`s straight — start a run, route a reply to
 * the run that asked for it, stop a run the page no longer wants — because the interpreter lives in `vm.ts`
 * and the wire shapes live in `protocol.ts`. Anything here that grew logic would be logic running on the
 * thread every other template shares.
 *
 * Two rules make that safe. Nothing thrown may reach the message handler: every branch reports a failure
 * code on the wire instead, because an exception here takes down the runs that are not this one. And a run
 * is forgotten only when it has nothing left to do: a run that registered hooks stays alive after its
 * `done`, waiting for `run-hooks`, because the callbacks it holds cannot cross the wire and exist nowhere
 * else.
 */
import type { HostResult, RunRequest, WorkerMessage, WorkerRequest } from '../protocol'
import { TemplateRun } from './vm'
import { readRunId, validateHostReply, validateRunRequest } from './protocol'
import { HOOKS_WAIT_MS } from './limits'

/** The part of a dedicated worker this thread needs, as a type this file can own. */
export interface WorkerScope {
  postMessage: (message: WorkerMessage) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

/** One live run, plus the timer that gives up on its hooks if the page never asks for them. */
interface LiveRun {
  run: TemplateRun
  hooksTimer: ReturnType<typeof setTimeout> | null
}

/**
 * The dispatcher, split from the thread's own bindings so it can be driven from a test.
 *
 * `templater.worker.ts` is the module the browser loads, and a test that imported it for its own sake would
 * attach a handler to the page the other suites are running on; the scope is therefore injected, and the
 * binding at the bottom of this file only happens on a real dedicated worker.
 */
export interface WorkerHandler {
  handle: (request: unknown) => void
  /** Stop everything, for a scope that is about to go away. */
  shutdown: () => void
  /** How many runs the thread is holding, hooks included. */
  size: () => number
}

export function createWorkerHandler(scope: WorkerScope): WorkerHandler {
  const runs = new Map<string, LiveRun>()
  // An id whose interpreter is still being built. Opening one takes a tick (the engine loads once, then a
  // runtime and a context per run), and a cancel that arrives during that tick has to be remembered rather
  // than lost, or the run would start after the page stopped wanting it.
  const opening = new Set<string>()

  function post(message: WorkerMessage): void {
    scope.postMessage(message)
  }

  /**
   * Everything one run sends, seen from the worker's side.
   *
   * A terminal message releases the run — `failed` always, `done` only when there are no callbacks left to
   * run. That is the one place the two halves agree on when a `runId` stops meaning anything, which is what
   * a late reply has to be measured against.
   */
  function publish(runId: string): (message: WorkerMessage) => void {
    return (message) => {
      post(message)
      if (message.kind === 'failed') {
        release(runId)
        return
      }
      if (message.kind !== 'done') return
      const live = runs.get(runId)
      if (!live) return
      if (live.run.currentState === 'hooks') {
        // Alive on a timer, not forever: a page that never sends `run-hooks` would otherwise leave a runtime
        // and its interpreter heap pinned to a thread that has nothing left to report.
        live.hooksTimer = setTimeout(() => {
          const still = runs.get(runId)
          if (!still) return
          still.run.cancel()
          runs.delete(runId)
          post({ kind: 'failed', runId, code: 'render-failed', detail: `run-hooks:${HOOKS_WAIT_MS}` })
        }, HOOKS_WAIT_MS)
      } else {
        release(runId)
      }
    }
  }

  function release(runId: string): void {
    const live = runs.get(runId)
    if (!live) return
    if (live.hooksTimer !== null) clearTimeout(live.hooksTimer)
    runs.delete(runId)
  }

  function start(request: RunRequest): void {
    opening.add(request.runId)
    void TemplateRun.open(request, publish(request.runId))
      .then((run) => {
        if (!opening.delete(request.runId)) {
          // Cancelled while its interpreter was being built. The run is freed here rather than started: a
          // run nobody asked for any more would report on an id the page has already forgotten.
          run.cancel()
          return
        }
        const previous = runs.get(request.runId)
        if (previous) {
          // The page reused an id while this one was opening. Replacing it keeps a retry working; the old
          // run is stopped first so its heap is not sitting next to the new one's.
          previous.run.cancel()
        }
        runs.set(request.runId, { run, hooksTimer: null })
        run.start()
      })
      .catch((error: unknown) => {
        opening.delete(request.runId)
        // An engine that would not load, or a namespace that would not build. Reported, never swallowed: the
        // reader gets `sandbox-unavailable` and the worker stays usable for the next run.
        post({
          kind: 'failed',
          runId: request.runId,
          code: 'sandbox-unavailable',
          detail: error instanceof Error ? `${error.name}:${error.message}` : String(error),
        })
      })
  }

  function handle(request: unknown): void {
    const record = asRecord(request)
    if (!record) {
      // Without a run id there is nobody to tell. Inventing one would put a false identity on the wire, so
      // this is the one case the worker prints instead of answering — with the reason, so a page that built
      // the wrong message can find it. A malformed message that *does* carry an id is answered on it.
      const carried = typeof request === 'object' && request !== null
        ? (request as { runId?: unknown }).runId
        : undefined
      if (typeof carried === 'string' && carried) {
        post({ kind: 'failed', runId: carried, code: 'render-failed', detail: 'request' })
      } else {
        reportOrphan('render-failed', 'request')
      }
      return
    }

    if (record.kind === 'run') {
      const validated = validateRunRequest(request)
      if (!validated.ok) {
        const runId = typeof record.runId === 'string' ? record.runId : ''
        if (runId) post({ kind: 'failed', runId, code: validated.code, detail: validated.detail })
        else reportOrphan(validated.code, validated.detail)
        return
      }
      start(validated.request)
      return
    }

    if (record.kind === 'host-reply') {
      const result: HostResult | null = validateHostReply(request)
      if (!result) {
        reportOrphan('render-failed', 'host-reply')
        return
      }
      const live = runs.get(result.runId)
      // A reply for a run that has ended is dropped, not an error: the run it belonged to is gone, its
      // interpreter is freed, and a template that is no longer executing cannot be handed an answer.
      if (!live) return
      live.run.deliver(result)
      // The hooks phase ends without a message of its own, so this is where a run that finished while being
      // handed an answer stops being held.
      if (live.run.currentState === 'finished') release(result.runId)
      return
    }

    const named = readRunId(request)
    if (!named) {
      reportOrphan('render-failed', 'kind')
      return
    }

    if (named.kind === 'cancel') {
      // An id that is only mid-open is dropped from the opening set, which is what `start` checks when its
      // interpreter finishes building.
      if (!opening.delete(named.runId)) {
        const live = runs.get(named.runId)
        if (live) {
          live.run.cancel()
          release(named.runId)
        }
      }
      return
    }

    const live = runs.get(named.runId)
    if (!live) {
      // `run-hooks` for a run that never registered callbacks has nothing to do; the page asked about a run
      // whose hooks had already timed out or never existed, and the timeout already reported that.
      return
    }
    if (live.hooksTimer !== null) {
      clearTimeout(live.hooksTimer)
      live.hooksTimer = null
    }
    // Ignored unless the run is holding callbacks, which is the only state in which `run-hooks` means
    // anything: a run still executing its template runs its own callbacks when it finishes.
    live.run.runHooks()
    if (live.run.currentState === 'finished') release(named.runId)
  }

  return {
    handle,
    shutdown() {
      for (const live of runs.values()) {
        if (live.hooksTimer !== null) clearTimeout(live.hooksTimer)
        live.run.cancel()
      }
      runs.clear()
      opening.clear()
    },
    size: () => runs.size,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * A message that cannot be attributed to a run.
 *
 * Printed rather than answered, because answering requires an id to answer *about* and this build does not
 * invent identities. The reason goes with it, so a page that posted the wrong shape can find its own bug.
 */
function reportOrphan(code: string, detail: string): void {
  globalThis.console.error(`[templater worker] unrouteable message: ${code} ${detail}`)
}

/**
 * Bind to the thread.
 *
 * Guarded because the same module is imported by the worker's own tests to drive `createWorkerHandler`
 * directly, and jsdom's `self` would otherwise take the message handler away from whatever the page under
 * test is using. `WorkerGlobalScope` exists only on a real dedicated worker.
 */
function currentScope(): WorkerScope | null {
  if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'undefined') return null
  return globalThis as unknown as WorkerScope
}

const scope = currentScope()

if (scope) {
  const handler = createWorkerHandler(scope)
  scope.onmessage = (event: MessageEvent<WorkerRequest>) => handler.handle(event.data)
}
