import { describe, expect, it } from 'vitest'
import type { Tag } from '@shared/types'
import { buildTagTree, collectParentPaths, flattenTagTree, searchTagTree, siblingParentPaths } from './tag-tree'
import { compileQuery } from './query-match'

function tag(name: string, count: number, isPinned = false): Tag {
  return { id: `id-${name}`, name, color: null, isPinned, count, createdAt: 1 }
}

describe('buildTagTree', () => {
  it('synthesizes the ancestors a nested name implies', () => {
    const tree = buildTagTree([tag('Inkstone/\u5165\u95e8/\u6307\u5357', 2)])
    expect(tree).toHaveLength(1)
    const root = tree[0]!
    expect([root.fullPath, root.name, root.depth, root.isVirtual]).toEqual(['Inkstone', 'Inkstone', 0, true])
    expect(root.children[0]!.fullPath).toBe('Inkstone/\u5165\u95e8')
    const leaf = root.children[0]!.children[0]!
    expect([leaf.fullPath, leaf.name, leaf.depth, leaf.isVirtual, leaf.count]).toEqual(
      ['Inkstone/\u5165\u95e8/\u6307\u5357', '\u6307\u5357', 2, false, 2])
  })

  it('rolls a parents count up from itself and every descendant', () => {
    const tree = buildTagTree([tag('work', 2), tag('work/meeting', 3), tag('work/deep/er', 5)])
    const root = tree.find((node) => node.fullPath === 'work')!
    expect([root.count, root.totalCount, root.isVirtual]).toEqual([2, 10, false])
  })

  it('reuses the real tag row when a parent also exists on its own', () => {
    const tree = buildTagTree([tag('demo', 4), tag('demo/child', 1)])
    const root = tree.find((node) => node.fullPath === 'demo')!
    expect([root.isVirtual, root.tag.id, root.tag.color]).toEqual([false, 'id-demo', null])
  })

  it('drops empty segments so a trailing slash cannot invent a level', () => {
    const tree = buildTagTree([tag('a//b/', 1)])
    expect(tree[0]!.children[0]!.fullPath).toBe('a/b')
  })

  it('orders siblings by rolled-up count then name', () => {
    const tree = buildTagTree([tag('aa', 1), tag('bb', 5), tag('cc', 5)])
    expect(tree.map((node) => node.name)).toEqual(['bb', 'cc', 'aa'])
  })

  it('floats a pinned tag above a busier one', () => {
    const tree = buildTagTree([tag('aa', 1), tag('bb', 99, true), tag('cc', 5)])
    expect(tree.map((node) => node.name)).toEqual(['bb', 'cc', 'aa'])
  })

  it('lifts an invented parent so a pinned descendant stays reachable', () => {
    const tree = buildTagTree([tag('solo', 50), tag('deep/child/pinned', 1, true)])
    expect(tree.map((node) => node.fullPath)).toEqual(['deep', 'solo'])
    expect(tree[0]!.isPinned).toBe(true)
    expect(tree[0]!.tag.id).toBe('virtual:deep')
  })
})

describe('flattenTagTree', () => {
  const tree = buildTagTree([tag('a', 1), tag('a/b', 2), tag('a/b/c', 3)])

  it('hides descendants until their own ancestor is expanded', () => {
    expect(flattenTagTree(tree, new Set()).map((node) => node.fullPath)).toEqual(['a'])
    expect(flattenTagTree(tree, new Set(['a'])).map((node) => node.fullPath)).toEqual(['a', 'a/b'])
    expect(flattenTagTree(tree, new Set(['a', 'a/b'])).map((node) => node.fullPath)).toEqual(
      ['a', 'a/b', 'a/b/c'])
  })

  it('reports only paths that actually have children', () => {
    expect(collectParentPaths(tree)).toEqual(['a', 'a/b'])
  })
})

describe('siblingParentPaths', () => {
  // The level a row belongs to is its parent's children, so "toggle this level" has to
  // return only the branches at that level that can actually be expanded.
  const tree = buildTagTree([
    { id: 'a', name: 'a/one', color: null, count: 1, createdAt: 1 },
    { id: 'b', name: 'a/two/x', color: null, count: 1, createdAt: 1 },
    { id: 'c', name: 'a/three', color: null, count: 1, createdAt: 1 },
    { id: 'd', name: 'z/one', color: null, count: 1, createdAt: 1 },
  ])
  const sorted = (paths: readonly string[]) => [...paths].sort()

  it('returns the expandable branches sharing the row parent', () => {
    expect(sorted(siblingParentPaths(tree, 'a/one'))).toEqual(['a/two'])
    expect(sorted(siblingParentPaths(tree, 'a/three'))).toEqual(['a/two'])
    expect(siblingParentPaths(tree, 'a/two')).toEqual([])
  })

  it('excludes the row itself from its own level', () => {
    const wider = buildTagTree([
      { id: 'p', name: 'p/q', color: null, count: 1, createdAt: 1 },
      { id: 'r', name: 'p/r/s', color: null, count: 1, createdAt: 1 },
    ])
    expect(siblingParentPaths(wider, 'p/q')).toEqual(['p/r'])
    expect(siblingParentPaths(wider, 'p/r/s')).toEqual([])
  })

  it('treats the roots as one level and an unknown parent as having none', () => {
    expect(siblingParentPaths(tree, 'a')).toEqual(['z'])
    expect(siblingParentPaths(tree, 'z')).toEqual(['a'])
    expect(siblingParentPaths(tree, 'nowhere/deep')).toEqual([])
  })
})

describe('searchTagTree', () => {
  const tree = buildTagTree([
    tag('Inkstone/\u5165\u95e8', 1),
    tag('Inkstone/\u5165\u95e8/\u6307\u5357', 2),
    tag('apikeys', 3),
  ])

  it('keeps the ancestor chain of a match so the child stays navigable', () => {
    const result = searchTagTree(tree, compileQuery('\u6307\u5357'))
    expect(result.nodes.map((node) => node.fullPath)).toEqual(['Inkstone'])
    expect(result.nodes[0]!.children[0]!.fullPath).toBe('Inkstone/\u5165\u95e8')
    expect(result.nodes[0]!.children[0]!.children[0]!.fullPath).toBe('Inkstone/\u5165\u95e8/\u6307\u5357')
    expect([...result.matchedPaths]).toEqual(['Inkstone/\u5165\u95e8/\u6307\u5357'])
    expect(result.hitCount).toBe(2)
  })

  it('keeps the whole subtree under a parent that matches', () => {
    const result = searchTagTree(tree, compileQuery('Inkstone'))
    expect(result.nodes[0]!.children[0]!.children).toHaveLength(1)
    expect(result.hitCount).toBe(2)
    expect([...result.matchedPaths]).toEqual(['Inkstone'])
  })

  it('tolerates a fuzzy query and drops unrelated branches', () => {
    const result = searchTagTree(tree, compileQuery('apky'))
    expect(result.nodes.map((node) => node.fullPath)).toEqual(['apikeys'])
    expect(result.hitCount).toBe(1)
  })

  it('counts the tags it shows rather than the invented ancestors above them', () => {
    const deep = buildTagTree([tag('a/b/target', 1), tag('a/b/other', 2)])
    const result = searchTagTree(deep, compileQuery('target'))
    expect(result.hitCount).toBe(1)
    expect(flattenTagTree(result.nodes, new Set(collectParentPaths(result.nodes)))).toHaveLength(3)
  })

  it('searches tag paths by expression when the query is written as one', () => {
    const result = searchTagTree(tree, compileQuery('/^api/'))
    expect(result.nodes.map((node) => node.fullPath)).toEqual(['apikeys'])
    const anchored = searchTagTree(tree, compileQuery('/keys$/'))
    expect([...anchored.matchedPaths]).toEqual(['apikeys'])
  })

  it('shows the reader why a refused expression matched nothing', () => {
    const refused = compileQuery('/(a+)+b/')
    expect(refused.error).toBe('unsafe')
    expect(searchTagTree(tree, refused).nodes).toEqual([])
  })

  it('returns the untouched tree for a blank query', () => {
    const result = searchTagTree(tree, compileQuery('   '))
    expect(result.nodes).toHaveLength(tree.length)
    expect(result.hitCount).toBe(0)
    expect(result.matchedPaths.size).toBe(0)
  })
})
