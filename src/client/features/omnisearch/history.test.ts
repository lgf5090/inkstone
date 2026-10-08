import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, unknown>()
vi.mock('../../lib/db', () => ({
  localDb: {
    loadOmnisearchHistory: () => Promise.resolve(store.get('history')),
    saveOmnisearchHistory: (value: unknown) => {
      store.set('history', value)
      return Promise.resolve()
    },
    loadOmnisearchCache: () => Promise.resolve(store.get('cache')),
    saveOmnisearchCache: (value: unknown) => {
      store.set('cache', value)
      return Promise.resolve()
    },
    clearOmnisearchCache: () => {
      store.delete('cache')
      return Promise.resolve()
    },
    dropOmnisearchBodies: (ids: string[]) => {
      for (const id of ids) store.delete(`body:${id}`)
      return Promise.resolve()
    },
    getOmnisearchBodies: (ids: string[]) => Promise.resolve(new Map(ids
      .map((id) => [id, store.get(`body:${id}`)] as const)
      .filter((pair): pair is [string, string] => typeof pair[1] === 'string'))),
    setOmnisearchBodies: (entries: [string, string][]) => {
      for (const [id, value] of entries) store.set(`body:${id}`, value)
      return Promise.resolve()
    },
  },
}))

const { isCacheRecord, readCache, writeCache } = await import('./cache')
const { clearHistory, initialQueryOf, loadHistory, OMNISEARCH_HISTORY_MAX, pushHistory } = await import('./history')

beforeEach(() => {
  store.clear()
})

describe('search history', () => {
  it('puts the newest query first and drops the older copy', async () => {
    await pushHistory('latte')
    await pushHistory('tea')
    await pushHistory('latte')
    expect(await loadHistory()).toEqual(['latte', 'tea'])
  })

  it('marks an abandoned query so the next opening starts blank', async () => {
    await pushHistory('latte')
    await pushHistory('   ')
    expect(await loadHistory()).toEqual(['', 'latte'])
    expect(initialQueryOf(await loadHistory(), true)).toBe('')
    expect(initialQueryOf(await loadHistory(), false)).toBe('')
  })

  it('forgets the marker as soon as a real query runs', async () => {
    await pushHistory('')
    await pushHistory('latte')
    expect(await loadHistory()).toEqual(['latte'])
  })

  it('keeps ten entries and clips what is longer than a query should be', async () => {
    for (let index = 0; index < 25; index++) await pushHistory(`q${index} ${'x'.repeat(600)}`)
    const history = await loadHistory()
    expect(history).toHaveLength(OMNISEARCH_HISTORY_MAX)
    expect(history[0]).toHaveLength(512)
  })

  it('survives a corrupted record by starting over', async () => {
    store.set('history', ['ok', 42, { not: 'a string' }])
    expect(await loadHistory()).toEqual([])
    await clearHistory()
    expect(await loadHistory()).toEqual([])
  })

  it('prefers the last query when the reader asked for it', () => {
    expect(initialQueryOf(['latte', 'tea'], true)).toBe('latte')
    expect(initialQueryOf(['latte'], false)).toBe('')
    expect(initialQueryOf([], true)).toBe('')
  })
})

describe('index cache record', () => {
  const record = () => ({
    version: 1,
    fingerprint: 'fp',
    savedAt: 1,
    bodyBytes: 10,
    payload: { index: '{}', refs: [['n:a', 1] as [string, number]], hasBody: [['n:a', true] as [string, boolean]], embeds: [['n:a', ['n:b']] as [string, string[]]] },
  })

  it('accepts a well-formed record', () => {
    expect(isCacheRecord(record())).toBe(true)
  })

  it('rejects every shape it cannot trust', () => {
    expect(isCacheRecord(null)).toBe(false)
    expect(isCacheRecord([])).toBe(false)
    expect(isCacheRecord({ ...record(), version: 999 })).toBe(false)
    expect(isCacheRecord({ ...record(), fingerprint: 7 })).toBe(false)
    expect(isCacheRecord({ ...record(), bodyBytes: -1 })).toBe(false)
    expect(isCacheRecord({ ...record(), savedAt: Number.NaN })).toBe(false)
    expect(isCacheRecord({ ...record(), payload: { ...record().payload, index: 5 } })).toBe(false)
    expect(isCacheRecord({ ...record(), payload: { ...record().payload, refs: [['n:a', 'nope']] } })).toBe(false)
    expect(isCacheRecord({ ...record(), payload: { ...record().payload, hasBody: [['n:a', 'yes']] } })).toBe(false)
    expect(isCacheRecord({ ...record(), payload: { ...record().payload, embeds: [['n:a', 'n:b']] } })).toBe(false)
  })

  it('only hands the index back when the fingerprint still matches', async () => {
    await writeCache(record())
    expect(await readCache('fp')).not.toBeNull()
    expect(await readCache('changed')).toBeNull()
  })
})
