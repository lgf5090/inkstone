/**
 * The one door from the interpreter to the page.
 *
 * `__host` is what a template can reach outside its own heap, so it is the whole attack surface, and it is
 * built from two frozen lists: `HOST_METHODS` decides which names exist, `HOST_METHOD_CAPABILITY` decides
 * which right each one needs. A name that is not on the list is refused here, in the worker, before any
 * message is posted — which is the point of putting the door on this side rather than only on the page's:
 * a template in a loop cannot turn the reader's notebook into a stream of modals, because the call that
 * would have opened the third one never leaves the thread.
 *
 * Three shapes of call, and the difference is only about who answers and whether the template waits:
 *
 * - `folder.list` and `template.read` are answered from the snapshot the run arrived with. The folders and
 *   the library templates are already in `TemplateRunContext`, so a round trip would buy latency and
 *   nothing else. They are still gated: `readOtherNotes` says whether this run may see them at all.
 * - `cursor.append` is sent and not waited for, because upstream it returns nothing and the editor needs
 *   the order the template asked for, not the order the page happened to reach. The call stays outstanding
 *   until the page answers it, which is what lets `vm.ts` refuse to report a run done while a write is
 *   still in flight.
 * - Everything else hands the template a QuickJS promise and waits for the page. This is the sync variant
 *   of the engine, so there is no way to block the interpreter on a host answer: the promise is created
 *   here, remembered, and settled by `deliver()` when the reply arrives, after which the runtime's job
 *   queue is pumped. A template that awaits inside a `.then()` is resolved from *within* a pending job, so
 *   one pump can produce another outstanding call before the queue drains — `vm.ts` re-reads
 *   `outstanding` after every pump for exactly that reason.
 *
 * Nothing on the wire is trusted as an answer for a live run unless the `runId` matches and the `callId` is
 * one this run is still waiting on. A reply for a cancelled run is dropped rather than thrown: the run it
 * belonged to no longer exists, its context is already disposed, and an error raised on the worker's own
 * event loop for a message nobody is waiting for would be the one failure mode that damages the other runs
 * sharing the thread.
 */
import { TemplaterError } from '../errors'
import type {
  Capabilities,
  HostMethod,
  HostResult,
  TemplateRunContext,
  WorkerMessage,
} from '../protocol'
import { HOST_METHOD_CAPABILITY, HOST_METHODS } from '../protocol'
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten-core'
import { isHostMethod, methodAllowed, methodIsAsync, methodIsSnapshotLocal } from './protocol'
import {
  MAX_CLIPBOARD_CHARS,
  MAX_HOST_ARG_CHARS,
  MAX_HOST_CALLS,
  MAX_HOST_RESULT_CHARS,
  MAX_OUTSTANDING_HOST_CALLS,
  MAX_PROMPT_ANSWER_CHARS,
} from './limits'

/** What `bootstrap.ts` gives the door: the marshalling helpers its own prelude closed over. */
export interface VmMarshalling {
  /** A JSON-safe host value, turned into a value inside the VM. The caller owns the handle. */
  toValue: (value: unknown) => QuickJSHandle
  /** An error inside the VM carrying a code token, so a rejection can be named without prose. */
  error: (code: string, detail?: string) => QuickJSHandle
}

export interface HostBindings {
  /** The `__host` object. `vm.ts` assigns it to the global of the same name. */
  readonly handle: QuickJSHandle
  /** Calls the page has not answered yet — waited-for and fire-and-forget alike. */
  readonly outstanding: number
  /** Calls this run has made, answered or not. */
  readonly calls: number
  /** Settle a reply against the call that asked for it. False when nothing was waiting on it. */
  deliver: (result: HostResult) => boolean
  /** Free every outstanding call without settling it, as `abandon` below explains. */
  abandon: () => void
  dispose: () => void
}

/**
 * A call that needs an answer, and the promise the template is holding while it waits.
 *
 * `deferred` is null for the fire-and-forget shape: the call is remembered so the ordering rule can be
 * enforced, but there is nothing left in the VM to settle.
 */
interface PendingCall {
  method: HostMethod
  deferred: QuickJSDeferredPromise | null
}

export interface HostBindingsOptions {
  context: QuickJSContext
  runId: string
  capabilities: Capabilities
  snapshot: TemplateRunContext
  marshalling: VmMarshalling
  post: (message: WorkerMessage) => void
  /** Ids come from one counter per run, so a reply can be matched without a shared namespace. */
  nextCallId: () => string
}

export function createHostBindings(options: HostBindingsOptions): HostBindings {
  const { context, runId, capabilities, snapshot, marshalling, post, nextCallId } = options
  const pending = new Map<string, PendingCall>()
  const namespaces = new Map<string, QuickJSHandle>()
  // Handles this side created and still owns. The engine's `setProp` copies its value rather than taking
  // it, so every function defined here has to be freed as well; the returned-handle cases are the ones the
  // engine's own call scope frees.
  const owned: QuickJSHandle[] = []
  const host = context.newObject()
  owned.push(host)
  let calls = 0

  /** The single implementation behind every shape of call. */
  function dispatch(method: unknown, args: unknown[]): QuickJSHandle | undefined {
    if (!isHostMethod(method)) {
      // Not on the list means it does not exist, and the template hears that rather than a permission
      // argument: reporting `capability-blocked` for `fs.unlink` would imply a way to be allowed it.
      throw new TemplaterError('not-supported', typeof method === 'string' ? method : '')
    }
    if (!methodAllowed(method, capabilities)) {
      throw new TemplaterError('capability-blocked', method)
    }
    if (calls >= MAX_HOST_CALLS) {
      // The run's own budget rather than the reader's rights, so the detail names the budget: a template
      // that prompts in a loop is broken, and "200" is what tells its author so.
      throw new TemplaterError('capability-blocked', `host-calls:${MAX_HOST_CALLS}`)
    }
    if (pending.size >= MAX_OUTSTANDING_HOST_CALLS) {
      throw new TemplaterError('capability-blocked', `outstanding:${MAX_OUTSTANDING_HOST_CALLS}`)
    }
    // A template can build a string far larger than any note may hold, and the arguments travel to the page
    // as one message. Measured here, on the already-dumped plain values, because the interpreter's own
    // strings are not the thing being bounded.
    if (measureArgs(args) > MAX_HOST_ARG_CHARS) {
      throw new TemplaterError('template-output-too-large', `host-args:${MAX_HOST_ARG_CHARS}`)
    }
    calls += 1

    if (methodIsSnapshotLocal(method)) return marshalling.toValue(snapshotAnswer(method, snapshot, args))

    const callId = nextCallId()
    const deferred = methodIsAsync(method) ? context.newPromise() : null
    post({ kind: 'host-call', call: { runId, callId, method, args } })
    pending.set(callId, { method, deferred })
    // Returning the promise handle transfers this reference into the interpreter; the engine's call scope
    // frees it, and `deliver` is what settles it later.
    return deferred ? deferred.handle : undefined
  }

  /**
   * One argument, read out of the interpreter.
   *
   * `dump` gives plain JavaScript, and the wire only carries plain JavaScript, so a function or a circular
   * object handed to a host call has no honest representation: it is refused with a code instead of being
   * turned into `{}`, which would let a template believe its callback reached the page.
   */
  function dumpArg(handle: QuickJSHandle): unknown {
    const value = context.dump(handle)
    if (typeof value === 'function') throw new TemplaterError('not-supported', 'function-argument')
    return value
  }

  /** `__host.note.read(...)`: one native function per allowlisted name, addressed by its dotted name. */
  for (const method of HOST_METHODS) {
    const dot = method.lastIndexOf('.')
    const namespace = namespaceOf(method.slice(0, dot))
    const leaf = method.slice(dot + 1)
    const fn = context.newFunction(leaf, (...handles) => dispatch(method, handles.map(dumpArg)))
    owned.push(fn)
    context.setProp(namespace, leaf, fn)
  }

  /**
   * The name-taking half of the door.
   *
   * `__host.call(method, args)` exists because the VM side of `tp.*` cannot enumerate the allowlist: the
   * user-script proxy hands over a key the template picked, and the `tp.file` wrappers want to pass their
   * arguments through as an array. Same gate, same budget, same accounting — the method name arrives as
   * data and is checked as data.
   */
  const callHandle = context.newFunction('call', (methodHandle, argsHandle) => {
    const method = methodHandle ? context.getString(methodHandle) : ''
    const raw = argsHandle ? context.dump(argsHandle) : []
    return dispatch(method, Array.isArray(raw) ? raw : [])
  })
  owned.push(callHandle)
  context.setProp(host, 'call', callHandle)

  function namespaceOf(path: string): QuickJSHandle {
    const existing = namespaces.get(path)
    if (existing) return existing
    const created = context.newObject()
    owned.push(created)
    namespaces.set(path, created)
    context.setProp(host, path, created)
    return created
  }

  return {
    handle: host,
    get outstanding() {
      return pending.size
    },
    get calls() {
      return calls
    },
    deliver(result) {
      // Two identities have to match before anything is touched: the run this binding belongs to, and a
      // call it is still waiting on. Anything else is a reply for a run that ended.
      if (result.runId !== runId) return false
      const waiting = pending.get(result.callId)
      if (!waiting) return false
      pending.delete(result.callId)
      const deferred = waiting.deferred
      // `abandon` may have freed this call's deferred already; the entry only survives while the call is
      // outstanding, so a reply arriving after that point has nothing to settle and is dropped.
      if (!deferred || !deferred.alive) return true
      if (result.ok) {
        const ceiling = sizeCeiling(waiting.method)
        const size = measure(result.value)
        if (size > ceiling) {
          deferred.reject(marshalling.error('template-output-too-large', `${waiting.method}:${ceiling}`))
        } else {
          deferred.resolve(marshalling.toValue(result.value))
        }
      } else {
        deferred.reject(marshalling.error(result.code, result.detail))
      }
      // `resolve` and `reject` free the deferred's own callback handles; `dispose` is the idempotent way
      // to make sure the promise reference is not kept alive past the answer.
      deferred.dispose()
      return true
    },
    abandon,
    dispose() {
      abandon()
      for (const handle of owned) {
        if (handle.alive) handle.dispose()
      }
      owned.length = 0
      namespaces.clear()
    },
  }

  /**
   * Free every outstanding call without settling it.
   *
   * Rejecting instead of dropping is what looks natural, and on this engine it is the wrong thing: a
   * rejection schedules a continuation for a template that is already gone, and a runtime freed with a job
   * still on its list aborts the whole WebAssembly module (`list_empty(&rt->gc_obj_list)` in
   * `JS_FreeRuntime`), which is fatal for the other runs sharing the worker. Measured both ways. Since the
   * context is being freed underneath them anyway, the promises do not need to be settled to be released —
   * only their host-side handles need freeing, which is what this does.
   */
  function abandon(): void {
    for (const entry of pending.values()) {
      if (entry.deferred && entry.deferred.alive) entry.deferred.dispose()
    }
    pending.clear()
  }
}

/**
 * The size a reply may be, per caller.
 *
 * The general ceiling is the note-sized one. The two answers that are not note-sized get their own, so an
 * oversized clipboard read fails loudly instead of arriving as text the template silently cut.
 */
function sizeCeiling(method: HostMethod): number {
  if (method === 'system.clipboard') return MAX_CLIPBOARD_CHARS
  if (method === 'system.prompt' || method === 'system.suggester' || method === 'system.multiSuggester') {
    return MAX_PROMPT_ANSWER_CHARS
  }
  return MAX_HOST_RESULT_CHARS
}

/** What one value weighs on the wire, in characters; `Infinity` when it cannot go on the wire at all. */
function measure(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (value === null || value === undefined) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    // Not something the wire can carry. Reported as too large rather than as a marshalling failure,
    // because from inside the VM those two read the same and one of them is a lie about the reader's data.
    return Number.POSITIVE_INFINITY
  }
}

/**
 * The answer the run already carries.
 *
 * Shapes follow what the snapshot holds, not what a template would like: `folder.list` gives the folder
 * records, `template.read` gives one library template by name. An unknown name is `null`, which is what
 * the exists-style calls already mean inside the VM.
 */
function snapshotAnswer(method: HostMethod, snapshot: TemplateRunContext, args: unknown[]): unknown {
  if (method === 'folder.list') return snapshot.folders.map((folder) => ({ ...folder }))
  if (method === 'template.read') {
    const name = typeof args[0] === 'string' ? args[0] : ''
    const found = snapshot.libraryTemplates.find((template) => template.name === name)
    return found ? { id: found.id, name: found.name, content: found.content } : null
  }
  return null
}

/** The capability a name needs, exposed for the diagnostics a failed call can print. */
export function capabilityOf(method: HostMethod): string {
  return HOST_METHOD_CAPABILITY[method]
}

/**
 * How much the arguments of one call weigh on the wire.
 *
 * Lengths of strings plus a small constant per other scalar, without serialising: `JSON.stringify` of a
 * megabyte of arguments to find out it was a megabyte is the cost this check exists to avoid.
 */
function measureArgs(args: unknown[]): number {
  let total = 0
  for (const arg of args) {
    if (typeof arg === 'string') total += arg.length
    else if (arg !== null && typeof arg === 'object') total += measureArgs(Object.values(arg)) + 8
    else if (arg !== null && arg !== undefined) total += 16
  }
  return total
}
