import { TaskRegularExpressions as RE } from '../model/task-regular-expressions'
import { OnCompletion, parseOnCompletionValue } from '../model/on-completion'
import { Priority } from '../model/priority'
import { emptyTaskFields, type SerializeOptions, type TaskDateField, type TaskFields, type TaskSerializer } from './index'

const ID = /[a-zA-Z0-9-_]+/
const ID_SEQUENCE = new RegExp(`${ID.source}( *, *${ID.source} *)*`)

/**
 * A field written as a Dataview inline field, in either bracket style.
 *
 * `[due:: 2026-10-04]` and `(due:: 2026-10-04)` both read, because readers use whichever one is
 * not already taken by a link on the same line. Only the square form is ever written.
 */
function inlineField(key: string, value: string): RegExp {
  return new RegExp(`(?:\\(|\\[)${key}:: *${value} *(?:\\)|\\]) *$`)
}

function dateValue(): string {
  return '(\\d{4}-\\d{2}-\\d{2})'
}

const DATE_KEYS: Array<{ field: TaskDateField; key: string }> = [
  { field: 'doneDate', key: 'completion' },
  { field: 'cancelledDate', key: 'cancelled' },
  { field: 'dueDate', key: 'due' },
  { field: 'scheduledDate', key: 'scheduled' },
  { field: 'startDate', key: 'start' },
  { field: 'createdDate', key: 'created' },
]

const WRITE_ORDER: TaskDateField[] = ['createdDate', 'startDate', 'scheduledDate', 'dueDate', 'cancelledDate', 'doneDate']

const KEY_FOR_FIELD: Record<TaskDateField, string> = {
  createdDate: 'created',
  startDate: 'start',
  scheduledDate: 'scheduled',
  dueDate: 'due',
  cancelledDate: 'cancelled',
  doneDate: 'completion',
}

const PRIORITY_NAMES: Record<Priority, string> = {
  [Priority.Highest]: 'highest',
  [Priority.High]: 'high',
  [Priority.Medium]: 'medium',
  [Priority.None]: 'none',
  [Priority.Low]: 'low',
  [Priority.Lowest]: 'lowest',
}

const NAME_TO_PRIORITY = new Map<string, Priority>(
  Object.entries(PRIORITY_NAMES).map(([priority, name]) => [name, priority as Priority]),
)

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

/**
 * The Dataview inline-field task format.
 *
 * Offered to readers who would rather write `due::` than an emoji, and to vaults imported from a
 * plain Dataview setup. It parses to exactly the same {@link TaskFields} as the emoji format, which
 * is what lets one query engine and one write path serve both.
 */
export class DataviewTaskSerializer implements TaskSerializer {
  deserialize(line: string): TaskFields {
    const fields = emptyTaskFields('')
    let rest = line
    let trailingTags = ''
    let progressed = true

    const patterns = {
      priority: inlineField('priority', `(${Object.values(PRIORITY_NAMES).join('|')})`),
      recurrence: inlineField('repeat', '([a-zA-Z0-9, !]+)'),
      onCompletion: inlineField('onCompletion', '([a-zA-Z]+)'),
      id: inlineField('id', `(${ID.source})`),
      dependsOn: inlineField('dependsOn', `(${ID_SEQUENCE.source})`),
    }

    while (progressed) {
      progressed = false

      const peel = (regex: RegExp, onMatch: (matched: RegExpExecArray) => void): boolean => {
        const matched = regex.exec(rest)
        if (matched === null || matched[0].length === 0) return false
        onMatch(matched)
        rest = rest.slice(0, rest.length - matched[0].length)
        progressed = true
        return true
      }

      peel(patterns.priority, (matched) => {
        const found = NAME_TO_PRIORITY.get(matched[1]!.trim().toLowerCase())
        if (found !== undefined) fields.priority = found
      })

      for (const { field, key } of DATE_KEYS) {
        if (peel(inlineField(key, dateValue()), (matched) => this.readDate(fields, field, matched[1]!))) break
      }
      if (progressed) continue

      peel(patterns.recurrence, (matched) => {
        fields.recurrenceRuleText = matched[1]!.trim()
      })
      peel(patterns.onCompletion, (matched) => {
        fields.onCompletion = parseOnCompletionValue(matched[1]!)
      })
      peel(patterns.id, (matched) => {
        fields.id = matched[1]!.trim()
      })
      peel(patterns.dependsOn, (matched) => {
        fields.dependsOn = matched[1]!.replace(/ /g, '').split(',').filter((item) => item !== '')
      })
      peel(RE.hashTagsFromEnd, (matched) => {
        const tag = matched[0].trim()
        trailingTags = trailingTags.length > 0 ? `${tag} ${trailingTags}` : tag
      })
    }

    rest = rest.trimEnd()
    if (trailingTags.length > 0) rest += rest.length > 0 ? ` ${trailingTags}` : trailingTags
    fields.description = rest
    fields.tags = (rest.match(RE.hashTags) ?? []).map((tag) => tag.trim())
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
    const add = (key: string, value: string): void => {
      parts.push(` [${key}:: ${value}]`)
    }

    if (fields.id !== '') add('id', fields.id)
    if (fields.dependsOn.length > 0) add('dependsOn', fields.dependsOn.join(','))
    if (fields.priority !== Priority.None) add('priority', PRIORITY_NAMES[fields.priority])
    if (fields.recurrenceRuleText !== '') add('repeat', fields.recurrenceRuleText)
    if (fields.onCompletion !== OnCompletion.Ignore) add('onCompletion', fields.onCompletion)

    for (const field of WRITE_ORDER) {
      const date = fields[field]
      if (date === null) continue
      if (field === 'scheduledDate' && options.scheduledDateIsInferred === true) continue
      const key = KEY_FOR_FIELD[field]
      const broken = fields.invalidDates[field]
      if (broken !== undefined) add(key, broken)
      else if (!short) add(key, formatDate(date))
    }

    return parts.join('')
  }
}
