/**
 * The worker's half of the wire: what may come in, what goes out, and what it means.
 *
 * `../protocol.ts` fixes the *shapes*; this file is the part that only the worker needs. Two jobs. First,
 * validation: a message arriving at `self.onmessage` is data, and the interpreter must never be handed
 * an unexamined field — so a run request is checked for the fields it actually drives (an id, a source
 * within budget, a deadline inside the clamp) and rejected as a failure code rather than throwing inside
 * the worker's own event handler, where a thrown value would kill the thread every other run shares.
 *
 * Second, the gate. `TemplateRunContext.capabilities` is a *name* (`'community'`), while
 * `HOST_METHOD_CAPABILITY` is keyed by the eight booleans a call is checked against. The name is resolved
 * into rights inside the worker (`vm.ts`, through `capabilitiesFor` in the contract), because the
 * alternative is trusting the page to have decided them first — and the page is the same code that
 * compiled an untrusted template. Every call is then re-checked here, in `host-bindings.ts`, against the
 * run's own copy.
 *
 * Runs are addressed by `runId` and calls by `callId`, both carried on every message in both directions.
 * That is the deliberate break from `../../dataview/js.ts`, whose `ask()` keeps one reply slot per worker:
 * one worker can hold several runs, one of which is sitting in a modal waiting for the reader while
 * another starts beside it, and a single in-flight message cannot express either. The cost is that
 * replies must be matched rather than assumed, which is what `callId` and the pending map are for.
 */
import {
  CAPABILITY_PROFILES,
  HOST_METHODS,
  HOST_METHOD_CAPABILITY,
  type Capabilities,
  type HostCall,
  type HostMethod,
  type HostResult,
  type RunMode,
  type RunRequest,
  type TemplateRunContext,
  type WorkerMessage,
} from '../protocol'
import {
  DEFAULT_RUN_DEADLINE_MS,
  MAX_PROGRAM_BYTES,
  MAX_RUN_DEADLINE_MS,
  MIN_RUN_DEADLINE_MS,
} from '../limits'

/** The modes the interpreter can be told it is in; anything else is a message this build cannot read. */
const RUN_MODES: readonly string[] = [
  'create-new',
  'append-active',
  'overwrite-file',
  'overwrite-active',
  'dynamic-processor',
  'startup',
  // Upstream's six plus the one mode this app added for a caller that renders a body and writes it
  // itself. The interpreter needs no new behaviour from it — `run_mode` reports create-new's number —
  // but a name the page can send and this list does not hold would refuse the run before it started.
  'render-only',
]

/** The profiles, for the same reason: a name that is not one of these has no table and no rights. */
const PROFILES: readonly string[] = Object.keys(CAPABILITY_PROFILES)

// The rights themselves are the contract's, not this file's: see `CAPABILITY_PROFILES` in
// `../protocol.ts`, where the method-to-right table beside it lives. A copy of the matrix on the worker
// side is one drift away from a gate that disagrees with the page's settings screen.

/** Whether one capability is granted; kept apart from the gate below so the table has one door. */
export function methodCapability(method: HostMethod): keyof Capabilities {
  return HOST_METHOD_CAPABILITY[method]
}

/**
 * The one permission test the worker makes.
 *
 * Called on every host call, from the run's own copy of the rights — never from anything the template
 * says. The page host checks again on its side (that is where settings and consent live), but a call
 * refused here never leaves the thread, which is what keeps a looping template from becoming a flood of
 * modals.
 */
export function methodAllowed(method: HostMethod, capabilities: Capabilities): boolean {
  return capabilities[methodCapability(method)] === true
}

/** Membership in the allowlist, from the frozen list rather than from a copy of it. */
export function isHostMethod(value: unknown): value is HostMethod {
  return typeof value === 'string' && (HOST_METHODS as readonly string[]).includes(value)
}

/**
 * Which calls the template may wait for.
 *
 * Everything except three names. `cursor.append` tells the editor where to put a cursor after the write
 * it already made: upstream it returns nothing and the order matters, so it is sent and left unsatisfied
 * — `vm.ts` still waits for its answer before reporting the run done, which is why it is not "promised".
 * `folder.list` and `template.read` are answered from the snapshot the run was given: the folders and the
 * library templates are already in `TemplateRunContext`, so a round trip to the page would only make the
 * template slower and put the answer behind an await it does not need.
 *
 * `system.clipboard`, `folder.create` and `app.commands` are promise-backed even though the plan's list
 * did not name them: the worker has no clipboard, no folder table beyond the snapshot, and no command
 * registry, so there is nothing to return synchronously. Returning `undefined` for those would be the
 * silent failure this package exists to avoid.
 */
const SYNC_METHODS: readonly HostMethod[] = ['cursor.append', 'folder.list', 'template.read']

/** The names answered inside the worker from the run's own snapshot, with no message on the wire. */
const SNAPSHOT_METHODS: readonly HostMethod[] = ['folder.list', 'template.read']

/** Whether the call settles in the VM with a promise the page answers. */
export function methodIsAsync(method: HostMethod): boolean {
  return !SYNC_METHODS.includes(method)
}

/** Whether the worker can answer without asking the page for anything. */
export function methodIsSnapshotLocal(method: HostMethod): boolean {
  return SNAPSHOT_METHODS.includes(method)
}

/** A failure that is the message's fault rather than the template's; `detail` names the field, never prose. */
export interface RequestRejection {
  ok: false
  code: string
  detail: string
}

export interface RunSourceCheck {
  /** The parser's own command count, when the caller has it; over budget means the run must not start. */
  commandCount?: number
}

export type ValidatedRunRequest = { ok: true; request: RunRequest } | RequestRejection

/**
 * A run request, checked enough to be executed.
 *
 * The deadline is clamped rather than validated: the page asking for a number this build does not allow
 * is a bug in one caller, and the safe reading of "the page asked for an hour" is "the page asked for as
 * much as the sandbox promises", not "refuse to run the reader's own template".
 *
 * Only the fields this side reads are checked. `context` is opaque here on purpose — it is the page's
 * snapshot, and its shape is `../protocol.ts`'s business; a worker that re-validated it would be a second
 * place to keep the same list in step.
 */
export function validateRunRequest(raw: unknown): ValidatedRunRequest {
  const request = asRecord(raw)
  if (!request) return reject('render-failed', 'request')
  if (request.kind !== 'run') return reject('render-failed', 'kind')

  const runId = request.runId
  if (typeof runId !== 'string' || !runId) return reject('render-failed', 'runId')

  const source = request.source
  if (typeof source !== 'string' || !source) return reject('render-failed', 'source')
  // Byte budget, not character: the source is what the interpreter compiles, and the cost is the copy of
  // it the engine holds. `length` over-counts astral characters, which only makes the ceiling stricter.
  if (source.length > MAX_PROGRAM_BYTES) return reject('render-failed', 'source')

  const context = asRecord(request.context)
  if (!context) return reject('render-failed', 'context')
  if (context.runId !== runId) return reject('render-failed', 'context.runId')
  if (typeof context.mode !== 'string' || !RUN_MODES.includes(context.mode)) {
    return reject('render-failed', 'context.mode')
  }
  if (typeof context.capabilities !== 'string' || !PROFILES.includes(context.capabilities)) {
    return reject('render-failed', 'context.capabilities')
  }

  const deadline = clampDeadline(request.deadlineMs)
  return {
    ok: true,
    request: {
      kind: 'run',
      runId,
      context: context as unknown as TemplateRunContext,
      source,
      deadlineMs: deadline,
    },
  }
}

/** The clamp, split out so `DEFAULT_RUN_DEADLINE_MS` is the documented answer to a missing number. */
export function clampDeadline(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_RUN_DEADLINE_MS
  }
  return Math.min(Math.max(value, MIN_RUN_DEADLINE_MS), MAX_RUN_DEADLINE_MS)
}

/** A host reply, checked for the two fields the pending map needs; the value itself stays opaque. */
export function validateHostReply(raw: unknown): HostResult | null {
  const request = asRecord(raw)
  if (!request || request.kind !== 'host-reply') return null
  const result = asRecord(request.result)
  if (!result) return null
  const callId = result.callId
  const runId = result.runId
  if (typeof callId !== 'string' || !callId) return null
  if (typeof runId !== 'string' || !runId) return null
  if (result.ok === true) return { runId, callId, ok: true, value: result.value }
  if (result.ok === false) {
    const code = typeof result.code === 'string' && result.code ? result.code : 'render-failed'
    const detail = typeof result.detail === 'string' ? result.detail : undefined
    return detail === undefined
      ? { runId, callId, ok: false, code }
      : { runId, callId, ok: false, code, detail }
  }
  return null
}

/** The two requests that name a run rather than carry one. */
export function readRunId(raw: unknown): { kind: 'run-hooks' | 'cancel'; runId: string } | null {
  const request = asRecord(raw)
  if (!request || (request.kind !== 'run-hooks' && request.kind !== 'cancel')) return null
  if (typeof request.runId !== 'string' || !request.runId) return null
  return { kind: request.kind, runId: request.runId }
}

/** One more call id for one run. Uniqueness only has to hold inside the run, so a counter is enough. */
export function createCallIdFactory(): (method: HostMethod) => string {
  let next = 0
  return () => `c${++next}`
}

/** The message that hands a rendered template back to the page. */
export function doneMessage(runId: string, output: string, durationMs: number): WorkerMessage {
  return { kind: 'done', runId, output, durationMs }
}

/** The message that says why a run did not render. `code` is a token from `../errors.ts`, not a sentence. */
export function failedMessage(runId: string, code: string, detail?: string): WorkerMessage {
  return detail === undefined ? { kind: 'failed', runId, code } : { kind: 'failed', runId, code, detail }
}

/** The message that asks the page to do something on the run's behalf. */
export function hostCallMessage(call: HostCall): WorkerMessage {
  return { kind: 'host-call', call }
}

/** The message that tells the page this run has callbacks waiting for `run-hooks`. */
export function hooksArmedMessage(runId: string, count: number): WorkerMessage {
  return { kind: 'hooks-armed', runId, count }
}

/** The run's mode, read back after the shape check above has already rejected anything else. */
export function runModeOf(context: TemplateRunContext): RunMode {
  return context.mode
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function reject(code: string, detail: string): RequestRejection {
  return { ok: false, code, detail }
}
