/**
 * One interpreter per run, with the three limits that make it safe to hand to a stranger's code.
 *
 * A run gets its own `runtime` and its own `context`. That is not tidiness: the runtime owns the heap, the
 * stack ceiling and the interrupt handler, and sharing one between two templates would let a template that
 * filled its own heap take down a run the reader is watching. The cost is a fresh context per run — tens of
 * milliseconds — while the WebAssembly module itself is built once per worker and reused.
 *
 * The deadline is the interesting one, and it measures CPU rather than wall clock. A template that reaches
 * `tp.system.prompt` hands control back to the worker while the reader composes an answer, and two seconds
 * of reading a dialog is not two seconds of the template's own execution. So the budget is kept as
 * *remaining time*: the interrupt handler is armed at the start of each synchronous slice with what is left,
 * and the slice's elapsed time is taken off when it returns. Waiting on the page is free; running is not.
 * The alternative — one deadline computed when the run starts — turns any prompt that outlasts the budget
 * into a timeout, which is a bug the reader would meet daily. `vm.test.ts` holds both halves: a spinning
 * program is stopped, and a program whose reply arrives after four times its own budget still renders.
 *
 * Two consequences of that choice are handled here rather than left to chance. A run whose program has
 * already returned can still have fire-and-forget calls outstanding (`cursor.append`), and reporting it
 * done while the page is mid-write is how a note ends up with its cursor jump applied to the wrong text —
 * so settling the promise is not the end of the run until every call has an answer. And a template that
 * awaits inside a `.then()` is resumed from *within* a pending job, which can leave a new outstanding call
 * behind before the queue drains, so the outstanding count is re-read after every pump rather than once.
 */
import { templaterErrorCode, templaterErrorDetail } from '../errors'
import type { HostResult, RunRequest, WorkerMessage } from '../protocol'
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core'
import baseVariant from '@jitl/quickjs-wasmfile-release-sync'
// `?url`, the same idiom `features/chat/brand-icon-assets.ts` uses: in a browser the engine's glue has to
// fetch the module, and this package ships no type for the bare `/wasm` subpath even though its `exports`
// map resolves it. A query suffix is what `vite/client` declares.
import wasmAsset from '@jitl/quickjs-wasmfile-release-sync/wasm?url'
import { createBootstrap, type Bootstrap } from './bootstrap'
import { createHostBindings, type HostBindings } from './host-bindings'
import { capabilitiesFor } from './protocol'
import {
  DEFAULT_RUN_DEADLINE_MS,
  HOOKS_DEADLINE_MS,
  MAX_OUTPUT_CHARS,
  RUNTIME_MEMORY_BYTES,
  STACK_BYTES,
} from './limits'

/** The program's own file name, which every reported stack frame is matched against. */
const PROGRAM_NAME = 'template.js'

/**
 * Where a run is.
 *
 * `hooks` is a finished, already reported run kept alive only so its registered callbacks can still be
 * invoked; whether a run is sitting on an unanswered host call is `awaitingPage`, not a state, because the
 * answer is what makes it move again.
 */
export type RunState = 'new' | 'running' | 'hooks' | 'finished'

/** The engine, loaded once per worker. */
let engine: Promise<QuickJSWASMModule> | null = null

/**
 * The wasm, however this build handed it over.
 *
 * Two answers are possible and both are real: a bundler that compiles the file into the bundle gives a
 * `WebAssembly.Module` (what the test configuration does, and what a Cloudflare Worker does), while one
 * that treats it as an asset gives a URL the engine's own glue has to fetch. Rather than picking one and
 * hoping, the value is inspected: a module goes straight to instantiation, a URL becomes the location
 * Emscripten loads, and anything else leaves the package's default lookup alone.
 */
function buildVariant() {
  const asset = wasmAsset as unknown
  if (asset instanceof WebAssembly.Module) return newVariant(baseVariant, { wasmModule: asset })
  if (typeof asset === 'string' && asset) return newVariant(baseVariant, { wasmLocation: asset })
  return baseVariant
}

/**
 * The interpreter, built once and reused.
 *
 * Instantiating the module is the expensive part, and every run after the first pays tens of milliseconds.
 * A failed load is not cached: the next run tries again, because a worker that failed to load once has not
 * necessarily lost the module for good.
 */
export function loadEngine(): Promise<QuickJSWASMModule> {
  const pending = newQuickJSWASMModuleFromVariant(buildVariant())
  engine ??= pending
  pending.catch(() => {
    // Only forget the promise if nothing replaced it in the meantime, so a retry is not thrown away by the
    // failure that triggered it.
    if (engine === pending) engine = null
  })
  return engine
}

export class TemplateRun {
  private readonly runtime: QuickJSRuntime
  private readonly context: QuickJSContext
  private readonly bootstrap: Bootstrap
  private readonly host: HostBindings
  private readonly post: (message: WorkerMessage) => void
  private readonly source: string
  private readonly deadlineMs: number
  private readonly startedAt: number
  private readonly runId: string

  /** The promise the compiled program returned, kept until the run is over. */
  private program: QuickJSHandle | null = null
  /** The CPU budget left, in milliseconds; the interrupt handler is armed from this. */
  private remainingMs: number
  /** The separate budget the hooks phase runs on. */
  private hooksRemainingMs = HOOKS_DEADLINE_MS
  private state: RunState = 'new'
  private collected = false
  /** Set when the engine threw at the host level; see `poison` for why that runtime is never freed. */
  private leaked = false
  private output = ''
  private hookIndex = 0

  private constructor(args: {
    runtime: QuickJSRuntime
    context: QuickJSContext
    bootstrap: Bootstrap
    host: HostBindings
    post: (message: WorkerMessage) => void
    request: RunRequest
  }) {
    this.runtime = args.runtime
    this.context = args.context
    this.bootstrap = args.bootstrap
    this.host = args.host
    this.post = args.post
    this.source = args.request.source
    this.runId = args.request.runId
    this.deadlineMs = args.request.deadlineMs > 0 ? args.request.deadlineMs : DEFAULT_RUN_DEADLINE_MS
    this.remainingMs = this.deadlineMs
    this.startedAt = Date.now()
  }

  /**
   * A run, ready to start: runtime and context built, limits set, namespace installed.
   *
   * Everything that can fail here is the app failing rather than the template — an engine that would not
   * load, a namespace that would not build — and it rejects so the caller can report `sandbox-unavailable`
   * instead of leaving a half-built interpreter behind.
   */
  static async open(request: RunRequest, post: (message: WorkerMessage) => void): Promise<TemplateRun> {
    const interpreter = await loadEngine()
    const runtime = interpreter.newRuntime()
    // Both ceilings go on the runtime before any context exists: the memory limit is what the allocator
    // consults, and the stack ceiling is what turns runaway recursion into an error instead of into a wasm
    // trap that takes the worker thread down with it.
    runtime.setMemoryLimit(RUNTIME_MEMORY_BYTES)
    runtime.setMaxStackSize(STACK_BYTES)
    const context = runtime.newContext()
    try {
      const bootstrap = createBootstrap({
        context,
        locale: request.context.locale,
        log: (level, text) => {
          // Console output has no channel on the frozen wire, so it goes to the worker's own console, which
          // is where a template author already looks. The run id is on every line because one worker can be
          // carrying several runs at once.
          globalThis.console.log(`[templater ${request.runId}] ${level}: ${text}`)
        },
      })
      let next = 0
      const host = createHostBindings({
        context,
        runId: request.runId,
        capabilities: capabilitiesFor(request.context.capabilities),
        snapshot: request.context,
        marshalling: { toValue: bootstrap.toValue, error: bootstrap.error },
        post,
        nextCallId: () => `c${++next}`,
      })
      bootstrap.install({ snapshot: request.context, host: host.handle })
      return new TemplateRun({ runtime, context, bootstrap, host, post, request })
    } catch (error) {
      // The namespace or the door failed to build, so nothing may be left holding the heap: a runtime that
      // nobody will ever run again is a leak the worker would carry until it was terminated.
      disposeQuietly(context, runtime, request.runId)
      throw error
    }
  }

  get currentState(): RunState {
    return this.state
  }

  get id(): string {
    return this.runId
  }

  /** How many callbacks the template registered; the worker uses this to decide whether to keep the run. */
  get armedHooks(): number {
    return this.bootstrap.hookCount()
  }

  /** Evaluate the program and run it as far as it can go without the page. */
  start(): void {
    if (this.state !== 'new') return
    this.state = 'running'
    this.armDeadline()
    const slice = Date.now()
    let evaluated: ReturnType<QuickJSContext['evalCode']>
    try {
      evaluated = this.context.evalCode(this.source, PROGRAM_NAME)
    } catch (error) {
      this.charge(slice)
      this.poison(error)
      return
    }
    this.charge(slice)
    if (evaluated.error) {
      const failure = this.readError(evaluated.error)
      evaluated.error.dispose()
      // A body the interpreter will not parse is the compiler's failure rather than the reader's: the
      // parser already refused the template text, so this is not a message about the template.
      this.report(failure.code, failure.detail)
      this.disposeNow()
      return
    }
    this.program = evaluated.value
    this.pump()
  }

  /**
   * One answer from the page.
   *
   * A reply nothing is waiting on — a cancelled run, a duplicated reply, a reply for a run id this worker
   * never had — is dropped rather than thrown. The alternative raises inside the worker's own message
   * handler, which belongs to every other run sharing the thread.
   */
  deliver(result: HostResult): void {
    if (this.state === 'finished') return
    if (!this.host.deliver(result)) return
    // The hooks phase and the program phase resume differently: a hook that was mid-flight has to continue
    // at its own index, while an answer to the template's own await just goes back to pumping.
    if (this.state === 'hooks') this.runHookPhase()
    else this.pump()
  }

  /**
   * Run the callbacks `tp.hooks.on_all_templates_executed` kept.
   *
   * They get their own short budget: they cannot prompt, and their return value is discarded, so a hook
   * that spins has no business holding a runtime open. A hook that throws is reported on the wire *after*
   * the run's `done`, because the reader's rendered text is already earned and must not be lost to a
   * callback that ran afterwards.
   */
  runHooks(): void {
    if (this.state !== 'hooks') return
    this.runHookPhase()
  }

  /** Stop the run and free it. Anything the page still owes is dropped, not answered. */
  cancel(): void {
    if (this.state === 'finished' || this.leaked) return
    this.disposeNow()
  }

  /** Whether the run is blocked on an answer the page has not sent. */
  get awaitingPage(): boolean {
    return this.host.outstanding > 0
  }

  /**
   * The pump: drain the job queue, then decide what the run is waiting for.
   *
   * This is the only place a run's state advances, and it always ends one of four ways: the program
   * settled, the page owes an answer, the budget ran out, or the interpreter refused to continue.
   */
  /**
   * Whether this run has already reported its result.
   *
   * An accessor rather than `this.state === 'finished'` at the call sites: those checks sit after a call
   * into `runJobs()`/`runHookJobs()`, which can settle the run from inside, but TypeScript has already
   * narrowed `'finished'` out of `this.state` by the earlier guard at the top of the same function and
   * reports the comparison as impossible. Reading the field through a method is what lets the runtime
   * possibility survive the static one — deleting the check would be the actual bug.
   */
  private get finished(): boolean {
    return this.state === 'finished'
  }

  private pump(): void {
    if (this.state === 'finished') return
    const drained = this.runJobs()
    if (drained === false || this.finished) return

    // Outstanding first: a pending promise with a call in flight is a template waiting for a reader, not a
    // deadlocked one, and the difference is exactly what this order protects.
    if (this.host.outstanding > 0) {
      return
    }

    if (this.collected) {
      this.finish()
      return
    }

    const promise = this.program
    if (!promise) return
    const settled = this.context.getPromiseState(promise)
    if (settled.type === 'pending') {
      // No outstanding call, no queued job, no value: the program is awaiting something this interpreter
      // cannot provide. Reported rather than left to the deadline, because the template is fine and only
      // its assumption is wrong, and a timeout would send the reader looking for a loop.
      this.report('render-failed', 'unresolvable')
      this.disposeNow()
      return
    }
    if (settled.type === 'rejected') {
      const failure = this.readError(settled.error)
      settled.error.dispose()
      this.report(failure.code, failure.detail)
      this.disposeNow()
      return
    }
    this.collectOutput(settled.value)
    settled.value.dispose()
    this.finish()
  }

  /** Pump the job queue, charging the time it took against the CPU budget. */
  private runJobs(): boolean {
    this.armDeadline()
    const slice = Date.now()
    while (true) {
      let result: ReturnType<QuickJSRuntime['executePendingJobs']>
      try {
        result = this.runtime.executePendingJobs()
      } catch (error) {
        this.charge(slice)
        this.poison(error)
        return false
      }
      if (result.error) {
        this.charge(slice)
        const failure = this.readError(result.error)
        result.error.dispose()
        this.report(failure.code, failure.detail)
        this.disposeNow()
        return false
      }
      if (result.value === 0) break
    }
    this.charge(slice)
    return true
  }

  /** The hooks phase, resumed from wherever it stopped. */
  private runHookPhase(): void {
    if (this.state === 'finished') return
    const count = this.armedHooks
    while (this.hookIndex < count) {
      const hook = this.bootstrap.hookHandle(this.hookIndex)
      const slice = Date.now()
      this.armHookDeadline()
      let called: ReturnType<QuickJSContext['callFunction']>
      try {
        called = this.context.callFunction(hook, this.context.undefined, [])
      } catch (error) {
        this.chargeHooks(slice)
        this.poison(error)
        return
      }
      hook.dispose()
      if (called.error) {
        this.chargeHooks(slice)
        const failure = this.readError(called.error)
        called.error.dispose()
        this.report(failure.code, failure.detail)
        this.disposeNow()
        return
      }
      called.value.dispose()
      this.hookIndex += 1
      const drained = this.runHookJobs(slice)
      if (!drained || this.finished) return
      if (this.host.outstanding > 0) {
        // A hook that awaits: the answer re-enters this loop at the same index, so a callback that asks the
        // reader a question behaves like the template itself rather than like a stalled process.
        return
      }
    }
    this.disposeNow()
  }

  /**
   * Drain jobs during the hooks phase.
   *
   * Separate from `runJobs` because the budget is separate: the template's own CPU time was already spent
   * and reported, and a callback that spins must not inherit what the program left behind.
   */
  private runHookJobs(sliceStart: number): boolean {
    while (true) {
      this.armHookDeadline()
      let result: ReturnType<QuickJSRuntime['executePendingJobs']>
      try {
        result = this.runtime.executePendingJobs()
      } catch (error) {
        this.chargeHooks(sliceStart)
        this.poison(error)
        return false
      }
      if (result.error) {
        this.chargeHooks(sliceStart)
        const failure = this.readError(result.error)
        result.error.dispose()
        this.report(failure.code, failure.detail)
        this.disposeNow()
        return false
      }
      if (result.value === 0) break
    }
    this.chargeHooks(sliceStart)
    return true
  }

  /**
   * A failure that came out of the engine as a host exception rather than as an error handle.
   *
   * This is the one case the measured stack ceiling does not cover: a template whose own frames are large
   * enough can still exhaust the stack the WebAssembly instance has before QuickJS notices, and the
   * `RangeError` arrives through the FFI. The runtime behind it must then be **leaked, not freed** — freeing
   * it aborts the entire WebAssembly module with `list_empty(&rt->gc_obj_list)` inside `JS_FreeRuntime`,
   * which would take every other run on the worker down with it. A leaked runtime costs one heap; an aborted
   * module costs the page. Measured both ways in this package's own probe before the line below was written.
   */
  private poison(error: unknown): void {
    this.leaked = true
    const failure = this.classifyHostThrow(error)
    this.report(failure.code, failure.detail)
    this.state = 'finished'
    // Nothing in this interpreter is touched again — not the outstanding promises, not the handles, not the
    // context. Each of those is a call into the runtime that just blew its stack, and the probe that
    // measured this behaviour found the module stays healthy exactly when nothing is freed. The heap of one
    // run is the price; the alternative measured out as an aborted module.
    globalThis.console.warn(`[templater ${this.runId}] interpreter left undisposed: ${String(error)}`)
  }

  private classifyHostThrow(error: unknown): { code: string; detail: string } {
    const message = error instanceof Error ? error.message : String(error)
    const name = error instanceof Error ? error.name : 'Error'
    if (/call stack/i.test(message)) return { code: 'sandbox-stack-overflow', detail: `${STACK_BYTES}` }
    if (/out of memory|memory limit/i.test(message)) return { code: 'sandbox-out-of-memory', detail: `${RUNTIME_MEMORY_BYTES}` }
    return { code: 'render-failed', detail: `${name}: ${message}` }
  }

  /**
   * Arm the interrupt handler for one synchronous slice.
   *
   * The engine consults this handler between instructions, so a program that spins is stopped mid-loop
   * rather than being left to a timer nobody can service while the interpreter owns the thread. The
   * deadline is computed from the *remaining* budget, which is what makes waiting on the page free.
   */
  private armDeadline(): void {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.remainingMs))
  }

  /** The hooks phase gets its own ceiling, never the template's remaining time. */
  private armHookDeadline(): void {
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.hooksRemainingMs))
  }

  private chargeHooks(sliceStart: number): void {
    this.hooksRemainingMs -= Date.now() - sliceStart
  }

  private charge(sliceStart: number): void {
    this.remainingMs -= Date.now() - sliceStart
  }

  /** The settled value, read out. A string is the output; anything else falls back to the global `tR`. */
  private collectOutput(value: QuickJSHandle): void {
    this.collected = true
    if (this.context.typeof(value) === 'string') {
      this.output = this.context.getString(value)
      return
    }
    this.output = this.bootstrap.readOutput()
  }

  private finish(): void {
    if (this.output.length > MAX_OUTPUT_CHARS) {
      // Reported, not truncated: a reader who asked for a note deserves to know the template produced
      // something the product cannot store, rather than getting half of it.
      this.report('template-output-too-large', `${MAX_OUTPUT_CHARS}`)
      this.disposeNow()
      return
    }
    const duration = Date.now() - this.startedAt
    const hooks = this.armedHooks
    if (hooks > 0) {
      // `hooks-armed` then `done`, so a page that waits for every run in a batch before sending
      // `run-hooks` can register the wait before the run resolves. The runtime stays alive for the
      // callbacks; the worker owns the timer that gives up on them.
      this.post({ kind: 'hooks-armed', runId: this.runId, count: hooks })
      this.post({ kind: 'done', runId: this.runId, output: this.output, durationMs: duration })
      this.state = 'hooks'
      return
    }
    this.post({ kind: 'done', runId: this.runId, output: this.output, durationMs: duration })
    this.disposeNow()
  }

  /** One failure on the wire, with a code the interface can translate. */
  private report(code: string, detail: string): void {
    this.post({ kind: 'failed', runId: this.runId, code, detail })
  }

  /**
   * The interpreter's error, read into a code.
   *
   * Order matters. The engine's own words come first, because they are the three cases the sandbox exists
   * to draw a line under: a program that was stopped, a heap that filled, a stack that ran out. Only after
   * those is the message read as a token the errors table knows, which is how a refusal raised from inside
   * the VM (`capability-blocked: note.write`) reaches the page as exactly that code.
   */
  private readError(handle: QuickJSHandle): { code: string; detail: string } {
    const dumped = this.context.dump(handle) as { name?: unknown; message?: unknown } | undefined
    const message = typeof dumped?.message === 'string' ? dumped.message : ''
    const name = typeof dumped?.name === 'string' ? dumped.name : ''
    if (/interrupt/i.test(message)) return { code: 'sandbox-timeout', detail: `${this.deadlineMs}ms` }
    if (/memory limit|out of memory|not enough memory/i.test(message)) {
      return { code: 'sandbox-out-of-memory', detail: `${RUNTIME_MEMORY_BYTES}` }
    }
    if (/stack overflow|too much recursion|maximum call stack/i.test(message)) {
      return { code: 'sandbox-stack-overflow', detail: `${STACK_BYTES}` }
    }
    const code = templaterErrorCode(message)
    const detail = templaterErrorDetail(message)
    if (code === 'render-failed' && message) {
      // Nothing recognised it, so the interpreter's own words are the only description there is. Kept in
      // full rather than dropped: a reader holding a stack frame can find the line.
      return { code, detail: `${name ? `${name}: ` : ''}${message}` }
    }
    return { code, detail }
  }

  /** Free everything this run held, without reporting anything. */
  private disposeNow(): void {
    this.state = 'finished'
    if (this.leaked) return
    if (this.program) {
      if (this.program.alive) this.program.dispose()
      this.program = null
    }
    // Order matters and is measured, not stylistic: `host.dispose()` has to release the outstanding prompts
    // *before* the context is freed, because a deferred rejected on the way out leaves a continuation in the
    // job queue, and freeing a runtime with work still queued on it aborts the entire WebAssembly module
    // (`list_empty(&rt->gc_obj_list)` in `JS_FreeRuntime`) — fatal for every other run on this worker.
    this.host.dispose()
    this.bootstrap.dispose()
    disposeQuietly(this.context, this.runtime, this.runId)
  }
}

/**
 * Dispose a context and its runtime, tolerating a refusal.
 *
 * An interpreter that stopped on an interrupt can be mid-instruction on the C side and refuse to be freed,
 * and a runtime whose handles the template leaked will complain too. Both are reported to the worker's own
 * console — never swallowed — and neither is retried, because the run's answer has already gone out on the
 * wire and a cleanup complaint is not a reason to lose it.
 */
function disposeQuietly(context: QuickJSContext, runtime: QuickJSRuntime, runId: string): void {
  try {
    context.dispose()
  } catch (error) {
    globalThis.console.warn(`[templater ${runId}] context not freed: ${String(error)}`)
  }
  try {
    runtime.dispose()
  } catch (error) {
    globalThis.console.warn(`[templater ${runId}] runtime not freed: ${String(error)}`)
  }
}
