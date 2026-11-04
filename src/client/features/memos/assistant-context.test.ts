/**
 * The page facts the Memos dock sends.
 *
 * The assistant is asked "these three" while the reader looks at a filtered feed, so the tests pin that the
 * space, the filters, the visible count and the first titles are what travel — and that a page with no
 * filter says so rather than sending an empty line the model has to interpret.
 */
import { describe, expect, it } from 'vitest'
import { buildMemoPageContext } from './assistant-context'
import type { Memo } from '@shared/memos/types'

function memo(id: string, title: string): Memo {
  return {
    id,
    title,
    content: title,
    snippet: title,
    tags: [],
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: null,
    location: null,
    properties: { hasLink: false, hasCode: false, hasTaskList: false, hasIncompleteTasks: false, hasLocation: false },
    attachments: [],
    reactions: [],
    relations: [],
    commentCount: 0,
    rev: 1,
    encrypted: false,
    contentCipher: '',
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('the Memos page context', () => {
  it('names the page, the space, and the filter it is showing', () => {
    const context = buildMemoPageContext({
      sectionLabel: '工作',
      spaceId: 'space-1',
      spaceName: '工作',
      state: 'normal',
      search: '',
      tag: null,
      filterExpression: 'pinned',
      quick: [],
      visible: 2,
      memos: [memo('a', '首页改版'), memo('b', '上线计划')],
      openMemo: null,
    })
    expect(context.surface).toBe('memos')
    expect(context.label).toBe('Memos · 工作')
    expect(context.facts).toEqual([
      'state: normal',
      'space: 工作',
      'filter: expression pinned',
      'visible: 2',
      'recent: "首页改版" | "上线计划"',
    ])
  })

  it('says "all" when nothing narrows the feed, and names the open memo', () => {
    const open = memo('c', '今天和设计对齐首页改版')
    const context = buildMemoPageContext({
      sectionLabel: 'memo',
      spaceId: null,
      spaceName: null,
      state: 'normal',
      search: '',
      tag: null,
      filterExpression: '',
      quick: [],
      visible: 0,
      memos: [],
      openMemo: open,
    })
    expect(context.facts).toEqual([
      'state: normal',
      'space: all',
      'filter: all',
      'visible: 0',
      'open memo: 今天和设计对齐首页改版',
    ])
  })

  it('sums up a search, tag, and quick filter in one line', () => {
    const context = buildMemoPageContext({
      sectionLabel: '首页',
      spaceId: null,
      spaceName: null,
      state: 'archived',
      search: '上线',
      tag: '设计',
      filterExpression: '',
      quick: ['media', 'task'],
      visible: 1,
      memos: [memo('d', '上周提到上线')],
      openMemo: null,
    })
    expect(context.facts[0]).toBe('state: archived')
    expect(context.facts[2]).toBe('filter: search "上线"; tag 设计; quick media, task')
  })
})
