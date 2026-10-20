import { TaskLayoutComponent, TaskLayoutOptions } from '../layout/task-layout'
import { expandPreset, type PresetContext } from './presets'
import { booleanField } from './boolean-field'
import { SIMPLE_FIELDS, parseSimpleFilterInstruction } from './instructions'
import { compareGroupKeys, type Comparator, type Grouper, type SearchInfo, type Sorter } from './values'
import type { Task } from '../model/task'

/** A line after continuations have been joined, kept with its original text for `explain`. */
interface Statement {
  raw: string
  instruction: string
}

export interface QueryLayout {
  shortMode: boolean
  hiddenQueryParts: Set<string>
  taskLayout: TaskLayoutOptions
}

export interface ParsedQuery {
  filters: Array<(task: Task, info: SearchInfo) => boolean>
  sorters: Sorter[]
  groupers: Grouper[]
  limit: number | null
  groupLimit: number | null
  layout: QueryLayout
  explain: boolean
  ignoreGlobalQuery: boolean
  errors: string[]
  /** Every non-comment line the reader wrote, in order. */
  instructions: string[]
  /** Only the lines that became filters, so an explanation can label them as such. */
  filterInstructions: string[]
}

const QUERY_PARTS = [
  'toolbar', 'postpone button', 'edit button', 'backlink', 'nested backlink',
  'task count', 'group count', 'tree', 'urgency',
]

const HIDEABLE_COMPONENTS = new Map<string, TaskLayoutComponent>([
  ['id', TaskLayoutComponent.Id],
  ['depends on', TaskLayoutComponent.DependsOn],
  ['priority', TaskLayoutComponent.Priority],
  ['recurrence rule', TaskLayoutComponent.RecurrenceRule],
  ['on completion', TaskLayoutComponent.OnCompletion],
  ['created date', TaskLayoutComponent.CreatedDate],
  ['start date', TaskLayoutComponent.StartDate],
  ['scheduled date', TaskLayoutComponent.ScheduledDate],
  ['due date', TaskLayoutComponent.DueDate],
  ['cancelled date', TaskLayoutComponent.CancelledDate],
  ['done date', TaskLayoutComponent.DoneDate],
  ['tags', TaskLayoutComponent.Description],
])

/**
 * Join backslash-continued lines.
 *
 * A trailing `\` is the reader's way of keeping one instruction on the screen without splitting it
 * in the query; `\\` is a literal backslash, so the escape has to be read before the join.
 */
export function scanStatements(source: string): Statement[] {
  const out: Statement[] = []
  let pending: string | null = null
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trimEnd()
    if (pending !== null) {
      const joined = `${pending} ${trimmed.replace(/^[ \t]+/, '')}`.trim()
      pending = joined.endsWith('\\') && !joined.endsWith('\\\\') ? joined.slice(0, -1) : null
      if (pending === null) out.push({ raw: joined, instruction: joined.replace(/\\\\/g, '\\').trim() })
      continue
    }
    if (trimmed === '') continue
    if (trimmed.endsWith('\\') && !trimmed.endsWith('\\\\')) {
      pending = trimmed.slice(0, -1).trimEnd()
      continue
    }
    out.push({ raw: trimmed, instruction: trimmed.replace(/\\\\/g, '\\').trim() })
  }
  if (pending !== null) out.push({ raw: pending, instruction: pending.trim() })
  return out
}

function emptyLayout(): QueryLayout {
  return { shortMode: false, hiddenQueryParts: new Set<string>(), taskLayout: new TaskLayoutOptions() }
}

/**
 * Parse a `tasks` block into something executable.
 *
 * Errors are collected rather than thrown: a half-written query is the normal state of a note while
 * its author is typing, and the block has to keep showing the lines that did parse alongside the one
 * that did not.
 */
export function parseTasksQuery(source: string, now: Date, context: PresetContext = { currentPath: null }): ParsedQuery {
  const parsed: ParsedQuery = {
    filters: [],
    sorters: [],
    groupers: [],
    limit: null,
    groupLimit: null,
    layout: emptyLayout(),
    explain: false,
    ignoreGlobalQuery: false,
    errors: [],
    instructions: [],
    filterInstructions: [],
  }

  // The reader's defaults are applied first and the block's own instructions after them, so a note
  // that says `show due date` still shows it in a vault that hides due dates everywhere.
  for (const field of context.defaultHiddenFields ?? []) applyVisibility(parsed.layout, 'hide', field)

  // A queue rather than a loop, because `preset x` expands into instructions that must themselves
  // be parsed; a preset that names another preset still terminates, since each expansion is
  // recorded before it is re-entered and the guard below refuses a second pass.
  const queue = scanStatements(source).map((statement) => statement.instruction)
  const expanded = new Set<string>()
  while (queue.length > 0) {
    const line = queue.shift()!
    if (line === '' || /^#/.test(line)) continue
    const preset = /^preset +(.*)$/i.exec(line)
    if (preset !== null) {
      const name = preset[1]!.trim().toLowerCase()
      if (expanded.has(name)) continue
      expanded.add(name)
      const lines = expandPreset(name, context)
      if (lines === null) parsed.errors.push(`unknown preset: ${name}`)
      else queue.unshift(...lines)
      continue
    }
    parsed.instructions.push(line)
    applyLine(parsed, line, now)
  }

  if (parsed.sorters.length === 0) parsed.sorters = defaultSorters()
  return parsed
}

function applyLine(parsed: ParsedQuery, line: string, now: Date): void {
  const lower = line.toLowerCase()

  if (/^#/.test(lower)) return
  if (lower === 'explain') { parsed.explain = true; return }
  if (lower === 'ignore global query') { parsed.ignoreGlobalQuery = true; return }
  if (lower === 'short mode' || lower === 'short') { parsed.layout.shortMode = true; return }
  if (lower === 'full mode' || lower === 'full') { parsed.layout.shortMode = false; return }

  const limit = /^limit (groups )?(?:to )?(\d+)(?: tasks?)?$/i.exec(line)
  if (limit) {
    const value = Number(limit[2])
    if (limit[1]) parsed.groupLimit = value
    else parsed.limit = value
    return
  }

  const view = /^view +(.*)$/i.exec(line)
  if (view) {
    const name = view[1]!.trim().toLowerCase()
    if (name !== 'list' && name !== 'table') parsed.errors.push(`unknown view: ${view[1]}`)
    return
  }

  const hide = /^(hide|show) +(.*)$/i.exec(line)
  if (hide) {
    applyVisibility(parsed.layout, hide[1]!.toLowerCase(), hide[2]!.trim().toLowerCase())
    return
  }

  const sort = /^sort by +(.*)$/i.exec(line)
  if (sort) {
    const found = createSorterFromLine(sort[1]!)
    if (found === null) parsed.errors.push(`don't know how to sort by: ${sort[1]}`)
    else parsed.sorters.push(found)
    return
  }

  const group = /^group by +(.*)$/i.exec(line)
  if (group) {
    const found = createGrouperFromLine(group[1]!)
    if (found === null) parsed.errors.push(`don't know how to group by: ${group[1]}`)
    else parsed.groupers.push(found)
    return
  }

  const filter = parseFilterLine(line, now)
  if (filter === null) {
    parsed.errors.push(`doesn't understand the query line: ${line}`)
    return
  }
  if (filter.error !== null) {
    parsed.errors.push(`${filter.error}`)
    return
  }
  parsed.filters.push(filter.filter!)
  parsed.filterInstructions.push(line)
}

function parseFilterLine(line: string, now: Date) {
  const simple = parseSimpleFilterInstruction(line, now)
  if (simple !== null) return simple
  if (booleanField.canCreateFilterForLine(line)) return booleanField.createFilterOrErrorMessage(line, now)
  return null
}

function createSorterFromLine(rest: string): Sorter | null {
  for (const field of SIMPLE_FIELDS) {
    const found = field.createSorterFromLine(`sort by ${rest}`)
    if (found !== null) return found
  }
  return null
}

function createGrouperFromLine(rest: string): Grouper | null {
  for (const field of SIMPLE_FIELDS) {
    const found = field.createGrouperFromLine(`group by ${rest}`)
    if (found !== null) return found
  }
  return null
}

function applyVisibility(layout: QueryLayout, verb: string, option: string): void {
  const show = verb === 'show'
  for (const [key, component] of HIDEABLE_COMPONENTS) {
    if (option.startsWith(key)) {
      layout.taskLayout.setVisibility(component, show)
      return
    }
  }
  for (const part of QUERY_PARTS) {
    if (option.startsWith(part)) {
      if (show) layout.hiddenQueryParts.delete(part)
      else layout.hiddenQueryParts.add(part)
      return
    }
  }
}

/** `status.type`, then urgency, then due, then priority, then path. */
function defaultSorters(): Sorter[] {
  const order = ['status.type', 'urgency', 'due', 'priority', 'path']
  const out: Sorter[] = []
  for (const name of order) {
    const field = SIMPLE_FIELDS.find((candidate) => candidate.fieldNameSingular() === name)
    if (field === undefined || !field.supportsSorting()) continue
    out.push(field.createSorterFromLine(`sort by ${name}`)!)
  }
  return out
}

/** A group of tasks under one heading path, which is what the renderer draws. */
export interface TaskGroup {
  path: string[]
  tasks: Task[]
}

/**
 * Filter, sort, truncate and group.
 *
 * The order is the one that makes `limit` mean what a reader expects: it cuts the sorted list
 * before grouping, so `limit 10` is ten tasks and not ten of an unbounded set.
 */
/**
 * Run a parsed query over the tasks the index can see.
 *
 * `globalFilter` is the vault's own rule about which lines count as tasks at all: it is applied here
 * rather than in the scanner, because the scanner must still understand every checkbox in a note the
 * reader is editing, while a list can be scoped. A block that says `ignore global query` opts out.
 */
export function runTasksQuery(
  tasks: Task[],
  parsed: ParsedQuery,
  now: Date,
  globalFilter = '',
): { groups: TaskGroup[]; tasks: Task[]; countBeforeLimit: number } {
  const info: SearchInfo = { allTasks: tasks, now }
  const scoped = globalFilter !== '' && !parsed.ignoreGlobalQuery
    ? tasks.filter((task) => task.fields.description.includes(globalFilter))
    : tasks
  let filtered = scoped.filter((task) => parsed.filters.every((filter) => filter(task, info)))

  const comparators = parsed.sorters.map((sorter) => ({ sorter, comparator: sorter.comparator }))
  filtered = filtered.slice().sort((a, b) => {
    for (const { sorter, comparator } of comparators) {
      const result = comparator(a, b, info)
      if (result !== 0) return sorter.reverse ? -result : result
    }
    return 0
  })

  const countBeforeLimit = filtered.length
  if (parsed.limit !== null) filtered = filtered.slice(0, parsed.limit)

  if (parsed.groupers.length === 0) {
    return { groups: [{ path: [], tasks: filtered }], tasks: filtered, countBeforeLimit }
  }

  const groups = new Map<string, TaskGroup>()
  for (const task of filtered) {
    const path = parsed.groupers.map((grouper) => joinKeys(grouper.grouper(task, info)))
    const key = path.join('\u0000')
    const existing = groups.get(key)
    if (existing) existing.tasks.push(task)
    else groups.set(key, { path, tasks: [task] })
  }

  const ordered = [...groups.values()].sort((a, b) => {
    for (let depth = 0; depth < a.path.length; depth++) {
      const grouper = parsed.groupers[depth]
      const result = compareGroupKeys(a.path[depth] ?? '', b.path[depth] ?? '')
      if (result !== 0) return grouper?.reverse === true ? -result : result
    }
    return 0
  })

  const capped = parsed.groupLimit === null
    ? ordered
    : ordered.map((group) => ({ ...group, tasks: group.tasks.slice(0, parsed.groupLimit!) }))

  return { groups: capped, tasks: capped.flatMap((group) => group.tasks), countBeforeLimit }
}

function joinKeys(keys: string[]): string {
  return keys.join(', ')
}

/** Remove the `%%n%%` sort hint a grouper prefixed for ordering, leaving the visible name. */
export function stripSortPrefix(value: string): string {
  return value.replace(/^%%[^%]*%%/, '')
}

/** The sort hint a heading carries, or null when it sorts by its own text. */
export function sortPrefixOf(value: string): string | null {
  const matched = /^%%([^%]*)%%/.exec(value)
  return matched ? matched[1]! : null
}

export type { Comparator }
