/**
 * The door the app walks through to run a Templater template.
 *
 * Everything above this file is plain data in, plain result out: the save path, the insertion command, the
 * preview and the dynamic-processor pass all come through here, and none of them touches the worker, the
 * interpreter or the wire. The one object callers must not have to think about is the worker itself, so it
 * is a module singleton created on first use — a page that spawned a thread per template would pay for the
 * engine load per template too.
 *
 * Two rules are set here rather than at each call site. A run resolves with a result or a failure code and
 * never rejects, so a save path cannot forget to catch a template written by somebody else. And the page's
 * answer to a host call is installed once, by `configureTemplater`, because it is the capability gate: two
 * different handlers would mean two different policies in one notebook.
 */
import { capabilitiesFor, type ProgramSource, type TemplateRunContext } from './protocol'
import { MAX_COMMANDS } from './limits'
import { createTemplaterClient, type HostCallHandler, type TemplaterClient, type TemplaterRunOutcome, type WorkerPort } from './worker/client'
import { methodAllowed } from './worker/protocol'

export type { TemplaterRunOutcome, HostCallHandler }
export { capabilitiesFor, methodAllowed }
export { TEMPLATER_LIMITS } from './limits'
export { isHostMethod } from './worker/protocol'

/** What the page has to provide before any template can run. */
export interface TemplaterConfig {
  /** The implementation of `HOST_METHODS`, and the second place a capability is checked. */
  onHostCall: HostCallHandler
  /**
   * How the thread is made. Overridable for tests and for nothing else: production gets the module worker
   * beside this file, and the interpreter inside it is the only thing that runs template code.
   */
  spawn?: () => WorkerPort
  /** Notified when a run registered `tp.hooks.on_all_templates_executed` callbacks. */
  onHooksArmed?: (runId: string, count: number) => void
}

let client: TemplaterClient | null = null

/**
 * Install the page's host.
 *
 * Calling this again replaces the client, and with it the worker: a second handler means a second policy,
 * and running one batch of templates under two of them is not a state worth preserving. Anything still in
 * flight is failed rather than orphaned, which is why the replacement is reported instead of silent.
 */
export function configureTemplater(config: TemplaterConfig): void {
  if (client) client.terminate()
  client = createTemplaterClient(config)
}

/** Whether the page has installed its host yet. The settings screen reads this before offering a run. */
export function templaterConfigured(): boolean {
  return client !== null
}

/**
 * Render one compiled program.
 *
 * The outcome is always a result: `{ ok: true, output }` when the template produced text, `{ ok: false,
 * code, detail }` for everything else — a timeout, a capability the run did not have, a worker that could
 * not be started. Nothing here throws on the reader's behalf, because the alternative is a save path that
 * only works if every caller remembers a `try`.
 */
export async function renderTemplate(args: {
  program: ProgramSource
  context: TemplateRunContext
  onHostCall?: HostCallHandler
  deadlineMs?: number
}): Promise<TemplaterRunOutcome> {
  const active = client ?? (args.onHostCall ? createTemplaterClient({ onHostCall: args.onHostCall }) : null)
  if (!active) {
    // Configured late or called early: reported as the app not being ready rather than as a template
    // failure, because the reader's template is fine and nothing ran.
    return { ok: false, code: 'sandbox-unavailable', detail: 'unconfigured' }
  }
  if (args.program.commandCount > MAX_COMMANDS) {
    // The parser counted the commands, so this is exact rather than estimated. Refused before the source is
    // posted: a program over budget is not going to render inside the deadline anyway, and the reader would
    // see a timeout instead of the reason.
    return { ok: false, code: 'not-supported', detail: `commands:${MAX_COMMANDS}` }
  }
  return active.run({
    kind: 'run',
    runId: args.context.runId,
    context: args.context,
    source: args.program.source,
    deadlineMs: args.deadlineMs ?? 0,
  })
}

/** Stop a run the reader walked away from. Its `renderTemplate` resolves as a cancellation. */
export function cancelTemplateRun(runId: string): void {
  client?.cancel(runId)
}

/**
 * Ask one finished run to fire its hooks.
 *
 * The callbacks exist only inside the interpreter that registered them, so this is the only way they run. A
 * run that never armed any is ignored rather than reported: there is nothing to do and saying so would be
 * the louder failure.
 */
export function runTemplaterHooks(runId: string): void {
  client?.runHooks(runId)
}

/** How many runs the page is waiting on, for a batch that wants to know when it is done. */
export function liveTemplateRuns(): number {
  return client?.live() ?? 0
}

/** Stop the thread. Everything in flight fails; the next run starts a fresh worker. */
export function terminateTemplater(): void {
  client?.terminate()
  client = null
}

/**
 * A new `runId`.
 *
 * Lives in `./run-id.ts` because the page host mints ids for the nested runs it starts, and a module under
 * `host/` may not import the door it is wired through — that would be a cycle. Re-exported so callers of
 * the door keep reaching it from here.
 */
export { createTemplateRunId } from './run-id'
