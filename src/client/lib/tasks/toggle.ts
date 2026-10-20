import { startOfDay } from '../../lib/time'
import { OnCompletion } from './model/on-completion'
import { extractTaskComponents, parseTaskLine, toMarkdownLine, type Task } from './model/task'
import { unknownPosition } from './model/task-location'
import type { Status } from './status/status'
import type { StatusRegistry } from './status/registry'
import type { TaskFields, TaskSerializer } from './serializer/index'

export interface ToggleSettings {
  registry: StatusRegistry
  serializer: TaskSerializer
  /** Stamp today onto `done` when a task reaches a done-type status. */
  setDoneDate: boolean
  /** Stamp today onto `cancelled` when a task reaches a cancelled-type status. */
  setCancelledDate: boolean
  /** Stamp today onto `created` when a task is first moved at all. */
  setCreatedDate: boolean
  /** Put the next occurrence of a recurring task below the finished one rather than above it. */
  recurrenceOnNextLine: boolean
  /** Carry a completion down to the task's own sub-tasks. */
  recursiveSubTaskCompletion: boolean
}

export interface ToggleTarget {
  /** Zero-based line index the row was extracted from. */
  line: number
  /** The task's text as the reader saw it, which is what refuses a stale line. */
  text: string
}

/**
 * The one way a checkbox changes a note.
 *
 * Three surfaces tick a task — the live editor, the reading preview and a query result — and each
 * used to own its own edit. That is how `[/]` and `[-]` ended up unclickable in the editor while the
 * preview accepted them: one path knew about status characters and two did not. Every surface calls
 * here now, so a tick means the same thing wherever the reader happened to see the box.
 *
 * Pure over a string, so all of it is testable without a store or a DOM.
 */
export function applyTaskToggle(source: string, target: ToggleTarget, settings: ToggleSettings, now: Date): string | null {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/u)
  if (lines.length <= target.line) return null

  const replacement = rewriteLine(lines[target.line]!, settings, now, target.text)
  if (replacement === null) return null
  lines.splice(target.line, 1, ...replacement)

  if (settings.recursiveSubTaskCompletion) {
    cascadeChildren(lines, target.line + replacement.length - 1, settings, now)
  }
  return lines.join(eol)
}

/**
 * Replace one line with the lines that take its place.
 *
 * A recurring task becomes two lines — the instance just finished and the one the rule produced —
 * and `on completion: delete` becomes none, so this returns a list.
 *
 * `expect` is the staleness guard: a query result is a picture of a line from some earlier moment,
 * and if the author has since retyped it, writing would edit words the reader never clicked on.
 */
function rewriteLine(line: string, settings: ToggleSettings, now: Date, expect?: string): string[] | null {
  const task = parseTaskLine(line, unknownPosition('', ''), {
    registry: settings.registry,
    serializer: settings.serializer,
    now,
  })
  if (task === null) return null
  if (expect !== undefined && normalize(task.fields.description) !== normalize(expect)) return null

  const next = advanceStatus(task, settings, now)
  return next.map((item) => toMarkdownLine(item, settings.serializer))
}

/**
 * Move a task to the next status, and produce what that implies.
 *
 * A recurring task does not simply become done and leave its own series: the instance is finished
 * and a fresh one is born from the rule. The newborn's status is not just the next one in the cycle
 * — in a vault whose `[x]` points back at `[x]` that would birth it already finished, invisible to
 * every `not done` search — so the registry is asked for the first open status down that chain.
 */
export function advanceStatus(task: Task, settings: ToggleSettings, now: Date): Task[] {
  const finishing = !task.status.isCompletedType
  // The box the reader just clicked moves one step along the cycle, whatever else happens. The
  // recurrence status is a different question — it names the status the *next* instance is born
  // with — and applying it to the finished line would leave the tick having changed nothing.
  const clicked = settings.registry.getNextStatusOrCreate(task.status)
  const bornStatus = task.recurrence !== null && finishing
    ? settings.registry.getNextRecurrenceStatusOrCreate(task.status)
    : clicked

  const finished: Task = {
    ...task,
    status: clicked,
    fields: stampDates(task.fields, task.status.type, clicked.type, settings, now),
  }

  if (!finishing || task.recurrence === null) {
    return keepOrDrop(task, [finished])
  }

  const occurrence = task.recurrence.next(now)
  const born: Task = {
    ...task,
    status: bornStatus,
    fields: freshFields(task.fields, occurrence, settings, now),
    blockLink: '',
    scheduledDateIsInferred: false,
  }
  const ordered = settings.recurrenceOnNextLine ? [finished, born] : [born, finished]
  return keepOrDrop(task, ordered)
}

/** `on completion: delete` removes the finished instance, leaving only what the rule produced. */
function keepOrDrop(original: Task, produced: Task[]): Task[] {
  if (original.fields.onCompletion !== OnCompletion.Delete) return produced
  const last = produced[produced.length - 1]
  if (last === undefined || !last.status.isDone) return produced
  return produced.slice(0, -1)
}

/** The dates a status change writes, clears, or leaves alone. */
function stampDates(fields: TaskFields, from: Status['type'], to: Status['type'], settings: ToggleSettings, now: Date): TaskFields {
  const out: TaskFields = { ...fields, invalidDates: { ...fields.invalidDates } }
  const day = startOfDay(now)
  if (to === 'DONE') out.doneDate = settings.setDoneDate ? day : null
  else if (from === 'DONE') out.doneDate = null
  if (to === 'CANCELLED') out.cancelledDate = settings.setCancelledDate ? day : null
  else if (from === 'CANCELLED') out.cancelledDate = null
  if (settings.setCreatedDate && out.createdDate === null) out.createdDate = day
  return out
}

/** The dates of a newly produced occurrence: the rule's shifted dates, and no history. */
function freshFields(fields: TaskFields, occurrence: { startDate: Date | null; scheduledDate: Date | null; dueDate: Date | null } | null, settings: ToggleSettings, now: Date): TaskFields {
  const out: TaskFields = {
    ...fields,
    invalidDates: {},
    startDate: occurrence?.startDate ?? null,
    scheduledDate: occurrence?.scheduledDate ?? null,
    dueDate: occurrence?.dueDate ?? null,
    doneDate: null,
    cancelledDate: null,
    id: '',
    dependsOn: [],
  }
  if (settings.setCreatedDate) out.createdDate = startOfDay(now)
  return out
}

/** Carry the new state down to the lines that belong to this one. */
function cascadeChildren(lines: string[], index: number, settings: ToggleSettings, now: Date): void {
  const base = indentOf(lines[index] ?? '')
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const line = lines[cursor]!
    if (!line.trim()) continue
    if (indentOf(line) <= base) break
    if (extractTaskComponents(line) === null) continue
    const rewritten = rewriteLine(line, settings, now)
    if (rewritten !== null && rewritten.length === 1) lines[cursor] = rewritten[0]!
  }
}

function indentOf(line: string): number {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? ''
  return lead.replace(/\t/g, '    ').length
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}
