import { beforeEach, describe, expect, it } from 'vitest'
import { defaultQuickAddSettings, type QuickAddSettings } from '@shared/quickadd'
import {
  STARTUP_STAMP_KEY,
  loadStartupStamp,
  markStartupRun,
  resetStartupSession,
  shouldRunStartup,
  startupDay,
} from './startup'

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

function settings(over: Partial<QuickAddSettings> = {}): QuickAddSettings {
  return { ...defaultQuickAddSettings(), startupMacroId: 'qa-mac', ...over }
}

const today = new Date(2026, 9, 8, 9, 0, 0)

beforeEach(() => {
  resetStartupSession()
})

describe('the startup macro’s own clock', () => {
  it('names the reader’s day, not the UTC one', () => {
    expect(startupDay(new Date(2026, 9, 8, 23, 30))).toBe('2026-10-08')
    expect(startupDay(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01')
  })

  it('refuses to run with nothing chosen, with the feature off, or with nobody signed in', () => {
    const storage = memoryStorage()
    expect(shouldRunStartup(settings({ startupMacroId: null }), 'u1', today, storage)).toBe(false)
    expect(shouldRunStartup(settings(), '', today, storage)).toBe(false)
    expect(shouldRunStartup(settings({ enabled: false }), 'u1', today, storage)).toBe(false)
  })

  it('runs the first time and not again the same day', () => {
    const storage = memoryStorage()
    expect(shouldRunStartup(settings(), 'u1', today, storage)).toBe(true)
    markStartupRun('u1', 'qa-mac', today, storage)
    expect(shouldRunStartup(settings(), 'u1', today, storage)).toBe(false)
  })

  it('runs again the next day, and again when a different macro is chosen', () => {
    const storage = memoryStorage()
    markStartupRun('u1', 'qa-mac', today, storage)
    resetStartupSession()
    expect(shouldRunStartup(settings(), 'u1', new Date(2026, 9, 9, 9), storage)).toBe(true)
    markStartupRun('u1', 'qa-mac', new Date(2026, 9, 9, 9), storage)
    resetStartupSession()
    expect(shouldRunStartup(settings({ startupMacroId: 'qa-other' }), 'u1', new Date(2026, 9, 9, 9), storage)).toBe(true)
  })

  it('keeps the session scope firing on every load but never twice in one load', () => {
    const storage = memoryStorage()
    const once = settings({ startupScope: 'session' })
    expect(shouldRunStartup(once, 'u1', today, storage)).toBe(true)
    markStartupRun('u1', 'qa-mac', today, storage)
    expect(shouldRunStartup(once, 'u1', today, storage)).toBe(false)
    resetStartupSession()
    expect(shouldRunStartup(once, 'u1', today, storage)).toBe(true)
  })

  it('lets a second account on the same browser still have its own first run', () => {
    const storage = memoryStorage()
    const once = settings({ startupScope: 'session' })
    markStartupRun('u1', 'qa-mac', today, storage)
    expect(shouldRunStartup(once, 'u2', today, storage)).toBe(true)
  })

  it('treats a stamp it cannot read as no stamp at all', () => {
    expect(loadStartupStamp(memoryStorage({ [STARTUP_STAMP_KEY]: '{not json' }))).toBeNull()
    expect(loadStartupStamp(memoryStorage({ [STARTUP_STAMP_KEY]: JSON.stringify({ macroId: 3 }) }))).toBeNull()
    const storage = memoryStorage({ [STARTUP_STAMP_KEY]: '{not json' })
    expect(shouldRunStartup(settings(), 'u1', today, storage)).toBe(true)
  })

  it('still decides sensibly when the browser refuses to store anything', () => {
    const broken: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => { throw new Error('private mode') },
      setItem: () => { throw new Error('quota') },
    }
    expect(shouldRunStartup(settings(), 'u1', today, broken)).toBe(true)
    markStartupRun('u1', 'qa-mac', today, broken)
    expect(shouldRunStartup(settings(), 'u1', today, broken), 'the session flag still keeps this load quiet').toBe(false)
  })
})
