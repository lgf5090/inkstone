import { parseDay } from '../date/date-parser'
import { formatTaskDate } from '../date/date-tools'
import { Recurrence } from '../model/recurrence'
import { Occurrence } from '../model/occurrence'
import { Priority } from '../model/priority'
import { extractTaskComponents } from '../model/task'
import { EMOJI_SYMBOLS } from '../serializer/emoji'
import type { StatusRegistry } from '../status/registry'

/**
 * What the editor offers while a task line is being typed.
 *
 * The menu is not a generic word completer: it knows a `📅` wants a day, that `every wed` is almost a
 * recurrence rule, and that a field already on the line should not be offered again. Everything here
 * is pure over `(line, cursor)` so the whole table can be tested without an editor — the CodeMirror
 * side only decides where to put the list.
 */

/** One row of the menu. */
export interface SuggestInfo {
  /** `match` means the row completes what the reader typed; `empty` is the "do nothing" escape row. */
  suggestionType?: 'match' | 'empty'
  displayText: string
  appendText: string
  /**
   * What the word under the caret is compared against, when that is not the display text.
   *
   * The created-date row displays `➕ created today (2026-10-19)`; without a narrower key, a reader
   * typing `today` into a due field would find the created field offered instead of the date they mean.
   */
  textToMatch?: string
  /** Character offset the replacement starts at, when it is not simply appended. */
  insertAt?: number
  /** How many characters after the caret the replacement swallows. */
  insertSkip?: number
}

export interface SuggestorSettings {
  /** Characters the reader must type before a field starts filtering its own menu. */
  autoSuggestMinMatch: number
  /** Ceiling on the whole menu, shared with the editor's completion list. */
  autoSuggestMaxItems: number
  /** The vault's global filter, which gates the menu to lines that carry it. */
  globalFilter: string
}

export const DEFAULT_SUGGESTOR_SETTINGS: SuggestorSettings = {
  autoSuggestMinMatch: 0,
  autoSuggestMaxItems: 6,
  globalFilter: '',
}

/** A field name is only offered when its symbol is not already on the line. */
export const MAX_GENERIC_FIELD_SUGGESTIONS = 5

interface Parameters {
  line: string
  cursorPos: number
  now: Date
  settings: SuggestorSettings
  /** The reader stamps dates as `[due:: …]` rather than `📅 …`. */
  dataviewMode: boolean
  postfix: string
  insertSkip: number
}

const S = {
  due: EMOJI_SYMBOLS.dueDate.write,
  start: EMOJI_SYMBOLS.startDate.write,
  scheduled: EMOJI_SYMBOLS.scheduledDate.write,
  created: EMOJI_SYMBOLS.createdDate.write,
  done: EMOJI_SYMBOLS.doneDate.write,
  cancelled: EMOJI_SYMBOLS.cancelledDate.write,
  recurrence: EMOJI_SYMBOLS.recurrence.write,
  onCompletion: EMOJI_SYMBOLS.onCompletion.write,
  id: EMOJI_SYMBOLS.id.write,
  dependsOn: EMOJI_SYMBOLS.dependsOn.write,
  priority: EMOJI_SYMBOLS.priority.write as Record<string, string>,
}

const DATE_PREFIX = `${S.start}|${S.scheduled}|${S.due}`

const GENERIC_DATES = [
  'today',
  'tomorrow',
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'next week',
  'next month',
  'next year',
]

const GENERIC_RECURRENCE = [
  'every',
  'every day',
  'every week',
  'every month',
  'every month on the',
  'every year',
  'every week on Sunday',
  'every week on Monday',
  'every week on Tuesday',
  'every week on Wednesday',
  'every week on Thursday',
  'every week on Friday',
  'every week on Saturday',
]

/** The reference plugin's order: the three everyday levels first, the two extremes after them. */
const PRIORITY_ROWS: Array<{ value: Priority; label: string }> = [
  { value: Priority.High, label: 'high' },
  { value: Priority.Medium, label: 'medium' },
  { value: Priority.Low, label: 'low' },
  { value: Priority.Highest, label: 'highest' },
  { value: Priority.Lowest, label: 'lowest' },
]

/**
 * The menu for one caret position.
 *
 * Order matters the way upstream's does: a field-specific match (a date after `📅`, a rule after
 * `🔁`) wins over the generic list of fields, and the generic list only appears when the caret is not
 * inside one of those.
 */
export function suggestFor(input: {
  line: string
  cursorPos: number
  now: Date
  settings?: Partial<SuggestorSettings>
  dataviewMode?: boolean
  existingIds?: string[]
}): SuggestInfo[] {
  const settings: SuggestorSettings = { ...DEFAULT_SUGGESTOR_SETTINGS, ...input.settings }
  const dataviewMode = input.dataviewMode === true
  const { postfix, insertSkip } = adjusters(dataviewMode, input.line, input.cursorPos)
  const parameters: Parameters = {
    line: input.line,
    cursorPos: input.cursorPos,
    now: input.now,
    settings,
    dataviewMode,
    postfix,
    insertSkip,
  }

  let out = dateSuggestions(MAX_GENERIC_FIELD_SUGGESTIONS, parameters)
  out = out.concat(recurrenceSuggestions(parameters))
  out = out.concat(idSuggestions(input.existingIds ?? [], parameters))
  out = out.concat(onCompletionSuggestions(MAX_GENERIC_FIELD_SUGGESTIONS, parameters))
  out = out.concat(fieldSuggestions(parameters))

  // A row that lets Enter mean "next line" is only needed when nothing else matched exactly: without
  // it, a reader typing past the menu finds themselves inserting a field instead of moving on.
  if (out.length > 0 && !out.some((value) => value.suggestionType === 'match') && !dataviewMode) {
    out.unshift({ suggestionType: 'empty', displayText: '⏎', appendText: '\n' })
  }
  return out.slice(0, settings.autoSuggestMaxItems)
}

/**
 * What a completed field is glued to: a space in the emoji format, and the reader's own closing
 * bracket plus a space in the inline-field one. When the caret already sits on a closing bracket,
 * the replacement swallows it instead of stacking two.
 */
function adjusters(dataviewMode: boolean, line: string, cursorPos: number): { postfix: string; insertSkip: number } {
  const closing = lastOpenBracket(line.slice(0, cursorPos), [['(', ')'], ['[', ']']]) === '(' ? ')' : ']'
  const postfix = dataviewMode ? `${closing} ` : ' '
  const insertSkip = dataviewMode && line.length > cursorPos && line.charAt(cursorPos) === closing ? 1 : 0
  return { postfix, insertSkip }
}

function dateSuggestions(max: number, parameters: Parameters): SuggestInfo[] {
  const results: SuggestInfo[] = []
  const match = matchIfCursorInRegex(new RegExp(`(${DATE_PREFIX})\\s*([0-9a-zA-Z ]*)`, 'ug'), parameters)
  if (match === null) return results
  const typed = match[2]
  if (typed.length < parameters.settings.autoSuggestMinMatch) return []

  if (typed.length > 1) {
    const parsed = parseDay(typed, parameters.now, true)
    if (parsed !== null) {
      // The words as typed, completed to the day they mean, offered first.
      construct(parameters, match, [formatTaskDate(parsed)], (symbol, text) => ({
        displayText: text,
        appendText: `${symbol} ${text}`,
      }), results)
    }
  }
  const generic = filterGeneric(GENERIC_DATES, typed, max, true)
  construct(parameters, match, generic, (symbol, text) => {
    const day = parseDay(text, parameters.now, true)
    const formatted = day === null ? text : formatTaskDate(day)
    return { displayText: `${text} (${formatted})`, appendText: `${symbol} ${formatted}` }
  }, results)
  return results
}

function recurrenceSuggestions(parameters: Parameters): SuggestInfo[] {
  const results: SuggestInfo[] = []
  const match = matchIfCursorInRegex(new RegExp(`(${S.recurrence})\\s*([0-9a-zA-Z ]*)`, 'ug'), parameters)
  if (match === null) return results
  const typed = match[2]
  if (typed.length < parameters.settings.autoSuggestMinMatch) return []

  if (typed.length > 0) {
    const parsed = Recurrence.fromText({
      recurrenceRuleText: typed,
      occurrence: new Occurrence({ startDate: null, scheduledDate: null, dueDate: null }),
      now: parameters.now,
    })?.toText()
    if (parsed !== undefined && parsed !== '') {
      const appended = `${match[1]} ${parsed}${parameters.postfix}`
      results.push({
        suggestionType: 'match',
        // The check mark is the reader's signal that this is a whole, valid rule, not a start.
        displayText: `✓ ${parsed}`,
        appendText: appended,
        insertAt: match.index,
        insertSkip: skipForMatch(match[0], parameters),
      })
      // The rule is already complete and the caret sits past it: the reader is typing on, not asking.
      if (match[0] === appended) return []
    }
  }

  const max = Math.floor(parameters.settings.autoSuggestMaxItems / 2)
  let generic = filterGeneric(GENERIC_RECURRENCE, typed, max, false)
  if (generic.length === 0 && typed.trim().length === 0) generic = GENERIC_RECURRENCE.slice(0, max)
  construct(parameters, match, generic, (symbol, text) => ({
    displayText: text,
    appendText: `${symbol} ${text}`,
  }), results)
  return results
}

function onCompletionSuggestions(max: number, parameters: Parameters): SuggestInfo[] {
  const results: SuggestInfo[] = []
  const match = matchIfCursorInRegex(new RegExp(`(${S.onCompletion})\\s*([0-9a-zA-Z ]*)`, 'ug'), parameters)
  if (match === null) return results
  const typed = match[2]
  if (typed.length < parameters.settings.autoSuggestMinMatch) return []
  construct(parameters, match, filterGeneric(['delete', 'keep'], typed, max, true), (symbol, text) => ({
    displayText: text,
    appendText: `${symbol} ${text}`,
  }), results)
  return results
}

function idSuggestions(existingIds: string[], parameters: Parameters): SuggestInfo[] {
  const results: SuggestInfo[] = []
  const match = matchIfCursorInRegex(new RegExp(`(${S.id})\\s*([a-zA-Z0-9-_]*)`, 'ug'), parameters)
  if (match !== null && match[0].trim().length <= S.id.length) {
    results.push({
      suggestionType: 'match',
      displayText: 'generate unique id',
      appendText: `${S.id} ${generateUniqueId(existingIds)}${parameters.postfix}`,
      insertAt: match.index,
      insertSkip: skipForMatch(match[0], parameters),
    })
  }
  return results
}

/** The fields the line does not carry yet, filtered by the word under the caret. */
function fieldSuggestions(parameters: Parameters): SuggestInfo[] {
  const line = parameters.line
  const generic: SuggestInfo[] = []
  const addField = (symbol: string, name: string): void => {
    if (!line.includes(symbol)) generic.push({ displayText: `${symbol} ${name}`, appendText: `${symbol} ` })
  }

  addField(S.due, 'due date')
  addField(S.start, 'start date')
  addField(S.scheduled, 'scheduled date')

  if (!PRIORITY_ROWS.some((row) => line.includes(S.priority[row.value]))) {
    for (const row of PRIORITY_ROWS) {
      generic.push({
        displayText: parameters.dataviewMode
          ? `${S.priority[row.value]} priority`
          : `${S.priority[row.value]} ${row.label} priority`,
        appendText: `${S.priority[row.value]}${parameters.postfix}`,
        insertSkip: parameters.dataviewMode ? parameters.insertSkip : undefined,
      })
    }
  }

  addField(S.recurrence, 'recurring (repeat)')
  if (!line.includes(S.created)) {
    const today = formatTaskDate(parameters.now)
    generic.push({
      textToMatch: `${S.created} created`,
      displayText: `${S.created} created today (${today})`,
      appendText: `${S.created} ${today}${parameters.postfix}`,
      insertSkip: parameters.dataviewMode ? parameters.insertSkip : undefined,
    })
  }
  addField(S.id, 'id')
  addField(S.dependsOn, 'depends on id')
  addField(S.onCompletion, 'on completion')

  const matched = matchWordAtCursor(generic, parameters)
  if (matched.length === 0 && parameters.settings.autoSuggestMinMatch === 0) return generic
  return matched
}

function matchWordAtCursor(generic: SuggestInfo[], parameters: Parameters): SuggestInfo[] {
  const wordMatch = matchIfCursorInRegex(/([a-zA-Z'_-]*)/g, parameters)
  const out: SuggestInfo[] = []
  if (!wordMatch || wordMatch[0].length === 0) return out
  const word = wordMatch[0]
  if (word.length < Math.max(1, parameters.settings.autoSuggestMinMatch)) return out
  for (const item of generic) {
    const key = item.textToMatch ?? item.displayText
    if (!key.toLowerCase().includes(word.toLowerCase())) continue
    out.push({
      suggestionType: 'match',
      displayText: item.displayText,
      appendText: item.appendText,
      insertAt: wordMatch.index,
      insertSkip: parameters.dataviewMode && /priority|created/.test(item.displayText)
        ? word.length + parameters.insertSkip
        : word.length,
    })
  }
  return out
}

function construct(
  parameters: Parameters,
  match: RegExpMatchArray,
  matches: string[],
  extract: (symbol: string, text: string) => { displayText: string; appendText: string },
  results: SuggestInfo[],
): void {
  for (const text of matches) {
    const { displayText, appendText } = extract(match[1], text)
    results.push({
      suggestionType: 'match',
      displayText,
      appendText: appendText + parameters.postfix,
      insertAt: match.index,
      insertSkip: skipForMatch(match[0], parameters),
    })
  }
}

function filterGeneric(items: string[], typed: string, max: number, allWhenEmpty: boolean): string[] {
  let hits = items
    .filter((item) => typed && item.toLowerCase().includes(typed.toLowerCase()))
    .slice(0, max)
  if (allWhenEmpty && hits.length === 0) hits = items.slice(0, max)
  return hits
}

/**
 * The match that contains the caret.
 *
 * A match that starts at character zero is kept (`match.index` is falsy but valid), which upstream's
 * `if (match.index && …)` silently dropped — a task line whose first field begins at the caret
 * deserves its menu too.
 */
export function matchIfCursorInRegex(regex: RegExp, parameters: Parameters): RegExpMatchArray | null {
  for (const match of parameters.line.matchAll(regex)) {
    const at = match.index ?? 0
    if (at <= parameters.cursorPos && parameters.cursorPos <= at + match[0].length) return match
  }
  return null
}

function skipForMatch(match: string, parameters: Parameters): number {
  return parameters.dataviewMode ? match.length + parameters.insertSkip : match.length
}

/** The last unclosed bracket of the given pairs, or null when none is open. */
export function lastOpenBracket(line: string, pairs: Array<[string, string]>): string | null {
  if (pairs.length === 0) return null
  const open = new Map<string, number>()
  const closerOf = new Map<string, string>()
  for (const [opening, closing] of pairs) {
    open.set(opening, 0)
    closerOf.set(closing, opening)
  }
  const stack: string[] = []
  for (const char of line) {
    if (open.has(char)) {
      open.set(char, open.get(char)! + 1)
      stack.push(char)
    } else if (closerOf.has(char)) {
      const opening = closerOf.get(char)!
      if ((open.get(opening) ?? 0) >= 1) {
        for (let index = stack.length - 1; index >= 0; index--) {
          if (stack[index] === opening) {
            stack.splice(index, 1)
            break
          }
        }
      }
      open.set(opening, Math.max(0, (open.get(opening) ?? 0) - 1))
    }
  }
  return stack.length > 0 ? stack[stack.length - 1] : null
}

/**
 * Whether the caret is somewhere a task field can go.
 *
 * Only a task line qualifies, and only past its checkbox: a suggestion menu inside the words the
 * reader is still writing would be noise, and a status the reader declared "not a task" has no fields
 * to complete. With a global filter set, the line has to carry it — that is what the filter means.
 */
export function canSuggestForLine(
  line: string,
  cursorPos: number,
  registry: StatusRegistry,
  globalFilter: string,
): boolean {
  if (line.length === 0) return false
  if (globalFilter !== '' && !line.includes(globalFilter)) return false
  const components = extractTaskComponents(line)
  if (components === null) return false
  if (registry.bySymbolOrCreate(components.statusSymbol).type === 'NON_TASK') return false
  const beforeDescription = `${components.indentation}${components.listMarker} [${components.statusSymbol}] `
  return cursorPos >= beforeDescription.length
}

/** Four characters, the shape the reference plugin uses so ids stay readable in a note. */
export function generateUniqueId(existing: string[]): string {
  let id = ''
  do {
    id = Math.random().toString(36).slice(2, 6)
  } while (id === '' || existing.includes(id))
  return id
}
