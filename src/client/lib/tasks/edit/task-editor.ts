import { formatTaskDate } from '../date/date-tools'
import { parseDay } from '../date/date-parser'
import { Occurrence } from '../model/occurrence'
import { Recurrence } from '../model/recurrence'
import { OnCompletion } from '../model/on-completion'
import { Priority } from '../model/priority'
import { moveToStatus, type ToggleSettings } from '../toggle'
import { startOfDay } from '../../time'
import type { Status } from '../status/status'
import type { Task } from '../model/task'
import type { TaskDateField, TaskFields } from '../serializer/index'

/** The six dates a task carries, in the order the form shows them. */
export type EditDateField = TaskDateField

export const EDIT_DATE_FIELDS: EditDateField[] = [
  'createdDate',
  'startDate',
  'scheduledDate',
  'dueDate',
  'cancelledDate',
  'doneDate',
]

/**
 * What the edit form holds: every field as text, because that is what a reader types into.
 *
 * The task itself is a record of `Date`s and a status object, which is the wrong shape for a form —
 * a half-typed date is not a `Date`, and a status is chosen from a registry the form should not have
 * to consult per keystroke. Keeping the two shapes apart is what lets validation say *which* field
 * is wrong instead of refusing the whole draft.
 */
export interface TaskDraft {
  description: string
  statusSymbol: string
  priority: Priority
  onCompletion: OnCompletion
  recurrenceRule: string
  dates: Record<EditDateField, string>
  /** The ids this task waits on, as the reader left them. */
  blockedBy: string[]
  /** Read-only in the form: an id is minted by the plugin, not typed. */
  id: string
}

/** Why a recurrence rule cannot be used, so the form can say it in words rather than HTML. */
export type RecurrenceProblem = 'none' | 'invalid' | 'needs-a-date'

export interface DraftErrors {
  dates: Partial<Record<EditDateField, true>>
  recurrence: RecurrenceProblem
}

function dateToFieldText(date: Date | null): string {
  if (date === null || Number.isNaN(date.getTime())) return ''
  return formatTaskDate(date)
}

/** The draft a task opens with. `globalFilter` is stripped from the shown description, if it has one. */
export function draftFromTask(task: Task, globalFilter = ''): TaskDraft {
  const description = globalFilter && task.fields.description.includes(globalFilter)
    ? task.fields.description.replace(globalFilter, '').replace(/\s{2,}/gu, ' ').trim()
    : task.fields.description
  return {
    description,
    statusSymbol: task.status.symbol,
    priority: task.fields.priority,
    onCompletion: task.fields.onCompletion,
    recurrenceRule: task.fields.recurrenceRuleText,
    dates: {
      createdDate: dateToFieldText(task.fields.createdDate),
      startDate: dateToFieldText(task.fields.startDate),
      scheduledDate: dateToFieldText(task.fields.scheduledDate),
      dueDate: dateToFieldText(task.fields.dueDate),
      cancelledDate: dateToFieldText(task.fields.cancelledDate),
      doneDate: dateToFieldText(task.fields.doneDate),
    },
    blockedBy: [...task.fields.dependsOn],
    id: task.fields.id,
  }
}

/**
 * Read the draft back into the model, and report what could not be read.
 *
 * A date the reader typed but that names no day is an error on that field rather than a silent
 * blank: the alternative is a Save that deletes what they wrote. Dates only move forward while
 * `forwardOnly` is on, which is how `next friday` means next Friday and not the one just past.
 */
export interface DraftOptions {
  /** Read dates that are not in the past, which is what a reader typing `friday` expects. */
  forwardOnly?: boolean
  /** The vault's global filter, which the form showed stripped and the save puts back. */
  globalFilter?: string
}

export function applyDraft(
  task: Task,
  draft: TaskDraft,
  status: Status,
  settings: ToggleSettings,
  now: Date,
  options: DraftOptions = {},
): { tasks: Task[]; errors: DraftErrors } {
  const { forwardOnly = true, globalFilter = '' } = options
  const errors: DraftErrors = { dates: {}, recurrence: 'none' }
  const fields: TaskFields = {
    ...task.fields,
    invalidDates: { ...task.fields.invalidDates },
    description: withGlobalFilter(draft.description.trim(), globalFilter),
    priority: draft.priority,
    onCompletion: draft.onCompletion,
    recurrenceRuleText: draft.recurrenceRule.trim(),
    dependsOn: draft.blockedBy,
    id: draft.id,
  }
  for (const field of EDIT_DATE_FIELDS) {
    const text = draft.dates[field].trim()
    if (text === '') {
      fields[field] = null
      delete fields.invalidDates[field]
      continue
    }
    const parsed = parseDay(text, now, forwardOnly)
    if (parsed === null) {
      errors.dates[field] = true
      continue
    }
    fields[field] = parsed
    delete fields.invalidDates[field]
  }

  const occurrence = new Occurrence({
    startDate: fields.startDate,
    scheduledDate: fields.scheduledDate,
    dueDate: fields.dueDate,
  })
  if (fields.recurrenceRuleText === '') {
    errors.recurrence = 'none'
  }
  else if (Recurrence.fromText({ recurrenceRuleText: fields.recurrenceRuleText, occurrence, now }) === null) {
    errors.recurrence = 'invalid'
  }
  else if (fields.dueDate === null && fields.scheduledDate === null && fields.startDate === null) {
    errors.recurrence = 'needs-a-date'
  }
  if (errors.recurrence !== 'none' || Object.keys(errors.dates).length > 0) {
    return { tasks: [], errors }
  }

  const edited: Task = {
    ...task,
    fields,
    // The rule is rebuilt from the dates as edited: the one the task arrived with was anchored to the
    // dates before the reader changed them, and ticking on would schedule from a day they undid.
    recurrence: fields.recurrenceRuleText === ''
      ? null
      : Recurrence.fromText({ recurrenceRuleText: fields.recurrenceRuleText, occurrence, now }),
  }
  // A date the reader typed for `done` or `cancelled` is the day the status change should stamp,
  // rather than today: editing a finished task must not silently move its finish date to now.
  const inferred = inferStatusDay(status, fields)
  return { tasks: moveToStatus(edited, status, settings, inferred).tasks, errors }
}

/**
 * Put the global filter back on the saved description.
 *
 * The form shows the description without it, because the filter is a convention rather than something
 * a reader means to type — so a save that took the stripped words literally would quietly unsubscribe
 * the task from every query that finds it. Anything the reader typed themselves already carries it.
 */
function withGlobalFilter(shown: string, globalFilter: string): string {
  if (globalFilter === '' || shown.includes(globalFilter)) return shown
  return `${globalFilter} ${shown}`.trim()
}

/** What `moveToStatus` should treat as "today" for this status change. */
function inferStatusDay(status: Status, fields: TaskFields): Date {
  if (status.type === 'DONE' && fields.doneDate !== null) return startOfDay(fields.doneDate)
  if (status.type === 'CANCELLED' && fields.cancelledDate !== null) return startOfDay(fields.cancelledDate)
  return new Date()
}

/** The rule as the model would write it back, or why it cannot. */
export function describeRecurrence(draft: TaskDraft, now: Date): { text: string; problem: RecurrenceProblem } {
  const rule = draft.recurrenceRule.trim()
  if (rule === '') return { text: '', problem: 'none' }
  const occurrence = new Occurrence({ startDate: null, scheduledDate: null, dueDate: null })
  const parsed = Recurrence.fromText({ recurrenceRuleText: rule, occurrence, now })
  if (parsed === null) return { text: '', problem: 'invalid' }
  return { text: parsed.toText(), problem: 'none' }
}
