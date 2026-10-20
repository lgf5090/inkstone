import { describe, expect, it, vi } from 'vitest'
import { dataviewModeOf, DATAVIEW_LANGUAGES, TASKS_LANGUAGES } from './body'

vi.mock('../i18n', () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}))

const pageLists = [
    {
        symbol: '-', text: 'overdue pay rent', line: 3, lineCount: 1, indent: 0, tags: [], links: [],
        section: { subpath: 'Money' }, blockId: null, link: {}, children: [], parent: null,
        fields: new Map(),
        task: {
            status: ' ', completed: false, fullyCompleted: false, statusType: 'TODO', statusName: 'Todo',
            fields: {
                description: 'overdue pay rent', priority: '1', createdDate: null, startDate: null,
                scheduledDate: null, dueDate: new Date(2026, 9, 5), doneDate: null, cancelledDate: null,
                invalidDates: {}, recurrenceRuleText: 'every week', onCompletion: '', id: '', dependsOn: [], tags: [],
            },
        },
    },
    {
        symbol: '-', text: 'no box here', line: 5, lineCount: 1, indent: 0, tags: [], links: [],
        section: { subpath: null }, blockId: null, link: {}, children: [], parent: null,
        fields: new Map(), task: null,
    },
]

vi.mock('./service', () => ({
    dataviewIndex: {
        allNoteIds: () => ['n1'],
        pageOf: (id: string) => (id === 'n1' ? { path: 'Home/Chores.md', lists: pageLists } : undefined),
        currentVersion: 1,
        subscribe: () => () => {},
    },
    dataviewSettings: () => ({ enabled: true, showErrorDetails: true }),
    querySettings: () => ({}),
}))

vi.mock('./blocks', () => ({
    encodeQueryBody: (value: string) => value,
}))

import { answerTasks, collectTasks, renderTasks } from './tasks-block'
import { parseTasksQuery } from '../tasks/query/query'

const NOW = new Date(2026, 9, 19)

describe('fence languages', () => {
    it('recognises the tasks languages without disturbing the others', () => {
        expect(TASKS_LANGUAGES).toEqual(['tasks', 'task'])
        expect(dataviewModeOf('tasks')).toBe('tasks')
        expect(dataviewModeOf('task')).toBe('tasks')
        expect(dataviewModeOf('dataview')).toBe('query')
        expect(dataviewModeOf('dataviewjs')).toBe('js')
        expect(dataviewModeOf('js')).toBeNull()
        expect(DATAVIEW_LANGUAGES).toEqual(['dataview', 'dv'])
    })
})

describe('the task provider', () => {
    it('reads tasks off the scanned index and skips items with no box', () => {
        const tasks = collectTasks()
        expect(tasks).toHaveLength(1)
        expect(tasks[0]!.fields.description).toBe('overdue pay rent')
        expect(tasks[0]!.location.path).toBe('Home/Chores.md')
        expect(tasks[0]!.location.lineNumber).toBe(3)
        expect(tasks[0]!.location.precedingHeader).toBe('Money')
        expect(tasks[0]!.recurrence).not.toBeNull()
    })
})

describe('answering a tasks block', () => {
    it('reports a parse error rather than an empty list', () => {
        const answer = answerTasks('nonsense line here', { originNoteId: null, editable: false })
        expect(answer.ok).toBe(false)
    })

    it('answers a valid query with groups and a total', () => {
        const answer = answerTasks('not done', { originNoteId: null, editable: false })
        expect(answer.ok).toBe(true)
        if (!answer.ok) return
        expect(answer.answer.total).toBe(1)
    })
})

describe('rendering a tasks block', () => {
    function render(source: string): HTMLElement {
        const parsed = parseTasksQuery(source, NOW)
        const groups = [{ path: [] as string[], tasks: collectTasks() }]
        return renderTasks({ groups, total: 1, parsed })
    }

    it('builds a row on the existing toggle contract', () => {
        const root = render('not done')
        const box = root.querySelector('input.dataview-task-checkbox') as HTMLInputElement | null
        expect(box).not.toBeNull()
        expect(box!.checked).toBe(false)
        expect(box!.dataset.dataviewTask).toBeTruthy()
        expect(root.querySelector('.dataview-task-text')?.textContent).toBe('overdue pay rent')
    })

    it('shows the due date and the recurrence rule as chips', () => {
        const root = render('not done')
        const chips = [...root.querySelectorAll<HTMLElement>('.dataview-task-chip')].map((chip) => chip.dataset.field)
        expect(chips).toContain('due')
        expect(chips).toContain('recurrence')
    })

    it('drops chip values in short mode but keeps the field', () => {
        const root = render('short mode')
        expect(root.querySelectorAll('.dataview-task-chip-value')).toHaveLength(0)
        expect(root.querySelectorAll('.dataview-task-chip').length).toBeGreaterThan(0)
    })

    it('draws group headings without the hidden sort key', () => {
        const parsed = parseTasksQuery('group by status.type', NOW)
        const root = renderTasks({
            groups: [{ path: ['%%2%%TODO'], tasks: collectTasks() }],
            total: 1,
            parsed,
        })
        const heading = root.querySelector('.tasks-group-heading')
        expect(heading?.textContent).toBe('TODO')
    })

    it('says so when nothing matched', () => {
        const root = renderTasks({
            groups: [{ path: [], tasks: [] }],
            total: 0,
            parsed: parseTasksQuery('not done', NOW),
        })
        expect(root.querySelector('.tasks-empty')?.textContent).toBe('tasks.no_results')
    })

    it('adds the explanation tree only when asked', () => {
        expect(render('not done').querySelector('.tasks-explain')).toBeNull()
        expect(render('explain\nnot done').querySelector('.tasks-explain')).not.toBeNull()
    })
})
