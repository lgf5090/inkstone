import { describe, expect, it } from 'vitest'
import type { ProjectCategory } from '@shared/project/model'
import { categoryDropZone, planCategoryDrop } from './sidebar-drag'

const cat = (id: string, name: string, type: ProjectCategory['type'] = 'custom'): ProjectCategory => ({
  id, userId: 'u1', name, type, collapsed: false, sortOrder: 0, createAt: 1, updateAt: 1, deleteAt: 0,
})

const tree = [cat('a', 'Work'), cat('b', 'Work/Backend'), cat('c', 'Personal'), cat('d', 'Archive')]

describe('where the pointer landed', () => {
  it('reads the edges as beside and the middle as inside', () => {
    expect(categoryDropZone(2, 40)).toBe('before')
    expect(categoryDropZone(20, 40)).toBe('inside')
    expect(categoryDropZone(38, 40)).toBe('after')
  })

  it('treats an unmeasured row as inside rather than dividing by zero', () => {
    expect(categoryDropZone(0, 0)).toBe('inside')
  })
})

describe('planning a category drop', () => {
  it('refuses a target that is not a real category instead of splicing at -1', () => {
    expect(planCategoryDrop(tree, 'a', 'group:Work', 'before')).toBeNull()
  })

  it('places before and after the target, keeping every other id', () => {
    expect(planCategoryDrop(tree, 'd', 'b', 'before')).toEqual({ kind: 'reorder', ids: ['a', 'd', 'b', 'c'] })
    expect(planCategoryDrop(tree, 'd', 'b', 'after')).toEqual({ kind: 'reorder', ids: ['a', 'b', 'd', 'c'] })
  })

  it('nests by renaming the dragged category and everything under it', () => {
    const plan = planCategoryDrop(tree, 'a', 'c', 'inside')
    expect(plan).toEqual({ kind: 'nest', renames: [{ id: 'a', name: 'Personal/Work' }, { id: 'b', name: 'Personal/Work/Backend' }] })
  })

  it('refuses nesting a category under itself or its own descendant', () => {
    expect(planCategoryDrop(tree, 'a', 'a', 'inside')).toBeNull()
    expect(planCategoryDrop(tree, 'a', 'b', 'inside')).toBeNull()
  })

  it('leaves system categories alone in both directions', () => {
    const withSystem = [...tree, cat('s', 'Inbox', 'system')]
    expect(planCategoryDrop(withSystem, 's', 'a', 'before')).toBeNull()
    expect(planCategoryDrop(withSystem, 'a', 's', 'inside')).toBeNull()
  })

  it('does not rewrite a descendant twice when nesting a leaf', () => {
    expect(planCategoryDrop(tree, 'c', 'd', 'inside')).toEqual({ kind: 'nest', renames: [{ id: 'c', name: 'Archive/Personal' }] })
  })
})