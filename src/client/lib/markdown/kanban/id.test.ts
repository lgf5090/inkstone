import { describe, expect, it } from 'vitest'
import { createKanbanId } from './id'

describe('createKanbanId', () => {
  it('never repeats an id across a burst generated in the same millisecond', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 2000; i++) ids.add(createKanbanId())
    expect(ids.size).toBe(2000)
  })

  it('keeps existing caller prefixes such as sub_ or item- intact', () => {
    expect(`sub_${createKanbanId()}`).toMatch(/^sub_[a-z0-9-]+$/)
    expect(`item-${createKanbanId()}`).toMatch(/^item-[a-z0-9-]+$/)
  })
})
