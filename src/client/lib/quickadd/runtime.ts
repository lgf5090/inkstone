/**
 * Builds the format engine's runtime out of the app seams, and owns the one behaviour the engine
 * cannot decide for itself: when a run asks its questions one at a time and when it asks them all on
 * a single page.
 *
 * A run's clock is fixed here, once. `{{DATE}}` in a name, a folder and a body has to agree even when
 * the reader spends a minute at a prompt, and a choice whose day origin is a specific note measures
 * every date token from that note's day instead.
 */
import type { QuickAddChoice, QuickAddChoiceBase, QuickAddOnePageMode, QuickAddPeriod, QuickAddSettings } from '@shared/quickadd'
import { formatDatePattern } from './date-pattern'
import { askQuickAddPrompts, type PromptAnswers } from '../../features/quickadd/prompt-queue'
import type { FormatRuntime, PromptAnswer, PromptRequest } from './format'
import type { NotePort } from './context'
import { localeTag } from '../../lib/i18n'

export interface RunSession {
  choice: QuickAddChoice
  base: QuickAddChoiceBase
  settings: QuickAddSettings
  variables: Map<string, PromptAnswer>
  clock: { now: Date; date: Date }
  /** The note this run is writing, once it is known. */
  destination: { id: string; title: string } | null
  /** The note the reader was in when the run started, for a macro reached from `{{MACRO:}}`. */
  sourceNoteId?: string
  /** Set only while a property capture formats its value. */
  propertyValue?: PromptAnswer
  /** A question was closed rather than answered: the run stops instead of writing what was typed. */
  dismissed?: boolean
}

export interface RuntimeHooks {
  /** How `{{MACRO:name}}` is answered; the macro engine injects this. */
  runMacro?: (name: string, label: string | null) => Promise<string>
}

export function globalVarMap(settings: QuickAddSettings): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of settings.globalVars) map.set(entry.name, entry.value)
  return map
}

function shift(origin: Date, period: QuickAddPeriod, offset: number): Date {
  const next = new Date(origin.getTime())
  if (!offset) return next
  switch (period) {
    case 'daily':
      next.setDate(next.getDate() + offset)
      break
    case 'weekly':
      next.setDate(next.getDate() + offset * 7)
      break
    case 'monthly':
      next.setMonth(next.getMonth() + offset)
      break
    case 'quarterly':
      next.setMonth(next.getMonth() + offset * 3)
      break
    case 'yearly':
      next.setFullYear(next.getFullYear() + offset)
      break
  }
  return next
}

/** The folder and title of the periodic note a `{{DAILY}}`-family token names. */
export function periodicNote(
  settings: QuickAddSettings,
  period: QuickAddPeriod,
  clock: { now: Date; date: Date },
  offset: number,
): { folder: string; title: string; templateId: string | null } {
  const entry = settings.periodic[period]
  return {
    folder: entry.folder,
    title: formatDatePattern(shift(clock.date, period, offset), entry.format, { locale: localeTag() }),
    templateId: entry.templateId,
  }
}

/** Which page mode a run asks in: the choice's own setting wins over the account's. */
export function pageMode(session: RunSession): QuickAddOnePageMode {
  return session.base.onePage ?? session.settings.onePage
}

/**
 * Ask what a format needs. One page is used when the choice or the account says always, or when the
 * run has two or more plain inputs. A run with a single input gets the single dialog, which is what
 * a person firing a hotkey expects, and a multi-select is kept off the page because its own dialog
 * already holds several rows.
 */
export async function askForInputs(
  session: RunSession,
  requests: PromptRequest[],
  extra?: { destination?: string },
): Promise<PromptAnswers> {
  if (requests.length === 0) return new Map()
  const mode = pageMode(session)
  const wantPage = mode === 'always'
    ? true
    : mode === 'never'
      ? false
      : requests.length > 1 && !requests.some((request) => request.multiSelect)
  return askQuickAddPrompts({
    requests,
    onePage: wantPage,
    choiceId: session.base.id,
    choiceName: session.base.name,
    destination: extra?.destination ?? session.destination?.title,
  }).then((answers) => {
    if (!answers) {
      session.dismissed = true
      return new Map<string, PromptAnswer>()
    }
    for (const [key, value] of answers) session.variables.set(key, value)
    return answers
  })
}

export function buildRuntime(session: RunSession, port: NotePort, hooks: RuntimeHooks = {}): FormatRuntime {
  const active = port.activeNote()
  const askOne = async (request: PromptRequest): Promise<PromptAnswer> => {
    const answers = await askForInputs(session, [request])
    return answers.get(request.key) ?? null
  }
  return {
    variables: session.variables,
    globalVars: globalVarMap(session.settings),
    locale: localeTag(),
    // A getter, not a snapshot: a page can be answered before "ask me each time" moves the run's day,
    // and a date token in a name and in a body still has to agree.
    get clock() { return session.clock },
    defaults: { dateFormat: session.settings.dateFormat, timeFormat: session.settings.timeFormat },
    // The engines fill these in as the run decides where it is writing and what the note is called.
    title: null,
    folderPath: null,
    activeTitle: active?.title ?? null,
    activeFolderPath: active?.folderPath ?? null,
    selection: port.selection(),
    clipboard: () => port.clipboard(),
    linkToActive: (subpath) => (active ? `${port.linkTo(active)}${subpath ?? ''}` : ''),
    cursorHeadingPath: () => port.cursorHeadingPath(),
    prompt: askOne,
    templateBody: (name) => port.templateBody(name),
    // A `{{MACRO:}}` inside a capture or template format has to reach the macro engine, or the token
    // silently writes nothing. The import is deferred because the macro engine is what runs captures:
    // a static edge here would close the cycle at module-evaluation time.
    runMacroByName: async (name, label) => {
      if (hooks.runMacro) return hooks.runMacro(name, label)
      const { runMacroByName } = await import('./macro')
      return runMacroByName(name, port, {
        variables: session.variables,
        day: session.clock.date,
        sourceNoteId: session.sourceNoteId,
      })
    },
    fieldValues: (token) => port.fieldValues(token.fieldName, {
      folder: token.folder,
      tag: token.tag,
      excludeTag: token.excludeTag,
    }),
    pickFile: (token) => port.pickFileTitles(token).then((titles) => askOne({
      kind: 'suggester',
      key: token.aliasName ?? token.folder,
      label: token.label ?? token.folder,
      defaultValue: '',
      options: titles,
      displayOptions: null,
      allowCustom: token.allowCustomInput,
      multiSelect: token.multiSelect,
      multiFormat: 'auto',
      optional: token.optional,
      trim: false,
      caseStyle: null,
      numeric: {},
      dateFormat: null,
      withTime: false,
    })),
    periodicPath: (period, offset, link) => {
      const note = periodicNote(session.settings, period, session.clock, offset)
      const found = port.findByTitle(note.title)
      const ref = found ?? { id: '', title: note.title, folderPath: note.folder || null }
      return link ? port.linkTo(ref) : note.folder ? `${note.folder}/${note.title}` : note.title
    },
    warn: (message) => port.notify(session.base.name, message, 'warning'),
  }
}
