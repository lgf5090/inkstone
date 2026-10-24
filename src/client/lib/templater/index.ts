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
import { capabilitiesFor, type HostCall, type HostResult, type HostMethod, type ProgramSource, type TemplateRunContext } from './protocol'
import { MAX_COMMANDS } from './limits'
import { createTemplaterClient, type HostCallHandler, type TemplaterClient, type TemplaterRunOutcome, type WorkerPort } from './worker/client'
import { methodAllowed } from './worker/protocol'
import { createPageHost } from './host/page-host'
import { storePageHostPorts } from './host/store-port'
import { createPromptHost, PROMPT_HOST_METHODS } from './host/prompt-host'
import { createWebHost, WEB_HOST_METHODS } from './host/web-host'

export type { TemplaterRunOutcome, HostCallHandler }
export { capabilitiesFor, methodAllowed }
export { TEMPLATER_LIMITS } from './limits'
export { isHostMethod } from './worker/protocol'

/**
 * The page's host, once.
 *
 * Three modules answer the twenty-odd host methods between them, and one worker may only ever have one
 * answer per call: `configureTemplater` already says a second handler is a second policy. So the split by
 * subject — data, dialogs, the network — happens here, and the door keeps the only reference.
 */
interface InstalledHost {
  call: (call: HostCall) => Promise<HostResult>
  beginRun: (context: TemplateRunContext) => void
  endRun: (runId: string) => void
}

let installed: InstalledHost | null = null

/**
 * Install the app's real host: the note store, the reader's dialogs, the same-origin web proxy.
 *
 * Call it once at startup. Until it has been called the door answers every run with `sandbox-unavailable`,
 * which is the honest state of an app that has a template engine and no place to put its effects.
 *
 * `webRequestsEnabled` is the reader's switch for `tp.web.*`. It is a parameter, defaulting to off, because
 * the setting itself is not shipped yet (plan P10-1): a capability nobody has approved stays closed, and the
 * P10 card swaps the argument for a read of the settings bundle rather than leaving a default here.
 *
 * The return value exists because the write pipeline (`host/run-template.ts`) needs the same three hosts the
 * door installed — its ports are `notes.write/create`, `editor.open` and `page.createTarget` — and the one
 * thing that must not happen is a second page host beside the one answering host calls: two registries of
 * runs, two capability checks that can disagree. The door hands its own out rather than letting the wiring
 * build another, and stays free of the UI store itself, which is what keeps this module off the first
 * screen.
 */
export interface TemplaterHosts {
  page: ReturnType<typeof createPageHost>
  prompt: ReturnType<typeof createPromptHost>
  web: ReturnType<typeof createWebHost>
  /** The store seams the installed host is using, so a caller writes through the same path it does. */
  ports: ReturnType<typeof storePageHostPorts>
}

export function installTemplaterHost(options: { webRequestsEnabled?: () => boolean } = {}): TemplaterHosts {
  const webRequestsEnabled = options.webRequestsEnabled ?? (() => false)
  // The nested seam is the door handing itself to the page host: `note.renderInclude` starts a child run
  // through the same `renderTemplate` every other caller uses, which is what keeps one worker, one profile
  // and one capability check per call. `host/store-port.ts` takes it as an argument rather than importing
  // this file for the same reason `tests/templater-protocol-purity.test.ts` forbids the import.
  const ports = storePageHostPorts({
    render: (args) => renderTemplate(args),
    cancel: cancelTemplateRun,
  })
  const page = createPageHost(ports)
  const prompt = createPromptHost()
  const web = createWebHost({ webRequestsEnabled })
  const halves: ReadonlyArray<{ methods: readonly HostMethod[]; host: (call: HostCall) => Promise<HostResult> }> = [
    { methods: PROMPT_HOST_METHODS, host: prompt },
    { methods: WEB_HOST_METHODS, host: web },
  ]
  installed = {
    // The page host is the default, not a fourth list to keep in step: a name no half claims is answered
    // there, and it is the one module that knows how to say `not-supported` for a method the port's frozen
    // list carries but this build has not wired yet.
    call: (call) => (halves.find((half) => half.methods.includes(call.method as HostMethod))?.host ?? page)(call),
    beginRun: (context) => {
      page.beginRun(context)
      prompt.beginRun(context)
      web.beginRun(context)
    },
    endRun: (runId) => {
      // Order matters only in that each half owns its own cleanup; none of them may be skipped, because a
      // dialog left on screen after its run died is the failure a reader sees.
      page.endRun(runId)
      prompt.endRun(runId)
      web.endRun(runId)
    },
  }
  configureTemplater({ onHostCall: installed.call })
  return { page, prompt, web, ports }
}

/**
 * Register one run with the page's host and release it when it is over.
 *
 * The door does this rather than leaving it to every caller, because a run that is never released keeps its
 * whole snapshot alive: the page hosts each hold their contexts in a bounded map, and the bound is a leak
 * report, not a design. A nested render arrives here too — its own context, its own id.
 */
async function withRunLifecycle(context: TemplateRunContext, run: () => Promise<TemplaterRunOutcome>): Promise<TemplaterRunOutcome> {
  installed?.beginRun(context)
  try {
    return await run()
  } finally {
    installed?.endRun(context.runId)
  }
}

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
  return withRunLifecycle(args.context, () => active.run({
    kind: 'run',
    runId: args.context.runId,
    context: args.context,
    source: args.program.source,
    deadlineMs: args.deadlineMs ?? 0,
  }))
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
  // The three page hosts are dropped with the thread, not left holding the contexts of runs that can no
  // longer report in: `endRun` on a run that died mid-dialog is exactly what a reader would otherwise see.
  installed = null
}

/**
 * A new `runId`.
 *
 * Lives in `./run-id.ts` because the page host mints ids for the nested runs it starts, and a module under
 * `host/` may not import the door it is wired through — that would be a cycle. Re-exported so callers of
 * the door keep reaching it from here.
 */
export { createTemplateRunId } from './run-id'
