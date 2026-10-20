import { useSession } from '../../store/session'
import { useNotes } from '../../store/notes'
import { applyTaskToggle, type ToggleSettings } from './toggle'
import { parseTaskLine } from './model/task'
import { unknownPosition } from './model/task-location'
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
  const dataview = useSession.getState().settings.dataview
  const serializer: TaskSerializer = new CompatTaskSerializer(dataview.taskCompletionUseEmojiShorthand
    ? new EmojiTaskSerializer()
    : new DataviewTaskSerializer())
  return {
    // The reader-defined status table and the two date stamps land with the settings screen;
    // until then a tick uses the four statuses everyone gets and the defaults the reference plugin ships.
    registry: statusRegistry(undefined),
    serializer,
    setDoneDate: dataview.taskCompletionTracking,
    setCancelledDate: true,
    setCreatedDate: false,
    recurrenceOnNextLine: false,
    recursiveSubTaskCompletion: dataview.recursiveSubTaskCompletion,
  }
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
