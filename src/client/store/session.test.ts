import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettingsPatch } from '@shared/constants'
import type { UserSettings } from '@shared/types'
import { initI18n } from '../lib/i18n'
import { api } from '../lib/api'
import { syncAppearanceToDom, useSession } from './session'
import { useUi } from './ui'

beforeEach(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  await initI18n()
  syncAppearanceToDom(DEFAULT_SETTINGS)
})

afterEach(() => vi.unstubAllGlobals())

describe('appearance synchronization', () => {
  it('does not rewrite the document or notify UI subscribers for unchanged appearance', () => {
    const observer = new MutationObserver(() => {})
    observer.observe(document.documentElement, { attributes: true, subtree: true, childList: true })
    const changed = vi.fn()
    const unsubscribe = useUi.subscribe(changed)
    try {
      syncAppearanceToDom(DEFAULT_SETTINGS)
      syncAppearanceToDom(mergeSettingsPatch(DEFAULT_SETTINGS, {
        editor: { spellcheck: !DEFAULT_SETTINGS.editor.spellcheck },
      }))
      expect(observer.takeRecords()).toHaveLength(0)
      expect(changed).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
      observer.disconnect()
    }
  })

  it('applies changed typography immediately without rewriting unrelated root attributes', () => {
    const observer = new MutationObserver(() => {})
    observer.observe(document.documentElement, { attributes: true })
    try {
      syncAppearanceToDom(mergeSettingsPatch(DEFAULT_SETTINGS, { appearance: { proseSize: 20 } }))
      expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('20px')
      expect(observer.takeRecords().map((record) => record.attributeName)).toEqual(['style'])
    } finally {
      observer.disconnect()
    }
  })
})

describe('settings patch queue', () => {
  const flush = () => new Promise((resolve) => {
    window.setTimeout(resolve, 700)
  })

  it('sends every group written inside one debounce window', async () => {
    const original = useSession.getState().settings
    const bodies: Partial<UserSettings>[] = []
    vi.spyOn(api.settings, 'save').mockImplementation(async (body) => {
      bodies.push(body)
      return mergeSettingsPatch(original, body)
    })
    try {
      useSession.getState().updateSettings({ appearance: { proseSize: 19 } })
      useSession.getState().updateSettings({ search: { maxIndexedNotes: 5400 } })
      await flush()
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toEqual({ appearance: { proseSize: 19 }, search: { maxIndexedNotes: 5400 } })
      expect(useSession.getState().settings.search.maxIndexedNotes).toBe(5400)
    } finally {
      useSession.setState({ settings: original })
    }
  })

  it('keeps a write that lands while the previous patch is still in flight', async () => {
    const original = useSession.getState().settings
    const pending: (() => void)[] = []
    const bodies: Partial<UserSettings>[] = []
    const settle = () => {
      for (const resolve of pending.splice(0, pending.length)) resolve()
    }
    vi.spyOn(api.settings, 'save').mockImplementation((body) => {
      bodies.push(body)
      return new Promise<UserSettings>((resolve) => {
        pending.push(() => resolve(mergeSettingsPatch(original, body)))
      })
    })
    try {
      useSession.getState().updateSettings({ search: { maxIndexedNotes: 5500 } })
      await flush()
      expect(bodies).toEqual([{ search: { maxIndexedNotes: 5500 } }])
      useSession.getState().updateSettings({ search: { maxIndexedNotes: 5600 } })
      settle()
      await flush()
      expect(bodies).toEqual([{ search: { maxIndexedNotes: 5500 } }, { search: { maxIndexedNotes: 5600 } }])
      expect(useSession.getState().settings.search.maxIndexedNotes).toBe(5600)
    } finally {
      settle()
      useSession.setState({ settings: original })
    }
  })
})
