/**
 * The to-do app's filter line: a query a reader can type in the search box or save as a smart list.
 *
 * The tokens are the note search's, not a second grammar: `parseQuery` from `search-query.ts` owns the
 * token regular expression, the quoting and the `tag:` handling, so `tag:"work meeting"` and
 * `-tag:later` mean here what they mean there. This module only gives a to-do meaning to the keys that
 * search does not already know:
 *
 * - `list:name` / `list:id` — one list, by its display name or its id.
 * - `tag:name` — one tag; a leading `#` is how a reader writes a tag, not part of its name. When a line
 *   names several, the last one is the filter, as with the other single-slot keys.
 * - `p:1` … `p:4` — one priority, in the app's own order: low, medium, high, urgent.
 * - `starred:true` — starred rows only. The note grammar's `is:starred` is accepted as the same thing.
 * - `status:todo,in_progress` — a set of statuses, comma separated.
 * - `due:2026-10-01..2026-10-31` — a due-day window whose ends are included; either end may be left
 *   out (`due:2026-10-01..`, `due:..2026-10-31`).
 * - `-tag:later` — a tag to leave out.
 * - any other word — search text.
 *
 * A value this module cannot read — `p:9`, `status:done,later`, `due:2026-02-30..2026-03-01` — is not
 * a filter and stays search text instead of being dropped. A reader who mistypes a line then sees an
 * empty answer rather than a wider list that silently ignored half of what they asked for; unknown keys
 * (`foo:bar`) take the same road. The note search's own qualifiers (`folder:`, `in:trash`) are consumed
 * by the shared tokenizer and have no to-do meaning, so they are ignored.
 *
 * `excludedTags` is the one condition the route cannot apply: `api.todos.list` has no negative tag
 * parameter, so the client hides those rows on the page it fetched. `store.ts` says how far that
 * reaches and what it means for the count beside the list.
 */
import { TASK_PRIORITIES, TASK_STATUSES } from '../assistant'
import { parseQuery } from '../search-query'
import type { TaskPriority, TaskStatus } from './model'

export interface TodoFilterQuery {
  /** The list the line names, by display name or id, or null when it names none. */
  list: string | null
  /** The tag the line names, without its `#`. */
  tag: string | null
  priority: TaskPriority | null
  /** True when the line asked for starred rows; null when it said nothing. */
  starred: boolean | null
  /** The statuses the line allows, in the order it wrote them; null when it named none. */
  status: TaskStatus[] | null
  /** First day of the due window, `YYYY-MM-DD`, included; null when that end is open. */
  dueFrom: string | null
  /** Last day of the due window, `YYYY-MM-DD`, included; null when that end is open. */
  dueTo: string | null
  /** The words the line did not read as a filter, in the order they were written. */
  text: string
  /**
   * Tags the line excluded with `-tag:`. The route has no exclusion, so the client filters the page
   * it fetched; the comment above says why that is the limit.
   */
  excludedTags: string[]
}

export function emptyTodoFilter(): TodoFilterQuery {
  return {
    list: null,
    tag: null,
    priority: null,
    starred: null,
    status: null,
    dueFrom: null,
    dueTo: null,
    text: '',
    excludedTags: [],
  }
}

/** The keys this module claims. `tag` is absent because `parseQuery` has already taken it. */
const QUALIFIERS: ReadonlySet<string> = new Set(['list', 'p', 'status', 'due', 'starred'])

/** A calendar day, as the due window spells one. */
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseTodoFilter(raw: string): TodoFilterQuery {
  const parsed = parseQuery(raw)
  const filter = emptyTodoFilter()
  filter.excludedTags = [...parsed.excludedTags]
  // The note grammar keeps every tag it sees; the listing has one slot, so the last one written wins,
  // the same way a later `list:` or `p:` replaces an earlier one.
  filter.tag = parsed.tags.length ? parsed.tags[parsed.tags.length - 1]! : null
  if (parsed.starred === true) filter.starred = true

  const words: string[] = []
  for (const term of parsed.terms) {
    if (!readTerm(filter, term)) words.push(term)
  }
  filter.text = words.join(' ')
  return filter
}

/** Fold one token into the filter; false means it is not a qualifier and belongs to the search text. */
function readTerm(filter: TodoFilterQuery, term: string): boolean {
  const colon = term.indexOf(':')
  if (colon <= 0) return false
  const rawKey = term.slice(0, colon)
  // Only `-tag:` is an exclusion, and `parseQuery` has already taken it. A negated anything else is
  // not a condition this grammar has, so it is searched for as the words the reader wrote.
  if (rawKey.startsWith('-')) return false
  const key = rawKey.toLowerCase()
  if (!QUALIFIERS.has(key)) return false
  const value = term.slice(colon + 1).trim()
  if (!value) return false
  switch (key) {
    case 'list':
      filter.list = value
      return true
    case 'p': {
      const index = /^[1-9]$/.test(value) ? Number(value) : 0
      if (index < 1 || index > TASK_PRIORITIES.length) return false
      filter.priority = TASK_PRIORITIES[index - 1]!
      return true
    }
    case 'starred':
      if (value.toLowerCase() !== 'true') return false
      filter.starred = true
      return true
    case 'status': {
      const wanted = [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))]
      if (!wanted.length || wanted.some((entry) => !(TASK_STATUSES as readonly string[]).includes(entry))) return false
      filter.status = wanted as TaskStatus[]
      return true
    }
    case 'due':
      return readDueWindow(filter, value)
    default:
      return false
  }
}

/** `from..to`, either end optional, both ends inclusive calendar days. A reversed or unknown day is no filter. */
function readDueWindow(filter: TodoFilterQuery, value: string): boolean {
  const parts = value.split('..')
  if (parts.length !== 2) return false
  const from = parts[0]!.trim()
  const to = parts[1]!.trim()
  if (!from && !to) return false
  if (from && !isCalendarDay(from)) return false
  if (to && !isCalendarDay(to)) return false
  if (from && to && from > to) return false
  filter.dueFrom = from || null
  filter.dueTo = to || null
  return true
}

/** Whether a `YYYY-MM-DD` string names a day that exists, not merely one shaped like a date. */
function isCalendarDay(value: string): boolean {
  const match = DAY_RE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
