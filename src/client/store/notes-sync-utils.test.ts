import { describe, expect, it } from 'vitest'
import type { Folder, NoteSummary, SyncResponse, Tag } from '@shared/types'
import { consolidateFullSync, mergeById, reconcileList } from './notes-sync-utils'

function summary(id: string, rev = 1): NoteSummary {
  return {
    id, title: id, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false,
    isArchived: false, wordCount: 0, charCount: 0, rev, position: 0, createdAt: 1, updatedAt: rev, deletedAt: null,
  }
}

function folder(id: string, name = id): Folder {
  return { id, parentId: null, name, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 }
}

function tag(id: string, name = id): Tag {
  return { id, name, color: null, count: 1, createdAt: 1 }
}

function sync(overrides: Partial<SyncResponse> = {}): SyncResponse {
  return {
    cursor: 1, full: true, hasMore: false, nextKey: null, facetsFull: true,
    settingsChanged: false, profileChanged: false, siteChanged: false,
    notes: [], folders: [], tags: [], deletions: [], serverTime: 1,
    ...overrides,
  }
}

describe('notes sync helpers', () => {
  it('consolidates a full snapshot with later deltas, facet replacements, and deletions', () => {
    const keptFolder = folder('kept', 'old')
    const snapshot = sync({
      cursor: 10, hasMore: true, nextKey: 'snapshot-page', facetsFull: false, serverTime: 10,
      notes: [summary('note-1'), summary('note-2')],
      folders: [folder('stale'), keptFolder],
      tags: [tag('stale-tag')],
    })
    const first = sync({
      cursor: 20, full: false, serverTime: 20, settingsChanged: true, facetsFull: false,
      notes: [summary('note-1', 2), summary('note-3')],
      folders: [folder('kept', 'new')], tags: [tag('tag-1')],
      deletions: [{ entity: 'note', id: 'note-2' }, { entity: 'tag', id: 'stale-tag' }],
    })
    const second = sync({
      cursor: 30, full: false, serverTime: 30, profileChanged: true, siteChanged: true,
      notes: [summary('note-3', 2), summary('note-4')],
      folders: [folder('fresh')], tags: [tag('tag-2')],
      deletions: [{ entity: 'folder', id: 'kept' }],
    })

    const result = consolidateFullSync(snapshot, [first, second])

    expect(result).toMatchObject({
      cursor: 30, serverTime: 30, full: true, hasMore: false, nextKey: null, facetsFull: true,
      settingsChanged: true, profileChanged: true, siteChanged: true, deletions: [],
    })
    expect(result.notes.map((note) => [note.id, note.rev])).toEqual([
      ['note-1', 2], ['note-3', 2], ['note-4', 1],
    ])
    expect(result.folders.map((item) => item.id)).toEqual(['fresh'])
    expect(result.tags.map((item) => item.id)).toEqual(['tag-2'])
    expect(snapshot.notes.map((note) => note.id)).toEqual(['note-1', 'note-2'])
    expect(snapshot.folders.map((item) => item.id)).toEqual(['stale', 'kept'])
  })

  it('reconciles a complete list while retaining equal rows and the original array on a no-op', () => {
    const first = { id: 'first', value: 1 }
    const second = { id: 'second', value: 2 }
    const current = [first, second]
    const equal = (left: typeof first, right: typeof first) => left.value === right.value

    expect(reconcileList(current, [{ ...first }, { ...second }], equal)).toBe(current)
    expect(reconcileList(current, [{ ...first }, { ...second }], equal)[0]).toBe(first)

    const reordered = reconcileList(current, [{ ...second }, { ...first }], equal)
    expect(reordered).not.toBe(current)
    expect(reordered).toEqual([second, first])
    expect(reordered[0]).toBe(second)

    const changed = { id: 'first', value: 3 }
    const updated = reconcileList(current, [changed, { ...second }], equal)
    expect(updated).toEqual([changed, second])
    expect(updated[1]).toBe(second)
  })

  it('merges by id copy-on-write and applies deletions only for the requested entity', () => {
    const first = { id: 'first', value: 1 }
    const second = { id: 'second', value: 2 }
    const third = { id: 'third', value: 3 }
    const current = [first, second, third]
    const equal = (left: typeof first, right: typeof first) => left.value === right.value
    const changedThird = { id: 'third', value: 4 }
    const added = { id: 'fourth', value: 5 }

    const result = mergeById(current, [{ ...second }, changedThird, added], [
      { entity: 'folder', id: 'first' },
      { entity: 'tag', id: 'second' },
      { entity: 'folder', id: 'missing' },
    ], 'folder', equal)

    expect(result).toEqual([second, changedThird, added])
    expect(result[0]).toBe(second)
    expect(current).toEqual([first, second, third])
  })

  it('returns the original merge input when every row and deletion is a no-op', () => {
    const current = [{ id: 'one', value: 1 }]
    const result = mergeById(current, [{ ...current[0]! }], [
      { entity: 'tag', id: 'one' }, { entity: 'folder', id: 'missing' },
    ], 'folder', (left, right) => left.value === right.value)
    expect(result).toBe(current)
  })
})
