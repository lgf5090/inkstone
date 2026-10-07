import { describe, expect, it } from 'vitest'
import type { NoteTemplate, NoteTemplateCategory } from '@shared/types'
import { cardClickAction, dropTarget, reorderTarget } from './gallery-actions'

function template(id: string, categoryId: string | null, position: number): NoteTemplate {
  return {
    id,
    categoryId,
    name: id,
    description: '',
    content: 'body',
    builtin: false,
    isPinned: false,
    isStarred: false,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    position,
  }
}

function category(id: string, position: number): NoteTemplateCategory {
  return { id, name: id, builtin: false, position, createdAt: 1 }
}

const CATEGORIES = [category('work', 0), category('life', 1)]
const LIBRARY = [
  template('a', 'work', 0),
  template('b', 'work', 1),
  template('c', 'work', 2),
  template('d', 'life', 0),
  template('e', null, 0),
]

describe('keyboard reorder target', () => {
  it('steps one slot up inside the same category', () => {
    expect(reorderTarget(LIBRARY, CATEGORIES, 'b', 'up')).toEqual({ id: 'b', categoryId: 'work', index: 0 })
  })

  it('steps one slot down inside the same category', () => {
    expect(reorderTarget(LIBRARY, CATEGORIES, 'b', 'down')).toEqual({ id: 'b', categoryId: 'work', index: 2 })
  })

  it('refuses to walk past either end of the category', () => {
    expect(reorderTarget(LIBRARY, CATEGORIES, 'a', 'up')).toBe(null)
    expect(reorderTarget(LIBRARY, CATEGORIES, 'c', 'down')).toBe(null)
  })

  it('moves into the next category and the previous one', () => {
    expect(reorderTarget(LIBRARY, CATEGORIES, 'c', 'right')).toEqual({ id: 'c', categoryId: 'life', index: 0 })
    expect(reorderTarget(LIBRARY, CATEGORIES, 'd', 'left')).toEqual({ id: 'd', categoryId: 'work', index: 0 })
  })

  it('walks out of a category into the uncategorized list and back in', () => {
    expect(reorderTarget(LIBRARY, CATEGORIES, 'a', 'left')).toEqual({ id: 'a', categoryId: null, index: 0 })
    expect(reorderTarget(LIBRARY, CATEGORIES, 'e', 'right')).toEqual({ id: 'e', categoryId: 'work', index: 0 })
    expect(reorderTarget(LIBRARY, CATEGORIES, 'e', 'left')).toBe(null)
  })

  it('refuses at the ends of the category strip', () => {
    expect(reorderTarget(LIBRARY, CATEGORIES, 'd', 'right')).toBe(null)
  })

  it('does nothing without a focused card', () => {
    expect(reorderTarget(LIBRARY, CATEGORIES, null, 'up')).toBe(null)
    expect(reorderTarget(LIBRARY, CATEGORIES, 'missing', 'up')).toBe(null)
  })

  it('follows the displayed order when a card has no position yet', () => {
    const unpositioned = [template('x', 'work', undefined as unknown as number), template('y', 'work', 0)]
    expect(reorderTarget(unpositioned, CATEGORIES, 'y', 'up')).toBe(null)
    expect(reorderTarget(unpositioned, CATEGORIES, 'x', 'up')).toEqual({ id: 'x', categoryId: 'work', index: 0 })
  })
})

describe('drop target', () => {
  const source = template('a', 'work', 0)
  const inWork = template('b', 'work', 1)
  const inLife = template('d', 'life', 0)

  it('follows the visible category when the view shows categories', () => {
    expect(dropTarget([source, inWork, inLife], source, inLife, false, false)).toEqual({ categoryId: 'life', index: 0 })
  })

  it('keeps the source category when the view mixes them', () => {
    expect(dropTarget([source, inWork, inLife], inLife, source, true, true)).toEqual({ categoryId: 'life', index: 0 })
  })

  it('counts the half it was dropped on', () => {
    const siblings = [source, inWork, template('c', 'work', 2)]
    const before = dropTarget(siblings, template('c', 'work', 2), inWork, false, false)
    const after = dropTarget(siblings, template('c', 'work', 2), inWork, true, false)
    expect(before).toEqual({ categoryId: 'work', index: 1 })
    expect(after).toEqual({ categoryId: 'work', index: 2 })
  })
})

describe('card click meaning', () => {
  it('is a tick while a selection is being made, whatever the modifier says', () => {
    expect(cardClickAction(true, true)).toBe('select')
    expect(cardClickAction(true, false)).toBe('select')
  })

  it('is a star with the modifier and a new note without it', () => {
    expect(cardClickAction(false, true)).toBe('star')
    expect(cardClickAction(false, false)).toBe('use')
  })
})
