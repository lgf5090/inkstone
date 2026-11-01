// @vitest-environment jsdom
/**
 * The appearance panel's own door to a colour the reader picked.
 *
 * `tests/custom-accent-dom.test.ts` follows the value through the store and onto the root element; this is the
 * other half of the path — the eight swatches, the well that only appears once the custom accent is the chosen
 * one, and the setting the wheel writes back. A control the reader can see but not drive is the failure this
 * round already caught twice, so every arm here clicks or types rather than reading a prop.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCENTS, mergeSettings } from '@shared/constants'
import { contrastRatio, parseColor } from '../../../../scripts/lib/contrast.mjs'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { useSession } from '../../store/session'
import { AppearanceSettings } from './AppearanceSettings'

let rendered: RenderedElement | null = null
const CUSTOM = () => t('settings.accent.custom')

function seedSettings(patch: Parameters<typeof mergeSettings>[0]) {
  act(() => {
    useSession.setState({ settings: mergeSettings(patch) })
  })
}

function pickColour(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  seedSettings({ appearance: { accent: 'indigo', accentColor: '' } })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the accent row', () => {
  it('offers the custom accent beside the seven named ones', () => {
    rendered = renderElement(createElement(AppearanceSettings, { accents: ACCENTS }))
    const group = rendered.container.querySelector(`[role="group"][aria-label="${t('settings.accent_color')}"]`)
    expect(group).toBeTruthy()
    const names = [...group!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(ACCENTS.map((accent) => t(`settings.accent.${accent.name}` as never)))
  })

  it('writes the custom accent when its swatch is clicked', () => {
    const update = vi.fn()
    vi.spyOn(useSession.getState(), 'updateSettings').mockImplementation(update)
    rendered = renderElement(createElement(AppearanceSettings, { accents: ACCENTS }))
    const custom = rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${CUSTOM()}"]`)
    expect(custom, 'no custom accent swatch').toBeTruthy()
    expect(custom!.getAttribute('aria-pressed')).toBe('false')
    act(() => custom!.click())
    expect(update).toHaveBeenCalledWith({ appearance: { accent: 'custom' } })
  })

  it('opens the colour wheel only for the accent that needs one', () => {
    rendered = renderElement(createElement(AppearanceSettings, { accents: ACCENTS }))
    expect(rendered.container.querySelector('input[type="color"]'), 'a named accent offered a colour wheel').toBeNull()

    seedSettings({ appearance: { accent: 'custom', accentColor: '#c12a2a' } })
    const well = rendered.container.querySelector<HTMLInputElement>('input[type="color"]')
    expect(well, 'the custom accent offered no colour wheel').toBeTruthy()
    expect(well!.getAttribute('aria-label')).toBe(CUSTOM())
    expect(well!.value).toBe('#c12a2a')
  })

  it('sends the colour the wheel was set to, as the setting stores it', () => {
    seedSettings({ appearance: { accent: 'custom', accentColor: '#c12a2a' } })
    const update = vi.fn()
    vi.spyOn(useSession.getState(), 'updateSettings').mockImplementation(update)
    rendered = renderElement(createElement(AppearanceSettings, { accents: ACCENTS }))
    const well = rendered.container.querySelector<HTMLInputElement>('input[type="color"]')!
    pickColour(well, '#00FF00')
    expect(update).toHaveBeenCalledWith({ appearance: { accent: 'custom', accentColor: '#00ff00' } })
  })

  it('paints the swatch with the colour that is stored', () => {
    seedSettings({ appearance: { accent: 'custom', accentColor: '#336699' } })
    rendered = renderElement(createElement(AppearanceSettings, { accents: ACCENTS }))
    const custom = rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${CUSTOM()}"]`)!
    // The cascade reports a hex background as its rgb triple — both jsdom and a browser — so this reads what
    // paints rather than what was typed into the attribute.
    expect(custom.style.background).toBe('rgb(51, 102, 153)')
  })

  it('keeps the selected mark readable on whatever colour was picked', () => {
    // Measured in Chromium first: with `#ffee00` stored the mark was pure white on it, 1.2:1, so the row
    // showed no selected state at all. The mark has to follow the colour it sits on, which is the same
    // question every swatch label in this app asks.
    for (const hex of ['#ffee00', '#c12a2a', '#ffffff', '#000000', '#808080']) {
      seedSettings({ appearance: { accent: 'custom', accentColor: hex } })
      rendered = renderElement(createElement(AppearanceSettings, { accents: ACCENTS }))
      const custom = rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${CUSTOM()}"]`)!
      const tick = custom.querySelector('svg')
      expect(tick, `${hex} was selected without a mark`).toBeTruthy()
      const ink = parseColor(getComputedStyle(tick!).color)
      const swatch = parseColor(hex)
      expect(ink, `${getComputedStyle(tick!).color} is not a colour this gate can read`).toBeTruthy()
      const ratio = contrastRatio(ink!.rgb, swatch!.rgb)
      // 3:1 is the WCAG floor for a graphic that carries state; text on it would need 4.5.
      expect(ratio, `${hex} paints its mark at ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
      rendered.unmount()
      rendered = null
    }
  })

  it('marks an empty custom swatch with the theme ink, not with white', () => {
    // An unset colour paints no background at all, so the mark sits on the page: it has to take a token that
    // the theme can make dark or light, the way every other empty affordance in the app does.
    seedSettings({ appearance: { accent: 'custom', accentColor: '' } })
    rendered = renderElement(createElement(AppearanceSettings, { accents: ACCENTS }))
    const custom = rendered.container.querySelector<HTMLButtonElement>(`button[aria-label="${CUSTOM()}"]`)!
    expect(custom.style.background).toBe('transparent')
    expect(custom.style.color).toBe('var(--text-secondary)')
  })
})
