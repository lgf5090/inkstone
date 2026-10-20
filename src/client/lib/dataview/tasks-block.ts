import { t } from '../i18n'
import { dataviewIndex } from './service'
import { encodeDataValue } from '../markdown/data-attr'
import { explainQuery } from '../tasks/query/explain'
import { parseTasksQuery, runTasksQuery, stripSortPrefix, type TaskGroup } from '../tasks/query/query'
import type { ParsedQuery } from '../tasks/query/query'
import type { Task } from '../tasks/model/task'
import { unknownPosition, type TaskLocation } from '../tasks/model/task-location'
import { taskSettings } from '../tasks/service'
import { shouldShowPostponeButton } from '../tasks/date/postpone'
import { TaskLayoutComponent } from '../tasks/layout/task-layout'
import { OnCompletion } from '../tasks/model/on-completion'
import { Priority, PRIORITY_NAMES } from '../tasks/model/priority'
import { Occurrence } from '../tasks/model/occurrence'
import { Recurrence } from '../tasks/model/recurrence'
import type { ListItemData } from './metadata'
import type { TaskFields } from '../tasks/line'
import { defaultStatusRegistry } from '../tasks/line'
import type { DataviewMountOptions } from './blocks'

export interface TasksAnswer {
    groups: TaskGroup[]
    total: number
    parsed: ParsedQuery
}

/**
 * Every task the index can see right now.
 *
 * Read off the scanned pages rather than re-parsing note bodies: the scanner already found the list
 * items, their line numbers and their sections, and a second parse would be a second opinion about
 * what a note says — the thing the single-source rule exists to prevent.
 */
export function collectTasks(): Task[] {
    const out: Task[] = []
    for (const noteId of dataviewIndex.allNoteIds()) {
        const page = dataviewIndex.pageOf(noteId)
        if (page === undefined) continue
        for (const item of page.lists) {
            const scanned = item.task
            if (scanned === null) continue
            const location = {
                ...unknownPosition(noteId, page.path),
                lineNumber: item.line,
                precedingHeader: item.section.subpath ?? null,
            }
            const parsed = parseTaskFromItem(item, scanned, location)
            if (parsed !== null) out.push(parsed)
        }
    }
    return out
}

function parseTaskFromItem(item: ListItemData, scanned: NonNullable<ListItemData['task']>, location: TaskLocation): Task {
    return {
        status: defaultStatusRegistry.bySymbolOrCreate(scanned.status),
        fields: scanned.fields,
        location,
        originalMarkdown: item.text,
        indentation: ' '.repeat(item.indent),
        listMarker: item.symbol,
        blockLink: item.blockId ? ` ^${item.blockId}` : '',
        hardBreak: '',
        scheduledDateIsInferred: false,
        recurrence: recurrenceFor(scanned.fields),
    }
}

function recurrenceFor(fields: TaskFields): Recurrence | null {
    if (fields.recurrenceRuleText === '') return null
    return Recurrence.fromText({
        recurrenceRuleText: fields.recurrenceRuleText,
        occurrence: new Occurrence({
            startDate: fields.startDate,
            scheduledDate: fields.scheduledDate,
            dueDate: fields.dueDate,
        }),
        now: new Date(),
    })
}

export function answerTasks(source: string, options: DataviewMountOptions): { ok: true; answer: TasksAnswer } | { ok: false; title: string; detail: string } {
    const now = new Date()
    const reader = taskSettings()
    const parsed = parseTasksQuery(source, now, {
        currentPath: currentPathOf(options),
        defaultHiddenFields: reader.defaultHiddenFields,
    })
    if (parsed.errors.length > 0) {
        return { ok: false, title: t('dataview.exec_failed'), detail: parsed.errors.join('\n') }
    }
    const result = runTasksQuery(collectTasks(), parsed, now, reader.globalFilter)
    return { ok: true, answer: { groups: result.groups, total: result.tasks.length, parsed } }
}

function currentPathOf(options: DataviewMountOptions): string | null {
    if (!options.originNoteId) return null
    return dataviewIndex.pageOf(options.originNoteId)?.path ?? null
}

/** Draw a `tasks` answer: group headings, then one row per task. */
export function renderTasks(answer: TasksAnswer): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'tasks-results'
    for (const group of answer.groups) {
        if (group.path.length > 0) wrap.append(...groupHeadings(group.path))
        const list = document.createElement('div')
        list.className = 'dataview-tasks'
        for (const task of group.tasks) list.append(renderTaskRow(task, answer.parsed))
        wrap.append(list)
    }
    if (answer.total === 0) {
        const empty = document.createElement('p')
        empty.className = 'tasks-empty'
        empty.textContent = t('tasks.no_results')
        wrap.append(empty)
    }
    const count = document.createElement('p')
    count.className = 'tasks-count'
    count.textContent = t('tasks.result_count', { value0: answer.total })
    if (!answer.parsed.layout.hiddenQueryParts.has('task count')) wrap.append(count)
    if (answer.parsed.explain) wrap.append(renderExplanation(answer.parsed))
    return wrap
}

function groupHeadings(path: string[]): HTMLElement[] {
    return path.map((value, depth) => {
        const heading = document.createElement('h4')
        heading.className = 'tasks-group-heading'
        heading.dataset.depth = String(depth)
        heading.textContent = stripSortPrefix(value)
        return heading
    })
}

/**
 * One task row, built to the shape the query module already owns.
 *
 * The `data-dataview-task` payload is the existing toggle contract, so a tick in a `tasks` block
 * writes back through the same handler as a tick in a DQL `TASK` result. Reusing it is what keeps
 * one write path rather than two that can disagree.
 */
function renderTaskRow(task: Task, parsed: ParsedQuery): HTMLElement {
    const row = document.createElement('div')
    row.className = 'dataview-task'
    const completed = task.status.isTicked

    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = `dataview-task-checkbox${completed ? ' is-checked' : ''}`
    box.checked = completed
    box.setAttribute('aria-label', completed ? t('dataview.task_done') : t('dataview.task_open'))
    box.dataset.dataviewTask = encodeDataValue(JSON.stringify({
        path: task.location.path,
        line: task.location.lineNumber,
        text: task.fields.description,
        completed,
        status: task.status.symbol,
    }))

    const text = document.createElement('span')
    text.className = `dataview-task-text${completed ? ' is-done' : ''}`
    text.textContent = rowText(task, parsed)

    row.append(box, text, ...renderChips(task, parsed))
    if (!parsed.layout.hiddenQueryParts.has('backlink')) {
        const source = document.createElement('span')
        source.className = 'dataview-task-source'
        source.textContent = task.location.path.split('/').pop() ?? task.location.path
        row.append(source)
    }
    if (!parsed.layout.hiddenQueryParts.has('postpone button') && task.location.noteId !== '' && shouldShowPostponeButton(task)) {
        const postpone = document.createElement('button')
        postpone.type = 'button'
        postpone.className = 'dataview-task-postpone'
        postpone.textContent = t('tasks.postpone_action')
        postpone.addEventListener('click', (event) => {
            event.stopPropagation()
            // The row already holds the parsed task, so the menu is built from it rather than from a
            // re-read: the dates a reader picks are the dates the row was drawn with.
            const box = postpone.getBoundingClientRect()
            void import('../../features/tasks/postpone-menu').then(({ openPostponeMenu }) => {
                openPostponeMenu(task, { x: box.left, y: box.bottom + 5 })
            })
        })
        row.append(postpone)
    }
    if (!parsed.layout.hiddenQueryParts.has('edit button') && task.location.noteId !== '') {
        const edit = document.createElement('button')
        edit.type = 'button'
        edit.className = 'dataview-task-edit'
        edit.textContent = t('tasks.edit_action')
        // The row says which line of which note it was drawn from; the form reads that line again when
        // it opens, so a result that has gone stale is caught there rather than written over here.
        edit.addEventListener('click', (event) => {
            event.stopPropagation()
            void import('../../features/tasks/store').then(({ openTaskEditor }) => {
                openTaskEditor({
                    noteId: task.location.noteId,
                    line: task.location.lineNumber,
                    text: task.fields.description,
                })
            })
        })
        row.append(edit)
    }
    return row
}

/**
 * The date and identity pills, in the order a reader scans a task.
 *
 * Short mode keeps the field and drops its value: a dense list still shows that something is due,
 * just not on which day.
 */
function renderChips(task: Task, parsed: ParsedQuery): HTMLElement[] {
    const out: HTMLElement[] = []
    const short = parsed.layout.shortMode === true
    const layout = parsed.layout.taskLayout
    const add = (key: string, value: string): void => {
        const chip = document.createElement('span')
        chip.className = 'dataview-task-chip'
        chip.dataset.field = key
        const label = document.createElement('span')
        label.className = 'dataview-task-chip-key'
        label.textContent = key
        chip.append(label)
        if (!short) {
            const shown = document.createElement('span')
            shown.className = 'dataview-task-chip-value'
            shown.textContent = value
            chip.append(shown)
        }
        out.push(chip)
    }

    const dates: Array<[string, TaskLayoutComponent, Date | null]> = [
        ['due', TaskLayoutComponent.DueDate, task.fields.dueDate],
        ['scheduled', TaskLayoutComponent.ScheduledDate, task.fields.scheduledDate],
        ['start', TaskLayoutComponent.StartDate, task.fields.startDate],
        ['created', TaskLayoutComponent.CreatedDate, task.fields.createdDate],
        ['done', TaskLayoutComponent.DoneDate, task.fields.doneDate],
        ['cancelled', TaskLayoutComponent.CancelledDate, task.fields.cancelledDate],
    ]
    for (const [key, component, date] of dates) {
        if (date === null || !layout.isShown(component)) continue
        add(key, Number.isFinite(date.getTime()) ? isoDay(date) : '—')
    }
    // A priority of "none" is the absence of a marker rather than a value worth a column of its own.
    if (task.fields.priority !== Priority.None && layout.isShown(TaskLayoutComponent.Priority)) {
        add('priority', PRIORITY_NAMES[task.fields.priority])
    }
    if (task.fields.recurrenceRuleText !== '' && layout.isShown(TaskLayoutComponent.RecurrenceRule)) {
        add('recurrence', task.fields.recurrenceRuleText)
    }
    if (task.fields.onCompletion !== OnCompletion.Ignore && layout.isShown(TaskLayoutComponent.OnCompletion)) {
        add('on completion', task.fields.onCompletion)
    }
    if (task.fields.id !== '' && layout.isShown(TaskLayoutComponent.Id)) add('id', task.fields.id)
    if (task.fields.dependsOn.length > 0 && layout.isShown(TaskLayoutComponent.DependsOn)) {
        add('depends on', task.fields.dependsOn.join(' '))
    }
    return out
}

/**
 * The words of the line as this query wants them.
 *
 * Tags ride inside the description rather than being a field the serializer writes, so `hide tags`
 * cuts them out of the same string the row is drawn from.
 */
function rowText(task: Task, parsed: ParsedQuery): string {
    if (parsed.layout.taskLayout.areTagsShown()) return task.fields.description
    const bare = task.fields.tags.reduce((text, tag) => text.split(tag).join(''), task.fields.description)
    return bare.replace(/\s{2,}/gu, ' ').trim()
}

function isoDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${date.getFullYear()}-${month}-${day}`
}

function renderExplanation(parsed: ParsedQuery): HTMLElement {
    const block = document.createElement('details')
    block.className = 'tasks-explain'
    const summary = document.createElement('summary')
    summary.textContent = t('tasks.explain')
    block.append(summary)
    const list = document.createElement('ul')
    for (const line of explainQuery(parsed)) {
        const item = document.createElement('li')
        item.dataset.kind = line.kind
        item.style.paddingLeft = `${line.depth * 12}px`
        item.textContent = line.text
        list.append(item)
    }
    block.append(list)
    return block
}
