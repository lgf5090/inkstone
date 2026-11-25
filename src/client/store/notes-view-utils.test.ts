import { describe, expect, it } from 'vitest'
import { LIMITS } from '@shared/constants'
import type { Folder, NoteSummary, Tag } from '@shared/types'
import {
  adjustTagCountsForNoteEdit,
  buildFolderTree,
  dayWindow,
  equalStringArrays,
  inDayWindow,
  tagNameKey,
} from './notes-view-utils'

function summary(id: string, updatedAt: number): NoteSummary {
  return {
    id, title: id, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
    isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: updatedAt, updatedAt, deletedAt: null,
  }
}

function folder(id: string, overrides: Partial<Folder> = {}): Folder {
  return {
    id, parentId: null, name: id, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

function tag(id: string, name: string, count: number): Tag {
  return { id, name, color: null, count, createdAt: 1 }
}

describe('notes view helpers', () => {
  it('normalizes tag identity and compares arrays by ordered value', () => {
    expect(tagNameKey('Ｉｎｋｓｔｏｎｅ')).toBe('inkstone')
    expect(tagNameKey('Inkstone')).toBe(tagNameKey('inkstone'))
    expect(equalStringArrays(['one', 'two'], ['one', 'two'])).toBe(true)
    expect(equalStringArrays(['one', 'two'], ['two', 'one'])).toBe(false)
    expect(equalStringArrays(['one'], ['one', 'two'])).toBe(false)
  })

  it('moves tag counts across normalized names, clamps at zero, and retains unchanged rows', () => {
    const inkstone = tag('inkstone', 'Inkstone', 1)
    const demo = tag('demo', 'Demo', 1)
    const untouched = tag('untouched', 'Other', 4)
    const zero = tag('zero', 'Gone', 0)
    const current = [inkstone, demo, untouched, zero]

    const next = adjustTagCountsForNoteEdit(current, ['Inkstone', 'Gone'], ['ＤＥＭＯ'])
    expect(next.map((item) => item.count)).toEqual([0, 2, 4, 0])
    expect(next[2]).toBe(untouched)
    expect(inkstone.count).toBe(1)
    expect(adjustTagCountsForNoteEdit(current, ['inkstone'], ['Inkstone'])).toBe(current)
  })

  it('builds an inclusive-start, exclusive-end local day window', () => {
    expect(dayWindow(null)).toBeNull()
    const days = dayWindow({ start: '2026-10-05', end: '2026-10-05' })!
    const from = new Date(2026, 9, 5).getTime()
    const to = new Date(2026, 9, 6).getTime()

    expect(days).toEqual({ from, to })
    expect(inDayWindow(summary('before', from - 1), days)).toBe(false)
    expect(inDayWindow(summary('start', from), days)).toBe(true)
    expect(inDayWindow(summary('last', to - 1), days)).toBe(true)
    expect(inDayWindow(summary('end', to), days)).toBe(false)
    expect(inDayWindow(summary('unfiltered', 0), null)).toBe(true)
  })

  it('builds a sorted folder tree with descendant counts and orphan roots', () => {
    const rootB = folder('root-b', { position: 2000 })
    const rootA = folder('root-a', { position: 1000 })
    const childB = folder('child-b', { parentId: rootA.id, position: 2000 })
    const childA = folder('child-a', { parentId: rootA.id, position: 1000 })
    const orphan = folder('orphan', { parentId: 'missing', position: 500 })
    const current = [rootB, childB, rootA, orphan, childA]
    const direct = new Map([[rootA.id, 2], [childA.id, 3], [childB.id, 4], [rootB.id, 5], [orphan.id, 6]])

    const tree = buildFolderTree(current, direct)

    expect(tree.map((node) => node.id)).toEqual(['orphan', 'root-a', 'root-b'])
    expect(tree[0]).toMatchObject({ parentId: null, depth: 0, directNotes: 6, totalNotes: 6 })
    expect(tree[1]).toMatchObject({ depth: 0, directNotes: 2, totalNotes: 9 })
    expect(tree[1]!.children.map((node) => node.id)).toEqual(['child-a', 'child-b'])
    expect(tree[1]!.children[0]).toMatchObject({ parentId: 'root-a', depth: 1, directNotes: 3, totalNotes: 3 })
    expect(tree[2]).toMatchObject({ directNotes: 5, totalNotes: 5, children: [] })
    expect(current.map((item) => item.id)).toEqual(['root-b', 'child-b', 'root-a', 'orphan', 'child-a'])
  })

  it('terminates cycles and recovers folders beyond the depth limit as additional roots', () => {
    const self = folder('self', { parentId: 'self' })
    expect(buildFolderTree([self], new Map())).toMatchObject([
      { id: 'self', parentId: null, depth: 0, children: [] },
    ])

    const chain = Array.from({ length: LIMITS.folderDepthMax + 2 }, (_, index) => folder(`f${index}`, {
      parentId: index === 0 ? null : `f${index - 1}`,
      position: index * 1000,
    }))
    const tree = buildFolderTree(chain, new Map())
    const flattened: Array<{ id: string; depth: number }> = []
    const visit = (nodes: ReturnType<typeof buildFolderTree>) => {
      for (const node of nodes) {
        flattened.push({ id: node.id, depth: node.depth })
        visit(node.children)
      }
    }
    visit(tree)

    expect(flattened).toHaveLength(chain.length)
    expect(flattened.every((node) => node.depth < LIMITS.folderDepthMax)).toBe(true)
    expect(tree.map((node) => node.id)).toEqual(['f0', `f${LIMITS.folderDepthMax}`])
  })
})
