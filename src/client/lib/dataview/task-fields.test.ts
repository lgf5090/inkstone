import { describe, expect, it } from 'vitest'
import { parseNote, serializePage, type NoteInput } from './metadata'
import { formatTaskDate } from '../tasks/line'
import type { DataObject } from './value'

const DUE = '\u{1F4C5}'
const RECUR = '\u{1F501}'
const LEGACY_CREATED = '\u2715'

function input(overrides: Partial<NoteInput> = {}): NoteInput {
  return {
    id: 'note-1',
    title: 'Tasks',
    folder: '',
    content: '',
    tags: [],
    charCount: 0,
    createdAt: 0,
    updatedAt: 0,
    starred: false,
    pinned: false,
    archived: false,
    wordCount: 0,
    ...overrides,
  }
}

function firstTask(content: string): DataObject {
  const page = parseNote(input({ content }))
  const file = serializePage(page).file as DataObject
  return (file.tasks as DataObject[])[0]!
}

describe('task fields on the page object', () => {
  it('gives a task line the fields a query filters on', () => {
    const task = firstTask(`- [ ] ship it ${DUE} 2024-05-06 #work`)
    expect(task.task).toBe(true)
    expect(formatTaskDate(task.due as Date)).toBe('2024-05-06')
    expect(task.statusType).toBe('TODO')
    expect(task.completed).toBe(false)
    expect(String(task.text)).toContain('ship it')
  })

  it('reads a bracketed format line the same way', () => {
    const task = firstTask('- [ ] ship it [due:: 2024-05-06] [priority:: high]')
    expect(formatTaskDate(task.due as Date)).toBe('2024-05-06')
    expect(task.priority).toBe('high')
  })

  it('resolves fields only from the trailing format, which is the documented rule', () => {
    const task = firstTask(`- [ ] ship it ${DUE} 2024-05-06 [priority:: high]`)
    expect(task.due).toBeUndefined()
    expect(task.priority).toBe('high')
  })

  it('reads the legacy cross mark as a created date', () => {
    const task = firstTask(`- [ ] older note ${LEGACY_CREATED} 2024-05-02`)
    expect(formatTaskDate(task.created as Date)).toBe('2024-05-02')
  })

  it('types an in-progress and a cancelled box apart from a ticked one', () => {
    expect(firstTask('- [/] mid flight').statusType).toBe('IN_PROGRESS')
    expect(firstTask('- [-] dropped').statusType).toBe('CANCELLED')
    expect(firstTask('- [x] wrapped').statusType).toBe('DONE')
    expect(firstTask('- [x] wrapped').completed).toBe(true)
  })

  it('lets an explicit bracket field win over the symbol on the same line', () => {
    const task = firstTask(`- [ ] both [due:: 2024-05-01] ${DUE} 2024-05-06`)
    expect(formatTaskDate(task.due as Date)).toBe('2024-05-01')
  })

  it('carries a recurrence rule through to the page object', () => {
    expect(firstTask(`- [ ] standup ${RECUR} every week`).recurrence).toBe('every week')
  })

  it('keeps a non-task list item out of the task rows', () => {
    const page = parseNote(input({ content: '- plain item\n- [ ] a task\n' }))
    const file = serializePage(page).file as DataObject
    expect((file.tasks as DataObject[])).toHaveLength(1)
    expect((file.lists as DataObject[])).toHaveLength(2)
  })
})
