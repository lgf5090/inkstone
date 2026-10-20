import { useSession } from '../../store/session'
import { useNotes } from '../../store/notes'
import { applyTaskToggle, taskWords, type ToggleSettings } from './toggle'
import { parseTaskLine, toMarkdownLine } from './model/task'
import { unknownPosition } from './model/task-location'
import { applyDraft, type DraftErrors, type TaskDraft } from './edit/task-editor'
import { CompatTaskSerializer, DataviewTaskSerializer, defaultStatusRegistry, EmojiTaskSerializer, StatusRegistry } from './line'
import type { StatusConfiguration, TaskSerializer } from './line'

let cachedRegistry: StatusRegistry | null = null
let cachedKey = ''

/**
 * The statuses this reader defined, or the four everyone gets.
 *
 * Rebuilt only when the stored table changes, because the registry is consulted for every checkbox
 * in every rendered result and rebuilding it per click would parse the settings on each one.
 */
function statusRegistry(custom: StatusConfiguration[] | undefined): StatusRegistry {
  const key = JSON.stringify(custom ?? [])
  if (cachedRegistry === null || cachedKey !== key) {
    cachedRegistry = custom && custom.length > 0 ? new StatusRegistry(custom) : defaultStatusRegistry
    cachedKey = key
  }
  return cachedRegistry
}

/**
 * How a tick is written, assembled from the reader's settings.
 *
 * The completion-marker settings the query module already had decide which *format* a tick speaks:
 * a reader who chose `[completion:: …]` over `✅ …` gets their own spelling back, rather than one
 * format imposed on every note. Reading is deliberately not limited to that format — see
 * {@link CompatTaskSerializer} — because a `🔁` line a reader cannot switch out of is a line whose
 * recurrence silently stops.
 */
export function toggleSettings(): ToggleSettings {
  const { dataview, tasks } = useSession.getState().settings
  const serializer: TaskSerializer = new CompatTaskSerializer(dataview.taskCompletionUseEmojiShorthand
    ? new EmojiTaskSerializer()
    : new DataviewTaskSerializer())
  return {
    registry: statusRegistry(tasks.statuses),
    serializer,
    setDoneDate: dataview.taskCompletionTracking,
    setCancelledDate: tasks.setCancelledDate,
    setCreatedDate: tasks.setCreatedDate,
    recurrenceOnNextLine: tasks.recurrenceOnNextLine,
    recursiveSubTaskCompletion: dataview.recursiveSubTaskCompletion,
  }
}

/** The reader's own settings, for the surfaces that are not a tick. */
export function taskSettings() {
  return useSession.getState().settings.tasks
}

export type TaskToggleResult = 'written' | 'conflict' | 'missing'

/**
 * Advance one checkbox in a note the reader may not be editing.
 *
 * The rewrite runs against the copy the server holds now, inside the store's queued write, so a
 * result drawn from an older read cannot overwrite a newer edit. Refusing a line whose text no
 * longer matches is what makes a stale result a no-op rather than an edit to somebody else's task.
 */
export async function toggleTaskLine(noteId: string, line: number, text: string): Promise<TaskToggleResult> {
  const settings = toggleSettings()
  return useNotes.getState().editRemoteContent(noteId, (content) => applyTaskToggle(content, { line, text }, settings, new Date()))
}

/**
 * Advance the checkboxes on the given lines of a source the caller already holds.
 *
 * The editor and the reading preview both have the whole text in hand and know which lines their boxes
 * came from, so the staleness guard a query result needs is meaningless here — the lines they are
 * looking at are the lines they are about to write. Bottom-up, because a recurring task inserts a line
 * and `on completion: delete` removes one: working from the end means no edit can move a line that is
 * still to come. And a tick is a step along the reader's own cycle, so a `[/]` or `[-]` moves here just
 * as it does in the preview.
 */
export function toggleTaskLinesInSource(source: string, lineIndexes: number[], now: Date = new Date()): string | null {
  const settings = toggleSettings()
  let out = source
  for (const index of [...lineIndexes].sort((a, b) => b - a)) {
    const line = out.split(/\r?\n/u)[index]
    if (line === undefined) continue
    const task = parseTaskLine(line, unknownPosition('', ''), {
      registry: settings.registry,
      serializer: settings.serializer,
      now,
    })
    if (task === null) continue
    const next = applyTaskToggle(out, { line: index, text: task.fields.description }, settings, now)
    if (next !== null) out = next
  }
  return out === source ? null : out
}

/** What the edit form sent: the draft, and which status character the reader chose. */
export interface TaskEdit {
  draft: TaskDraft
  statusSymbol: string
}

/**
 * Replace one task line with what the edit form produced.
 *
 * The same two-anchor contract as a tick: the line is found by index and confirmed by its words, so a
 * note that moved since the form opened is refused rather than overwritten. A recurring task can come
 * back as two lines, so the replacement is a list.
 */
export function editTaskInSource(
  source: string,
  lineIndex: number,
  edit: TaskEdit,
  now: Date = new Date(),
  expect?: string,
): EditOutcome {
  const settings = toggleSettings()
  const lines = source.split(/\r?\n/u)
  const line = lines[lineIndex]
  if (line === undefined) return { ok: false, reason: 'missing', source }
  const task = parseTaskLine(line, unknownPosition('', ''), {
    registry: settings.registry,
    serializer: settings.serializer,
    now,
  })
  if (task === null) return { ok: false, reason: 'missing', source }
  if (expect !== undefined && taskWords(task.fields.description) !== taskWords(expect)) {
    return { ok: false, reason: 'missing', source }
  }
  const status = settings.registry.bySymbolOrCreate(edit.statusSymbol)
  // The form shows the description with the reader's global filter taken out, so writing it back has to
  // put the word in again — otherwise saving a task that was found by the filter would quietly stop it
  // from matching, and the row would vanish from the very list the reader was looking at.
  const applied = applyDraft(task, edit.draft, status, settings, now, { globalFilter: taskSettings().globalFilter })
  if (applied.errors.recurrence !== 'none' || Object.keys(applied.errors.dates).length > 0) {
    return { ok: false, reason: 'invalid', errors: applied.errors, source }
  }
  const replacement = applied.tasks.map((item) => toMarkdownLine(item, settings.serializer))
  const out = [...lines]
  out.splice(lineIndex, 1, ...replacement)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  return { ok: true, source: out.join(eol) }
}

/**
 * Edit a task in a note the reader may not be editing.
 *
 * The same remote-write path a tick uses, so a form that was opened from a query result cannot
 * overwrite a newer copy of the note: the words the row showed are confirmed against the line the
 * server holds now.
 */
export async function editTaskInNote(
  noteId: string,
  line: number,
  text: string | null,
  edit: TaskEdit,
  now: Date = new Date(),
): Promise<TaskToggleResult> {
  return useNotes.getState().editRemoteContent(noteId, (content) => {
    const outcome = editTaskInSource(content, line, edit, now, text ?? undefined)
    return outcome.ok ? outcome.source : null
  })
}

/** Why an edit did not land, so the form can say which field to look at. */
export type EditReason = 'missing' | 'invalid'

export interface EditOutcome {
  ok: boolean
  reason?: EditReason
  errors?: DraftErrors
  source: string
}

/** The draft as the model reads it, for a form that must say which field failed before saving. */
export function validateTaskDraft(
  source: string,
  lineIndex: number,
  edit: TaskEdit,
  now: Date = new Date(),
): DraftErrors | null {
  const outcome = editTaskInSource(source, lineIndex, edit, now)
  return outcome.ok ? null : (outcome.errors ?? null)
}
