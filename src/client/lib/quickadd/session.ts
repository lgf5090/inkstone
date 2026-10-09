/**
 * The parts of a choice run that every engine needs: a session with one clock, the ask-me-which-day
 * prompt, the prompt-request defaulting, and the format-then-ask loop.
 *
 * `formatWithPrompts` exists because a format can grow tokens while it is being formatted — an
 * included template or a macro that emits `{{VALUE:…}}` — and a literal token written into a note is
 * a silent failure. So the pass asks, formats, and asks again for anything that only appeared after
 * the first round.
 */
import { collectRequirements, formatQuickAddText, type FormatRuntime, type PromptAnswer, type PromptRequest } from './format'
import { askForInputs, pageMode } from './runtime'
import type { RunSession } from './runtime'
import type { NotePort, QuickAddRunStatus } from './context'
import { t } from '../../lib/i18n'
import type { QuickAddChoice } from '@shared/quickadd'

export function promptRequest(over: Partial<PromptRequest>): PromptRequest {
  return {
    kind: 'text',
    key: '',
    label: '',
    defaultValue: '',
    options: [],
    displayOptions: null,
    allowCustom: false,
    multiSelect: false,
    multiFormat: 'auto',
    optional: false,
    trim: false,
    caseStyle: null,
    numeric: {},
    dateFormat: null,
    withTime: false,
    ...over,
  }
}

/** What a caller can tell a run about itself before it starts. */
export interface RunOptions {
  /** Variables the reader has already answered — a page, or a macro that shares its session. */
  variables?: Map<string, PromptAnswer>
  /** The day a `pick a day` entry was given, before the choice's own origin is applied. */
  day?: Date
  /** The note the reader was in, which a macro reached through `{{MACRO:}}` inherits. */
  sourceNoteId?: string
  /** Ask which day this run measures from, whatever the choice's own day origin says. */
  pickDay?: boolean
}

export function newSession(
  choice: QuickAddChoice,
  port: NotePort,
  options: RunOptions = {},
): RunSession {
  const { variables, day, sourceNoteId, pickDay } = options
  const now = new Date()
  const date = day ? new Date(day.getTime()) : now
  if (day) date.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds())
  const session: RunSession = {
    choice,
    base: choice,
    settings: port.settings(),
    variables: variables ?? new Map<string, PromptAnswer>(),
    clock: { now, date },
    destination: null,
    sourceNoteId,
    pickDay,
    dayGiven: day !== undefined,
  }
  // What the reader has selected answers an un-named `{{VALUE}}` instead of asking: a selection is an
  // answer, not a pre-fill, so a blank selection leaves the prompt exactly where it was. The choice
  // overrides the account setting, which is itself the reference's always-on behaviour.
  const override = (choice as { useSelectionAsValue?: boolean | null }).useSelectionAsValue
  if ((override ?? session.settings.selectionAsValue) && !session.variables.has('value')) {
    const selected = port.selection()
    if (selected.trim() !== '') session.variables.set('value', selected)
  }
  return session
}

/**
 * Whether this run still has to ask which day it counts from.
 *
 * Two things decide the day besides the clock: the choice's own "ask me each time", and an entry point
 * that means a second command — the palette twin, the launcher's Shift. When the entry point has
 * already been given a day, neither of them asks again: the reader would answer the same question
 * twice, and re-reading a date out of text can land on a different day than the `Date` they picked.
 */
export function asksForDay(session: RunSession): boolean {
  if (session.dayGiven) return false
  return session.base.dateOrigin === 'ask' || session.pickDay === true
}

/** The "ask me each time" day question, shared by the opening page and the engine that applies it. */
export function dayRequest(session: RunSession): PromptRequest {
  return promptRequest({
    kind: 'date',
    key: 'day',
    label: t('quickadd.prompt_day'),
    dateFormat: session.settings.dateFormat,
  })
}

/** The day a run measures its dates from, when the choice or the entry point says to ask. */
export async function applyDateOrigin(session: RunSession): Promise<QuickAddRunStatus | null> {
  if (!asksForDay(session)) return null
  const value = await askOrReuse(session, dayRequest(session))
  if (value === null) return { kind: 'cancelled' }
  const stamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(stamp))
    return { kind: 'failed', reason: t('quickadd.error_day_unreadable') }
  const origin = new Date(stamp)
  origin.setHours(session.clock.now.getHours(), session.clock.now.getMinutes(), session.clock.now.getSeconds())
  session.clock = { now: session.clock.now, date: origin }
  return null
}

/**
 * One question, taken from the opening page when there is one. Without this the precollect pass would
 * ask the very same thing twice — every engine-level prompt has to look for the answer first.
 */
export async function askOrReuse(
  session: RunSession,
  request: PromptRequest,
  destination?: string,
): Promise<PromptAnswer> {
  if (session.variables.has(request.key)) return session.variables.get(request.key) ?? null
  const answers = await askForInputs(session, [request], destination === undefined ? undefined : { destination })
  return answers.get(request.key) ?? null
}

/**
 * Ask everything the run can already name, once, before it writes anything.
 *
 * The setting promises "always one page", and a choice used to honour it one surface at a time: a
 * template asked for its day, then its name, then its folder, then its body — four dialogs for one
 * button press. Only questions whose wording and choices are known before the run starts can share a
 * page, so each engine hands over what it knows statically (`requests` for the engine's own prompts,
 * `texts` for the formats whose tokens can be scanned) and keeps asking the rest where the answer
 * depends on something the earlier answers produced.
 *
 * `auto` deliberately stays out of this: asking the body's questions before the target note is known
 * would cost the prompt the destination it names, which is the one thing the reader is looking at.
 */
export async function precollectInputs(
  session: RunSession,
  runtime: FormatRuntime,
  surfaces: { requests?: PromptRequest[]; texts?: string[]; skip?: Set<string> },
  destination?: string,
): Promise<void> {
  if (pageMode(session) !== 'always') return
  const wanted: PromptRequest[] = []
  const seen = new Set<string>()
  const take = (request: PromptRequest, fromText: boolean): void => {
    // A multi-select keeps its own dialog: the page cannot hold a picker, and the surface that asked
    // for it still asks exactly as it did before this pass existed.
    if (request.key === '' || request.multiSelect) return
    const id = request.key.toLowerCase()
    if (seen.has(id) || session.variables.has(request.key)) return
    // `skip` names variables the run writes itself, which only ever arrive out of a scanned format —
    // an engine's own request is one it has decided to ask.
    if (fromText && surfaces.skip?.has(id)) return
    seen.add(id)
    wanted.push(request)
  }
  for (const request of surfaces.requests ?? []) take(request, false)
  for (const text of surfaces.texts ?? []) {
    for (const request of collectRequirements(text, runtime)) take(request, true)
  }
  if (wanted.length === 0) return
  await askForInputs(session, wanted, destination === undefined ? undefined : { destination })
}

/** Ask for the inputs of a text, then format it: the order the one-page form promises. */
export async function formatWithPrompts(
  text: string,
  runtime: FormatRuntime,
  session: RunSession,
  destination?: string,
): Promise<{ text: string; cursor: number | null }> {
  const promised = collectRequirements(text, runtime).filter(
    (entry) => !session.variables.has(entry.key),
  )
  if (promised.length > 0) await askForInputs(session, promised, { destination })
  // A closed question leaves its variable unset, so the second pass below would ask the very same
  // thing again — the reader who pressed Escape would watch the dialog reappear.
  if (session.dismissed) return { text: '', cursor: null }
  const result = await formatQuickAddText(text, runtime)
  // A token that only appeared after the prompts ran (a macro or an included template's own
  // `{{VALUE}}`) has not been asked for yet; ask once more rather than write a literal token.
  const rest = collectRequirements(result.text, runtime).filter(
    (entry) => !session.variables.has(entry.key),
  )
  if (rest.length === 0) return result
  await askForInputs(session, rest, { destination })
  if (session.dismissed) return { text: '', cursor: null }
  return formatQuickAddText(text, runtime)
}


