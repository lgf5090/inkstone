// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import type { TaskListEntry } from '../../lib/api'
import type { TaskTag, TodoTask } from '@shared/todos/model'
import { buildTodoAssistantContext } from './assistant-context'

function task(id: string, title: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: 'L1',
    tags: [],
    parentId: null,
    dependsOn: [],
    blocks: [],
    starred: false,
    repeat: null,
    remindedAt: null,
    plannedFor: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    ...extra,
  }
}

const list: TaskListEntry = {
  id: 'L1', name: 'Work', icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0,
  openCount: 0, doneCount: 0, archivedAt: null, parentId: null,
}
const tag: TaskTag = { id: 'T1', name: 'Design', color: null, createdAt: 0, updatedAt: 0, openCount: 0 }

function source(over: Partial<Parameters<typeof buildTodoAssistantContext>[0]> = {}): Parameters<typeof buildTodoAssistantContext>[0] {
  return {
    view: 'list',
    listId: 'L1',
    tagId: null,
    query: '',
    dueFrom: null,
    dueTo: null,
    lists: [list],
    tags: [tag],
    tasks: [task('t1', 'Ship it', { dueAt: Date.parse('2026-10-21T03:00:00Z'), plannedFor: '2026-10-22', starred: true })],
    completed: [],
    draft: null,
    editorOpen: false,
    timezone: 'UTC',
    ...over,
  }
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
})

describe('the to-do assistant context', () => {
  it('names the list and carries the tasks in the order on screen', () => {
    const context = buildTodoAssistantContext(source({
      tasks: [task('t1', 'First'), task('t2', 'Second')],
    }))
    expect(context.view).toBe('list')
    expect(context.listName).toBe('Work')
    expect(context.tasks.map((entry) => entry.id)).toEqual(['t1', 't2'])
  })

  it('carries the open task when the editor is on one', () => {
    const context = buildTodoAssistantContext(source({ editorOpen: true, draft: { id: 't1' } }))
    expect(context.taskId).toBe('t1')
    expect(context.taskTitle).toBe('Ship it')
  })

  it('reads the finished bucket on the completed screen', () => {
    const context = buildTodoAssistantContext(source({
      view: 'completed',
      tasks: [task('open', 'Open')],
      completed: [task('done', 'Done', { status: 'done' })],
    }))
    expect(context.tasks.map((entry) => entry.id)).toEqual(['done'])
  })

  it('does not pretend a calendar or statistics screen carries a task page', () => {
    expect(buildTodoAssistantContext(source({ view: 'calendar' })).tasks).toEqual([])
    expect(buildTodoAssistantContext(source({ view: 'stats' })).tasks).toEqual([])
  })

  it('caps the snapshot and names the inbox', () => {
    const context = buildTodoAssistantContext(source({
      listId: 'inbox',
      tasks: Array.from({ length: 25 }, (_, index) => task(`t${index}`, `Task ${index}`)),
    }))
    expect(context.listName).toBe(t('todo.smart.inbox'))
    expect(context.tasks).toHaveLength(20)
  })
})
