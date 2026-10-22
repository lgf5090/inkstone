/**
 * The chips a tool result earns.
 *
 * Two things are pinned: a task row becomes a chip, and nothing else does. The second half is the one
 * that matters — a list answers with `{ id, name }`, and a chip drawn from it would navigate the reader
 * to a task id that is really a list, which opens an empty panel over nothing.
 */
import { describe, expect, it } from 'vitest'
import { taskRefsFromToolResult } from './task-refs'

const ID = '01j9z8x4kq2m6b7n3p5r8s0t2v'

describe('taskRefsFromToolResult', () => {
  it('draws a chip for each task the payload named', () => {
    const result = JSON.stringify({
      count: 2,
      tasks: [{ id: ID, title: 'File the return' }, { id: '01j9z8x4kq2m6b7n3p5r8s0t2w', title: 'Send the mail' }],
    })
    expect(taskRefsFromToolResult('list_tasks', result)).toEqual([
      { id: ID, title: 'File the return' },
      { id: '01j9z8x4kq2m6b7n3p5r8s0t2w', title: 'Send the mail' },
    ])
  })

  it('reads the task a single-task answer wrapped', () => {
    const result = JSON.stringify({ created: { id: ID, title: 'File the return' } })
    expect(taskRefsFromToolResult('create_task', result)).toEqual([{ id: ID, title: 'File the return' }])
  })

  it('draws nothing for a list row, which has a name and no title', () => {
    const result = JSON.stringify({ lists: [{ id: ID, name: 'Work', open: 2, total: 3 }] })
    expect(taskRefsFromToolResult('list_task_lists', result)).toEqual([])
  })

  it('draws nothing for a note tool, whose ids look the same', () => {
    const result = JSON.stringify({ notes: [{ id: ID, title: 'Q4 plan' }] })
    expect(taskRefsFromToolResult('list_notes', result)).toEqual([])
  })

  it('draws nothing for a payload that is not this app\'s JSON', () => {
    expect(taskRefsFromToolResult('list_tasks', 'three tasks are due')).toEqual([])
    expect(taskRefsFromToolResult('list_tasks', undefined)).toEqual([])
  })

  it('shows one chip per task even when a payload repeats it', () => {
    const result = JSON.stringify({ task: { id: ID, title: 'One' }, steps: [{ id: ID, title: 'One' }] })
    expect(taskRefsFromToolResult('get_task', result)).toHaveLength(1)
  })
})
