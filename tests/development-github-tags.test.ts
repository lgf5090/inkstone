import { describe, expect, it } from 'vitest'
import type { GithubTag } from '@shared/development/github/types'
import {
  buildTagTree,
  collectTagDescendants,
  tagCountsWithAncestors,
  tagDepth,
} from '../src/client/features/development/github/lib/tags'

function tag(id: string, parentId: string | null, sortOrder = 0, createdAt = 0): GithubTag {
  return { id, name: id, color: '#64748b', parentId, sortOrder, createdAt, updatedAt: 0 }
}

describe('GitHub tag tree', () => {
  it('builds a sorted multi-level tree from unordered input', () => {
    const tree = buildTagTree([
      tag('c', 'a', 2),
      tag('b', 'a', 1),
      tag('a', null, 2),
      tag('d', null, 1),
    ])
    expect(tree.map((node) => node.id)).toEqual(['d', 'a'])
    expect(tree[1]!.children.map((node) => node.id)).toEqual(['b', 'c'])
  })

  it('promotes orphaned and self-parented tags to roots', () => {
    const tree = buildTagTree([tag('a', 'missing'), tag('b', 'b')])
    expect(tree.map((node) => node.id)).toEqual(['a', 'b'])
    expect(tree.every((node) => node.children.length === 0)).toBe(true)
  })

  it('breaks parent cycles instead of recursing forever', () => {
    const tree = buildTagTree([tag('a', 'b'), tag('b', 'a')])
    expect(tree.map((node) => node.id).sort()).toEqual(['a', 'b'])
    expect(tree.every((node) => node.children.length === 0)).toBe(true)
  })

  it('collects a tag and all of its descendants', () => {
    const tags = [tag('a', null), tag('b', 'a'), tag('c', 'b'), tag('d', null)]
    expect(collectTagDescendants(tags, 'a').sort()).toEqual(['a', 'b', 'c'])
    expect(collectTagDescendants(tags, 'd')).toEqual(['d'])
    expect(collectTagDescendants(tags, 'missing')).toEqual(['missing'])
  })

  it('computes depth with cycle protection', () => {
    const tags = [tag('a', null), tag('b', 'a'), tag('c', 'b'), tag('x', 'y'), tag('y', 'x')]
    expect(tagDepth(tags, tags[0]!)).toBe(0)
    expect(tagDepth(tags, tags[2]!)).toBe(2)
    expect(tagDepth(tags, tags[3]!)).toBeLessThanOrEqual(10)
  })

  it('counts assignments up through the tag ancestors', () => {
    const tags = [tag('a', null), tag('b', 'a'), tag('c', null)]
    const counts = tagCountsWithAncestors(tags, [
      { tagIds: ['b', 'c', 'missing'] },
      { tagIds: ['c'] },
      { tagIds: ['a', 'b'] },
      { tagIds: [] },
    ])
    expect(counts.get('a')).toBe(2)
    expect(counts.get('b')).toBe(2)
    expect(counts.get('c')).toBe(2)
    expect(counts.get('missing')).toBeUndefined()
  })
})
