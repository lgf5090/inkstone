import { describe, expect, it } from 'vitest'
import { kanbanStableKeys } from './kanban-list-keys'

describe('kanbanStableKeys', () => {
  it('keeps a rule\'s key when an unrelated neighbour is removed', () => {
    const rules = [
      { propertyId: 'status', operator: 'equals', value: 'todo' },
      { propertyId: 'priority', operator: 'equals', value: 'high' },
      { propertyId: 'tags', operator: 'contains', value: 'ui' },
    ]
    const withThree = kanbanStableKeys(rules, (r) => [r.propertyId, r.operator, r.value])
    const afterRemoval = kanbanStableKeys([rules[0]!, rules[2]!], (r) => [r.propertyId, r.operator, r.value])
    expect(afterRemoval[0]).toBe(withThree[0])
    expect(afterRemoval[1]).toBe(withThree[2])
  })

  it('gives two identical rules distinct keys', () => {
    const rules = [
      { propertyId: 'status', operator: 'equals', value: 'todo' },
      { propertyId: 'status', operator: 'equals', value: 'todo' },
    ]
    const keys = kanbanStableKeys(rules, (r) => [r.propertyId, r.operator, r.value])
    expect(keys[0]).not.toBe(keys[1])
  })

  it('reads a rebuilt identical list to the same keys', () => {
    const parts = (r: { a: string; b?: string }) => [r.a, r.b]
    expect(kanbanStableKeys([{ a: 'x', b: undefined }], parts))
      .toEqual(kanbanStableKeys([{ a: 'x' }], parts))
  })
})
