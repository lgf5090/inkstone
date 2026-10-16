/**
 * Running the model's own code, in a Worker of its own that can reach nothing.
 *
 * This is the one place in the app where code nobody reviewed is executed, so the safety comes from the
 * environment rather than from reading the source: the program is compiled into a fresh Worker loaded at
 * runtime, given no bindings, and cut off from the network with `globalOutbound: null`, so a `fetch()` in
 * it throws before a packet is built. There is no `eval` here and no `new Function`: this file never
 * executes the model's text in the app's own isolate — it hands the text to the loader and the loader's
 * runtime runs it somewhere else. What the sandbox can do is therefore exactly nothing except arithmetic,
 * which is the whole point of an interpreter for a reader's own numbers.
 *
 * The code arrives as the body of an async function, and the module wrapped around it does three things
 * the model would otherwise have to do itself and would get wrong: it captures `console.log` (a program
 * that computes silently is useless to debug), it serialises whatever was returned into something JSON can
 * carry, and it turns a thrown value into a message instead of a failed load. That last one matters for the
 * loop a reader actually watches: the model reads the error, fixes the line, and runs again.
 *
 * Two limits guard the reader's request. A wall-clock deadline is the one this app enforces itself and the
 * only one it can prove: a program that sleeps forever is idle, not expensive, so no CPU budget stops it.
 * `limits.cpuMs` rides along as the deployment-side backstop for a program that spins instead of sleeping.
 */

/** A scratch Worker has no business running for longer than this. */
export const CODE_EXECUTION_TIMEOUT_MS = 10_000

/**
 * The CPU budget handed to the deployment, for a program that spins rather than sleeps.
 *
 * Not enforced by the local runtime this repo tests against — measured: a three-second tight loop ran to
 * completion with a 200 ms budget — so the deadline above is what the reader is actually protected by, and
 * this is a second line of defence for a real deployment rather than a substitute for the first.
 */
export const SANDBOX_CPU_MS = 1_000

/** How much of a program's chatter is worth keeping. A loop that logs is a program that hangs anyway. */
export const MAX_SANDBOX_LOGS = 100
export const MAX_SANDBOX_LOG_CHARS = 500

/** What one answer may weigh. A tool result is fed back to the model, and a message row is not a file store. */
export const MAX_SANDBOX_RESULT_CHARS = 20_000

/** The sandbox's own module and entry, named here because both sides have to agree on them. */
const SANDBOX_MODULE_NAME = 'index.js'
const SANDBOX_ENTRY_URL = 'https://sandbox/'

/**
 * The semantics a scratch program is compiled with.
 *
 * Pinned rather than inherited: a deployment that moves its own compatibility date forward should not
 * silently change what `Date`, `Intl` or the JSON encoder do underneath code the model already wrote.
 */
const SANDBOX_COMPATIBILITY_DATE = '2026-05-01'

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
 * The wrapper, as an explicit list of lines rather than one template literal.
 *
 * The line count is the point: `codeLine` is derived from it, and `codeLine` is what turns the runtime's
 * `index.js:25` into the model's own `line 4`. A wrapper written as a single string with the code spliced
 * in could not state where the splice landed.
 */
function harnessHead(): string[] {
  return [
    'export default {',
    '  async fetch() {',
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
    '      error = thrown && thrown.stack ? String(thrown.stack) : String(thrown)',
    '    }',
    '    return Response.json({ logs, result: safe(result), error })',
    '  },',
    '}',
  ]
}

/** Wraps a model's code into the module the sandbox runs. */
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
 * A program that throws, or that will not compile, is not an error of this function: it comes back in
 * `result.error` so the model can read it and try again, which is the loop an interpreter exists for. What
 * throws out of here is the app failing to run anything at all — a deadline, or an answer that was not the
 * sandbox's.
 */
export async function runSandboxedCode(loader: WorkerLoader, code: string): Promise<CodeExecutionResult> {
  const started = Date.now()
  const { source, codeLine, codeLines } = sandboxModule(code)

  let response: Response
  try {
    const worker = loader.get(null, () => ({
      compatibilityDate: SANDBOX_COMPATIBILITY_DATE,
      mainModule: SANDBOX_MODULE_NAME,
      modules: { [SANDBOX_MODULE_NAME]: source },
      // The whole safety story, in one line: no network. Bindings are not passed either, so the sandbox
      // cannot reach the reader's notes, their files or their keys even if it asks for them by name.
      globalOutbound: null,
      limits: { cpuMs: SANDBOX_CPU_MS, subRequests: 0 },
    }))
    response = await withDeadline(worker.getEntrypoint().fetch(SANDBOX_ENTRY_URL), CODE_EXECUTION_TIMEOUT_MS)
  } catch (error) {
    if (error instanceof CodeExecutionError) throw error
    // A module that will not parse never reaches the wrapper's own try/catch, so the runtime's refusal is
    // the only place its syntax error can be read. It is reported as the program's own failure rather than
    // thrown, so the model can fix the line — and a deployment whose sandbox is broken surfaces here too,
    // in the runtime's own words rather than in a message this app invented.
    return { logs: [], result: null, error: tidySandboxError(messageOf(error), codeLine, codeLines), durationMs: Date.now() - started }
  }

  if (!response.ok) {
    throw new CodeExecutionError(`The sandbox answered ${response.status} instead of a result.`)
  }
  const payload = await response.json().catch(() => null) as { logs?: unknown, result?: unknown, error?: unknown } | null
  if (!payload || typeof payload !== 'object') {
    throw new CodeExecutionError('The sandbox answered with something that was not a result.')
  }
  const logs = Array.isArray(payload.logs) ? payload.logs.filter((line): line is string => typeof line === 'string') : []
  const error = typeof payload.error === 'string' && payload.error ? tidySandboxError(payload.error, codeLine, codeLines) : null
  return { logs, result: clipResult(payload.result), error, durationMs: Date.now() - started }
}

/**
 * The reader's clock, not the sandbox's.
 *
 * A program that awaits forever burns no CPU, so the deployment's budget never fires and the reader would
 * wait for the request to be killed from outside. Racing the call against a timer is what makes the turn
 * come back; the sandbox itself is left to be reclaimed, which is the trade this side of the boundary can
 * actually make.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CodeExecutionError(`The program was still running after ${ms / 1000} seconds, so it was stopped. Check for a loop that never ends.`)),
      ms,
    )
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * A stack trace with the wrapper's frames removed and the rest renumbered.
 *
 * The model reads these line numbers to find its own bug, and every number the runtime prints is an offset
 * into a module the model never wrote. Frames outside its code belong to the wrapper and are dropped
 * rather than translated, because "at line 41" for a fifteen-line program is worse than saying nothing.
 */
function tidySandboxError(raw: string, codeLine: number, codeLines: number): string {
  const lines = raw
    .replace(/Failed to start Worker:\s*/gi, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const message = (lines.shift() ?? 'The program could not be started.').replace(/^Uncaught\s+/, '')
  const frames: string[] = []
  for (const line of lines) {
    if (!line.startsWith('at ')) continue
    const match = /index\.js:(\d+):(\d+)/.exec(line)
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
