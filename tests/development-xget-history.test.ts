// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearXgetHistory,
  loadXgetHistory,
  prependXgetHistory,
  saveXgetHistory,
  type XgetHistoryItem,
} from '../src/client/features/development/xget/lib/history'

const USER_A = 'user-a'
const USER_B = 'user-b'

function item(index: number, overrides: Partial<XgetHistoryItem> = {}): XgetHistoryItem {
  return {
    url: `https://github.com/a/b/archive/${index}.zip`,
    result: `https://inkstone.test/api/development/xget/gh/a/b/archive/${index}.zip`,
    key: 'gh',
    time: 1_700_000_000_000 + index,
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('the Xget conversion history', () => {
  it('is stored per account and never crosses accounts', () => {
    saveXgetHistory(USER_A, [item(1)])
    expect(loadXgetHistory(USER_A)).toHaveLength(1)
    expect(loadXgetHistory(USER_B)).toEqual([])
  })

  it('caps the list at ten entries and prepends the newest', () => {
    let history: XgetHistoryItem[] = []
    for (let index = 0; index < 12; index += 1) history = prependXgetHistory(USER_A, history, item(index))
    expect(history).toHaveLength(10)
    expect(history[0]?.url).toContain('/11.zip')
    expect(loadXgetHistory(USER_A)).toHaveLength(10)
  })

  it('drops entries from broken JSON, unknown platforms and bad timestamps', () => {
    localStorage.setItem('inkstone.development.xget.history.user-a', '{not json')
    expect(loadXgetHistory(USER_A)).toEqual([])

    localStorage.setItem(
      'inkstone.development.xget.history.user-a',
      JSON.stringify([
        item(1),
        { ...item(2), key: 'not-a-platform' },
        { ...item(3), time: Number.NaN },
        { ...item(4), url: '' },
        { ...item(5), result: 42 },
      ]),
    )
    const loaded = loadXgetHistory(USER_A)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.key).toBe('gh')
  })

  it('clears only the current account', () => {
    saveXgetHistory(USER_A, [item(1)])
    saveXgetHistory(USER_B, [item(2)])
    clearXgetHistory(USER_A)
    expect(loadXgetHistory(USER_A)).toEqual([])
    expect(loadXgetHistory(USER_B)).toHaveLength(1)
  })

  it('does nothing without a signed-in account', () => {
    expect(loadXgetHistory(null)).toEqual([])
    expect(prependXgetHistory(null, [], item(1))).toHaveLength(1)
    expect(localStorage.length).toBe(0)
  })
})
