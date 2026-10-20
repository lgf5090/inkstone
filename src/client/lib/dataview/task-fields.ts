import { DataviewTaskSerializer, EmojiTaskSerializer, type TaskDateField, type TaskFields } from '../tasks'
import { PRIORITY_NAMES, Priority } from '../tasks'
import type { Literal } from './value'

const emoji = new EmojiTaskSerializer()
const inline = new DataviewTaskSerializer()

const DATE_FIELDS: TaskDateField[] = ['createdDate', 'startDate', 'scheduledDate', 'dueDate', 'cancelledDate', 'doneDate']

/**
 * Read a task line into the one shape every view agrees on.
 *
 * Both formats are tried because Inkstone notes already mix them: a vault where half the tasks say
 * `📅 2026-10-04` and half say `[due:: 2026-10-04]` should not have to pick an engine. The emoji
 * format wins where both found the same field, since it is the one that carries the rest of them.
 */
export function readTaskFields(body: string): TaskFields {
    const fromEmoji = emoji.deserialize(body)
    const fromInline = inline.deserialize(body)
    const merged: TaskFields = { ...fromEmoji }
    for (const field of DATE_FIELDS) {
        if (merged[field] === null && fromInline[field] !== null) {
            merged[field] = fromInline[field]
            if (fromInline.invalidDates[field] !== undefined) merged.invalidDates[field] = fromInline.invalidDates[field]
        }
    }
    if (merged.priority === Priority.None && fromInline.priority !== Priority.None) merged.priority = fromInline.priority
    if (merged.recurrenceRuleText === '') merged.recurrenceRuleText = fromInline.recurrenceRuleText
    if (merged.id === '') merged.id = fromInline.id
    if (merged.dependsOn.length === 0) merged.dependsOn = fromInline.dependsOn
    return merged
}

/**
 * The task's fields as Dataview fields, so `WHERE due < today` and `TABLE priority` answer for a
 * task line the same way they do for a frontmatter property.
 *
 * `completion` is kept beside `done`: it is the name this project's Dataview port published, and
 * readers have queries written against it. Keys the note already set by hand are skipped, because
 * an explicit `[due:: …]` states what the author meant more directly than a symbol does.
 */
export function taskFieldEntries(fields: TaskFields, taken: Map<string, Literal[]>): Array<[string, Literal]> {
    const entries: Array<[string, Literal]> = []
    const add = (key: string, value: Literal | null): void => {
        if (value !== null) entries.push([key, value])
    }

    add('due', fields.dueDate)
    add('scheduled', fields.scheduledDate)
    add('start', fields.startDate)
    add('created', fields.createdDate)
    add('done', fields.doneDate)
    add('cancelled', fields.cancelledDate)
    add('completion', fields.doneDate)
    if (fields.priority !== Priority.None) add('priority', PRIORITY_NAMES[fields.priority])
    add('recurrence', fields.recurrenceRuleText === '' ? null : fields.recurrenceRuleText)
    add('id', fields.id === '' ? null : fields.id)
    add('dependsOn', fields.dependsOn.length === 0 ? null : [...fields.dependsOn])
    if (fields.onCompletion !== '') add('onCompletion', fields.onCompletion)

    return entries.filter(([key]) => !taken.has(key))
}
