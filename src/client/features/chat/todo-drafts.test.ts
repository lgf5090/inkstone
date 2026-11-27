import { describe, expect, it } from 'vitest'
import { todoDraftFromToolResult } from './todo-drafts'

/**
 * The drafts the to-do tools answer with, read off a tool result.
 *
 * What these cases pin is the boundary between a proposal and a press: the reader's button is the only
 * thing that writes, so the reader has to be able to trust what it says it will do. A row whose id is
 * not an id, a day that is not a day, or a reason the rule never names is dropped rather than offered
 * as a button that would fail.
 */

describe('a plan draft', () => {
  it('reads the rows and the day, in the order the tool answered', () => {
    const draft = todoDraftFromToolResult('plan_today', {
      draft: true,
      today: '2026-10-24',
      suggestions: [
        { id: '01m5q89938cz5r4rxa6g99jsyw', title: 'Pay rent', reason: 'overdue' },
        { id: '01m5q899457bqjtfzjx1jmm9gs', title: 'Read', reason: 'unscheduled' },
      ],
    })

    expect(draft).toEqual({
      kind: 'plan',
      today: '2026-10-24',
      rows: [
        { id: '01m5q89938cz5r4rxa6g99jsyw', title: 'Pay rent', reason: 'overdue' },
        { id: '01m5q899457bqjtfzjx1jmm9gs', title: 'Read', reason: 'unscheduled' },
      ],
    })
  })

  it('drops a row it cannot offer, and a day it cannot read', () => {
    expect(todoDraftFromToolResult('plan_today', {
      today: '2026-10-24',
      suggestions: [{ id: 'not-an-id', title: 'Pay rent', reason: 'overdue' }],
    })).toBeNull()

    expect(todoDraftFromToolResult('plan_today', {
      today: 'tomorrow',
      suggestions: [{ id: '01m5q89938cz5r4rxa6g99jsyw', title: 'Pay rent', reason: 'overdue' }],
    })).toBeNull()

    expect(todoDraftFromToolResult('plan_today', {
      today: '2026-10-24',
      suggestions: [{ id: '01m5q89938cz5r4rxa6g99jsyw', title: 'Pay rent', reason: 'because' }],
    })).toBeNull()
  })
})

describe('a steps draft', () => {
  it('reads the task and the steps it proposed', () => {
    const draft = todoDraftFromToolResult('decompose_task', {
      draft: true,
      task: { id: '01m5q89938cz5r4rxa6g99jsyw', title: 'Plan the offsite' },
      steps: ['Book the room', 'Send invites'],
    })

    expect(draft).toEqual({
      kind: 'steps',
      taskId: '01m5q89938cz5r4rxa6g99jsyw',
      taskTitle: 'Plan the offsite',
      steps: ['Book the room', 'Send invites'],
    })
  })

  it('has nothing to offer without a task or without steps', () => {
    expect(todoDraftFromToolResult('decompose_task', { steps: ['Book the room'] })).toBeNull()
    expect(todoDraftFromToolResult('decompose_task', { task: { id: '01m5q89938cz5r4rxa6g99jsyw' } })).toBeNull()
  })
})

describe('every other tool result', () => {
  it('carries no draft', () => {
    expect(todoDraftFromToolResult('list_todos', { tasks: [] })).toBeNull()
    expect(todoDraftFromToolResult('create_todo', { task: { id: 'x' } })).toBeNull()
    expect(todoDraftFromToolResult('complete_todo', null)).toBeNull()
  })
})
