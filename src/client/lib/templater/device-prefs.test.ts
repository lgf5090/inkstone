import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearTemplaterDevicePrefs,
  defaultTemplaterDevicePrefs,
  loadTemplaterDevicePrefs,
  setTemplaterDevicePrefs,
  templaterDevicePrefsKey,
  useTemplaterDevicePrefs,
} from './device-prefs'

/**
 * The device's own two answers.
 *
 * Each case names its own account id: the module caches per user, so a shared id would make one case read
 * another case's write instead of the storage it claims to be measuring.
 */

// The hook cases below call `act`; without this flag React only warns and the flushes become no-ops, which
// would let a stale-render assertion pass because nothing ever re-rendered to fail it.
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

/** The accounts this file has touched, so no case can inherit another's cache. */
const usedIds: string[] = []

function account(prefix: string): string {
  const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
  usedIds.push(id)
  return id
}

afterEach(() => {
  for (const id of usedIds.splice(0)) {
    localStorage.removeItem(templaterDevicePrefsKey(id))
    clearTemplaterDevicePrefs(id)
  }
})

describe('templater device preferences', () => {
  it('starts every account with both switches off', () => {
    expect(loadTemplaterDevicePrefs(account('none'))).toEqual({
      triggerOnFileCreation: false,
      enableStartupTemplates: false,
    })
    expect(defaultTemplaterDevicePrefs()).toEqual({ triggerOnFileCreation: false, enableStartupTemplates: false })
  })

  it('keys the row by account, so one device shared by two readers holds two answers', () => {
    const a = account('a')
    const b = account('b')
    setTemplaterDevicePrefs(a, { triggerOnFileCreation: true })
    setTemplaterDevicePrefs(b, { enableStartupTemplates: true })
    expect(JSON.parse(localStorage.getItem(templaterDevicePrefsKey(a))!)).toEqual({
      triggerOnFileCreation: true,
      enableStartupTemplates: false,
    })
    expect(JSON.parse(localStorage.getItem(templaterDevicePrefsKey(b))!)).toEqual({
      triggerOnFileCreation: false,
      enableStartupTemplates: true,
    })
  })

  it('reads back from storage once the cache is dropped, which is what a reload does', () => {
    const id = account('reload')
    setTemplaterDevicePrefs(id, { enableStartupTemplates: true })
    clearTemplaterDevicePrefs(id)
    expect(loadTemplaterDevicePrefs(id).enableStartupTemplates).toBe(true)
  })

  it('answers the defaults for a row that is not JSON, or is JSON of the wrong shape', () => {
    const junk = account('junk')
    const array = account('array')
    const nul = account('null')
    localStorage.setItem(templaterDevicePrefsKey(junk), 'not json')
    localStorage.setItem(templaterDevicePrefsKey(array), '[1,2]')
    localStorage.setItem(templaterDevicePrefsKey(nul), 'null')
    expect(loadTemplaterDevicePrefs(junk)).toEqual(defaultTemplaterDevicePrefs())
    expect(loadTemplaterDevicePrefs(array)).toEqual(defaultTemplaterDevicePrefs())
    expect(loadTemplaterDevicePrefs(nul)).toEqual(defaultTemplaterDevicePrefs())
  })

  it('reads a stored row that knows a name this build does not have', () => {
    const id = account('extra')
    localStorage.setItem(templaterDevicePrefsKey(id), JSON.stringify({
      triggerOnFileCreation: true,
      enableSystemCommands: true,
    }))
    expect(loadTemplaterDevicePrefs(id)).toEqual({ triggerOnFileCreation: true, enableStartupTemplates: false })
  })

  it('reads a non-boolean as the safe answer rather than as truth', () => {
    const id = account('string')
    localStorage.setItem(templaterDevicePrefsKey(id), JSON.stringify({ triggerOnFileCreation: 'yes' }))
    expect(loadTemplaterDevicePrefs(id).triggerOnFileCreation).toBe(false)
  })

  it('reports the answer it wrote, and a forgotten account starts from storage again', () => {
    const id = account('forget')
    expect(setTemplaterDevicePrefs(id, { triggerOnFileCreation: true }))
      .toEqual({ triggerOnFileCreation: true, enableStartupTemplates: false })
    clearTemplaterDevicePrefs(id)
    expect(loadTemplaterDevicePrefs(id).triggerOnFileCreation).toBe(true)
    localStorage.removeItem(templaterDevicePrefsKey(id))
    expect(loadTemplaterDevicePrefs(id).triggerOnFileCreation).toBe(false)
  })

  it('holds nothing on disk for an empty account id, but still answers this session', () => {
    // A signed-out page has no id to key by. Writing under an empty key would be one reader's answer
    // arriving on the next reader's device, so the write stays in memory and the disk is left alone.
    expect(setTemplaterDevicePrefs('', { triggerOnFileCreation: true }).triggerOnFileCreation).toBe(true)
    expect(localStorage.getItem(templaterDevicePrefsKey(''))).toBeNull()
    expect(loadTemplaterDevicePrefs('')).toEqual(defaultTemplaterDevicePrefs())
  })
})

/**
 * The hook, rendered for real.
 *
 * `useTemplaterDevicePrefs` is a `useSyncExternalStore` over the module's cache, so the two things worth
 * pinning are that a write reaches the tree and that unmounting stops the updates — neither of which a
 * direct call to the snapshot function would show.
 */
describe('useTemplaterDevicePrefs', () => {
  function renderProbe(userId: string | null | undefined, observe: (prefs: ReturnType<typeof defaultTemplaterDevicePrefs>) => void) {
    function Probe() {
      observe(useTemplaterDevicePrefs(userId))
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => {
      root.render(createElement(Probe))
    })
    return () => {
      act(() => {
        root.unmount()
      })
    }
  }

  it('shows the answer for its own account, and updates when it changes', () => {
    const id = account('hook')
    const seen: Array<boolean> = []
    const unmount = renderProbe(id, (prefs) => seen.push(prefs.enableStartupTemplates))
    act(() => {
      setTemplaterDevicePrefs(id, { enableStartupTemplates: true })
    })
    expect(seen).toEqual([false, true])
    unmount()
  })

  it('stops updating once the tree is gone', () => {
    const id = account('hook-off')
    const observe = vi.fn()
    const unmount = renderProbe(id, observe)
    const calls = observe.mock.calls.length
    unmount()
    act(() => {
      setTemplaterDevicePrefs(id, { triggerOnFileCreation: true })
    })
    expect(observe.mock.calls.length).toBe(calls)
  })

  it('answers the defaults for a reader with no id, which is what the shell sees before sign-in', () => {
    for (const userId of [null, undefined]) {
      const observed: Array<ReturnType<typeof defaultTemplaterDevicePrefs>> = []
      const unmount = renderProbe(userId, (prefs) => observed.push(prefs))
      expect(observed).toEqual([defaultTemplaterDevicePrefs()])
      unmount()
    }
  })
})
