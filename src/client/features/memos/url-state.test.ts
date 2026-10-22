import { describe, expect, it } from 'vitest'
import { MEMO_DISPLAY_DEFAULTS } from '@shared/memos/constants'
import { buildMemoSearch, memoFilterExpression, readMemoUrlState } from './url-state'

describe('memo URL state', () => {
  it('starts with no filter, no tag and no layout overrides', () => {
    const state = readMemoUrlState('')
    expect(state).toEqual({
      q: '',
      tag: null,
      filter: '',
      quick: [],
      spaceId: null,
      orderBy: null,
      order: null,
      columns: null,
      compact: null,
      linkPreview: null,
    })
  })

  it('reads the search, tag, CEL filter, space, sort and display tokens', () => {
    const state = readMemoUrlState('?q=hello&tag=%23work&filter=pinned&space=s1&sort=updated-asc&display=2,compact,no-link-preview')
    expect(state.q).toBe('hello')
    expect(state.tag).toBe('work')
    expect(state.filter).toBe('pinned')
    expect(state.spaceId).toBe('s1')
    expect(state.orderBy).toBe('updated')
    expect(state.order).toBe('asc')
    expect(state.columns).toBe(2)
    expect(state.compact).toBe(true)
    expect(state.linkPreview).toBe(false)
  })

  it('reads quick filters in order and drops unknown or repeated values', () => {
    expect(readMemoUrlState('?quick=pinned,has_link,pinned,sparkly,recent_7d').quick)
      .toEqual(['pinned', 'has_link', 'recent_7d'])
    expect(readMemoUrlState('?quick=').quick).toEqual([])
  })

  it('ignores values it does not understand instead of guessing', () => {
    const state = readMemoUrlState('?sort=sideways-asc&display=9,sparkly')
    expect(state.orderBy).toBeNull()
    expect(state.order).toBeNull()
    expect(state.columns).toBeNull()
    expect(state.compact).toBeNull()
    expect(state.linkPreview).toBeNull()
  })

  it('keeps the default address free of layout parameters', () => {
    expect(buildMemoSearch({ q: '', tag: null, filter: '', spaceId: null, display: MEMO_DISPLAY_DEFAULTS })).toBe('')
  })

  it('writes filters, sorting and layout choices back into an address', () => {
    const search = buildMemoSearch({
      q: 'hello',
      tag: 'work',
      filter: 'pinned',
      quick: ['has_link', 'recent_30d'],
      spaceId: 's1',
      orderBy: 'updated',
      order: 'asc',
      display: { columns: 3, compact: true, linkPreview: false, timeBasis: 'updated', order: 'asc' },
    })
    expect(readMemoUrlState(search)).toMatchObject({
      q: 'hello',
      tag: 'work',
      filter: 'pinned',
      quick: ['has_link', 'recent_30d'],
      spaceId: 's1',
      orderBy: 'updated',
      order: 'asc',
      columns: 3,
      compact: true,
      linkPreview: false,
    })
  })

  it('turns free text into one contains clause per word and keeps an explicit filter', () => {
    expect(memoFilterExpression('', '')).toBe('')
    expect(memoFilterExpression('hello "there"', ''))
      .toBe('content.contains("hello") && content.contains("\\"there\\"")')
    expect(memoFilterExpression('', 'pinned && has_link')).toBe('(pinned && has_link)')
    expect(memoFilterExpression('todo', 'has_task_list')).toBe('content.contains("todo") && (has_task_list)')
  })

  it('joins quick filters into the same CEL expression', () => {
    expect(memoFilterExpression('', '', ['pinned', 'has_incomplete_tasks']))
      .toBe('pinned && has_incomplete_tasks')
    expect(memoFilterExpression('ship', '', ['visibility_public', 'recent_7d']))
      .toBe('content.contains("ship") && visibility == "PUBLIC" && created_ts >= now - duration("7d")')
    expect(memoFilterExpression('', 'content.contains("x")', ['has_code']))
      .toBe('has_code && (content.contains("x"))')
    expect(memoFilterExpression('', '', ['visibility_public', 'visibility_private']))
      .toBe('(visibility == "PUBLIC" || visibility == "PRIVATE")')
  })
})
