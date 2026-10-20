import { TaskRegularExpressions as RE } from '../model/task-regular-expressions'
import { OnCompletion, parseOnCompletionValue } from '../model/on-completion'
import { Priority } from '../model/priority'
import { emptyTaskFields, type SerializeOptions, type TaskDateField, type TaskFields, type TaskSerializer } from './index'

/** The characters allowed in a task id, and a comma-separated run of them. */
const ID = /[a-zA-Z0-9-_]+/
const ID_SEQUENCE = new RegExp(`${ID.source}( *, *${ID.source} *)*`)

/**
 * Build a pattern that strips one field off the end of the line.
 *
 * Every field is anchored at `$` because the reader may write them in any order: the parser peels
 * from the right until nothing recognisable is left, which is what lets `📅 … ✅ … #tag` and
 * `#tag ✅ … 📅 …` both parse. `\uFE0F?` accepts the emoji either with or without its variation
 * selector, and the `u` flag is deliberately absent — with it, some engines refuse to match these
 * emoji at all.
 */
function fieldRegex(symbols: string, value = ''): RegExp {
  return new RegExp(value === '' ? `${symbols}\uFE0F? *$` : `${symbols}\uFE0F? *${value} *$`)
}

function dateFieldRegex(symbols: string): RegExp {
  return fieldRegex(symbols, '(\\d{4}-\\d{2}-\\d{2})')
}

/**
 * The emoji format's symbol table.
 *
 * `read` is wider than `write` wherever Inkstone already accepted a spelling: `created` answers to
 * the `✕` this project's Dataview port used, and `scheduled` to `⌚`. Writing only the upstream
 * spelling keeps new notes portable while old ones keep reading.
 */
/**
 * The priority symbols, written as code points rather than literals.
 *
 * Several of these emoji are commonly followed by U+FE0F, which is invisible in an editor and turns
 * a regex alternation into one with an empty branch — a pattern that matches zero characters and
 * would make the peel loop run forever. Spelling them as escapes removes that whole class of bug.
 */
const PRIORITY_SYMBOLS: Array<{ symbol: string; priority: Priority }> = [
  { symbol: '\u{1F53A}', priority: Priority.Highest },
  { symbol: '\u23EB', priority: Priority.High },
  { symbol: '\u{1F53C}', priority: Priority.Medium },
  { symbol: '\u{1F53D}', priority: Priority.Low },
  { symbol: '\u23EC', priority: Priority.Lowest },
]

const PRIORITY_BY_SYMBOL = new Map<string, Priority>(
  PRIORITY_SYMBOLS.map((entry) => [entry.symbol, entry.priority]),
)

const PRIORITY_WRITE: Record<string, string> = Object.fromEntries(
  PRIORITY_SYMBOLS.map((entry) => [entry.priority, entry.symbol]),
)

/**
 * The emoji format's symbol table.
 *
 * `read` is wider than `write` wherever Inkstone already accepted a spelling: `created` answers to
 * the U+2715 this project's Dataview port used, and `scheduled` to U+231A. Writing only the upstream
 * spelling keeps new notes portable while old ones keep reading.
 */
export const EMOJI_SYMBOLS = {
  priority: {
    read: `(${PRIORITY_SYMBOLS.map((entry) => entry.symbol).join('|')})`,
    write: PRIORITY_WRITE,
  },
  createdDate: { write: '\u2795', read: '(?:\u2795|\u2715)' },
  startDate: { write: '\u{1F6EB}', read: '(?:\u{1F6EB})' },
  scheduledDate: { write: '\u23F3', read: '(?:\u23F3|\u231B|\u231A)' },
  dueDate: { write: '\u{1F4C5}', read: '(?:\u{1F4C5}|\u{1F4C6}|\u{1F5D3})' },
  cancelledDate: { write: '\u274C', read: '(?:\u274C)' },
  doneDate: { write: '\u2705', read: '(?:\u2705)' },
  recurrence: { write: '\u{1F501}', pattern: fieldRegex('\u{1F501}', '([a-zA-Z0-9, !]+)') },
  onCompletion: { write: '\u{1F3C1}', pattern: fieldRegex('\u{1F3C1}', '([a-zA-Z]+)') },
  id: { write: '\u{1F194}', pattern: fieldRegex('\u{1F194}', `(${ID.source})`) },
  dependsOn: { write: '\u26D4', pattern: fieldRegex('\u26D4', `(${ID_SEQUENCE.source})`) },
}

const PRIORITY_PATTERN = fieldRegex(EMOJI_SYMBOLS.priority.read)

/** Read order is significance order, matching the layout order written back. */
const DATE_FIELDS: Array<{ field: TaskDateField; regex: RegExp }> = [
  { field: 'doneDate', regex: dateFieldRegex(EMOJI_SYMBOLS.doneDate.read) },
  { field: 'cancelledDate', regex: dateFieldRegex(EMOJI_SYMBOLS.cancelledDate.read) },
  { field: 'dueDate', regex: dateFieldRegex(EMOJI_SYMBOLS.dueDate.read) },
  { field: 'scheduledDate', regex: dateFieldRegex(EMOJI_SYMBOLS.scheduledDate.read) },
  { field: 'startDate', regex: dateFieldRegex(EMOJI_SYMBOLS.startDate.read) },
  { field: 'createdDate', regex: dateFieldRegex(EMOJI_SYMBOLS.createdDate.read) },
]

const WRITE_ORDER: TaskDateField[] = [
  'createdDate',
  'startDate',
  'scheduledDate',
  'dueDate',
  'cancelledDate',
  'doneDate',
]

/**
 * A `YYYY-MM-DD` that names a real day, or an `Invalid Date` when the shape was right and the day
 * was not. `2022-02-30` is the case this exists for: it must stay visible as a mistake.
 */
function parseDateText(text: string): Date {
  const [year, month, day] = text.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) return new Date(Number.NaN)
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return new Date(Number.NaN)
  }
  return date
}

function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function extractHashtags(description: string): string[] {
  const found = description.match(RE.hashTags)
  return found === null ? [] : found.map((tag) => tag.trim())
}

/**
 * The Tasks emoji format.
 *
 * Reading peels recognised fields off the right-hand end until nothing matches, so field order is
 * the reader's choice rather than a grammar. Writing uses a fixed order, because a rewrite that
 * reshuffled fields would produce a diff for every tick.
 */
export class EmojiTaskSerializer implements TaskSerializer {
  deserialize(line: string): TaskFields {
    const fields = emptyTaskFields('')
    let rest = line
    let trailingTags = ''
    let progressed = true

    // Each pattern is end-anchored and matches at least one character, so every peel strictly
    // shortens `rest`; the loop ends on its own and needs no iteration cap to stop a runaway.
    while (progressed) {
      progressed = false

      const peel = (regex: RegExp, onMatch: (matched: RegExpExecArray) => void): boolean => {
        const matched = regex.exec(rest)
        // A pattern that can match the empty string would otherwise leave `rest` unchanged and
        // keep the loop reporting progress forever.
        if (matched === null || matched[0].length === 0) return false
        onMatch(matched)
        rest = rest.slice(0, rest.length - matched[0].length)
        progressed = true
        return true
      }

      peel(PRIORITY_PATTERN, (matched) => {
        const found = PRIORITY_BY_SYMBOL.get(matched[1]!)
        if (found !== undefined) fields.priority = found
      })

      for (const { field, regex } of DATE_FIELDS) {
        if (!peel(regex, (matched) => this.readDate(fields, field, matched[1]!))) continue
        break
      }
      if (progressed) continue

      peel(EMOJI_SYMBOLS.recurrence.pattern, (matched) => {
        fields.recurrenceRuleText = matched[1]!.trim()
      })
      peel(EMOJI_SYMBOLS.onCompletion.pattern, (matched) => {
        fields.onCompletion = parseOnCompletionValue(matched[1]!)
      })

      peel(RE.hashTagsFromEnd, (matched) => {
        const tag = matched[0].trim()
        // Accumulated right-to-left and re-joined in order, because tags may sit between fields.
        trailingTags = trailingTags.length > 0 ? `${tag} ${trailingTags}` : tag
      })

      peel(EMOJI_SYMBOLS.id.pattern, (matched) => {
        fields.id = matched[1]!.trim()
      })
      peel(EMOJI_SYMBOLS.dependsOn.pattern, (matched) => {
        fields.dependsOn = matched[1]!
          .replace(/ /g, '')
          .split(',')
          .filter((item) => item !== '')
      })
    }

    rest = rest.trimEnd()
    if (trailingTags.length > 0) {
      rest += rest.length > 0 ? ` ${trailingTags}` : trailingTags
    }
    fields.description = rest
    fields.tags = extractHashtags(rest)
    return fields
  }

  private readDate(fields: TaskFields, field: TaskDateField, text: string): void {
    const date = parseDateText(text)
    if (Number.isNaN(date.getTime())) {
      fields[field] = new Date(Number.NaN)
      fields.invalidDates[field] = text
    }
    else {
      fields[field] = date
    }
  }

  serialize(fields: TaskFields, options: SerializeOptions = {}): string {
    const short = options.shortMode === true
    const parts: string[] = [fields.description]

    if (fields.id !== '') parts.push(` ${EMOJI_SYMBOLS.id.write} ${fields.id}`)
    if (fields.dependsOn.length > 0) parts.push(` ${EMOJI_SYMBOLS.dependsOn.write} ${fields.dependsOn.join(',')}`)

    const prioritySymbol = EMOJI_SYMBOLS.priority.write[fields.priority]
    if (prioritySymbol !== undefined) parts.push(` ${prioritySymbol}`)

    if (fields.recurrenceRuleText !== '') {
      parts.push(short
        ? ` ${EMOJI_SYMBOLS.recurrence.write}`
        : ` ${EMOJI_SYMBOLS.recurrence.write} ${fields.recurrenceRuleText}`)
    }
    if (fields.onCompletion !== OnCompletion.Ignore) {
      parts.push(` ${EMOJI_SYMBOLS.onCompletion.write} ${fields.onCompletion}`)
    }

    for (const field of WRITE_ORDER) {
      const date = fields[field]
      if (date === null) continue
      if (field === 'scheduledDate' && options.scheduledDateIsInferred === true) continue
      const symbol = EMOJI_SYMBOLS[field].write
      const broken = fields.invalidDates[field]
      // An unreadable date goes back exactly as it was found rather than dropped or "fixed", so the
      // reader still sees the typo they made instead of finding their note quietly edited.
      if (broken !== undefined) parts.push(` ${symbol} ${broken}`)
      else parts.push(short ? ` ${symbol}` : ` ${symbol} ${formatDate(date)}`)
    }

    return parts.join('')
  }
}
