import { startOfDay } from '../../../lib/time'
import { parseRange } from '../date/date-parser'
import { DateRange } from '../date/date-range'
import type { TaskDateField } from '../serializer/index'
import type { Task } from '../model/task'
import { Field } from './field'
import { invalidFilter, type Comparator, type FilterOrErrorMessage, type GrouperFunction, type SearchInfo } from './values'

/**
 * Longest first, so `due on or before x` is not read as `due on x`.
 *
 * The alternation is ordered rather than anchored cleverly because the whole point of the two-word
 * forms is that a reader means "and everything up to", and matching `on` first would silently
 * narrow it to a single day.
 */
const RELATION_PATTERN = 'on or before|in or before|on or after|in or after|before|after|on|in'

function dayValue(date: Date | null): number | null {
  if (date === null) return null
  const time = startOfDay(date).getTime()
  return Number.isFinite(time) ? time : null
}

/**
 * A field that holds one of a task's dates, and the six relations a reader can ask of it.
 *
 * A missing date answers false to every relation, except for the one field where that is a lie:
 * `starts` is documented to also match tasks with no start date, because readers use it to ask
 * "what can I begin". That exception lives in `matchesWhenAbsent`, not in the comparison.
 */
export abstract class DateField extends Field {
  protected abstract dateOf(task: Task): Date | null

  /** True when the instruction should still match a task that has no value for this field. */
  protected matchesWhenAbsent(): boolean {
    return false
  }

  protected abstract instructionName(): string

  private presenceRegExp(): RegExp {
    return new RegExp(`^(has|no) ${this.fieldNameSingular()} date$`, 'i')
  }

  private invalidRegExp(): RegExp {
    return new RegExp(`^${this.fieldNameSingular()} date is invalid$`, 'i')
  }

  private relationRegExp(): RegExp {
    return new RegExp(`^${this.instructionName()} (${RELATION_PATTERN})? ?(.*)$`, 'i')
  }

  protected override filterRegExp(): RegExp {
    return this.relationRegExp()
  }

  /**
   * Three word orders, because a reader types the question differently for each.
   *
   * `has due date` and `due before x` start with different words, and `due date is invalid` shares a
   * prefix with both. They are matched separately rather than folded into one alternation so that a
   * malformed relation reports the relation it could not read instead of claiming the field name is
   * unknown.
   */
  override canCreateFilterForLine(line: string): boolean {
    const trimmed = line.trim()
    return this.presenceRegExp().test(trimmed)
      || this.invalidRegExp().test(trimmed)
      || this.relationRegExp().test(trimmed)
  }

  override createFilterOrErrorMessage(line: string, now?: Date): FilterOrErrorMessage {
    const trimmed = line.trim()

    const presence = this.presenceRegExp().exec(trimmed)
    if (presence !== null) {
      const want = presence[1]!.toLowerCase() === 'has'
      return { filter: (task) => (this.dateOf(task) !== null) === want, error: null }
    }

    if (this.invalidRegExp().test(trimmed)) {
      return { filter: (task) => this.isBroken(task), error: null }
    }

    const matched = this.relationRegExp().exec(trimmed)
    if (matched === null) return invalidFilter(`unable to parse: ${line}`)
    const relation = (matched[1] ?? 'on').toLowerCase()
    const text = (matched[2] ?? '').trim()
    if (text === '') return invalidFilter(`Missing date after '${relation}' in: ${line}`)
    const range = parseRange(text, now ?? new Date())
    if (range === null || !range.isValid()) return invalidFilter(`cannot parse the date: ${text}`)

    const compare = comparatorFor(relation)
    return {
      filter: (task) => {
        const value = dayValue(this.dateOf(task))
        if (value === null) return this.matchesWhenAbsent()
        return compare(value, range)
      },
      error: null,
    }
  }

  private isBroken(task: Task): boolean {
    const date = this.dateOf(task)
    return date !== null && !Number.isFinite(date.getTime())
  }

  protected override sorterRegExp(): RegExp {
    return new RegExp(`^sort by ${this.fieldNameSingular()}( reverse)?`, 'i')
  }

  override supportsSorting(): boolean {
    return true
  }

  comparator(): Comparator {
    const read = (task: Task) => dayValue(this.dateOf(task))
    return (a, b) => {
      const left = read(a)
      const right = read(b)
      if (left === null && right === null) return 0
      if (left === null) return 1
      if (right === null) return -1
      return left - right
    }
  }

  override supportsGrouping(): boolean {
    return true
  }

  override grouper(): GrouperFunction {
    return (task) => {
      const date = this.dateOf(task)
      if (date === null) return ['No ' + this.fieldNameSingular() + ' date']
      if (!Number.isFinite(date.getTime())) return ['%%0%%Invalid date']
      const day = startOfDay(date)
      const month = String(day.getMonth() + 1).padStart(2, '0')
      const dateOfDay = String(day.getDate()).padStart(2, '0')
      return [`%%${day.getFullYear() * 10000 + Number(month) * 100 + Number(dateOfDay)}%%${day.getFullYear()}-${month}-${dateOfDay}`]
    }
  }
}

function comparatorFor(relation: string): (value: number, range: DateRange) => boolean {
  const startOf = (range: DateRange) => range.start.getTime()
  const endOf = (range: DateRange) => range.end.getTime()
  switch (relation) {
    case 'before':
      return (value, range) => value < startOf(range)
    case 'after':
      return (value, range) => value > endOf(range)
    case 'on':
    case 'in':
      return (value, range) => value >= startOf(range) && value <= endOf(range)
    case 'on or before':
    case 'in or before':
      return (value, range) => value <= endOf(range)
    case 'on or after':
    case 'in or after':
      return (value, range) => value >= startOf(range)
    default:
      return () => false
  }
}

function dateField(name: string, field: TaskDateField, options: { instruction?: string; matchesWhenAbsent?: boolean } = {}): DateField {
  class Concrete extends DateField {
    protected override instructionName(): string {
      return options.instruction ?? name
    }

    protected override matchesWhenAbsent(): boolean {
      return options.matchesWhenAbsent === true
    }

    fieldName(): string {
      return name
    }

    protected dateOf(task: Task): Date | null {
      return task.fields[field]
    }
  }
  return new Concrete()
}

export const dueDateField = dateField('due', 'dueDate')
export const doneDateField = dateField('done', 'doneDate')
export const createdDateField = dateField('created', 'createdDate')
export const scheduledDateField = dateField('scheduled', 'scheduledDate')
export const cancelledDateField = dateField('cancelled', 'cancelledDate')
/** The instruction is `starts`, the field is `start`: the plural is what reads as a question. */
export const startDateField = dateField('start', 'startDate', { instruction: 'starts', matchesWhenAbsent: true })

/** `happens` asks of any of the three forward-looking dates, and never of the record dates. */
class HappensField extends DateField {
  fieldName(): string {
    return 'happens'
  }

  protected instructionName(): string {
    return 'happens'
  }

  protected dateOf(task: Task): Date | null {
    const dates = [task.fields.dueDate, task.fields.scheduledDate, task.fields.startDate]
      .filter((date): date is Date => date !== null)
      .sort((a, b) => a.getTime() - b.getTime())
    return dates[0] ?? null
  }

  override supportsGrouping(): boolean {
    return false
  }
}

export const happensDateField = new HappensField()

export const DATE_FIELDS: DateField[] = [
  dueDateField,
  doneDateField,
  createdDateField,
  scheduledDateField,
  cancelledDateField,
  startDateField,
  happensDateField,
]
export type { SearchInfo }
