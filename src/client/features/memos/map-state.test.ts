import { describe, expect, it, vi } from 'vitest'
import type { Memo, MemoAttachment } from '@shared/memos/types'
import {
  MEMO_MAP_FETCH_LIMIT,
  MEMO_MAP_MAX_MEMOS,
  MEMO_MAP_MAX_PAGES,
  buildMemoMapGroups,
  clearMemoMapFilters,
  collectMemoMapMemos,
  hasMemoMapFilters,
  memoMapFilter,
  memoMapGroupContaining,
  memoMapPinKind,
  readMemoMapUrl,
  updateMemoMapSearch,
} from './map-state'

function attachment(overrides: Partial<MemoAttachment> = {}): MemoAttachment {
  return {
    id: 'att-1',
    filename: 'photo.jpg',
    mime: 'image/jpeg',
    size: 100,
    width: 10,
    height: 10,
    url: '/api/memos/files/att-1',
    thumbnailUrl: '/api/memos/files/att-1?thumb=1',
    motion: null,
    mediaMetadata: null,
    createdAt: 1,
    ...overrides,
  }
}

function memo(id: string, overrides: Partial<Memo> = {}): Memo {
  return {
    id,
    content: '',
    title: '',
    snippet: '',
    tags: [],
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
    ...overrides,
  }
}

describe('memo map URL state', () => {
  it('reads a complete view and selection', () => {
    expect(readMemoMapUrl('?lat=37.7749&lng=-122.4194&zoom=12&memo=m-1')).toEqual({
      view: { latitude: 37.7749, longitude: -122.4194, zoom: 12 },
      memoId: 'm-1',
    })
  })

  it('ignores incomplete or invalid coordinates', () => {
    expect(readMemoMapUrl('')).toEqual({ view: null, memoId: null })
    expect(readMemoMapUrl('?lat=37.7')).toEqual({ view: null, memoId: null })
    expect(readMemoMapUrl('?lng=37.7')).toEqual({ view: null, memoId: null })
    expect(readMemoMapUrl('?lat=&lng=&zoom=9')).toEqual({ view: null, memoId: null })
    expect(readMemoMapUrl('?lat=91&lng=0')).toEqual({ view: null, memoId: null })
    expect(readMemoMapUrl('?lat=0&lng=-181')).toEqual({ view: null, memoId: null })
    expect(readMemoMapUrl('?lat=abc&lng=0')).toEqual({ view: null, memoId: null })
  })

  it('clamps a numeric zoom and falls back for an invalid one', () => {
    expect(readMemoMapUrl('?lat=1&lng=2&zoom=99').view?.zoom).toBe(19)
    expect(readMemoMapUrl('?lat=1&lng=2&zoom=0').view?.zoom).toBe(1)
    expect(readMemoMapUrl('?lat=1&lng=2&zoom=near').view?.zoom).toBe(2)
    expect(readMemoMapUrl('?lat=1&lng=2&zoom=').view?.zoom).toBe(2)
    expect(readMemoMapUrl('?lat=1&lng=2').view?.zoom).toBe(2)
  })

  it('drops an empty memo selection', () => {
    expect(readMemoMapUrl('?memo=%20').memoId).toBeNull()
    expect(readMemoMapUrl('?memo=m-1').memoId).toBe('m-1')
  })

  it('writes a view without disturbing filters or selection', () => {
    const next = updateMemoMapSearch(
      'q=coffee&tag=work&sort=updated-desc&memo=m-1',
      { view: { latitude: 37.774929, longitude: -122.419416, zoom: 11 } },
    )
    const params = new URLSearchParams(next)
    expect(params.get('lat')).toBe('37.774929')
    expect(params.get('lng')).toBe('-122.419416')
    expect(params.get('zoom')).toBe('11')
    expect(params.get('q')).toBe('coffee')
    expect(params.get('tag')).toBe('work')
    expect(params.get('sort')).toBe('updated-desc')
    expect(params.get('memo')).toBe('m-1')
  })

  it('removes the view and selection when asked', () => {
    const clearedView = new URLSearchParams(updateMemoMapSearch(
      'lat=1&lng=2&zoom=5&memo=m-1&q=coffee',
      { view: null },
    ))
    expect(clearedView.has('lat')).toBe(false)
    expect(clearedView.has('lng')).toBe(false)
    expect(clearedView.has('zoom')).toBe(false)
    expect(clearedView.get('memo')).toBe('m-1')
    expect(clearedView.get('q')).toBe('coffee')

    const clearedMemo = new URLSearchParams(updateMemoMapSearch('memo=m-1&lat=1', { memoId: null }))
    expect(clearedMemo.has('memo')).toBe(false)
    expect(clearedMemo.get('lat')).toBe('1')
  })

  it('formats negative zero as zero', () => {
    const params = new URLSearchParams(updateMemoMapSearch('', {
      view: { latitude: -0.0000001, longitude: 0, zoom: 3 },
    }))
    expect(params.get('lat')).toBe('0')
    expect(params.get('lng')).toBe('0')
  })
})

describe('memo map filters', () => {
  it('detects active filters', () => {
    expect(hasMemoMapFilters('')).toBe(false)
    expect(hasMemoMapFilters('lat=1&lng=2&memo=m-1')).toBe(false)
    expect(hasMemoMapFilters('q=coffee')).toBe(true)
    expect(hasMemoMapFilters('tag=work')).toBe(true)
    expect(hasMemoMapFilters('filter=pinned')).toBe(true)
  })

  it('clears filters and keeps the map view', () => {
    const params = new URLSearchParams(clearMemoMapFilters('q=coffee&tag=work&filter=pinned&lat=1&lng=2&memo=m-1'))
    expect(params.has('q')).toBe(false)
    expect(params.has('tag')).toBe(false)
    expect(params.has('filter')).toBe(false)
    expect(params.get('lat')).toBe('1')
    expect(params.get('lng')).toBe('2')
    expect(params.get('memo')).toBe('m-1')
  })

  it('always requires a location and merges the reader filters', () => {
    expect(memoMapFilter('')).toBe('has_location')
    expect(memoMapFilter('q=coffee')).toBe('has_location && content.contains("coffee")')
    expect(memoMapFilter('filter=pinned')).toBe('has_location && (pinned)')
    expect(memoMapFilter('q=coffee&filter=pinned&tag=work'))
      .toBe('has_location && content.contains("coffee") && (pinned) && tag == "work"')
    expect(memoMapFilter('q=%22quoted%22')).toBe('has_location && content.contains("\\"quoted\\"")')
  })
})

describe('memo map groups', () => {
  it('groups memos at the same rounded point', () => {
    const groups = buildMemoMapGroups([
      memo('a', { location: { placeholder: 'Cafe', latitude: 12.34567891, longitude: 45.67891234 } }),
      memo('b', { location: { placeholder: 'Cafe two', latitude: 12.34567889, longitude: 45.67891239 } }),
      memo('c', { location: { placeholder: 'Elsewhere', latitude: 20, longitude: 30 } }),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].memoIds).toEqual(['a', 'b'])
    expect(groups[0].count).toBe(2)
    expect(groups[0].label).toBe('Cafe')
    expect(groups[1].label).toBe('Elsewhere')
  })

  it('skips memo without a usable location', () => {
    const groups = buildMemoMapGroups([
      memo('none'),
      memo('bad', { location: { placeholder: 'bad', latitude: 120, longitude: 0 } }),
      memo('good', { location: { placeholder: '', latitude: 1.5, longitude: 2.5 } }),
    ])
    expect(groups.map((group) => group.memoIds)).toEqual([['good']])
    expect(groups[0].label).toBe('1.5, 2.5')
  })

  it('prefers a photo, then a creator initial, then a dot', () => {
    const photo = buildMemoMapGroups([
      memo('photo', {
        location: { placeholder: 'Photo', latitude: 1, longitude: 1 },
        attachments: [attachment()],
        creator: { id: 'u', login: 'ada', name: 'Ada Lovelace', avatarUrl: '', role: 'owner', createdAt: 1, username: 'ada' },
      }),
    ])[0]
    expect(photo.photoUrl).toBe('/api/memos/files/att-1?thumb=1')
    expect(photo.initial).toBe('A')
    expect(memoMapPinKind(photo)).toBe('photo')

    const initial = buildMemoMapGroups([
      memo('initial', {
        location: { placeholder: 'Initial', latitude: 2, longitude: 2 },
        creator: { id: 'u', login: 'ada', name: '', avatarUrl: '', role: 'owner', createdAt: 1, username: 'ada' },
      }),
    ])[0]
    expect(initial.photoUrl).toBeNull()
    expect(initial.initial).toBe('A')
    expect(memoMapPinKind(initial)).toBe('initial')

    const dot = buildMemoMapGroups([
      memo('dot', { location: { placeholder: 'Dot', latitude: 3, longitude: 3 } }),
    ])[0]
    expect(memoMapPinKind(dot)).toBe('dot')
  })

  it('uses a later photo when the first memo has none', () => {
    const groups = buildMemoMapGroups([
      memo('plain', { location: { placeholder: 'Shared', latitude: 1, longitude: 1 } }),
      memo('photo', { location: { placeholder: 'Shared', latitude: 1, longitude: 1 }, attachments: [attachment()] }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].photoUrl).toBe('/api/memos/files/att-1?thumb=1')
  })

  it('finds the group that holds a memo', () => {
    const groups = buildMemoMapGroups([
      memo('a', { location: { placeholder: 'A', latitude: 1, longitude: 1 } }),
      memo('b', { location: { placeholder: 'B', latitude: 2, longitude: 2 } }),
    ])
    expect(memoMapGroupContaining(groups, 'b')?.label).toBe('B')
    expect(memoMapGroupContaining(groups, 'missing')).toBeNull()
  })
})

describe('memo map pagination', () => {
  it('reads every page and reports an exhausted list', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [memo('a'), memo('b')], nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [memo('c')], nextCursor: null })
    const result = await collectMemoMapMemos(fetchPage, 5)
    expect(result.memos.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(result.capped).toBe(false)
    expect(fetchPage).toHaveBeenNthCalledWith(1, null)
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'next')
  })

  it('stops at the memo cap and reports it', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [memo('a'), memo('b')], nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [memo('c'), memo('d')], nextCursor: 'next-2' })
    const result = await collectMemoMapMemos(fetchPage, 3)
    expect(result.memos.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(result.capped).toBe(true)
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('does not report a cap when the exact last page ends the list', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [memo('a'), memo('b')], nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [memo('c')], nextCursor: null })
    const result = await collectMemoMapMemos(fetchPage, 3)
    expect(result.memos).toHaveLength(3)
    expect(result.capped).toBe(false)
  })

  it('refuses a repeated cursor instead of looping forever', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [memo('a')], nextCursor: 'same' })
      .mockResolvedValueOnce({ items: [memo('b')], nextCursor: 'same' })
    await expect(collectMemoMapMemos(fetchPage, 100)).rejects.toThrow('same cursor')
  })

  it('stops at the page ceiling and reports it', async () => {
    let page = 0
    const fetchPage = vi.fn(async () => {
      page += 1
      return { items: [memo(`m-${page}`)], nextCursor: `cursor-${page}` }
    })
    const result = await collectMemoMapMemos(fetchPage, 1_000)
    expect(result.memos).toHaveLength(MEMO_MAP_MAX_PAGES)
    expect(result.capped).toBe(true)
    expect(fetchPage).toHaveBeenCalledTimes(MEMO_MAP_MAX_PAGES)
  })

  it('keeps the server page size under the API ceiling', () => {
    expect(MEMO_MAP_FETCH_LIMIT).toBeLessThanOrEqual(100)
    expect(MEMO_MAP_MAX_MEMOS).toBeGreaterThan(MEMO_MAP_FETCH_LIMIT)
    expect(MEMO_MAP_MAX_PAGES).toBe(MEMO_MAP_MAX_MEMOS / MEMO_MAP_FETCH_LIMIT)
  })
})
