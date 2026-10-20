import { OnCompletion } from '../model/on-completion'
import { TaskRegularExpressions } from '../model/task-regular-expressions'
import { Priority } from '../model/priority'
import { DataviewTaskSerializer } from './dataview-format'
import { EmojiTaskSerializer } from './emoji'
import { emptyTaskFields, type SerializeOptions, type TaskDateField, type TaskFields, type TaskSerializer } from './index'

const formats: TaskSerializer[] = [new EmojiTaskSerializer(), new DataviewTaskSerializer()]

const DATE_FIELDS: TaskDateField[] = ['createdDate', 'startDate', 'scheduledDate', 'dueDate', 'cancelledDate', 'doneDate']

/**
 * Read a task's fields from whichever format wrote each of them.
 *
 * A vault is not a single format: notes written by the query module say `[due:: 2026-10-04]` while the
 * task feature says `📅 2026-10-04`, and a reader can mix the two inside one line. Reading only the
 * format the reader picked for their completion stamps would leave a `🔁 every week` line unread for
 * anyone who chose inline fields, and ticking it would finish the instance without producing the next
 * one. So each format is asked in turn what it can see at the end of the line, until neither can peel
 * any more; what is written back is one shape, and the reader's own format decides its spelling.
 */
export function readEitherFormat(text: string): TaskFields {
  const found = emptyTaskFields(text)
  let rest = text
  // Six field kinds across two formats, and one field may sit in front of another the other format
  // owns; a handful of passes covers any order a reader can type without an unbounded loop.
  for (let pass = 0; pass < 4; pass++) {
    let progressed = false
    for (const format of formats) {
      const read = format.deserialize(rest)
      if (read.description.length >= rest.length) continue
      rest = read.description
      take(found, read)
      progressed = true
    }
    if (!progressed) break
  }
  found.description = rest
  found.tags = (rest.match(TaskRegularExpressions.hashTags) ?? []).map((tag) => tag.trim())
  return found
}

/** Take a field from a format that saw it, leaving alone anything already answered. */
function take(found: TaskFields, read: TaskFields): void {
  for (const field of DATE_FIELDS) {
    if (found[field] === null && read[field] !== null) {
      found[field] = read[field]
      if (read.invalidDates[field] !== undefined) found.invalidDates[field] = read.invalidDates[field]
    }
  }
  if (found.priority === Priority.None) found.priority = read.priority
  if (found.recurrenceRuleText === '') found.recurrenceRuleText = read.recurrenceRuleText
  if (found.onCompletion === OnCompletion.Ignore) found.onCompletion = read.onCompletion
  if (found.id === '') found.id = read.id
  if (found.dependsOn.length === 0) found.dependsOn = read.dependsOn
}

/** {@link readEitherFormat} for the reading half, with one chosen format for the writing half. */
export class CompatTaskSerializer implements TaskSerializer {
  constructor(private readonly write: TaskSerializer) {}

  deserialize(text: string): TaskFields {
    return readEitherFormat(text)
  }

  serialize(fields: TaskFields, options: SerializeOptions = {}): string {
    return this.write.serialize(fields, options)
  }
}
