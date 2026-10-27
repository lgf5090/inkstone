import { describe, expect, it } from 'vitest'
import { APP_TABS, DEFAULT_APP_TAB, appTab, tabIdForPath, type AppTabId } from './app-tabs'

// The union is written out on purpose: add an id without a registry entry and this object stops
// compiling, which is the only place that disagreement can be caught before a reader sees a rail
// with a button that goes nowhere.
const EVERY_TAB_ID: Record<AppTabId, true> = {
  notes: true,
  memos: true,
  calendar: true,
  todo: true,
  email: true,
  projects: true,
  nav: true,
  chat: true,
  subscriptions: true,
  reading: true,
  rss: true,
  music: true,
  tools: true,
  development: true,
}

describe('the app tab registry', () => {
  it('lists exactly the ids the union names', () => {
    expect(APP_TABS.map((tab) => tab.id).sort()).toEqual(Object.keys(EVERY_TAB_ID).sort())
  })

  it('places memos directly after notes', () => {
    const ids = APP_TABS.map((tab) => tab.id)
    expect(ids[ids.indexOf('notes') + 1]).toBe('memos')
  })

  it('gives each container an address of its own', () => {
    const paths = APP_TABS.map((tab) => tab.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(true)
      // A trailing slash here would make the rail link one address and the router answer another.
      expect(path.endsWith('/')).toBe(false)
    }
  })

  for (const tab of APP_TABS) {
    it(`answers ${tab.path} with the ${tab.id} container`, () => {
      expect(tabIdForPath(tab.path)).toBe(tab.id)
      expect(tabIdForPath(`${tab.path}/`)).toBe(tab.id)
      expect(appTab(tab.id)).toBe(tab)
    })
  }

  it('opens the notebook at the bare origin, with no address to type', () => {
    expect(tabIdForPath('/')).toBe('notes')
    expect(DEFAULT_APP_TAB).toBe('notes')
  })

  it('falls back to the notebook for an address that names no container', () => {
    expect(tabIdForPath('/no-such-app')).toBe('notes')
    // A note's own deep link has no container of its own; the shell reads the id off the address
    // once the notebook is up, so the fall-through is the whole rule.
    expect(tabIdForPath('/n/aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('notes')
  })
})
