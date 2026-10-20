import type { Task } from '../model/task'

/**
 * What a task means to a query: the task itself plus the note-level facts a filter may need.
 *
 * `allTasks` is carried because `is blocked` cannot be answered from one task alone — it has to ask
 * whether the task id it depends on is finished anywhere in the result set.
 */
export interface SearchInfo {
  allTasks: Task[]
  /**
   * The day the query is being answered on.
   *
   * Handed in rather than read off the clock inside a comparator, because `sort by urgency` and
   * `due before next week` are both questions about today, and a comparison that consulted the
   * machine would make the same query answer differently halfway through one render.
   */
  now: Date
}

/** An instruction line that either filters, or explains itself to the reader. */
export interface FilterOrErrorMessage {
  filter: ((task: Task, info: SearchInfo) => boolean) | null
  error: string | null
}

export function validFilter(filter: (task: Task, info: SearchInfo) => boolean): FilterOrErrorMessage {
  return { filter, error: null }
}

export function invalidFilter(error: string): FilterOrErrorMessage {
  return { filter: null, error }
}

export type Comparator = (a: Task, b: Task, info: SearchInfo) => number
export type GrouperFunction = (task: Task, info: SearchInfo) => string[]

/** A parsed `sort by` line. */
export interface Sorter {
  instruction: string
  property: string
  comparator: Comparator
  reverse: boolean
}

/** A parsed `group by` line. */
export interface Grouper {
  instruction: string
  property: string
  grouper: GrouperFunction
  reverse: boolean
}

export function makeSorter(instruction: string, property: string, comparator: Comparator, reverse: boolean): Sorter {
  return { instruction, property, comparator, reverse }
}

export function makeGrouper(instruction: string, property: string, grouper: GrouperFunction, reverse: boolean): Grouper {
  return { instruction, property, grouper, reverse }
}

/**
 * Compare two group keys the way a reader expects a list of headings to read.
 *
 * Numeric-aware, because `group by due` produces dates and `group by priority` produces names that
 * end in a number, and a plain string compare would put `10` before `2`.
 */
export function compareGroupKeys(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}
