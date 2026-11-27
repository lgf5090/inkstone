import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersistedStore, readPersistedState } from './persisted-store'

type State = { enabled: boolean; count: number }

const defaults: State = { enabled: true, count: 0 }
const normalize = (value: unknown): State => {
  const row = value && typeof value === 'object' ? value as Partial<State> : {}
  return {
    enabled: typeof row.enabled === 'boolean' ? row.enabled : defaults.enabled,
    count: typeof row.count === 'number' ? row.count : defaults.count,
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('persisted stores', () => {
  it('reads the current key before a legacy value and validates both', () => {
    localStorage.setItem('inkstone.calendar.test.v1:user', JSON.stringify({ enabled: false, count: 2 }))
    localStorage.setItem('inkstone:calendar:test:user', JSON.stringify({ enabled: true, count: 9 }))
    expect(readPersistedState('inkstone.calendar.test.v1:user', defaults, normalize, localStorage, ['inkstone:calendar:test:user']))
      .toEqual({ enabled: false, count: 2 })

    localStorage.setItem('inkstone.calendar.test.v1:user', '{broken')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readPersistedState('inkstone.calendar.test.v1:user', defaults, normalize, localStorage, ['inkstone:calendar:test:user']))
      .toEqual({ enabled: true, count: 9 })
  })

  it('publishes local writes and applies another tab storage change', () => {
    const key = 'inkstone.calendar.cross-tab.v1:user'
    const store = createPersistedStore(key, defaults, normalize)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.setState({ count: 3 })
    expect(store.getState()).toEqual({ enabled: true, count: 3 })
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ enabled: true, count: 3 })
    expect(listener).toHaveBeenCalledTimes(1)

    localStorage.setItem(key, JSON.stringify({ enabled: false, count: 8 }))
    window.dispatchEvent(new StorageEvent('storage', {
      key,
      newValue: JSON.stringify({ enabled: false, count: 8 }),
      storageArea: localStorage,
    }))
    expect(store.getState()).toEqual({ enabled: false, count: 8 })
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('keeps the in-memory value when persistence is refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const store = createPersistedStore('inkstone.calendar.readonly.v1:user', defaults, normalize)

    expect(() => store.setState({ enabled: false })).not.toThrow()
    expect(store.getState().enabled).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })
})
