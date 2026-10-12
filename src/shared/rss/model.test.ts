import { describe, expect, it } from 'vitest'
import { RSS_LIMITS, newGroup, parseRssLibrary } from './model'

function library(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { feeds: [], groups: [], ...over }
}

describe('parsing a library with folders and tags', () => {
  it('keeps two folders of the same name when they hang under different parents', () => {
    const { data, dropped } = parseRssLibrary(library({
      groups: [
        { id: 'g1', name: 'Tech', parentId: null },
        { id: 'g2', name: 'Articles', parentId: 'g1' },
        { id: 'g3', name: 'Articles', parentId: null },
      ],
    }))
    expect(dropped).toBe(0)
    expect(data?.groups.map(group => group.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('drops only the second of two folders that share a parent and a folded name', () => {
    const { data, dropped } = parseRssLibrary(library({
      groups: [
        { id: 'g1', name: 'Tech', parentId: null },
        { id: 'g2', name: ' tech ', parentId: null },
      ],
    }))
    expect(dropped).toBe(1)
    expect(data?.groups.map(group => group.id)).toEqual(['g1'])
  })

  it('reads the version 1 `order` field as a position', () => {
    const { data } = parseRssLibrary(library({ groups: [{ id: 'g1', name: 'Tech', order: 4 }] }))
    expect(data?.groups[0].position).toBe(4)
    expect(data?.groups[0].parentId).toBeNull()
  })

  it('cuts a ring of folders that are each other parents, and says the library was repaired', () => {
    const { data, truncated } = parseRssLibrary(library({
      groups: [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' },
      ],
    }))
    expect(truncated).toBe(true)
    expect(data?.groups.every(group => group.parentId === null || !data!.groups.some(other => other.id === group.parentId && other.parentId === group.id))).toBe(true)
  })

  it('promotes a folder that nests past the ceiling instead of dropping it', () => {
    const deep = Array.from({ length: RSS_LIMITS.groupDepthMax + 3 }, (_, index) => ({
      id: `g${index}`,
      name: `Level ${index}`,
      parentId: index === 0 ? null : `g${index - 1}`,
    }))
    const { data } = parseRssLibrary(library({ groups: deep }))
    expect(data?.groups).toHaveLength(deep.length)
    const byId = new Map(data!.groups.map(group => [group.id, group]))
    for (const group of data!.groups) {
      let depth = 1
      let cursor: string | null = group.parentId
      const seen = new Set<string>()
      while (cursor && byId.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor)
        cursor = byId.get(cursor)!.parentId
        depth++
      }
      expect(depth).toBeLessThanOrEqual(RSS_LIMITS.groupDepthMax)
    }
  })

  it('folds feed tags, keeps the hierarchy, and refuses names that are not names', () => {
    const { data } = parseRssLibrary(library({
      feeds: [{
        url: 'https://a.example.com/feed',
        tags: ['tech/rss', ' Tech/RSS ', 'has space', '', '#lead', 'trail/', 'a,b'],
      }],
    }))
    // A leading # and a trailing / are how a tag is typed, not what it is called; the folded
    // duplicate is dropped, and a name with a space or a comma in it never was a name.
    expect(data?.feeds[0].tags).toEqual(['lead', 'tech/rss', 'trail'])
  })

  it('carries hiddenIds and defaults them for an old library', () => {
    expect(parseRssLibrary(library()).data?.hiddenIds).toEqual([])
    const { data } = parseRssLibrary(library({ hiddenIds: ['e1', 'e1', 'e2'] }))
    expect(data?.hiddenIds).toEqual(['e1', 'e2'])
  })

  it('still refuses a payload that is not a library at all', () => {
    expect(parseRssLibrary({}).data).toBeNull()
    expect(parseRssLibrary(null).data).toBeNull()
  })

  it('gives a nested folder an id its parent cannot collide with', () => {
    const top = newGroup('x', 'Top', 0)
    const child = newGroup('y', 'Top', 1, 'x')
    expect(top.id).not.toBe(child.id)
    expect(child.parentId).toBe('x')
  })
})
