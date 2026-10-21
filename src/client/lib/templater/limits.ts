/**
 * Every number a template run is allowed to cost, in one place.
 *
 * A template is someone else's code, and the run that executes it has to stop on its own terms rather
 * than on the reader's patience. Each limit below answers one concrete attack or one concrete accident:
 * a loop that never ends, a program that fills the heap, a recursion that fills the stack, a template
 * that renders a megabyte into a note, a program that spams the host with calls.
 *
 * They live beside `protocol.ts` because both halves enforce them: the worker stops the program, the
 * page refuses the write, and a ceiling the two sides disagree about is a ceiling neither of them means.
 *
 * They are constants, not settings. A reader choosing "how long may my template run" would be a setting;
 * a reader choosing "how much memory may untrusted code take" is not a choice anyone should make, and
 * every value here is a ceiling the *app* holds itself to. The one number a caller may pass is the CPU
 * deadline on the run request, and `MAX_RUN_DEADLINE_MS` clamps even that.
 */

/** A kibibyte, spelled once so the sizes below read as their own units. */
const KB = 1024

/** A mebibyte. */
const MB = 1024 * KB

/**
 * The CPU a run gets when the page did not say.
 *
 * Measured, not guessed: an empty run with the whole namespace installed — moment's UMD source
 * evaluated, the locale on top of it, `TFile`/`TFolder` defined — settles in a few hundred milliseconds
 * on this engine, so two seconds is orders of magnitude above the honest case and short enough that a
 * runaway loop fails while the reader is still looking at the dialog.
 */
export const DEFAULT_RUN_DEADLINE_MS = 2_000

/**
 * The floor for a page-supplied deadline.
 *
 * Below this the engine is mostly spending its time loading itself: the deadline would expire inside
 * the bootstrap and report a timeout the reader cannot act on.
 */
export const MIN_RUN_DEADLINE_MS = 500

/**
 * The ceiling for a page-supplied deadline.
 *
 * The page is trusted, but a bug that asks for an hour would otherwise hang a run for an hour. This is
 * CPU time, so it is not the same thing as how long a reader may take to answer a prompt — see
 * `MAX_RUN_WALL_MS`, which is the wall-clock half.
 */
export const MAX_RUN_DEADLINE_MS = 20_000

/**
 * How much heap one run may allocate.
 *
 * Sized against the bootstrap rather than against a template: the namespace alone carries moment's
 * parsed UMD source and its locale table, and a limit below that fails every date-formatting template
 * with `sandbox-out-of-memory`, which reads as a bug in the app. Measured with
 * `runtime.dumpMemoryUsage()` after bootstrap in `vm.test.ts`. 64 MiB also bounds the damage a loop of
 * `new Uint8Array(1e6)` can do, which is the number that matters for untrusted code.
 */
export const RUNTIME_MEMORY_BYTES = 64 * MB

/**
 * How deep the interpreter may recurse.
 *
 * Measured against the engine rather than against a guess. `runtime.setMaxStackSize` is only useful while
 * it is smaller than the stack the WebAssembly instance actually has: at 128 KiB and below QuickJS raises
 * its own `InternalError: stack overflow`, which arrives as an error handle and whose runtime frees
 * cleanly; at 512 KiB and above the recursion blows the native stack first, the engine throws a
 * `RangeError` out of the call, and the runtime behind it can no longer be freed — freeing it aborts the
 * whole WebAssembly module (`list_empty(&rt->gc_obj_list)` in `JS_FreeRuntime`), which would take every
 * other run sharing the worker down with it. 64 KiB sits well under the measured boundary and still
 * allows a recursion depth no template reaches on purpose.
 */
export const STACK_BYTES = 64 * KB

/**
 * How long the program the page compiled may be.
 *
 * A library template is capped at the import budget (`TEMPLATE_IMPORT_LIMITS.maxContentLength`, 64 KiB)
 * and `include` splices other notes into it, so the compiled body can legitimately be several times the
 * template the reader wrote. Beyond this the run is not a template any more; it is a payload.
 */
export const MAX_PROGRAM_BYTES = 512 * KB

/**
 * How many commands one template may contain.
 *
 * Checked by `client.ts` before the program is posted, from `ProgramSource.commandCount`: it is the
 * parser's own count, so it is exact, and a program that arrives already over budget is a bug rather
 * than a policy question. It exists because each command costs both parse time and, through the
 * `<% tp.file.include %>` path, more commands.
 */
export const MAX_COMMANDS = 2_000

/**
 * How large the rendered text may be.
 *
 * The output of a run becomes a note body, and `search.maxContentChars` can be set as high as 200,000 —
 * that is the largest body the rest of the app promises to read back, so a template that outgrows it is
 * not producing something the product can show. Checked on the settled string, before anything is
 * written, and reported as `template-output-too-large` rather than silently cut.
 */
export const MAX_OUTPUT_CHARS = 200_000

/**
 * How many host calls one run may make.
 *
 * The multiplicative case is a loop around a prompt: each iteration costs a modal the reader has to
 * dismiss. This is per run, not per template, and hitting it fails the run with `capability-blocked`
 * naming the method, which is honest about what stopped it.
 */
export const MAX_HOST_CALLS = 200

/**
 * How many host calls may be outstanding at once.
 *
 * Separate from the total because it is the one that can wedge the worker: every outstanding call holds
 * a QuickJS promise, and a template that starts ten thousand of them from one synchronous loop has
 * allocated ten thousand things the page then has to answer.
 */
export const MAX_OUTSTANDING_HOST_CALLS = 32

/**
 * How deep `include` and `create_new` may nest.
 *
 * Upstream's own number (`InternalModuleFile.ts`, and the port plan's D9 row for nested `create_new`),
 * kept so a template written against Templater behaves the same here. Enforced by the page host, which
 * is the side that starts the nested run; the worker cannot see depth and does not pretend to.
 */
export const MAX_TEMPLATE_DEPTH = 10

/**
 * How much text the reader may be asked to type, and how much the clipboard may hand back.
 *
 * Both answers come from outside the interpreter, so they are measured on the way in rather than hoped
 * for: an oversized answer is a failure, not a truncation, because a template that silently got the
 * first 4,000 characters of a clipboard write would produce a wrong note.
 */
export const MAX_PROMPT_ANSWER_CHARS = 8 * KB
export const MAX_CLIPBOARD_CHARS = 64 * KB

/**
 * How large one host call's arguments may be.
 *
 * The arguments cross a structured clone, so the cost is real twice over: the string has to be built
 * inside the VM and then parsed by the worker. `web.request`'s body and `note.write`'s content both go
 * through this, which is why it sits above the output cap rather than below it.
 */
export const MAX_HOST_ARG_CHARS = MAX_OUTPUT_CHARS

/**
 * How large one host reply may be.
 *
 * The single legitimate large reply is `note.read`/`template.read` of a whole note; anything bigger is
 * either a network response or a mistake, and both are the page's to have truncated first.
 */
export const MAX_HOST_RESULT_CHARS = MAX_OUTPUT_CHARS

/**
 * How much of a template's own console output is kept.
 *
 * Debugging a template means reading what it printed, and a loop that logs is a loop that ends for some
 * other reason anyway. The count and the per-line size are both capped so logging cannot become the way
 * around the memory limit.
 */
export const MAX_LOG_LINES = 200
export const MAX_LOG_CHARS = 2 * KB

/**
 * How long the page waits for *evidence of progress* before it terminates the worker.
 *
 * This is the wall-clock half, and it is deliberately an idle guard rather than a run budget: a run
 * blocked on a prompt is a run the reader is still composing an answer for, and it must not be killed at
 * two seconds. Any message resets it — a host call, a reply's effect, completion. A worker that died,
 * hung or lost a message produces nothing at all, which is exactly what this catches.
 */
export const IDLE_GUARD_MS = 5 * 60_000

/**
 * The absolute ceiling on one run's wall clock, independent of activity.
 *
 * The backstop for a template that keeps the reader in prompts forever, or that fires host calls just
 * under the idle guard indefinitely. Generous because a reader who is mid-answer is not the target; the
 * target is a loop that produces messages without ever finishing.
 */
export const MAX_RUN_WALL_MS = 30 * 60_000

/**
 * How long a hooks phase may take after the template itself finished.
 *
 * `tp.hooks.on_all_templates_executed` callbacks run once the page has said every template in the batch
 * is done. They get a short, fixed budget: they cannot prompt, and their output is discarded, so
 * there is no reason for them to be long.
 */
export const HOOKS_DEADLINE_MS = 1_000

/**
 * How long the worker keeps a finished run's interpreter alive for its callbacks.
 *
 * A run that registered `tp.hooks.on_all_templates_executed` has already reported its text, and the only
 * thing left to do with it is invoke callbacks that cannot cross the wire — so the runtime is held, not
 * cached. Without this the thread would keep a heap per run until it was terminated; with it, a page that
 * never sends `run-hooks` gets one late failure naming the wait instead of a silent leak.
 */
export const HOOKS_WAIT_MS = 60_000

/**
 * The same numbers as one object, for callers that want the set rather than the eight names.
 *
 * The port plan calls this `TEMPLATER_LIMITS`, and the reference panel and any future settings screen
 * should read from here so there is one list of what the sandbox promises.
 */
export const TEMPLATER_LIMITS = {
  runDeadlineMs: DEFAULT_RUN_DEADLINE_MS,
  minRunDeadlineMs: MIN_RUN_DEADLINE_MS,
  maxRunDeadlineMs: MAX_RUN_DEADLINE_MS,
  runtimeMemoryBytes: RUNTIME_MEMORY_BYTES,
  stackBytes: STACK_BYTES,
  maxProgramBytes: MAX_PROGRAM_BYTES,
  maxCommands: MAX_COMMANDS,
  maxOutputChars: MAX_OUTPUT_CHARS,
  maxHostCalls: MAX_HOST_CALLS,
  maxOutstandingHostCalls: MAX_OUTSTANDING_HOST_CALLS,
  maxTemplateDepth: MAX_TEMPLATE_DEPTH,
  maxPromptAnswerChars: MAX_PROMPT_ANSWER_CHARS,
  maxClipboardChars: MAX_CLIPBOARD_CHARS,
  maxHostArgChars: MAX_HOST_ARG_CHARS,
  maxHostResultChars: MAX_HOST_RESULT_CHARS,
  maxLogLines: MAX_LOG_LINES,
  maxLogChars: MAX_LOG_CHARS,
  idleGuardMs: IDLE_GUARD_MS,
  maxRunWallMs: MAX_RUN_WALL_MS,
  hooksDeadlineMs: HOOKS_DEADLINE_MS,
  hooksWaitMs: HOOKS_WAIT_MS,
} as const
