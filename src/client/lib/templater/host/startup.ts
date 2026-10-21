/**
 * The batch policy for the reader's startup templates.
 *
 * A startup run is the one kind of template execution nobody pressed a button for, so the rules that make it
 * safe to have at all are the ones this module holds: it happens once per session, in the order the reader
 * wrote the list, one template at a time, and a template that fails does not end the batch. Upstream runs
 * them serially for the same reason (`core/Templater.ts` `onLayoutReady` → `on_startup_templates_executed`):
 * two of them writing the same note is a race the reader cannot see, and `tp.hooks` callbacks registered by
 * one are meant to fire after it, not interleaved with another's.
 *
 * Nothing here decides *whether* the batch may run — that is a device switch the caller reads — and nothing
 * here speaks to the reader. Each outcome comes back with the code the pipeline gave, so the caller can say
 * it in the app's own words, once, beside the template the reader named.
 */
import type { TemplaterErrorCode } from '../errors'

/** One template's answer for a batch. */
export interface StartupOutcome {
  templateId: string
  ok: boolean
  /** The pipeline's refusal, when it refused; `detail` is its measurement, never prose. */
  code?: TemplaterErrorCode
  detail?: string
}

/** What the batch asks of the page: run one template by id and report what came back. */
export interface StartupPorts {
  run(templateId: string): Promise<{ ok: boolean; code?: TemplaterErrorCode; detail?: string }>
}

/**
 * Run the list, serially, and answer for every entry.
 *
 * Ids are de-duplicated and blanks dropped before anything runs: the settings list is cleaned on the way in,
 * so a duplicate here would mean two rows of one template executing twice in a session, which for a template
 * that appends to a daily note is a visibly wrong note. An id the page cannot resolve is reported as a
 * refusal by the caller rather than guessed at here — this module has no view of the library.
 *
 * A `run` that throws is folded into the same shape as a refusal, because the batch's promise is that one
 * broken template does not hide the ones after it; the error text travels as `detail` so the toast can name
 * it, and the code stays `render-failed`, which is the honest label for "this never got an answer".
 */
export async function runStartupTemplates(
  templateIds: readonly string[],
  ports: StartupPorts,
): Promise<StartupOutcome[]> {
  const outcomes: StartupOutcome[] = []
  const seen = new Set<string>()
  for (const rawId of templateIds) {
    const templateId = rawId.trim()
    if (templateId === '' || seen.has(templateId)) continue
    seen.add(templateId)
    try {
      const answer = await ports.run(templateId)
      outcomes.push({ templateId, ...answer })
    }
    catch (error) {
      outcomes.push({ templateId, ok: false, code: 'render-failed', detail: describeFailure(error) })
    }
  }
  return outcomes
}

/**
 * The one line a thrown port contributes.
 *
 * Cut at the same width the error formatter uses for a measurement, and flattened: this text ends up in a
 * toast, and a stack trace in a toast is a toast nobody can read.
 */
function describeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').trim().slice(0, 120) || 'unknown'
}
