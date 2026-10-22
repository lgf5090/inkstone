import { describe, expect, it } from 'vitest'
import type { Memo } from '@shared/memos/types'
import { memoTagCounts, suggestMemoTags } from './tag-suggestions'

function memo(id: string, tags: string[]): Memo {
  return {
    id,
    content: '',
    title: '',
    snippet: '',
    tags,
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: null,
    location: null,
    properties: {
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: false,
    },
    attachments: [],
    reactions: [],
    relations: [],
    commentCount: 0,
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('the tag suggestions', () => {
  it('ranks by frequency and keeps the three strongest tags', () => {
    const items = [
      memo('a', ['work', 'idea']),
      memo('b', ['work', 'reading']),
      memo('c', ['work', 'reading', 'idea']),
      memo('d', ['idea', 'travel']),
    ]
    expect(suggestMemoTags(items, null)).toEqual(['work', 'idea', 'reading'])
  })

  it('excludes the active tag', () => {
    const items = [memo('a', ['work', 'idea']), memo('b', ['work'])]
    expect(suggestMemoTags(items, 'work')).toEqual(['idea'])
  })

  it('answers nothing without items or tags', () => {
    expect(suggestMemoTags([], null)).toEqual([])
    expect(suggestMemoTags([memo('a', [])], null)).toEqual([])
  })
})

describe('the editor tag completion list', () => {
  it('counts every tag, skips blanks and orders by use', () => {
    const items = [
      memo('a', ['work', ' idea ', '']),
      memo('b', ['work', 'reading']),
    ]
    expect(memoTagCounts(items)).toEqual([
      { name: 'work', count: 2 },
      { name: 'idea', count: 1 },
      { name: 'reading', count: 1 },
    ])
  })
})
