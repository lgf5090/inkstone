/**
 * The statistics as one CSV file the reader can open in a spreadsheet.
 *
 * Five tables share the file, separated by a blank line and introduced by `#` comment lines: the
 * trend first (`period,completed,created`), then every distribution (`distribution,key,label,count`),
 * then the cumulative flow (`period,todo,in_progress,done`), and — when the screen had a worklog to
 * hand over — the tracked time by day (`period,tracked_ms`) and by whatever the reader was grouping by
 * (`group,key,label,tracked_ms`, with the dimension named in a `# dimension` line of its own).
 * The column names are fixed English so a script written against one export still reads the next; the
 * label column carries the reader's language. Days are the account-zone `YYYY-MM-DD` strings the
 * answer already holds, never UTC instants re-zoned here. Times are milliseconds, not the rounded hours
 * the bars draw: a spreadsheet can divide, and it cannot undo a rounding. The file starts with a UTF-8
 * BOM because Excel otherwise reads a Chinese label as mojibake.
 */
import type { TodoStats, Worklog } from '@shared/todos/model'
import { listName, tagName, weekdayName } from './stats-format'
import { priorityLabel } from './todo-ui'

const BOM = '\ufeff'

/** One CSV cell: quoted only when the text contains a delimiter, a quote or a line break. */
function cell(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function row(...values: Array<string | number>): string {
  return values.map(cell).join(',')
}

/**
 * The whole answer as one CSV: the trend, the distributions, the flow, and the hours if there were
 * any to ask about.
 *
 * `worklog` is optional rather than fetched here because this function's job is to serialise what the
 * screen already showed. When the read failed, the two time tables are simply absent — a file that
 * claimed nobody worked would be a wrong fact, while a missing table is a question the reader can ask
 * again.
 */
export function buildStatsCsv(stats: TodoStats, worklog: Worklog | null = null): string {
  const lines = [
    `${BOM}# Inkstone todo statistics`,
    row('# range', stats.range.from, stats.range.to),
    row('# timezone', stats.range.timezone),
    '# encoding,UTF-8 with BOM',
    '# table 1: completed and created by period',
    row('period', 'completed', 'created'),
    ...stats.series.map((point) => row(point.day, point.completed, point.created)),
    '',
    '# table 2: completions by list, tag, priority, weekday and hour',
    row('distribution', 'key', 'label', 'count'),
    ...stats.distributions.byList.map((entry) => row('list', entry.id ?? '', listName(entry), entry.completed)),
    ...stats.distributions.byTag.map((entry) => (
      row('tag', entry.id ?? entry.name ?? '', tagName(entry), entry.completed)
    )),
    ...stats.distributions.byPriority.map((entry) => (
      row('priority', entry.priority, priorityLabel(entry.priority), entry.completed)
    )),
    ...stats.distributions.byWeekday.map((entry) => (
      row('weekday', entry.weekday, weekdayName(entry.weekday), entry.completed)
    )),
    ...stats.distributions.byHour.map((entry) => (
      row('hour', entry.hour, String(entry.hour).padStart(2, '0'), entry.completed)
    )),
    '',
    '# table 3: cumulative flow by period',
    row('period', 'todo', 'in_progress', 'done'),
    ...stats.flow.map((point) => row(point.day, point.todo, point.inProgress, point.done)),
    ...(worklog ? [
      '',
      '# table 4: tracked time by day',
      row('period', 'tracked_ms'),
      ...worklog.byDay.map((day) => row(day.day, day.trackedMs)),
      '',
      `# dimension,${worklog.range.dimension}`,
      '# table 5: tracked time by group',
      row('group', 'key', 'label', 'tracked_ms'),
      ...worklog.byGroup.map((group) => row(worklog.range.dimension, group.key, group.label, group.trackedMs)),
      // How many groups the page left off, and what the whole window really held. The cap is a screen
      // decision, and a reader who totals the rows would otherwise be quietly short by the rest.
      `# truncated_groups,${worklog.truncatedGroups}`,
      `# total_tracked_ms,${worklog.totalMs}`,
    ] : []),
  ]
  return `${lines.join('\n')}\n`
}

/** The downloaded file's name, carrying the range it describes. */
export function statsCsvFilename(range: { from: string; to: string }): string {
  return `inkstone-todo-stats-${range.from}_${range.to}.csv`
}

/**
 * Hand the CSV to the browser as a download.
 *
 * A Blob and an object URL: the data is already in memory, and a temporary anchor is the platform's
 * own download gesture — no dependency and no server round trip. The URL is revoked on the next task
 * because a browser may start reading the blob after the click handler returns.
 */
export function downloadStatsCsv(stats: TodoStats, worklog: Worklog | null = null): void {
  const blob = new Blob([buildStatsCsv(stats, worklog)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = statsCsvFilename(stats.range)
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}
