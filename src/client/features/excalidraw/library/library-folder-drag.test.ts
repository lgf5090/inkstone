import { afterEach, describe, expect, it } from 'vitest'
import {
  LIBRARY_FOLDER_DRAG_TYPE,
  beginFolderDrag,
  currentFolderDrag,
  endFolderDrag,
  folderDropPlacement,
  isFolderDrag,
  orderedSiblings,
  pointerRatio,
  resolveFolderDrop,
} from './library-folder-drag'
import type { ExcalidrawLibraryFolder } from './types'

function folder(id: string, parentId: string | null, order: number, createdAt = 1): ExcalidrawLibraryFolder {
  return { id, name: id.toUpperCase(), parentId, order, createdAt, updatedAt: createdAt }
}

/**
 * a · b( c( d ) ) · e
 *
 * Three roots and a two-level branch under `b`: the only shape where a drop can try to land a folder
 * next to its own grandchild, which has to be refused rather than silently made into a cycle.
 */
function tree(): ExcalidrawLibraryFolder[] {
  return [folder('a', null, 0), folder('b', null, 1), folder('e', null, 2), folder('c', 'b', 0), folder('d', 'c', 0)]
}

function transfer(bag: Map<string, string>): DataTransfer {
  const dataTransfer = {
    getData: (key: string) => bag.get(key) ?? '',
    setData: (key: string, value: string) => {
      bag.set(key, value)
    },
    dropEffect: 'none',
    effectAllowed: 'unset',
  }
  // A live `types` list, the way a browser reports it: the bag is filled by the drag itself.
  Object.defineProperty(dataTransfer, 'types', { get: () => [...bag.keys()], configurable: true })
  return dataTransfer as unknown as DataTransfer
}

afterEach(() => {
  endFolderDrag()
})

describe('the drop placement a pointer asks for', () => {
  it('splits the row into three bands with the middle one generous', () => {
    expect(folderDropPlacement(0)).toBe('before')
    expect(folderDropPlacement(0.27)).toBe('before')
    expect(folderDropPlacement(0.28)).toBe('inside')
    expect(folderDropPlacement(0.5)).toBe('inside')
    expect(folderDropPlacement(0.72)).toBe('inside')
    expect(folderDropPlacement(0.73)).toBe('after')
    expect(folderDropPlacement(1)).toBe('after')
  })

  it('falls back to the hierarchy band when the geometry is not there', () => {
    // jsdom, and any row that has not been laid out yet, hands back a zero-height box. Choosing a
    // placement that still does something sensible (reparent) beats refusing every drag.
    expect(pointerRatio({ clientY: 12 }, { top: 0, height: 0 })).toBe(0.5)
    expect(folderDropPlacement(NaN)).toBe('inside')
  })
})

describe('the folder drag bridge', () => {
  it('publishes its own type and keeps the id readable while the pointer is still moving', () => {
    const bag = new Map<string, string>()
    const dataTransfer = transfer(bag)
    beginFolderDrag('a', dataTransfer)
    expect(bag.get('application/x-inkstone-library-folder')).toBe('a')
    expect(isFolderDrag(dataTransfer)).toBe(true)
    expect(currentFolderDrag()).toBe('a')
    expect(dataTransfer.effectAllowed).toBe('move')
    endFolderDrag()
    expect(currentFolderDrag()).toBeNull()
  })

  it('ignores a folder id that arrives in somebody else’s payload', () => {
    // The drop reads the in-flight id, never the transfer: another document can write our type and
    // name a folder it happens to guess, and that must not be enough to reorder this library.
    const forged = { getData: () => 'folder-general', setData: () => {}, types: [LIBRARY_FOLDER_DRAG_TYPE] } as unknown as DataTransfer
    expect(isFolderDrag(forged)).toBe(true)
    expect(currentFolderDrag()).toBeNull()
  })

  it('ignores a drag that carries neither the folder type nor an id in memory', () => {
    const dataTransfer = transfer(new Map([['application/x-inkstone-note', 'n-1']]))
    expect(isFolderDrag(dataTransfer)).toBe(false)
    expect(currentFolderDrag()).toBeNull()
  })
})

describe('resolving a folder drop into a move', () => {
  const solve = (subjectId: string, targetId: string | null, placement: 'before' | 'inside' | 'after') =>
    resolveFolderDrop({ folders: tree(), subjectId, targetId, placement })

  it('puts the folder in front of the row it was dropped above', () => {
    expect(solve('e', 'a', 'before')).toEqual({ parentId: null, beforeId: 'a', changed: true })
    expect(solve('c', 'a', 'before')).toEqual({ parentId: null, beforeId: 'a', changed: true })
  })

  it('puts the folder behind the row by naming that row’s successor', () => {
    expect(solve('a', 'b', 'after')).toEqual({ parentId: null, beforeId: 'e', changed: true })
    // Nothing follows e, so sliding past the last row means the end of the list.
    expect(solve('b', 'e', 'after')).toEqual({ parentId: null, beforeId: null, changed: true })
  })

  it('appends when the successor is none, which is how a drop below the last row reads', () => {
    expect(solve('a', 'e', 'after')).toEqual({ parentId: null, beforeId: null, changed: true })
  })

  it('reparents on the middle band without disturbing the sibling order of the target', () => {
    expect(solve('a', 'b', 'inside')).toEqual({ parentId: 'b', beforeId: null, changed: true })
    expect(solve('d', 'a', 'inside')).toEqual({ parentId: 'a', beforeId: null, changed: true })
  })

  it('sends a drop on the top level to the end of the root list', () => {
    expect(solve('c', null, 'inside')).toEqual({ parentId: null, beforeId: null, changed: true })
  })

  it('refuses a folder’s own row, so a drop on itself is not a move', () => {
    expect(solve('b', 'b', 'inside')).toBeNull()
    expect(solve('b', 'b', 'before')).toBeNull()
    expect(solve('b', 'b', 'after')).toBeNull()
  })

  it('refuses every row inside the subtree, at any band', () => {
    // b into c: c is b's child, so the parent would be b itself.
    expect(solve('b', 'c', 'inside')).toBeNull()
    // b next to c: the slot is c's parent, which is b.
    expect(solve('b', 'c', 'before')).toBeNull()
    // b next to d: the slot is d's parent c, still inside b.
    expect(solve('b', 'd', 'after')).toBeNull()
    expect(solve('b', 'd', 'inside')).toBeNull()
  })

  it('refuses an id that is not in the tree at all', () => {
    expect(solve('ghost', 'b', 'inside')).toBeNull()
    expect(solve('a', 'ghost', 'inside')).toBeNull()
  })

  it('marks a drop that lands the folder in its own slot as needing no write', () => {
    // a is the first of a, b, e, so "before b" names the slot it already holds.
    expect(solve('a', 'b', 'before')).toEqual({ parentId: null, beforeId: 'b', changed: false })
    // Two roots, b last: sliding b past a asks for the end of the list, which is where b sits.
    const two = [folder('a', null, 0), folder('b', null, 1)]
    expect(resolveFolderDrop({ folders: two, subjectId: 'b', targetId: 'a', placement: 'after' })).toEqual({
      parentId: null,
      beforeId: null,
      changed: false,
    })
    // Already the only root folder, so a drop on the top level changes nothing.
    expect(resolveFolderDrop({ folders: [folder('a', null, 0)], subjectId: 'a', targetId: null, placement: 'inside' })).toEqual({
      parentId: null,
      beforeId: null,
      changed: false,
    })
    // One slot away is not a no-op, and neither is a drop into a different folder.
    expect(solve('e', 'a', 'before')?.changed).toBe(true)
    expect(solve('a', 'b', 'after')?.changed).toBe(true)
    expect(solve('a', 'b', 'inside')?.changed).toBe(true)
  })

  it('orders siblings the way the tree draws them, then by age', () => {
    const folders = [folder('z', null, 2, 5), folder('y', null, 1, 9), folder('x', null, 1, 3), folder('w', 'y', 0)]
    expect(orderedSiblings(folders, null).map((f) => f.id)).toEqual(['x', 'y', 'z'])
    expect(orderedSiblings(folders, 'y').map((f) => f.id)).toEqual(['w'])
    expect(orderedSiblings(folders, 'missing')).toEqual([])
  })
})
