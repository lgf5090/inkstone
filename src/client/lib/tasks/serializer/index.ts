import { OnCompletion } from '../model/on-completion'
import { Priority } from '../model/priority'

export type TaskDateField =
  | 'createdDate'
  | 'startDate'
  | 'scheduledDate'
  | 'dueDate'
  | 'doneDate'
  | 'cancelledDate'

/**
 * What a task line says, before it becomes a {@link Task}.
 *
 * A date is a `Date`, and a date that was written in the right shape but names no real day —
 * `📅 2022-02-30` — is an `Invalid Date` rather than `null`. The distinction is load-bearing twice
 * over: `due date is invalid` has to be answerable, and a rewrite that read the broken date as
 * "absent" would delete the reader's typo instead of showing it to them.
 */
export interface TaskFields {
  description: string
  priority: Priority
  createdDate: Date | null
  startDate: Date | null
  scheduledDate: Date | null
  dueDate: Date | null
  doneDate: Date | null
  cancelledDate: Date | null
  /** The original text of each unparseable date, so serialising puts back what it found. */
  invalidDates: Partial<Record<TaskDateField, string>>
  /** Unparsed on purpose: building the rule needs a reference date, which may still be ahead. */
  recurrenceRuleText: string
  onCompletion: OnCompletion
  id: string
  dependsOn: string[]
  tags: string[]
}

export function emptyTaskFields(description: string): TaskFields {
  return {
    description,
    priority: Priority.None,
    createdDate: null,
    startDate: null,
    scheduledDate: null,
    dueDate: null,
    doneDate: null,
    cancelledDate: null,
    invalidDates: {},
    recurrenceRuleText: '',
    onCompletion: OnCompletion.Ignore,
    id: '',
    dependsOn: [],
    tags: [],
  }
}

/** A serialiser that can read and write one on-disk task format. */
export interface TaskSerializer {
  /** Parse the text that follows the checkbox. */
  deserialize(line: string): TaskFields
  /** Render everything after the checkbox, in the format's own field order. */
  serialize(fields: TaskFields, options?: SerializeOptions): string
}

export interface SerializeOptions {
  /** Keep each field's symbol but drop its value, for a dense list. */
  shortMode?: boolean
  /** Components the reader chose to hide, which must not come back on the next write. */
  hiddenComponents?: string[]
}
