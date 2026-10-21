/**
 * Why a template did not produce what the reader asked for, as a name the interface can translate.
 *
 * Template code is written by someone else — the reader, a gallery author, a file someone imported —
 * so a failure has two audiences. The reader needs a sentence in their language; a test and the
 * capability gate need a token that does not move when the sentence is reworded. The code is that
 * token, and the only thing that crosses the worker boundary on failure.
 *
 * Two rules follow from that. Nothing here carries an English sentence: `detail` is a measurement, a
 * path, or a name the template itself used, never prose, because prose would be the only English in a
 * Chinese interface. And no code is a shrug: `render-failed` exists as the fallback a caller reaches
 * only when an error came from outside this module (an interpreter throw, an editor refusal), in which
 * case the original text is shown alongside the label rather than dropped.
 */
import type { MessageKey } from '@shared/locales/en-US'

export type TemplaterErrorCode =
  | 'parse-unclosed'
  | 'parse-invalid'
  | 'sandbox-unavailable'
  | 'sandbox-timeout'
  | 'sandbox-out-of-memory'
  | 'sandbox-stack-overflow'
  | 'template-recursion'
  | 'template-output-too-large'
  | 'prompt-cancelled'
  | 'capability-blocked'
  | 'web-disabled'
  | 'web-blocked'
  | 'web-request-failed'
  | 'script-load-failed'
  | 'script-require-denied'
  | 'note-not-found'
  | 'note-conflict'
  | 'path-invalid'
  | 'not-supported'
  | 'render-failed'

/** The sentence each code is told with, in the reader's locale. */
export const TEMPLATER_ERROR_MESSAGES: Record<TemplaterErrorCode, MessageKey> = {
  'parse-unclosed': 'templater.error.parse_unclosed',
  'parse-invalid': 'templater.error.parse_invalid',
  'sandbox-unavailable': 'templater.error.sandbox_unavailable',
  'sandbox-timeout': 'templater.error.sandbox_timeout',
  'sandbox-out-of-memory': 'templater.error.sandbox_out_of_memory',
  'sandbox-stack-overflow': 'templater.error.sandbox_stack_overflow',
  'template-recursion': 'templater.error.template_recursion',
  'template-output-too-large': 'templater.error.output_too_large',
  'prompt-cancelled': 'templater.error.prompt_cancelled',
  'capability-blocked': 'templater.error.capability_blocked',
  'web-disabled': 'templater.error.web_disabled',
  'web-blocked': 'templater.error.web_blocked',
  'web-request-failed': 'templater.error.web_request_failed',
  'script-load-failed': 'templater.error.script_load_failed',
  'script-require-denied': 'templater.error.script_require_denied',
  'note-not-found': 'templater.error.note_not_found',
  'note-conflict': 'templater.error.note_conflict',
  'path-invalid': 'templater.error.path_invalid',
  'not-supported': 'templater.error.not_supported',
  'render-failed': 'templater.error.render_failed',
}

const CODES = Object.keys(TEMPLATER_ERROR_MESSAGES) as TemplaterErrorCode[]

export { CODES as TEMPLATER_ERROR_CODES }

export function isTemplaterErrorCode(value: string): value is TemplaterErrorCode {
  return (CODES as readonly string[]).includes(value)
}

/**
 * A template failure that carries what the reader needs to act.
 *
 * `detail` is the variable half — a line number, a note title, a limit that was exceeded. It is shown
 * beside the translated label, which is why an error that only knows its code is still a usable error.
 */
export class TemplaterError extends Error {
  readonly code: TemplaterErrorCode
  readonly detail: string | undefined

  constructor(code: TemplaterErrorCode, detail?: string) {
    super(`${code}${detail ? `: ${detail}` : ''}`)
    this.name = 'TemplaterError'
    this.code = code
    this.detail = detail
  }
}

/**
 * The stable half of a diagnostic.
 *
 * A string reaches here in one of two shapes: `code`, or `code: what the reader can change`, because
 * that is what `TemplaterError.message` is made of and what survives a worker boundary as plain text.
 * The head before the colon is therefore all that may be matched against the table — matching the
 * whole string instead would read every detailed failure back as the generic one.
 */
export function templaterErrorCode(error: unknown): TemplaterErrorCode {
  if (error instanceof TemplaterError) return error.code
  if (typeof error === 'string') {
    const colon = error.indexOf(':')
    const head = (colon === -1 ? error : error.slice(0, colon)).trim()
    return isTemplaterErrorCode(head) ? head : 'render-failed'
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && isTemplaterErrorCode(code)) return code
  }
  return 'render-failed'
}

/**
 * The variable half.
 *
 * Only text that *starts* with a code this module knows has a detail to take off the front. Anything
 * else — an interpreter throw, a message from a library — carries no code at all, and its whole text
 * is the only description there is, so it comes back unchanged rather than split at the first colon.
 *
 * The two shapes that cross a worker boundary are read too, the way {@link templaterErrorCode} reads
 * them: `HostResult`'s failure arm is `{ code, detail }`, so its measurement is taken off the field
 * rather than lost (which would make a proxied refusal read shorter than the local one that caused it),
 * and a thrown `Error` keeps its message, because `render-failed` beside nothing is the shrug this
 * module's header refuses. A plain object that is not an `Error` gets no message lookup: its `message`
 * is whichever sentence whoever built it chose, and prose is not a measurement.
 */
export function templaterErrorDetail(error: unknown): string {
  if (error instanceof TemplaterError) return error.detail ?? ''
  if (typeof error === 'string') {
    const code = templaterErrorCode(error)
    if (!error.startsWith(code)) return error
    return error.slice(code.length).replace(/^:\s*/, '').trim()
  }
  if (error && typeof error === 'object') {
    const detail = (error as { detail?: unknown }).detail
    if (typeof detail === 'string') return detail
    if (error instanceof Error && error.message !== '') return error.message
  }
  return ''
}

/**
 * How much of a detail one line may carry.
 *
 * Sized against what this module's own reporters write: a colon chain around a virtual path, a template
 * name or a measurement fits under it with room, and a note body, a clipboard value or a pasted paragraph
 * does not — which is the point. See {@link isMeasurement}.
 */
const MAX_ERROR_DETAIL_CHARS = 120

/**
 * Whether a detail is something the run measured rather than something somebody wrote.
 *
 * Every failure this module reports carries one line of tokens, a path, a number or a name the template
 * itself used — `chars:200001`, `Notes/Gone.md`, `403` — and that is the half a reader can act on. A body
 * or a clipboard value is neither: it runs over lines, or far past the length of any name, and printing it
 * under an error label would put somebody's text on the screen wearing the interface's voice. What fails
 * the test is dropped rather than cut, the same choice `./limits.ts` makes for an oversized answer: half a
 * path helps nobody, and a reader who needs the whole of it still has the note.
 */
function isMeasurement(detail: string): boolean {
  if (detail === '' || detail.length > MAX_ERROR_DETAIL_CHARS) return false
  return !/[\r\n\u0000-\u001f\u007f]/.test(detail)
}

/**
 * What the reader is told about a failed run: the code's sentence, plus its measurement.
 *
 * The translate function comes in as a parameter rather than being imported and called here, which is
 * both how the rest of this module stays free of the interface (`./protocol.ts`'s header records that
 * these files are compiled by both sides) and the only way a line typed after a language switch speaks
 * the new language — `scripts/check-i18n.mjs` refuses a module-scope call for the same reason.
 *
 * Every code is reachable, so every answer is a sentence: `templaterErrorCode` has a fallback rather
 * than a failure mode, and a caller that hands this a `t` with no resource loaded still gets the key
 * back rather than an empty line, the way `t()` itself degrades.
 */
export function templaterErrorText(error: unknown, translate: (key: MessageKey) => string): string {
  const code = templaterErrorCode(error)
  const key = TEMPLATER_ERROR_MESSAGES[code]
  const label = translate(key).trim() || key
  const detail = templaterErrorDetail(error)
  // Straight brackets, not the full-width pair Chinese typesets with: this is not a locale file, and the
  // same shape is what `markdown/mindmap/errors.ts` prints, so one failure looks like the other.
  return isMeasurement(detail) ? `${label} (${detail})` : label
}
