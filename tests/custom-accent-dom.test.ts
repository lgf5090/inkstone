// @vitest-environment jsdom
/**
 * Where a picked accent reaches the interface.
 *
 * `tests/custom-accent-contrast.test.ts` judges the four numbers; this judges the three ways they arrive and
 * the one way they leave: painted onto the root element, recomputed when the theme flips under them, cleared
 * when the reader picks a named accent again, and refused at both doors a value can come through — the
 * settings merge and the locally cached copy of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCustomAccent, clearCustomAccent, deriveCustomAccent } from '../src/client/lib/custom-accent'
import { applyThemeToDom } from '../src/client/store/ui'
import { mergeSettings } from '@shared/constants'
import { UI_STORAGE_KEY } from '../src/client/lib/runtime'

const CUSTOM_VARS = ['--accent', '--accent-hover', '--accent-contrast', '--accent-on-soft'] as const
const SEED = '#c12a2a'

function appearance(accent: string, accentColor: string, theme = 'light') {
  return { theme: theme as 'light' | 'dark', accent: accent as never, accentColor, background: 'paper' as never, fontScale: 16 }
}

beforeEach(() => {
  document.documentElement.removeAttribute('style')
  localStorage.clear()
})

describe('painting the accent onto the root element', () => {
  it('writes exactly the four variables and removes exactly those four', () => {
    applyCustomAccent(document.documentElement, SEED, 'light')
    for (const name of CUSTOM_VARS) {
      expect(document.documentElement.style.getPropertyValue(name), `${name} left unset`).not.toBe('')
    }
    clearCustomAccent(document.documentElement)
    for (const name of CUSTOM_VARS) {
      expect(document.documentElement.style.getPropertyValue(name), `${name} survived the clear`).toBe('')
    }
  })

  it('writes nothing for an empty pick', () => {
    // An unread accent must not leave four inline properties the cascade cannot see through.
    applyCustomAccent(document.documentElement, '', 'light')
    for (const name of CUSTOM_VARS) expect(document.documentElement.style.getPropertyValue(name)).toBe('')
  })

  it('recomputes when the theme flips under the same colour', () => {
    applyCustomAccent(document.documentElement, SEED, 'light')
    const light = document.documentElement.style.getPropertyValue('--accent')
    applyCustomAccent(document.documentElement, SEED, 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).not.toBe(light)
  })

  it('measures the wash against the surfaces the cascade actually reports', () => {
    // jsdom resolves these tokens to nothing, so the walk has no surface to judge and must hand back the
    // accent itself rather than invent a text colour.
    applyCustomAccent(document.documentElement, SEED, 'light')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--accent-on-soft')).toBe(root.style.getPropertyValue('--accent'))
  })
})

describe('applyThemeToDom', () => {
  it('paints the custom accent only when both the name and the colour say so', () => {
    applyThemeToDom(appearance('custom', SEED))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(deriveCustomAccent(SEED, 'light', [])['--accent'])
    expect(document.documentElement.dataset.accent).toBe('custom')

    applyThemeToDom(appearance('custom', ''))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')

    applyThemeToDom(appearance('indigo', SEED))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
    expect(document.documentElement.dataset.accent).toBe('indigo')
  })

  it('clears the custom properties when the reader goes back to a named accent', () => {
    applyThemeToDom(appearance('custom', SEED))
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).not.toBe('')
    applyThemeToDom(appearance('celadon', SEED))
    for (const name of CUSTOM_VARS) {
      expect(document.documentElement.style.getPropertyValue(name), `${name} left over from the custom accent`).toBe('')
    }
  })
})

describe('the doors a colour comes through', () => {
  it('keeps a plain hex and lowercases it', () => {
    const merged = mergeSettings({ appearance: { accent: 'custom', accentColor: '#C12A2A' } })
    expect(merged.appearance.accentColor).toBe('#c12a2a')
    expect(merged.appearance.accent).toBe('custom')
  })

  it('refuses anything that is not a plain hex, keeping the previous colour', () => {
    for (const junk of ['#c12a2', 'red', '#c12a2z', 'var(--accent)', ' url("javascript:1")', 42, null, undefined]) {
      expect(mergeSettings({ appearance: { accent: 'custom', accentColor: junk } }).appearance.accentColor).toBe('')
    }
    const kept = mergeSettings({ appearance: { accent: 'custom', accentColor: '#00ff00' } })
    expect(mergeSettings({ appearance: { accentColor: 'not a colour' } }).appearance.accentColor).toBe('')
    expect(kept.appearance.accentColor).toBe('#00ff00')
  })

  it('reads a cached accent back, and drops a cached colour that is not one', async () => {
    const load = async (payload: Record<string, unknown>) => {
      localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(payload))
      vi.resetModules()
      const mod = await import('../src/client/store/ui')
      return mod.useUi.getState()
    }
    const good = await load({ accent: 'custom', accentColor: '#C12A2A' })
    expect(good.accent).toBe('custom')
    expect(good.accentColor).toBe('#c12a2a')

    const junk = await load({ accent: 'custom', accentColor: 'url(#filter)' })
    expect(junk.accentColor).toBe('')

    const unknownAccent = await load({ accent: 'not-a-theme', accentColor: '#c12a2a' })
    expect(unknownAccent.accent).toBe('indigo')
  })
})
