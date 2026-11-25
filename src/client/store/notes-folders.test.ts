import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder } from '@shared/types'
import {
  applyOptimisticFolderPatch,
  availableLocalFolderName,
  compareFolders,
  insertionPositionForFolders,
  positionsForPromotedFolders,
  removeFolderAndPromoteChildren,
  replaceFolder,
} from './notes-folders'

function folder(id: string, overrides: Partial<Folder> = {}): Folder {
  return {
    id,
    parentId: null,
    name: id,
    icon: null,
    color: null,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('notes folder helpers', () => {
  it('replaces a folder in place or appends a missing one without mutating the input', () => {
    const first = folder('first')
    const second = folder('second')
    const saved = folder('first', { name: 'Saved' })
    const current = [first, second]

    const replaced = replaceFolder(current, saved)
    expect(replaced).toEqual([saved, second])
    expect(replaced[1]).toBe(second)
    expect(current).toEqual([first, second])

    const added = folder('third')
    expect(replaceFolder(current, added)).toEqual([first, second, added])
  })

  it('applies metadata and placement in one optimistic patch while retaining untouched rows', () => {
    vi.spyOn(Date, 'now').mockReturnValue(50)
    const moving = folder('moving', { parentId: 'old', position: 1500, updatedAt: 10 })
    const before = folder('before', { parentId: 'new', position: 1000 })
    const after = folder('after', { parentId: 'new', position: 5000 })
    const current = [moving, before, after]

    const next = applyOptimisticFolderPatch(current, 'moving', {
      name: 'Renamed', icon: 'star', color: '#123456', parentId: 'new', beforeId: 'after',
    })

    expect(next[0]).toMatchObject({
      id: 'moving', name: 'Renamed', icon: 'star', color: '#123456', parentId: 'new', position: 3000, updatedAt: 50,
    })
    expect(next[1]).toBe(before)
    expect(next[2]).toBe(after)
    expect(moving.parentId).toBe('old')
    expect(applyOptimisticFolderPatch(current, 'missing', { name: 'Nope' })).toBe(current)
  })

  it('keeps a metadata-only folder patch at its current position', () => {
    vi.spyOn(Date, 'now').mockReturnValue(50)
    const current = folder('current', { position: 2500, updatedAt: 10 })
    const next = applyOptimisticFolderPatch([current], current.id, { name: 'Renamed' })
    expect(next[0]).toMatchObject({ name: 'Renamed', position: 2500, updatedAt: 50 })
  })

  it('finds insertion positions among sorted siblings and ignores other parents', () => {
    const moving = folder('moving', { parentId: 'parent', position: 1500 })
    const first = folder('first', { parentId: 'parent', position: 1000 })
    const last = folder('last', { parentId: 'parent', position: 5000 })
    const elsewhere = folder('elsewhere', { parentId: 'other', position: 2500 })
    const current = [last, elsewhere, moving, first]

    expect(insertionPositionForFolders(current, moving.id, 'parent', 'last')).toBe(3000)
    expect(insertionPositionForFolders(current, moving.id, 'parent', 'first')).toBe(0)
    expect(insertionPositionForFolders(current, moving.id, 'parent', null)).toBe(6000)
    expect(insertionPositionForFolders(current, moving.id, 'parent', 'missing')).toBe(6000)
    expect(insertionPositionForFolders(current, moving.id, 'empty', null)).toBe(1000)
    expect(current.map((item) => item.id)).toEqual(['last', 'elsewhere', 'moving', 'first'])
  })

  it('distributes promoted folders in the available gap and normalizes when no gap remains', () => {
    expect(positionsForPromotedFolders(undefined, undefined, 0)).toEqual([])
    expect(positionsForPromotedFolders(undefined, undefined, 2)).toEqual([1000, 2000])
    expect(positionsForPromotedFolders(undefined, 5000, 2)).toEqual([3000, 4000])
    expect(positionsForPromotedFolders(1000, undefined, 2)).toEqual([2000, 3000])
    expect(positionsForPromotedFolders(1000, 5000, 2)).toEqual([1000 + 4000 / 3, 1000 + 8000 / 3])
    expect(positionsForPromotedFolders(1000, 1000, 2)).toBeNull()
  })

  it('promotes children into a removable folder gap in sibling order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const before = folder('before', { position: 1000 })
    const removed = folder('removed', { position: 2000 })
    const after = folder('after', { position: 4000 })
    const childB = folder('child-b', { parentId: removed.id, position: 2000, createdAt: 2 })
    const childA = folder('child-a', { parentId: removed.id, position: 1000, createdAt: 1 })
    const elsewhere = folder('elsewhere', { parentId: 'other', position: 10 })
    const current = [before, removed, after, childB, childA, elsewhere]

    const next = removeFolderAndPromoteChildren(current, removed.id)
    expect(next.find((item) => item.id === removed.id)).toBeUndefined()
    expect(next.find((item) => item.id === 'child-a')).toMatchObject({ parentId: null, position: 2000, updatedAt: 100 })
    expect(next.find((item) => item.id === 'child-b')).toMatchObject({ parentId: null, position: 3000, updatedAt: 100 })
    expect(next.find((item) => item.id === before.id)).toBe(before)
    expect(next.find((item) => item.id === after.id)).toBe(after)
    expect(next.find((item) => item.id === elsewhere.id)).toBe(elsewhere)
    expect(childA.parentId).toBe(removed.id)
    expect(removeFolderAndPromoteChildren(current, 'missing')).toBe(current)
  })

  it('renumbers the sibling set when promoted children cannot fit between equal positions', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const before = folder('before', { position: 0, createdAt: 1 })
    const removed = folder('removed', { position: 0, createdAt: 2 })
    const after = folder('after', { position: 0, createdAt: 3 })
    const childB = folder('child-b', { parentId: removed.id, position: 0, createdAt: 5 })
    const childA = folder('child-a', { parentId: removed.id, position: 0, createdAt: 4 })

    const next = removeFolderAndPromoteChildren([before, removed, after, childB, childA], removed.id)
    expect(next.map((item) => [item.id, item.position])).toEqual([
      ['before', 1000], ['after', 4000], ['child-b', 3000], ['child-a', 2000],
    ])
    expect(next.find((item) => item.id === 'child-a')).toMatchObject({ parentId: null, updatedAt: 100 })
    expect(next.find((item) => item.id === 'after')).toMatchObject({ updatedAt: 1 })
  })

  it('compares folders by position, creation time, then id', () => {
    const first = folder('first', { position: 1, createdAt: 1 })
    expect(compareFolders(first, folder('second', { position: 2 }))).toBeLessThan(0)
    expect(compareFolders(first, folder('second', { position: 1, createdAt: 2 }))).toBeLessThan(0)
    expect(compareFolders(first, folder('second', { position: 1, createdAt: 1 }))).toBeLessThan(0)
  })

  it('chooses a case-insensitive local name without colliding across parents', () => {
    const current = [
      folder('one', { name: 'Project' }),
      folder('two', { name: 'project 2' }),
      folder('other', { name: 'Project 3', parentId: 'other' }),
    ]
    expect(availableLocalFolderName(current, null, 'Project')).toBe('Project 3')
    expect(availableLocalFolderName(current, null, 'Unique')).toBe('Unique')
    expect(availableLocalFolderName(current, 'other', 'Project')).toBe('Project')
  })
})
