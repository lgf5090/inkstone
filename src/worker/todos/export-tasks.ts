/**
 * The whole of one account's to-do list, handed back as a document the reader can keep.
 *
 * ## Why this exists at all
 *
 * The task rows live in `todos_tasks` and its companions, and nothing in the product wrote them out:
 * the statistics file is an aggregate of the work, not the work, and the scheduled backup covers notes,
 * folders, tags, settings, attachments and QuickAdd — it never reads a `todos_*` table. So a reader who
 * trusted "I have a backup" was keeping every other app in the vault and losing this one. This module is
 * the smallest honest answer: read every live row and serialise it. The backup half of that gap is a
 * restore-design question (idempotency, the foreign-key order of eight tables) and is deliberately left
 * to its own round rather than half-solved here.
 *
 * ## The two formats are not two spellings of one thing
 *
 * JSON is the lossless one: it carries the row as the API answers it, so a step list, a repeat rule, an
 * estimate and the archive mark all survive, and what comes back out of it can be put back into the same
 * app. CSV is the *interchange* one, and it is written to be read by this repository's own importer
 * (`todos/import-csv.ts`) rather than to be pretty: the header names, the priority words, the `;` between
 * tags and the `done`/`no` in `completed` are that parser's vocabulary, and the due column is the
 * account-zone wall-clock string `parseLocalTime()` accepts. A file exported here and imported back is
 * the same set of tasks; that property is a test, not a hope.
 *
 * ## What is not exported, and why the answer is loud
 *
 * Trashed rows are absent — `store.listTasks` answers through the same visibility predicate every listing
 * uses, so a row on its way to being gone is not in a document about what the reader owes. Archived rows
 * are in, and carry their `archivedAt`.
 *
 * The read is paged and bounded by {@link MAX_EXPORT_TASKS}, and the two formats meet that ceiling
 * differently because only one of them can carry the announcement. JSON has an envelope, so a document
 * built at the ceiling says so in its own body and stays useful. CSV has no room to comment on itself:
 * {@link parseTodoCsv} reads its first line as the header and every later line as a task, so a metadata
 * line written into the file would come back as a task named `# timezone,UTC`. Rather than either
 * polluting the interchange format or shipping a short file that looks complete, the CSV writer throws
 * {@link TodoExportTooLarge} and the route answers it with the JSON export named as the way to get the
 * rest (AGENTS.md rule 2).
 */
import { toLocalMinute } from '@shared/assistant-time'
import { MAX_TASKS_PER_QUERY } from '@shared/todos/model'
import { isTaskDone } from '@shared/todos/status'
import type { TodoExportDocument, TodoTask } from '@shared/todos/model'
import type { AssistantStore } from '../assistant/store'

/** How many rows one export walks at most, and the ceiling its paging stops at. */
export const MAX_EXPORT_TASKS = 10_000

/** The columns `todos/import-csv.ts` reads, spelled the way it spells them. */
const CSV_HEADER = ['title', 'notes', 'due', 'priority', 'list', 'tags', 'completed']

/** The two words the importer reads as "this one is finished" and "this one is not". */
const CSV_DONE = 'done'
const CSV_OPEN = 'no'

/**
 * Every live row, read a page at a time in the order the rows were created.
 *
 * Paging is by offset over a fixed `sort: created`: the export is not a snapshot in a transaction, and a
 * row written *during* the walk can therefore be missed or repeated. That is acceptable for a document a
 * reader archives, and it is why the rows come back in creation order rather than in any order a view
 * would have used — a view's order moves under a write, and creation order does not.
 */
export async function collectExportTasks(
  store: AssistantStore,
): Promise<{ tasks: TodoTask[]; truncated: boolean }> {
  const tasks: TodoTask[] = []
  while (tasks.length < MAX_EXPORT_TASKS) {
    const page = await store.listTasks({
      status: 'all',
      archived: 'any',
      sort: 'created',
      limit: Math.min(MAX_TASKS_PER_QUERY, MAX_EXPORT_TASKS - tasks.length),
      offset: tasks.length,
    })
    tasks.push(...page)
    if (page.length < MAX_TASKS_PER_QUERY) return { tasks, truncated: false }
  }
  return { tasks, truncated: true }
}

/** The lossless document: the rows as the API answers them, plus what the walk saw. */
export function buildTodoExportJson(
  tasks: readonly TodoTask[],
  meta: { exportedAt: number; timezone: string; truncated: boolean },
): string {
  const document: TodoExportDocument = {
    format: 'inkstone-todos',
    version: 1,
    exportedAt: meta.exportedAt,
    timezone: meta.timezone,
    total: meta.truncated ? MAX_EXPORT_TASKS : tasks.length,
    truncated: meta.truncated,
    tasks: [...tasks],
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * One CSV cell.
 *
 * A cell that opens with `=`, `+`, `-`, `@`, a tab or a CR is handed to a spreadsheet's formula engine
 * before it is shown, and a task title is text somebody else may have written — it arrives from an
 * imported CSV as readily as from the keyboard. Quoting does not stop that, so the mark goes in front.
 * Numbers are never defused: the columns this file writes are all text.
 *
 * The mark is a real cost and it is paid knowingly — a title that opens with `=` comes back out of the
 * importer carrying the apostrophe, because stripping it there would corrupt a legitimate title that
 * starts with one. That asymmetry is the reason this module has two formats: JSON is the faithful export,
 * CSV the one that opens in a spreadsheet and reads back into this app.
 */
function cell(value: string): string {
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The interchange document: a header line and one row per task, in the importer's own vocabulary.
 *
 * `notes` keeps the task's Markdown verbatim — the importer stores that column as the description, so the
 * note survives the round trip. `due` is the account-zone wall clock, because a due date in a file the
 * reader opens in a spreadsheet has to read as the day they filed the task for, not as a UTC instant.
 * Nothing else goes in the file: the reader's language, the account's zone and the export instant are
 * already in the JSON document and in the file name, and a comment line here would be imported as a task.
 */
export function buildTodoExportCsv(
  tasks: readonly TodoTask[],
  meta: { timezone: string; truncated: boolean; listName: (task: TodoTask) => string | null },
): string {
  if (meta.truncated) throw new TodoExportTooLarge()
  const lines = [CSV_HEADER.join(',')]
  for (const task of tasks) {
    lines.push([
      cell(task.title),
      cell(task.description),
      cell(task.dueAt === null ? '' : toLocalMinute(task.dueAt, meta.timezone)),
      cell(task.priority),
      cell(meta.listName(task) ?? ''),
      // `;` is the separator the importer splits this column on; a comma would arrive as one tag.
      cell(task.tags.map((tag) => tag.name).join(';')),
      isTaskDone(task.status) ? CSV_DONE : CSV_OPEN,
    ].join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

/**
 * The account is bigger than one CSV can honestly carry.
 *
 * Thrown rather than answered with a short file: a partial export that reads as a complete one is the
 * wrong fact this module exists to avoid, and the CSV has no place to say it is partial.
 */
export class TodoExportTooLarge extends Error {
  constructor() {
    super(`A CSV export carries at most ${MAX_EXPORT_TASKS} tasks; the JSON export marks its own ceiling.`)
    this.name = 'TodoExportTooLarge'
  }
}
