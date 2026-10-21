// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ancestorTagPaths,
  buildMemoTagTree,
  flatMemoTagRows,
  loadMemoTagBrowserPrefs,
  MEMO_TAG_BROWSER_STORAGE_KEY,
  saveMemoTagBrowserPrefs,
} from './tag-browser'

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the memo tag tree', () => {
  it('builds hierarchy, rolls counts up and sorts by weight', () => {
    const tree = buildMemoTagTree({
      work: 2,
      'work/meeting': 1,
      personal: 1,
    })
    expect(tree.map((node) => node.fullPath)).toEqual(['work', 'personal'])
    const work = tree[0]!
    expect(work.isVirtual).toBe(false)
    expect(work.count).toBe(2)
    expect(work.totalCount).toBe(3)
    expect(work.children.map((node) => node.fullPath)).toEqual(['work/meeting'])
    expect(tree[1]!.totalCount).toBe(1)
  })

  it('keeps a parent that only leads to a counted child', () => {
    const tree = buildMemoTagTree({ 'project/alpha': 2 })
    expect(tree).toHaveLength(1)
    const project = tree[0]!
    expect(project.fullPath).toBe('project')
    expect(project.isVirtual).toBe(true)
    expect(project.count).toBe(0)
    expect(project.totalCount).toBe(2)
    expect(project.children[0]?.fullPath).toBe('project/alpha')
  })

  it('ignores empty names and non-positive counts', () => {
    const tree = buildMemoTagTree({ '': 3, blank: 0, '  ': 1, kept: 1 })
    expect(tree.map((node) => node.fullPath)).toEqual(['kept'])
  })

  it('lists only real tags in a flat list, sorted by path', () => {
    const rows = flatMemoTagRows(buildMemoTagTree({
      work: 2,
      'work/meeting': 1,
      personal: 1,
    }))
    expect(rows.map((node) => node.fullPath)).toEqual(['personal', 'work', 'work/meeting'])
    expect(rows.map((node) => node.count)).toEqual([1, 2, 1])
  })

  it('lists the ancestor paths of a tag', () => {
    expect(ancestorTagPaths('work/meeting')).toEqual(['work'])
    expect(ancestorTagPaths('a/b/c')).toEqual(['a', 'a/b'])
    expect(ancestorTagPaths('plain')).toEqual([])
  })
})

describe('the stored tag browser preferences', () => {
  it('defaults to a tree with nothing expanded', () => {
    expect(loadMemoTagBrowserPrefs()).toEqual({ mode: 'tree', expanded: [] })
  })

  it('round-trips the mode and expanded paths', () => {
    saveMemoTagBrowserPrefs({ mode: 'flat', expanded: ['work', 'a/b'] })
    expect(loadMemoTagBrowserPrefs()).toEqual({ mode: 'flat', expanded: ['work', 'a/b'] })
  })

  it('drops malformed entries instead of failing', () => {
    localStorage.setItem(MEMO_TAG_BROWSER_STORAGE_KEY, JSON.stringify({
      mode: 'grid',
      expanded: ['work', 3, '', 'a/b'],
    }))
    expect(loadMemoTagBrowserPrefs()).toEqual({ mode: 'tree', expanded: ['work', 'a/b'] })
  })

  it('falls back to the defaults for unreadable storage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    localStorage.setItem(MEMO_TAG_BROWSER_STORAGE_KEY, '{not json')
    expect(loadMemoTagBrowserPrefs()).toEqual({ mode: 'tree', expanded: [] })
    expect(warn).toHaveBeenCalled()
  })
})
