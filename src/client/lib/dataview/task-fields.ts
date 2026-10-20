import { defaultStatusRegistry, PRIORITY_NAMES, Priority, type TaskFields } from '../tasks/line'
import type { Literal } from './value'

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

/**
 * What a checkbox character means, as two flat fields.
 *
 * `completed` answers "is the box ticked", which is what a Dataview task table has always shown.
 * `statusType` answers "is this task finished", which is the question a `[-]` cancelled task asks
 * and `completed` cannot answer. Both stay on the page so a reader can filter either way.
 */
export function describeStatus(symbol: string): { statusType: string; statusName: string } {
    const status = defaultStatusRegistry.bySymbolOrCreate(symbol)
    return { statusType: status.type, statusName: status.name }
}
