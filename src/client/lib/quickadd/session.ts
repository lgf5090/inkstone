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
import { askForInputs } from './runtime'
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

export function newSession(
  choice: QuickAddChoice,
  port: NotePort,
  variables?: Map<string, PromptAnswer>,
  /** The day a `pick a day` command was given, before the choice's own origin is applied. */
  day?: Date,
  /** The note the reader was in, which a macro reached through `{{MACRO:}}` inherits. */
  sourceNoteId?: string,
): RunSession {
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

/** The day a run measures its dates from, when the choice says "ask me each time". */
export async function applyDateOrigin(session: RunSession): Promise<QuickAddRunStatus | null> {
  if (session.base.dateOrigin !== 'ask') return null
  const answers = await askForInputs(session, [promptRequest({
    kind: 'date',
    key: 'day',
    label: t('quickadd.prompt_day'),
    dateFormat: session.settings.dateFormat,
  })])
  const value = answers.get('day') ?? null
  if (value === null) return { kind: 'cancelled' }
  const stamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(stamp))
    return { kind: 'failed', reason: t('quickadd.error_day_unreadable') }
  const origin = new Date(stamp)
  origin.setHours(session.clock.now.getHours(), session.clock.now.getMinutes(), session.clock.now.getSeconds())
  session.clock = { now: session.clock.now, date: origin }
  return null
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


