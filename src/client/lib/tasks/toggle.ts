import { startOfDay } from '../../lib/time'
import { OnCompletion } from './model/on-completion'
import { parseTaskLine, toMarkdownLine, type Task } from './model/task'
import { unknownPosition } from './model/task-location'
import { DataviewTaskSerializer } from './serializer/dataview-format'
import { EmojiTaskSerializer } from './serializer/emoji'
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

  const produced = advanceLine(lines[target.line]!, settings, now, target.text)
  if (produced === null) return null
  const replacement = produced.tasks.map((task) => toMarkdownLine(task, settings.serializer))
  lines.splice(target.line, 1, ...replacement)

  if (settings.recursiveSubTaskCompletion && replacement.length > 0) {
    // The status the reader just moved the clicked line to is what the subtree is carried down to, and
    // the subtree starts after the last line that was written. `on completion: delete` leaves no line
    // to anchor it on, so a deleted task carries nothing down.
    cascadeChildren(lines, target.line + replacement.length - 1, produced.clicked, settings, now)
  }
  return lines.join(eol)
}

/** What one click does to one line, and the status the reader put it into. */
export interface ToggledLine {
  tasks: Task[]
  clicked: Status
}

/**
 * Read one line and say what takes its place.
 *
 * A recurring task becomes two lines — the instance just finished and the one the rule produced —
 * and `on completion: delete` becomes none, so this returns a list.
 *
 * `expect` is the staleness guard: a query result is a picture of a line from some earlier moment,
 * and if the author has since retyped it, writing would edit words the reader never clicked on.
 */
function advanceLine(line: string, settings: ToggleSettings, now: Date, expect?: string): ToggledLine | null {
  const task = parseTaskLine(line, unknownPosition('', ''), {
    registry: settings.registry,
    serializer: settings.serializer,
    now,
  })
  if (task === null) return null
  if (expect !== undefined && taskWords(task.fields.description) !== taskWords(expect)) return null

  return advanceStatus(task, settings, now)
}

/**
 * Move a task to the next status, and produce what that implies.
 *
 * A recurring task does not simply become done and leave its own series: the instance is finished
 * and a fresh one is born from the rule. The newborn's status is not just the next one in the cycle
 * — in a vault whose `[x]` points back at `[x]` that would birth it already finished, invisible to
 * every `not done` search — so the registry is asked for the first open status down that chain.
 */
export function advanceStatus(task: Task, settings: ToggleSettings, now: Date): ToggledLine {
  // The box the reader just clicked moves one step along the cycle, whatever else happens. The
  // recurrence status is a different question — it names the status the *next* instance is born
  // with — and applying it to the finished line would leave the tick having changed nothing.
  return moveToStatus(task, settings.registry.getNextStatusOrCreate(task.status), settings, now)
}

/**
 * Move a task to a named status, and produce what that implies.
 *
 * A recurring task does not simply become done and leave its own series: the instance is finished
 * and a fresh one is born from the rule. The newborn's status is not the one being moved to — in a
 * vault whose `[x]` points back at `[x]` that would birth it already finished, invisible to every
 * `not done` search — so the registry is asked for the first open status down that chain.
 */
export function moveToStatus(task: Task, next: Status, settings: ToggleSettings, now: Date): ToggledLine {
  // The same status is not a move: an edit form that saved without touching the box must not stamp a
  // date, end the series, or birth the next occurrence.
  if (next.symbol === task.status.symbol) return { tasks: [task], clicked: next }

  const finishing = !task.status.isDone
  const bornStatus = task.recurrence !== null && finishing
    ? settings.registry.getNextRecurrenceStatusOrCreate(task.status)
    : next

  const finished: Task = {
    ...task,
    status: next,
    fields: stampDates(task.fields, task.status.type, next.type, settings, now),
  }

  if (!finishing || task.recurrence === null) {
    return { tasks: keepOrDrop(task, [finished]), clicked: next }
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
  return { tasks: keepOrDrop(task, ordered), clicked: next }
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

/**
 * Carry the clicked line's new state down to the lines that belong to it.
 *
 * A descendant is moved only when it does not already show that state, so ticking a parent twice
 * cannot walk its children down the status cycle twice over — which matters the moment one command
 * ticks a whole selection, where a child would otherwise be advanced by itself and again by its parent.
 */
function cascadeChildren(lines: string[], index: number, target: Status, settings: ToggleSettings, now: Date): void {
  const base = indentOf(lines[index] ?? '')
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const line = lines[cursor]!
    if (!line.trim()) continue
    if (indentOf(line) <= base) break
    const task = parseTaskLine(line, unknownPosition('', ''), {
      registry: settings.registry,
      serializer: settings.serializer,
      now,
    })
    if (task === null || task.status.isDone === target.isDone) continue
    lines[cursor] = toMarkdownLine({
      ...task,
      status: target,
      fields: stampDates(task.fields, task.status.type, target.type, settings, now),
    }, settings.serializer)
  }
}

function indentOf(line: string): number {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? ''
  return lead.replace(/\t/g, '    ').length
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}

const emojiFormat = new EmojiTaskSerializer()
const bracketFormat = new DataviewTaskSerializer()

/**
 * The words a reader clicked, with every field format taken back off.
 *
 * The caller's serializer decides what this line is read as, and the text being compared against was
 * read by whatever parser built the row — so the two sides can be in different formats even before a
 * reader mixes them inside one line. Stripping both leaves the prose the reader actually clicked, and a
 * stale line still fails the guard because its words moved.
 */
export function taskWords(text: string): string {
  let out = text
  // Two formats, in either order on the line: each pass strips what it recognises until the text settles.
  for (let pass = 0; pass < 3; pass++) {
    const next = bracketFormat.deserialize(emojiFormat.deserialize(out).description).description
    if (next === out) break
    out = next
  }
  return normalize(out)
}
