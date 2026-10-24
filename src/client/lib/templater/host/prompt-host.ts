/**
 * The page's answer to a template that has to ask the reader something.
 *
 * Four members of Templater's `system` module cannot be answered inside the interpreter, which has no
 * screen, no focus and no clipboard: `prompt`, `suggester`, `multi_suggester` and `clipboard`
 * (`src/core/functions/internal_functions/system/InternalModuleSystem.ts`, AGPL-3.0-only). Upstream draws
 * its own modals for the first three (`PromptModal.ts`, `SuggesterModal.ts`, `MultiSuggesterModal.ts`).
 * This port draws none, because this app already has a prompt queue that puts an accessible dialog on a
 * desktop and a sheet on a phone, moves focus into it and back out when it closes, filters a list fuzzily
 * and by pinyin, and says everything around it in the reader's language. Building a second dialog would
 * have meant a second accessibility contract to keep, and a reader seeing two kinds of question.
 *
 * Three rules, each the way an asking host goes wrong:
 *
 * - **cancellation is a code, never a value.** The reader closing a question is not the answer `''` and not
 *   the answer `null`: it is a call that did not get an answer, reported as `prompt-cancelled`. What that
 *   means for the template is decided by the frozen prelude (`worker/bootstrap.ts`'s `settle`), which yields
 *   `null` for a prompt and a suggester, `[]` for a multi-suggester, and rethrows when the template asked
 *   for `throw_on_cancel`. So `throwOnCancel` deliberately changes nothing on this side: flattening the two
 *   here is the one way to make `throw_on_cancel: true` stop meaning anything, and the prelude's own table
 *   of that behaviour is pinned in `worker/bootstrap.test.ts`.
 * - **the answer is the item, not the row text.** `values` are what a template gets back; `labels`, when a
 *   caller sends them, are only what the reader reads. That is the queue's existing `options`/`displayOptions`
 *   pair, so no second channel for "display text ≠ returned value" is invented here.
 * - **the capability is re-checked here.** The worker gates the same table before posting, and that gate is
 *   not a licence for this side: a host that asks the reader on trust from its caller is a host that opens a
 *   modal for a run that was never allowed one.
 *
 * What this host is not: a place that sizes an answer. Both halves of that rule already exist — the reply's
 * ceiling is measured in `worker/host-bindings.ts` against `../limits.ts`, and a second copy here would be
 * free to drift from it.
 */
import {
  askQuickAddPrompts,
  cancelQuickAddPromptsFor,
  clearQuickAddDrafts,
  type PromptAnswers,
  type PromptGroup,
} from '../../../features/quickadd/prompt-queue'
import type { PromptAnswer, PromptRequest } from '../../../lib/quickadd/format'
import { promptRequest } from '../../../lib/quickadd/session'
import {
  HOST_METHOD_CAPABILITY,
  HOST_METHODS,
  capabilitiesFor,
  type HostCall,
  type HostMethod,
  type HostResult,
  type TemplaterPromptRequest,
  type TemplateRunContext,
} from '../protocol'
import type { TemplaterErrorCode } from '../errors'

/** What the page's answer carries when the reader answered. */
type Success = { ok: true; value: unknown }
/** What it carries when they did not, or when the call could not be answered: a code, and a measurement. */
type Refusal = { ok: false; code: TemplaterErrorCode; detail: string }
type Outcome = Success | Refusal

/**
 * The names this host answers, so the door can route on one list instead of four string comparisons.
 *
 * `system.clipboard` belongs here rather than in `./web-host.ts` because it belongs to upstream's `system`
 * module, and because the thing it reaches for is the reader's own machine — the same thing the three
 * dialogs reach for. The web host's subject is what leaves the deployment.
 */
export const PROMPT_HOST_METHODS: readonly HostMethod[] = [
  'system.prompt',
  'system.suggester',
  'system.multiSuggester',
  'system.clipboard',
]

/**
 * How many runs this host holds contexts for.
 *
 * The same bound `./page-host.ts` puts on its own registry, for the same reason: the page is supposed to
 * release every run it starts, and a host that keeps one forever keeps the whole snapshot alive beside it.
 */
const MAX_TRACKED_RUNS = 32

/** The prefix that marks a queue entry as a template's question rather than a choice run's. */
const CHOICE_PREFIX = 'templater:'

export interface PromptHostDeps {
  /**
   * The page's one question queue.
   *
   * Defaults to the real queue and is injected only by a test: the point of the shared queue is that a
   * template's dialog is the app's dialog, and a wiring that could pass some other asker would be a
   * second, unaudited path to the reader.
   */
  ask?: (group: PromptGroup) => Promise<PromptAnswers | null>
  /**
   * The clipboard read behind `tp.system.clipboard()`.
   *
   * `null` is the answer for a browser that gives the page no clipboard at all — an insecure context, or one
   * with no such API — which is a different fact from a read that was refused, and gets a different code.
   */
  readClipboard?: () => Promise<string | null>
}

/** A callable host: `configureTemplater`'s door can take it as an `onHostCall` for these names directly. */
export interface PromptHost {
  (call: HostCall): Promise<HostResult>
  /** Record the context one run started with, before posting its program. */
  beginRun: (context: TemplateRunContext) => void
  /** Forget a run: its next call is refused, and a dialog it left on screen is taken back off. */
  endRun: (runId: string) => void
  /** How many runs the page is holding contexts for. */
  liveRuns: () => number
}

export function createPromptHost(deps: PromptHostDeps = {}): PromptHost {
  const ask = deps.ask ?? askQuickAddPrompts
  const readClipboard = deps.readClipboard ?? browserClipboard
  const runs = new Map<string, TemplateRunContext>()

  function beginRun(context: TemplateRunContext): void {
    runs.set(context.runId, context)
    while (runs.size > MAX_TRACKED_RUNS) {
      const oldest = runs.keys().next()
      if (oldest.done === true || oldest.value === context.runId) break
      runs.delete(oldest.value)
      console.warn('[inkstone] templater prompt host dropped a run the page never released', oldest.value)
    }
  }

  function endRun(runId: string): void {
    if (!runs.delete(runId)) return
    // A run the reader walked away from must not leave its question on screen: the answer would go to a
    // worker that has already forgotten the run, and the reader would be dismissing a dialog that does
    // nothing. `clearQuickAddDrafts` is the same half — a template's half-typed text is not a default for
    // anything, and it is keyed under this run alone.
    cancelQuickAddPromptsFor(choiceIdFor(runId))
    clearQuickAddDrafts(choiceIdFor(runId))
  }

  async function onHostCall(call: HostCall): Promise<HostResult> {
    let outcome: Outcome
    try {
      outcome = await dispatch(call)
    }
    catch (error) {
      // Nothing here may reject: the door answers one host call at a time, and a rejection would be the
      // worker waiting on a reply that never comes. The thrown value is a console line, never the detail,
      // because it is prose no locale translates.
      console.error('[inkstone] templater prompt host failed', call.method, error)
      outcome = fail('render-failed', `throw:${call.method}`)
    }
    return outcome.ok
      ? { runId: call.runId, callId: call.callId, ok: true, value: outcome.value }
      : { runId: call.runId, callId: call.callId, ok: false, code: outcome.code, detail: outcome.detail }
  }

  async function dispatch(call: HostCall): Promise<Outcome> {
    const method = asHostMethod(call.method)
    if (method === null || !PROMPT_HOST_METHODS.includes(method)) {
      // A name this host was handed that it does not answer is a routing bug, and saying `not-supported`
      // for it would tell the reader the app has no prompt surface at all.
      console.error('[inkstone] templater prompt host asked about a method it does not own', call.method)
      return fail('render-failed', `prompt-host:${typeof call.method === 'string' ? call.method : 'unnamed'}`)
    }
    const run = runs.get(call.runId)
    if (run === undefined) return fail('render-failed', `run:${call.runId}`)
    const capabilities = capabilitiesFor(run.capabilities)
    if (capabilities[HOST_METHOD_CAPABILITY[method]] !== true) return fail('capability-blocked', method)
    if (method === 'system.clipboard') return await clipboard(readClipboard)

    const args = Array.isArray(call.args) ? call.args : []
    const decoded = decodePrompt(args[0], method)
    if (!decoded.ok) return decoded
    // The answer is keyed by the call, so a run that asks twice cannot inherit the first answer's slot.
    const answers = await ask(groupFor(call.callId, run, decoded.request))
    if (answers === null) return fail('prompt-cancelled', method)
    return answered(answers.get(call.callId), decoded.request, method)
  }

  return Object.assign(onHostCall, { beginRun, endRun, liveRuns: () => runs.size })
}

/** Which names belong to this host, taken from the contract's list rather than from a copy of it. */
function asHostMethod(value: unknown): HostMethod | null {
  return typeof value === 'string' && (HOST_METHODS as readonly string[]).includes(value)
    ? value as HostMethod
    : null
}

/**
 * One question, in the asker's own namespace.
 *
 * The queue keeps a cancelled answer as the next default *for that asker*, which is what a reader who runs
 * the same choice again wants and what a template that asks twice does not: the run id is the namespace, so
 * nothing crosses between runs, and `endRun` clears it.
 */
function choiceIdFor(runId: string): string {
  return `${CHOICE_PREFIX}${runId}`
}

/** The name the dialog signs itself with, in the line that says who is asking. */
function askedBy(run: TemplateRunContext): string {
  // A library template has a name the reader chose, and it is the one worth reading. A run of text typed
  // into the editor has none, so the note it belongs to is the next thing the reader recognises.
  return run.template?.name.trim() || run.frozenTitle.trim() || run.runId
}

function groupFor(key: string, run: TemplateRunContext, question: TemplaterPromptRequest): PromptGroup {
  return {
    requests: [requestFor(key, question)],
    onePage: false,
    choiceId: choiceIdFor(run.runId),
    choiceName: askedBy(run),
  }
}

/**
 * The wire's question, turned into the queue's.
 *
 * Every default is upstream's, and two of them are worth the reason:
 *
 * - `optional` is true for a typed answer because upstream's Submit button answers an empty field
 *   (`PromptModal.ts:88-93`), and a dialog that refused one would turn "no text" into a cancelled run.
 * - `optional` is true for a multi-select because upstream's Save answers nothing with `[]`
 *   (`MultiSuggesterModal.ts:120-124`). A single choice is *not* optional: upstream has nothing to answer
 *   until the reader picks a row, and an empty picker answer here would be a value the template never
 *   offered.
 */
function requestFor(key: string, question: TemplaterPromptRequest): PromptRequest {
  const shared = {
    key,
    label: question.title,
    options: question.values,
    displayOptions: question.labels ?? null,
    placeholder: question.placeholder,
    limit: question.limit,
    selectDefaultValue: question.selectDefaultValue,
  }
  switch (question.kind) {
    case 'text':
      return promptRequest({
        // The queue already has a multi-line answer — `kind: 'multiline'` — so upstream's `multi_line` is
        // that kind rather than a second way to say the same thing.
        kind: question.multiLine === true ? 'multiline' : 'text',
        defaultValue: question.defaultValue ?? '',
        optional: true,
        ...shared,
      })
    case 'suggest':
      return promptRequest({
        kind: 'suggester',
        // A default arrives as display text and has to become the option it names: the queue answers with
        // the option, and the prelude maps that back to the template's own item.
        defaultValue: optionValue(question, question.defaultValue) ?? '',
        ...shared,
      })
    case 'multi-suggest':
      return promptRequest({
        kind: 'suggester',
        multiSelect: true,
        optional: true,
        defaultPicks: (question.defaultPicks ?? []).map((one) => optionValue(question, one) ?? one),
        ...shared,
      })
  }
}

/**
 * A default named by its display text, as the option it belongs to.
 *
 * Only a caller that sends `labels` separately has anything to map: the prelude sends the display text as
 * the value, and then the two are the same string and this answers what it was given.
 */
function optionValue(question: TemplaterPromptRequest, label: string | undefined): string | undefined {
  if (label === undefined) return undefined
  const labels = question.labels
  if (labels === undefined) return label
  const position = labels.indexOf(label)
  return position === -1 ? label : question.values[position] ?? label
}

/** The queue's answer, read as the shape this call promised. */
function answered(picked: PromptAnswer | undefined, question: TemplaterPromptRequest, method: HostMethod): Outcome {
  switch (question.kind) {
    case 'text':
      // A request left out of the map is no answer, which is what `prompt-queue.ts` says it means.
      return typeof picked === 'string' ? succeed(picked) : fail('prompt-cancelled', method)
    case 'suggest':
      // Enter in a picker's filter box commits the field, which — with nothing picked — is no choice at all.
      // Upstream's picker cannot answer nothing either: it closes, and closing is a cancellation.
      return typeof picked === 'string' && picked !== '' ? succeed(picked) : fail('prompt-cancelled', method)
    case 'multi-suggest':
      return succeed(Array.isArray(picked) ? picked : [])
  }
}

/**
 * `tp.system.clipboard()`, which upstream is one call deep: `navigator.clipboard.readText()`
 * (`InternalModuleSystem.ts:25-29`).
 *
 * Two refusals, because there are two facts. No clipboard surface at all is something this app does not
 * offer (`not-supported`); a surface that said no — no permission, a document the browser does not consider
 * focused — is this run's call failing (`render-failed`), with the browser's own reason kept for the
 * console, since it is a sentence no locale translates.
 */
async function clipboard(read: () => Promise<string | null>): Promise<Outcome> {
  let text: string | null
  try {
    text = await read()
  }
  catch (error) {
    console.error('[inkstone] templater clipboard read refused', error)
    return fail('render-failed', 'system.clipboard:denied')
  }
  if (text === null) return fail('not-supported', 'system.clipboard')
  return succeed(text)
}

async function browserClipboard(): Promise<string | null> {
  const clipboardApi = globalThis.navigator?.clipboard
  return typeof clipboardApi?.readText === 'function' ? await clipboardApi.readText() : null
}

/**
 * The question the worker sent, checked against the contract rather than helped into shape.
 *
 * Every field a template can reach is stringified by the prelude before it is sent, so a value of the wrong
 * type here is a bug in this app, not a mistake in someone's template — which is why the detail names the
 * method and the field, and why nothing is coerced. A coerced `values` would put rows on the reader's
 * screen that no template wrote.
 */
function decodePrompt(value: unknown, method: HostMethod): { ok: true; request: TemplaterPromptRequest } | Refusal {
  const refused = (field: string): Refusal => fail('render-failed', `${method}:${field}`)
  const record = asRecord(value)
  if (record === null) return refused('request')
  const kind = record.kind
  if (kind !== 'text' && kind !== 'suggest' && kind !== 'multi-suggest') return refused('kind')
  const values = record.values
  if (!isStringArray(values)) return refused('values')
  const labels = record.labels
  if (labels !== undefined && (!isStringArray(labels) || labels.length !== values.length)) return refused('labels')
  if (record.title !== undefined && typeof record.title !== 'string') return refused('title')
  if (record.defaultValue !== undefined && typeof record.defaultValue !== 'string') return refused('defaultValue')
  if (record.placeholder !== undefined && typeof record.placeholder !== 'string') return refused('placeholder')
  if (record.limit !== undefined && (typeof record.limit !== 'number' || !Number.isFinite(record.limit))) return refused('limit')
  if (record.defaultPicks !== undefined && !isStringArray(record.defaultPicks)) return refused('defaultPicks')
  for (const field of ['multiLine', 'selectDefaultValue', 'throwOnCancel'] as const) {
    if (record[field] !== undefined && typeof record[field] !== 'boolean') return refused(field)
  }

  const limit = typeof record.limit === 'number' ? Math.max(0, Math.floor(record.limit)) : undefined
  return {
    ok: true,
    request: {
      kind,
      values,
      labels,
      title: typeof record.title === 'string' ? record.title : '',
      defaultValue: typeof record.defaultValue === 'string' ? record.defaultValue : undefined,
      placeholder: typeof record.placeholder === 'string' && record.placeholder !== '' ? record.placeholder : undefined,
      limit,
      defaultPicks: isStringArray(record.defaultPicks) ? record.defaultPicks : undefined,
      multiLine: record.multiLine === true,
      selectDefaultValue: record.selectDefaultValue === true,
      throwOnCancel: record.throwOnCancel === true,
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function succeed(value: unknown): Success {
  return { ok: true, value }
}

function fail(code: TemplaterErrorCode, detail: string): Refusal {
  return { ok: false, code, detail }
}
