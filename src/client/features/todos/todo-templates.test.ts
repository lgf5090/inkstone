/**
 * A task's shape, kept and put back.
 *
 * The two halves are pure functions, and what this file pins is the rule between them: a template
 * carries the kind of work and none of the occasion. A date that survived the round trip would file
 * today's task in the past the first time the template was used, which is the one mistake the feature
 * exists to prevent.
 */
import { describe, expect, it } from 'vitest'
import type { TodoTemplate } from '@shared/types'
import { draftToTemplate, templateToDraft } from './todo-templates'

const SOURCE = {
  title: 'Weekly report',
  description: 'Gather the numbers, then write the summary.',
  priority: 'high' as const,
  listId: 'work',
  timeEstimate: 90 * 60_000,
}

function template(over: Partial<TodoTemplate> = {}): TodoTemplate {
  return {
    id: 'weekly-report-abc',
    name: 'Weekly report',
    title: 'Weekly report',
    description: '',
    priority: 'medium',
    listId: null,
    tags: [],
    steps: [],
    timeEstimate: null,
    ...over,
  }
}

describe('keeping a task’s shape', () => {
  it('holds the words, the list, the tags, the steps and the estimate', () => {
    const kept = draftToTemplate(SOURCE, { name: '  Weekly report  ', steps: ['Gather', 'Write'], tags: ['work'] })

    expect(kept).toMatchObject({
      name: 'Weekly report',
      title: 'Weekly report',
      description: SOURCE.description,
      priority: 'high',
      listId: 'work',
      tags: ['work'],
      steps: ['Gather', 'Write'],
      timeEstimate: 90 * 60_000,
    })
    // The id survives being used as a key: lowercase ascii, and the stamp keeps two templates that
    // share a name from replacing each other.
    expect(kept.id).toMatch(/^weekly-report-[a-z0-9]+$/)
  })

  it('names an id for a template whose name an id cannot spell', () => {
    const kept = draftToTemplate(SOURCE, { name: '周报', steps: [], tags: [] })
    expect(kept.id).toMatch(/^template-[a-z0-9]+$/)
  })
})

describe('filling a form from a template', () => {
  it('writes every field the template holds', () => {
    const draft = templateToDraft(template({
      description: 'Numbers first',
      priority: 'urgent',
      listId: 'work',
      tags: ['a', 'b'],
      steps: ['One'],
      timeEstimate: 30 * 60_000,
    }))

    expect(draft).toEqual({
      title: 'Weekly report',
      description: 'Numbers first',
      priority: 'urgent',
      listId: 'work',
      tags: ['a', 'b'],
      steps: ['One'],
      timeEstimate: 30 * 60_000,
    })
  })

  it('carries no date and no reminder, whatever the task it was saved from', () => {
    // The source has a due date, a start date, a plan day and two reminders; the template keeps none
    // of them, and the draft it becomes cannot invent one.
    const kept = draftToTemplate(
      { ...SOURCE, dueAt: 1_700_000_000_000, startAt: 1_699_000_000_000, plannedFor: '2026-10-24' } as never,
      { name: 'Weekly report', steps: [], tags: [] },
    )
    const draft = templateToDraft(kept)

    expect(Object.keys(kept)).not.toContain('dueAt')
    expect(draft).not.toHaveProperty('dueAt')
    expect(draft).not.toHaveProperty('startAt')
    expect(draft).not.toHaveProperty('plannedFor')
    expect(draft).not.toHaveProperty('reminders')
    expect(draft).not.toHaveProperty('remindAt')
  })

  it('hands back fresh lists, so editing a draft cannot edit the template', () => {
    const kept = template({ tags: ['work'], steps: ['Gather'] })
    const draft = templateToDraft(kept)
    draft.tags?.push('extra')
    draft.steps?.push('Another')
    expect(kept.tags).toEqual(['work'])
    expect(kept.steps).toEqual(['Gather'])
  })
})
