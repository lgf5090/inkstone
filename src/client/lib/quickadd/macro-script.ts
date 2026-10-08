/**
 * A macro step that computes something in a Worker, the same hardened sandbox a note's runnable code
 * block already uses.
 *
 * The boundary is deliberate: the script gets a snapshot of the run — its variables, the selection,
 * the note it is writing — as plain JSON, and hands back text and more variables. It has no handle on
 * the app, because a note author's JavaScript must not be able to move the reader's data around. That
 * makes this a transform rather than the reference plugin's user script, which can drive Obsidian; the
 * macro step list covers the driving half with the named steps instead.
 */
import { executeJsExample, type JsRunnerWorker } from '../../features/preview/js-runner'

export const MACRO_SCRIPT_INPUT_LIMIT = 200_000

export interface MacroScriptInput {
  variables: Record<string, string>
  selection: string
  title: string
  content: string
  /** ISO day the run counts dates from, and the run's start instant. */
  date: string
  now: string
}

export interface MacroScriptResult {
  text: string
  variables: Record<string, string>
  logs: string[]
  error: string | null
  durationMs: number
}

function snapshot(input: MacroScriptInput): string {
  const content = input.content.length > MACRO_SCRIPT_INPUT_LIMIT
    ? `${input.content.slice(0, MACRO_SCRIPT_INPUT_LIMIT)}\n…`
    : input.content
  const payload = { ...input, content }
  // `</script` inside a JSON string would only matter in markup; a worker message is evaluated as
  // code, and JSON.stringify escapes the quotes that could otherwise end the literal.
  return `const quickadd = ${JSON.stringify(payload)};\n`
}

function cleanVariables(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[^\u0000-\u001f]{1,60}$/.test(key) || key === '__proto__') continue
    if (typeof entry === 'string') out[key] = entry.slice(0, 2000)
    else if (typeof entry === 'number' || typeof entry === 'boolean') out[key] = String(entry)
  }
  return out
}

function interpret(result: unknown): { text: string; variables: Record<string, string> } {
  if (result === null || result === undefined) return { text: '', variables: {} }
  if (typeof result === 'string') return { text: result, variables: {} }
  if (typeof result === 'number' || typeof result === 'boolean') return { text: String(result), variables: {} }
  if (Array.isArray(result))
    return { text: result.map((item) => (item === null || item === undefined ? '' : String(item))).join('\n'), variables: {} }
  const record = result as Record<string, unknown>
  const text = typeof record.text === 'string'
    ? record.text
    : typeof record.value === 'string' ? record.value : ''
  return { text, variables: cleanVariables(record.variables) }
}

/** Run one script step. The result is never thrown at: a broken script says so and the run carries on. */
export async function runMacroScript(
  code: string,
  input: MacroScriptInput,
  spawnWorker?: () => JsRunnerWorker,
): Promise<MacroScriptResult> {
  if (!code.trim())
    return { text: '', variables: {}, logs: [], error: null, durationMs: 0 }
  const { logs, result, error, durationMs } = await executeJsExample(snapshot(input) + code, spawnWorker)
  if (error) {
    return {
      text: '',
      variables: {},
      logs: logs.map((item) => item.text),
      error,
      durationMs,
    }
  }
  // The worker hands back a printed value, so an object answer has to be read from that text. Only a
  // returned object or a returned array is decoded; anything else is used as the text it printed as.
  const parsed = result === undefined ? null : parsePrinted(result)
  if (parsed === null)
    return { text: result ?? '', variables: {}, logs: logs.map((item) => item.text), error: null, durationMs }
  const interpreted = interpret(parsed)
  return {
    ...interpreted,
    logs: logs.map((item) => item.text),
    error: null,
    durationMs,
  }
}

function parsePrinted(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed.replace(/^"/, '').replace(/"$/, ''))
  } catch {
    return null
  }
}
