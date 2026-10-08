export interface JsRunLog {
  type: string
  text: string
}

export interface JsRunOutcome {
  logs: JsRunLog[]
  resultText: string
  errorText: string
  durationMs: number
}

export function formatJsValue(val: unknown): string {
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'
  if (typeof val === 'string') return val
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'symbol' || typeof val === 'bigint') {
    return String(val)
  }
  if (typeof val === 'function') {
    return val.toString()
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}`
  }
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}

export function formatJsError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

const SHADOWED_GLOBALS = [
  'console', 'self', 'globalThis', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'indexedDB', 'caches', 'importScripts', 'postMessage', 'close',
]

/**
 * Everything a note's code could use to leave the worker thread. The shadowed parameter names above
 * only cover the direct route: `Function('return this')()` still hands back the real worker scope,
 * so the same names are taken away there too. `navigator` is reached through its own object because
 * `sendBeacon` hangs off that rather than off the scope.
 */
export const NEUTRALISED_GLOBALS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'indexedDB', 'caches',
  'importScripts', 'postMessage', 'close', 'Worker', 'SharedWorker', 'ServiceWorker',
] as const

export function hardenWorkerScope(scope: Record<string, unknown>): void {
  for (const name of NEUTRALISED_GLOBALS) {
    try {
      Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false })
    } catch {
      // A property the engine refuses to redefine is one the note's code cannot reach either way;
      // the page-side timeout is the backstop, so a refusal here is never a reason to stop.
    }
  }
  const navigator = scope.navigator as Record<string, unknown> | undefined
  if (navigator && typeof navigator === 'object') {
    try {
      Object.defineProperty(navigator, 'sendBeacon', { value: undefined, writable: false, configurable: false })
    } catch {
    }
  }
}

export function executeUserCode(code: string): JsRunOutcome {
  return runUserCode(code)
}

/**
 * The same run with extra names handed to the code as parameters. A Dataview DML block gets a `dv`
 * object this way: the shadowing list above still applies, so an injection can only add a name the note
 * could not reach anyway, and a note that rebinds `dv` itself rebinds a parameter, not the worker scope.
 */
export function runUserCode(code: string, injections: Record<string, unknown> = {}): JsRunOutcome {
  // A name the sandbox already shadows cannot be handed over as a second parameter: two parameters of
  // one name are a syntax error the moment the body says "use strict".
  const names = Object.keys(injections).filter((name) => !SHADOWED_GLOBALS.includes(name))
  const values = names.map((name) => injections[name])
  const logs: JsRunLog[] = []
  const fakeConsole = {
    log: (...args: unknown[]) => logs.push({ type: 'log', text: args.map(formatJsValue).join(' ') }),
    info: (...args: unknown[]) => logs.push({ type: 'info', text: args.map(formatJsValue).join(' ') }),
    warn: (...args: unknown[]) => logs.push({ type: 'warn', text: args.map(formatJsValue).join(' ') }),
    error: (...args: unknown[]) => logs.push({ type: 'error', text: args.map(formatJsValue).join(' ') }),
  }

  const start = performance.now()
  let result: unknown
  let errorText = ''
  try {
    const fn = new Function(...SHADOWED_GLOBALS, ...names, `"use strict";\n${code}`)
    result = fn(fakeConsole, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ...values)
  } catch (err) {
    errorText = formatJsError(err)
  }
  const durationMs = Math.round(performance.now() - start)

  return {
    logs,
    resultText: result === undefined ? '' : formatJsValue(result),
    errorText,
    durationMs,
  }
}
