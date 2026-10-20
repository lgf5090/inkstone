import { startOfDay } from '../../../lib/time'
import { TaskRegularExpressions as RE } from './task-regular-expressions'
import { Recurrence } from './recurrence'
import { Occurrence } from './occurrence'
import { unknownPosition, type TaskLocation } from './task-location'
import type { TaskFields } from '../serializer/index'
import type { TaskSerializer } from '../serializer/index'
import type { Status } from '../status/status'
import type { StatusRegistry } from '../status/registry'

/**
 * One task, as it lives on a line of a note.
 *
 * A record rather than upstream's class: its many cloning getters exist to stop a mutable Moment
 * being shared between two instances, and a task date here is always a fresh immutable `Date`.
 */
export interface Task {
  status: Status
  fields: TaskFields
  location: TaskLocation
  /** The line exactly as read, which is what a rewrite refuses against when it no longer matches. */
  originalMarkdown: string
  indentation: string
  listMarker: string
  /** ` ^some-id`, kept apart from the description so it survives a rewrite and stays last. */
  blockLink: string
  /** Two or more trailing spaces, which Markdown reads as a hard line break. */
  hardBreak: string
  /** True when `scheduledDate` came from the note's filename rather than from the line. */
  scheduledDateIsInferred: boolean
  recurrence: Recurrence | null
}

export interface ParseTaskOptions {
  registry: StatusRegistry
  serializer: TaskSerializer
  now: Date
  /** A day inferred from the note's name, used only when the line states no date at all. */
  fallbackDate?: Date | null
}

interface LineParts {
  indentation: string
  listMarker: string
  statusSymbol: string
  body: string
  blockLink: string
  hardBreak: string
}

/** Split a line into the markdown around the checkbox, or null when it is not a task line. */
export function extractTaskComponents(line: string): LineParts | null {
  const matched = RE.taskRegex.exec(line)
  if (matched === null) return null
  let body = matched[4] ?? ''
  let blockLink = ''
  let hardBreak = ''

  const trailing = /[ \t]{2,}$/.exec(body)
  if (trailing) {
    hardBreak = trailing[0]
    body = body.slice(0, body.length - hardBreak.length)
  }
  const link = RE.blockLinkRegex.exec(body)
  if (link) {
    blockLink = link[0]
    body = body.slice(0, body.length - blockLink.length)
  }
  return {
    indentation: matched[1] ?? '',
    listMarker: matched[2] ?? '-',
    statusSymbol: matched[3] ?? ' ',
    body,
    blockLink,
    hardBreak,
  }
}

/**
 * Read one line as a task.
 *
 * Deliberately unaware of any global filter: what a note *says* should not depend on a setting, so
 * the filter is applied where results are chosen rather than here, and a query that opts out of it
 * sees the same tasks.
 */
export function parseTaskLine(line: string, location: TaskLocation, options: ParseTaskOptions): Task | null {
  const parts = extractTaskComponents(line)
  if (parts === null) return null

  const fields = options.serializer.deserialize(parts.body)
  const inferred = shouldInferSchedule(fields) && options.fallbackDate
    ? startOfDay(options.fallbackDate)
    : null
  if (inferred !== null) fields.scheduledDate = inferred

  return {
    status: options.registry.bySymbolOrCreate(parts.statusSymbol),
    fields,
    location,
    originalMarkdown: line,
    indentation: parts.indentation,
    listMarker: parts.listMarker,
    blockLink: parts.blockLink,
    hardBreak: parts.hardBreak,
    scheduledDateIsInferred: inferred !== null,
    recurrence: buildRecurrence(fields, options.now),
  }
}

function shouldInferSchedule(fields: TaskFields): boolean {
  return fields.startDate === null && fields.scheduledDate === null && fields.dueDate === null
}

/**
 * Build the rule last, from the dates that have all been read.
 *
 * `every week` needs a reference date to be anchored at all, and that date may appear anywhere in
 * the line, so the rule text is carried unparsed until now.
 */
function buildRecurrence(fields: TaskFields, now: Date): Recurrence | null {
  if (fields.recurrenceRuleText === '') return null
  return Recurrence.fromText({
    recurrenceRuleText: fields.recurrenceRuleText,
    occurrence: new Occurrence({
      startDate: fields.startDate,
      scheduledDate: fields.scheduledDate,
      dueDate: fields.dueDate,
    }),
    now,
  })
}

/** Render the task back to a single markdown line, preserving everything the reader wrote. */
export function toMarkdownLine(task: Task, serializer: TaskSerializer): string {
  const body = serializer.serialize(task.fields, { scheduledDateIsInferred: task.scheduledDateIsInferred })
  return `${task.indentation}${task.listMarker} [${task.status.symbol}] ${body}${task.blockLink}${task.hardBreak}`
}

export function isDone(task: Task): boolean {
  return task.status.isDone
}

export function isRecurring(task: Task): boolean {
  return task.recurrence !== null
}

/** The dates a task is "about": the ones a reader would say they are running to. */
export function happensDates(task: Task): Array<Date | null> {
  return [task.fields.dueDate, task.fields.scheduledDate, task.fields.startDate]
}

export function filenameOf(task: Task): string {
  const path = task.location.path
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

export function rootOf(task: Task): string {
  const slash = task.location.path.indexOf('/')
  return slash < 0 ? task.location.path : task.location.path.slice(0, slash)
}

export function folderOf(task: Task): string {
  const path = task.location.path
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** A position for a task a script invented, which can be listed but never written back. */
export function taskFromFields(fields: TaskFields, options: ParseTaskOptions): Task {
  return {
    status: options.registry.bySymbolOrCreate(' '),
    fields,
    location: unknownPosition(),
    originalMarkdown: '',
    indentation: '',
    listMarker: '-',
    blockLink: '',
    hardBreak: '',
    scheduledDateIsInferred: false,
    recurrence: buildRecurrence(fields, options.now),
  }
}
