// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  canMove,
  childrenOf,
  collectionMatches,
  duplicateSubtree,
  filterByTag,
  reordered,
  subtreeIds,
  tagCounts,
} from '../src/client/features/development/api-tester/lib/tree'
import type { CollectionNode, TagNode } from '../src/shared/development/api-tester/types'

function node(id: string, parentId: string | null, type: 'folder' | 'request' = 'request', extra: Partial<CollectionNode> = {}): CollectionNode {
  return { id, parentId, type, name: id, order: 0, tags: [], updatedAt: 0, ...extra }
}

const NODES = [node('folder', null, 'folder'), node('a', 'folder'), node('b', 'folder'), node('c', null)]

describe('API Tester collection tree', () => {
  it('finds children, subtrees and blocks moves into descendants', () => {
    expect(childrenOf(NODES, 'folder').map((entry) => entry.id)).toEqual(['a', 'b'])
    expect([...subtreeIds(NODES, 'folder')].sort()).toEqual(['a', 'b', 'folder'])
    expect(canMove(NODES, 'folder', 'a')).toBe(false)
    expect(canMove(NODES, 'a', 'folder')).toBe(true)
    expect(canMove(NODES, 'a', null)).toBe(true)
  })

  it('duplicates a subtree with fresh ids and a root suffix', () => {
    const copies = duplicateSubtree(NODES, 'folder', 'copy')
    expect(copies.map((entry) => entry.name)).toEqual(['folder copy', 'a', 'b'])
    const ids = new Set(copies.map((entry) => entry.id))
    expect(ids.size).toBe(3)
    expect(copies[1]?.parentId).toBe(copies[0]?.id)
    expect(copies[2]?.parentId).toBe(copies[0]?.id)
  })

  it('reorders only the named siblings', () => {
    const next = reordered(NODES, 'folder', ['b', 'a'])
    expect(next.find((entry) => entry.id === 'b')?.order).toBe(1)
    expect(next.find((entry) => entry.id === 'a')?.order).toBe(2)
    expect(next.find((entry) => entry.id === 'c')?.order).toBe(0)
  })

  it('keeps ancestors in search and tag filters', () => {
    expect([...collectionMatches(NODES, 'A')].sort()).toEqual(['a', 'folder'])
    const tagged = [
      node('folder', null, 'folder'),
      node('a', 'folder', 'request', { tags: ['t'] }),
      node('b', 'folder'),
    ]
    const filtered = filterByTag(tagged, 't')
    expect(filtered.visibleNodes.map((entry) => entry.id).sort()).toEqual(['a', 'folder'])
    expect([...filtered.autoExpandIds]).toEqual(['folder'])
  })

  it('counts descendant tags', () => {
    const tags: TagNode[] = [
      { id: 'root', name: 'Root', parentId: null, color: 'blue', sortOrder: 0, createdAt: 0 },
      { id: 'child', name: 'Child', parentId: 'root', color: 'blue', sortOrder: 0, createdAt: 0 },
    ]
    const nodes = [node('a', null, 'request', { tags: ['child'] }), node('b', null, 'request', { tags: ['root'] })]
    const counts = tagCounts(tags, nodes)
    expect(counts.get('child')).toBe(1)
    expect(counts.get('root')).toBe(2)
  })
})
