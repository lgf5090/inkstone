/**
 * The colour a task wears, away from the DOM.
 *
 * The rule is small enough to say in one line — its own, else its list's, else the neutral — but the
 * edges are what a reader sees: a task that has cleared its own colour goes back to the list's rather
 * than to grey, an inbox task never asks a list it does not have, and a list deleted out from under
 * a task leaves the row wearing the caller's neutral instead of throwing.
 */
import { describe, expect, it } from 'vitest'
import type { TaskList, TodoTask } from '@shared/todos/model'
import { taskColorOf } from './task-face'

function task(extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id: 'task-1',
    title: 'Task',
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    ...extra,
  } as TodoTask
}

function list(id: string, color: string | null): TaskList {
  return {
    id,
    name: id,
    icon: null,
    color,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    openCount: 0,
    doneCount: 0,
  }
}

describe("a task's own colour", () => {
  it('wins over the list it sits in', () => {
    const lists = [list('l1', '#2563eb')]
    expect(taskColorOf(task({ listId: 'l1', color: '#dc2626' }), lists)).toBe('#dc2626')
  })

  it('is the list colour when the task names none', () => {
    const lists = [list('l1', '#2563eb')]
    expect(taskColorOf(task({ listId: 'l1' }), lists)).toBe('#2563eb')
    expect(taskColorOf(task({ listId: 'l1', color: null }), lists)).toBe('#2563eb')
  })

  it('is the caller neutral for a task in no list at all', () => {
    expect(taskColorOf(task({ listId: null }), [])).toBe('var(--text-tertiary)')
    expect(taskColorOf(task({ listId: null }), [], 'var(--accent)')).toBe('var(--accent)')
  })

  it('falls back for a list that has since been deleted', () => {
    expect(taskColorOf(task({ listId: 'gone' }), [list('l1', '#2563eb')])).toBe('var(--text-tertiary)')
  })

  it('is the caller neutral when the list itself has no colour', () => {
    expect(taskColorOf(task({ listId: 'l1' }), [list('l1', null)])).toBe('var(--text-tertiary)')
    expect(taskColorOf(task({ listId: 'l1' }), [list('l1', null)], 'var(--accent)')).toBe('var(--accent)')
  })
})

// A fixture written before the column existed answers with no face at all; the reading is the list's,
// exactly as it was the day before tasks could have one of their own.
describe('a task with no face of its own', () => {
  it('reads as the list colour when the field is absent', () => {
    const lists = [list('l1', '#2563eb')]
    const row = task({ listId: 'l1' })
    delete (row as { color?: string | null }).color
    expect(taskColorOf(row, lists)).toBe('#2563eb')
  })
})
