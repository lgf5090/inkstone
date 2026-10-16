/**
 * Running the model's own code, in an interpreter that is not this runtime.
 *
 * This is the one place in the app where code nobody reviewed is executed, so the safety comes from the
 * environment rather than from reading the source: the program is handed to QuickJS — a small JavaScript
 * engine compiled to WebAssembly and vendored as a module — which parses and interprets it in its own
 * heap. Nothing of it reaches V8's `eval` or `new Function`, and the interpreter has no bindings, no
 * network, no timers and no imports, so a program that asks for any of those finds a name that does not
 * exist. What it can do is therefore exactly nothing except arithmetic, which is the whole point of an
 * interpreter for a reader's own numbers.
 *
 * The earlier design compiled the program into a scratch Worker loaded at runtime. That is a better
 * isolation boundary and it is not available here: Dynamic Workers are a paid-plan feature, and a
 * deployment that could not start was a worse answer than a smaller one. QuickJS in this isolate costs a
 * deadline the app enforces itself — and gets something back in exchange, because the engine can be
 * interrupted mid-instruction, so a program that spins is stopped rather than merely abandoned.
 *
 * The code arrives as the body of an async function, and the wrapper around it does three things the model
 * would otherwise have to do itself and would get wrong: it captures `console.log` (a program that
 * computes silently is useless to debug), it serialises whatever was returned into something JSON can
 * carry, and it turns a thrown value into a message instead of a failed run. That last one matters for the
 * loop a reader actually watches: the model reads the error, fixes the line, and runs again.
 */
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core'
import baseVariant from '@jitl/quickjs-wasmfile-release-sync'
import wasmModule from './quickjs.wasm'

/**
 * How long a program may run.
 *
 * Shorter than the scratch Worker's ten seconds because this one is not free: the interpreter runs inside
 * the request that asked for it, so the time it spends is the reader's own request budget. Two seconds is
 * far more than an arithmetic scratchpad needs and short enough that a runaway loop fails the turn instead
 * of the deployment.
 */
export const CODE_EXECUTION_TIMEOUT_MS = 2_000

/** How much heap the interpreter may take. A program that needs more is not doing arithmetic. */
const SANDBOX_MEMORY_BYTES = 32 * 1024 * 1024

/** How deep it may recurse, which is what turns a runaway recursion into an error rather than a crash. */
const SANDBOX_STACK_BYTES = 1024 * 1024

/** How much of a program's chatter is worth keeping. A loop that logs is a program that hangs anyway. */
export const MAX_SANDBOX_LOGS = 100
export const MAX_SANDBOX_LOG_CHARS = 500

/** What one answer may weigh. A tool result is fed back to the model, and a message row is not a file store. */
export const MAX_SANDBOX_RESULT_CHARS = 20_000

/** The name the program is compiled under. Frames in a reported error are read back by this name. */
const PROGRAM_NAME = 'program.js'

export class CodeExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodeExecutionError'
  }
}

export interface CodeExecutionResult {
  /** Everything the program printed, in order. */
  logs: string[]
  /** What it returned, made safe for JSON; `null` when it returned nothing or the result was too big. */
  result: unknown
  /** Set when the program threw or could not be compiled. A normal outcome, not a failed tool call. */
  error: string | null
  durationMs: number
}

export interface SandboxModule {
  source: string
  /** The 1-based line of `source` where the model's own code begins. */
  codeLine: number
  /** How many lines that code occupies, so a stack frame outside it can be recognised as wrapper noise. */
  codeLines: number
}

/**
 * The engine, built once per isolate.
 *
 * Loading it is the expensive part — the WebAssembly module is instantiated on first use — and every turn
 * after the first reuses the same engine, each run getting a fresh runtime inside it. A failed load is not
 * cached: the next call tries again, because a deployment that lost the module for one request has not
 * necessarily lost it for the next.
 */
let engine: Promise<QuickJSWASMModule> | null = null

function quickjs(): Promise<QuickJSWASMModule> {
  if (!engine) {
    engine = newQuickJSWASMModuleFromVariant(newVariant(baseVariant, { wasmModule }))
    engine.catch(() => { engine = null })
  }
  return engine
}

/**
 * The wrapper, as an explicit list of lines rather than one template literal.
 *
 * The line count is the point: `codeLine` is derived from it, and `codeLine` is what turns the engine's
 * `program.js:25` into the model's own `line 4`. A wrapper written as a single string with the code spliced
 * in could not state where the splice landed.
 */
function harnessHead(): string[] {
  return [
    '(async () => {',
    '    const logs = []',
    '    const stack = new Set()',
    '    const safe = (value) => {',
    '      if (value === null) return null',
    '      const type = typeof value',
    "      if (type === 'undefined') return '[undefined]'",
    "      if (type === 'bigint') return value.toString() + 'n'",
    "      if (type === 'function') return '[function]'",
    '      if (type === \'symbol\') return value.toString()',
    "      if (type !== 'object') return value",
    "      if (stack.has(value)) return '[circular]'",
    "      if (stack.size > 20) return '[too deep]'",
    '      stack.add(value)',
    '      try {',
    '        if (value instanceof Date) return value.toISOString()',
    "        if (value instanceof Error) return value.name + ': ' + value.message",
    '        if (value instanceof Map) return safe(Object.fromEntries(value))',
    '        if (value instanceof Set) return safe([...value])',
    '        if (Array.isArray(value)) return value.map((item) => safe(item))',
    '        const out = {}',
    '        for (const key of Object.keys(value)) out[key] = safe(value[key])',
    '        return out',
    '      } finally {',
    '        stack.delete(value)',
    '      }',
    '    }',
    "    const format = (value) => typeof value === 'string' ? value : JSON.stringify(safe(value))",
    '    const write = (...parts) => {',
    `      if (logs.length >= ${MAX_SANDBOX_LOGS}) return`,
    `      logs.push(parts.map(format).join(' ').slice(0, ${MAX_SANDBOX_LOG_CHARS}))`,
    '    }',
    '    const console = { log: write, info: write, warn: write, error: write, debug: write, trace: write }',
    '    let result = null',
    '    let error = null',
    '    try {',
    '      result = await (async () => {',
  ]
}

function harnessTail(): string[] {
  return [
    '      })()',
    '    } catch (thrown) {',
    // QuickJS's own `stack` is frames only — the `TypeError: ...` line a reader expects is not in it, so
    // the message is composed here rather than hoped for.
    '      const detail = thrown && thrown.stack ? thrown.stack : String(thrown)',
    "      error = thrown && thrown.name ? thrown.name + ': ' + thrown.message + '\\n' + detail : detail",
    '    }',
    '    return { logs, result: safe(result), error }',
    '})()',
  ]
}

/** Wraps a model's code into the program the interpreter runs. */
export function sandboxModule(code: string): SandboxModule {
  const head = harnessHead()
  return {
    source: [...head, code, ...harnessTail()].join('\n'),
    codeLine: head.length + 1,
    codeLines: Math.max(1, code.split('\n').length),
  }
}

/**
 * Runs one program and reports what it did.
 *
 * A program that throws, that will not parse, or that runs past its deadline is not an error of this
 * function: it comes back in `result.error` so the model can read it and try again, which is the loop an
 * interpreter exists for. What throws out of here is the app failing to run anything at all — an engine
 * that would not load, or an answer that was not the interpreter's.
 */
export async function runSandboxedCode(code: string): Promise<CodeExecutionResult> {
  const started = Date.now()
  const { source, codeLine, codeLines } = sandboxModule(code)
  const interpreter = await quickjs()
  const runtime = interpreter.newRuntime()
  runtime.setMemoryLimit(SANDBOX_MEMORY_BYTES)
  runtime.setMaxStackSize(SANDBOX_STACK_BYTES)
  // The one limit this app can enforce on itself, and the only one it can prove: the engine asks this
  // handler between instructions, so a program that spins is stopped at the deadline rather than left to
  // the platform's own budget, which would fail the whole turn.
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(started + CODE_EXECUTION_TIMEOUT_MS))
  const context = runtime.newContext()
  try {
    return collect(context, runtime, source, { codeLine, codeLines, started })
  } finally {
    // Disposal is best-effort by design: a runtime the engine has already given up on may refuse to be
    // freed, and losing the answer because the cleanup complained would be the worse failure.
    try {
      context.dispose()
    } catch {
      // The answer has already been read; a refused cleanup leaves nothing the reader can act on.
    }
    try {
      runtime.dispose()
    } catch {
      // Same.
    }
  }
}

/** Evaluates the program, drives its promises, and reads back what it produced. */
function collect(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  source: string,
  options: { codeLine: number, codeLines: number, started: number },
): CodeExecutionResult {
  const { codeLine, codeLines, started } = options
  const elapsed = () => Date.now() - started

  const evaluated = context.evalCode(source, PROGRAM_NAME)
  if (evaluated.error) {
    // A module that will not parse never reaches the wrapper's own try/catch, so the engine's refusal is
    // the only place its syntax error can be read. It is reported as the program's own failure rather than
    // thrown, so the model can fix the line.
    const dumped = dumpError(context, evaluated.error)
    evaluated.error.dispose()
    return { logs: [], result: null, error: syntaxError(dumped, codeLine, codeLines), durationMs: elapsed() }
  }

  const promise = evaluated.value
  try {
    let state = context.getPromiseState(promise)
    while (state.type === 'pending') {
      const pumped = runtime.executePendingJobs()
      if (pumped.error) {
        // The interrupt handler fired: the program ran past its deadline, or one of its own jobs threw in a
        // way the wrapper could not catch. Either way the program is over and the engine says why.
        const dumped = dumpError(context, pumped.error)
        pumped.error.dispose()
        return { logs: [], result: null, error: failureMessage(dumped, codeLine, codeLines), durationMs: elapsed() }
      }
      if (pumped.value === 0) {
        // Nothing left to run and the promise has not settled: it is waiting for something this interpreter
        // cannot provide — a timer, a request, an import. Saying so is more useful than a deadline that
        // never comes, because the program itself is fine and only its assumption is wrong.
        return { logs: [], result: null, error: UNRESOLVABLE, durationMs: elapsed() }
      }
      state = context.getPromiseState(promise)
    }
    if (state.type === 'rejected') {
      const dumped = dumpError(context, state.error)
      state.error.dispose()
      return { logs: [], result: null, error: failureMessage(dumped, codeLine, codeLines), durationMs: elapsed() }
    }
    const value = context.dump(state.value)
    state.value.dispose()
    const payload = value && typeof value === 'object' ? value as { logs?: unknown, result?: unknown, error?: unknown } : {}
    const logs = Array.isArray(payload.logs) ? payload.logs.filter((line): line is string => typeof line === 'string') : []
    const error = typeof payload.error === 'string' && payload.error ? interpretFailure(payload.error, codeLine, codeLines) : null
    return { logs, result: clipResult(payload.result), error, durationMs: elapsed() }
  } finally {
    promise.dispose()
  }
}

/**
 * What a program is told when it waits for something that cannot happen here.
 *
 * There is no timer, no request and no import in this interpreter, so a promise that is still pending once
 * the job queue has drained will never settle. The program is not broken and the deadline has not passed:
 * it asked the wrong environment for something, and that is what it should hear.
 */
const UNRESOLVABLE
  = 'The program stopped without finishing: it is waiting for something that cannot happen here (there are no timers, no network and no imports).'

/** What a program is told when it ran past its deadline and was stopped. */
const TIMEOUT_MESSAGE
  = `The program was still running after ${CODE_EXECUTION_TIMEOUT_MS / 1000} seconds, so it was stopped. Check for a loop that never ends.`

/** The interpreter's own error object, read into plain JavaScript before its handle is freed. */
function dumpError(context: QuickJSContext, handle: Parameters<QuickJSContext['dump']>[0]): { name: string, message: string, stack: string, lineNumber: number | null } {
  const raw = context.dump(handle) as { name?: unknown, message?: unknown, stack?: unknown, lineNumber?: unknown } | undefined
  return {
    name: typeof raw?.name === 'string' ? raw.name : 'Error',
    message: typeof raw?.message === 'string' ? raw.message : 'The program failed.',
    stack: typeof raw?.stack === 'string' ? raw.stack : '',
    lineNumber: typeof raw?.lineNumber === 'number' ? raw.lineNumber : null,
  }
}

/**
 * A program that never parsed, said in the model's own line numbers.
 *
 * The engine reports the line of the whole program, wrapper included, and the wrapper is not the model's
 * code. A line outside it is not translated — "at line 41" for a fifteen-line program is worse than saying
 * nothing — but the message alone is still enough to find a missing brace.
 */
function syntaxError(dumped: { name: string, message: string, lineNumber: number | null }, codeLine: number, codeLines: number): string {
  const own = dumped.lineNumber === null ? 0 : dumped.lineNumber - codeLine + 1
  const where = own >= 1 && own <= codeLines ? ` (line ${own})` : ''
  return `${dumped.name}: ${dumped.message}${where}`
}

/** A run that ended in a thrown value rather than a result: the deadline, or a job that escaped. */
function failureMessage(dumped: { name: string, message: string, stack: string }, codeLine: number, codeLines: number): string {
  // The engine's own word for a stopped program. Translating it is what turns "interrupted" into something
  // the model can act on — the alternative is a message that reads like a bug in the app.
  if (/interrupt/i.test(dumped.message)) return TIMEOUT_MESSAGE
  return tidySandboxError(`${dumped.name}: ${dumped.message}\n${dumped.stack}`, codeLine, codeLines)
}

/**
 * The same reading for an error the wrapper caught itself.
 *
 * A stopped program usually surfaces here rather than as a rejected promise, because the interrupt lands
 * inside the wrapper's own `try`. Leaving it as the engine spelled it would hand the model a word
 * ("interrupted") that names nothing it can change.
 */
function interpretFailure(raw: string, codeLine: number, codeLines: number): string {
  if (/interrupt/i.test(raw)) return TIMEOUT_MESSAGE
  return tidySandboxError(raw, codeLine, codeLines)
}

/**
 * A stack trace with the wrapper's frames removed and the rest renumbered.
 *
 * The model reads these line numbers to find its own bug, and every number the engine prints is an offset
 * into a program the model never wrote. Frames outside its code belong to the wrapper and are dropped
 * rather than translated, because "at line 41" for a fifteen-line program is worse than saying nothing.
 */
function tidySandboxError(raw: string, codeLine: number, codeLines: number): string {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const message = (lines.shift() ?? 'The program could not be started.').replace(/^Uncaught\s+/, '')
  const frames: string[] = []
  for (const line of lines) {
    if (!line.startsWith('at ')) continue
    const match = new RegExp(`${PROGRAM_NAME}:(\\d+):(\\d+)`).exec(line)
    if (!match) continue
    const own = Number(match[1]) - codeLine + 1
    if (own < 1 || own > codeLines) continue
    frames.push(`    at line ${own}:${match[2]}`)
  }
  return frames.length ? `${message}\n${frames.join('\n')}` : message
}

/** Keeps one answer to a size a model can read, saying so rather than pretending the value was small. */
function clipResult(result: unknown): unknown {
  if (result === undefined || result === null) return result ?? null
  let text: string
  try {
    text = JSON.stringify(result) ?? 'null'
  } catch {
    // The wrapper already made the value JSON-safe, so this is the app's own bug rather than the model's,
    // and saying so is better than reporting a result that was never there.
    return '[a result this app could not read]'
  }
  return text.length > MAX_SANDBOX_RESULT_CHARS
    ? `${text.slice(0, MAX_SANDBOX_RESULT_CHARS)}… [truncated: ${text.length} characters]`
    : result
}
