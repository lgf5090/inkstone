import { beforeEach, describe, expect, it } from 'vitest'
import { defaultQuickAddSettings, newMacroChoice, newTemplateChoice, type QuickAddChoice, type QuickAddSettings } from '@shared/quickadd'
import {
  STARTUP_STAMP_KEY,
  loadStartupStamps,
  markStartupRun,
  resetStartupSession,
  shouldRunStartup,
  startupDay,
  startupMacros,
} from './startup'

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

function settings(over: Partial<QuickAddSettings> = {}): QuickAddSettings {
  return { ...defaultQuickAddSettings(), ...over }
}

const today = new Date(2026, 9, 8, 9, 0, 0)

beforeEach(() => {
  resetStartupSession()
})

describe('which macros run themselves', () => {
  it('keeps the flagged, switched-on macros in list order', () => {
    const choices: QuickAddChoice[] = [
      { ...newMacroChoice('qa-b', 'Evening', 1), runOnStartup: true },
      { ...newMacroChoice('qa-a', 'Morning', 0), runOnStartup: true },
      { ...newMacroChoice('qa-c', 'Quiet', 2), runOnStartup: true, enabled: false },
      newMacroChoice('qa-d', 'Manual', 3),
      { ...newTemplateChoice('qa-t', 'Not a macro', 4), runOnStartup: true } as QuickAddChoice,
    ]
    expect(startupMacros(choices).map((macro) => macro.id)).toEqual(['qa-a', 'qa-b'])
  })
})

describe('the startup macro’s own clock', () => {
  it('names the reader’s day, not the UTC one', () => {
    expect(startupDay(new Date(2026, 9, 8, 23, 30))).toBe('2026-10-08')
    expect(startupDay(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01')
  })

  it('refuses to run with no macro, a switched-off feature, or nobody signed in', () => {
    const storage = memoryStorage()
    expect(shouldRunStartup(settings(), '', 'u1', today, storage)).toBe(false)
    expect(shouldRunStartup(settings(), 'qa-a', '', today, storage)).toBe(false)
    expect(shouldRunStartup(settings({ enabled: false }), 'qa-a', 'u1', today, storage)).toBe(false)
  })

  it('runs the first time and not again the same day', () => {
    const storage = memoryStorage()
    expect(shouldRunStartup(settings(), 'qa-a', 'u1', today, storage)).toBe(true)
    markStartupRun('u1', 'qa-a', today, storage)
    expect(shouldRunStartup(settings(), 'qa-a', 'u1', today, storage)).toBe(false)
  })

  it('keeps a second macro’s own count, and runs again the next day', () => {
    const storage = memoryStorage()
    markStartupRun('u1', 'qa-a', today, storage)
    expect(shouldRunStartup(settings(), 'qa-b', 'u1', today, storage), 'two flagged macros are two runs').toBe(true)
    resetStartupSession()
    expect(shouldRunStartup(settings(), 'qa-a', 'u1', new Date(2026, 9, 9, 9), storage)).toBe(true)
  })

  it('fires on every load once the reader asks for the session scope', () => {
    const storage = memoryStorage()
    const once = settings({ startupScope: 'session' })
    expect(shouldRunStartup(once, 'qa-a', 'u1', today, storage)).toBe(true)
    markStartupRun('u1', 'qa-a', today, storage)
    expect(shouldRunStartup(once, 'qa-a', 'u1', today, storage)).toBe(false)
    resetStartupSession()
    expect(shouldRunStartup(once, 'qa-a', 'u1', today, storage)).toBe(true)
  })

  it('lets a second account on the same browser still have its own first run', () => {
    const storage = memoryStorage()
    const once = settings({ startupScope: 'session' })
    markStartupRun('u1', 'qa-a', today, storage)
    expect(shouldRunStartup(once, 'qa-a', 'u2', today, storage)).toBe(true)
  })

  it('treats a stamp file it cannot read as no stamps at all', () => {
    expect(loadStartupStamps(memoryStorage({ [STARTUP_STAMP_KEY]: '{not json' }))).toEqual({})
    expect(loadStartupStamps(memoryStorage({ [STARTUP_STAMP_KEY]: '{"qa-a": 3, "__proto__": "polluted"}' }))).toEqual({})
    const storage = memoryStorage({ [STARTUP_STAMP_KEY]: '{not json' })
    expect(shouldRunStartup(settings(), 'qa-a', 'u1', today, storage)).toBe(true)
  })

  it('still decides sensibly when the browser refuses to store anything', () => {
    const broken: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => { throw new Error('private mode') },
      setItem: () => { throw new Error('quota') },
    }
    expect(shouldRunStartup(settings(), 'qa-a', 'u1', today, broken)).toBe(true)
    markStartupRun('u1', 'qa-a', today, broken)
    expect(shouldRunStartup(settings(), 'qa-a', 'u1', today, broken), 'the session set still keeps this load quiet').toBe(false)
  })
})
