// @vitest-environment jsdom
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getColorSpaceValues } from '@shared/tools/color/spaces'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, t } from '../../../lib/i18n'
import { useColorStudioStore } from './store'
import { ColorStudioView } from './views/ColorStudioView'
import { UiPaletteView } from './views/UiPaletteView'
import { TokenScaleModal } from './components/modals/TokenScaleModal'

vi.mock('./api', () => ({
  colorApi: {
    getSettings: vi.fn().mockResolvedValue({
      stripHash: false,
      defaultFormat: 'hex',
      defaultUiTab: 'tailwind',
      autoSaveHistory: false,
      updatedAt: 1,
    }),
    addHistory: vi.fn().mockResolvedValue({}),
    listHistory: vi.fn().mockResolvedValue([]),
    listFavorites: vi.fn().mockResolvedValue([]),
    listPalettes: vi.fn().mockResolvedValue([]),
    createFavorite: vi.fn().mockResolvedValue({ id: 'f' }),
  },
}))

let rendered: RenderedElement | null = null

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  installTestGlobals()
  await initI18n()
  useColorStudioStore.setState({
    currentHex: '#627486',
    colorSpaceValues: getColorSpaceValues('#627486'),
    settings: { stripHash: false, defaultFormat: 'hex', defaultUiTab: 'tailwind', autoSaveHistory: false, updatedAt: 1 },
  })
})

describe('Hex field', () => {
  it('keeps focus and the caret when the typed value commits', () => {
    rendered = renderElement(createElement(ColorStudioView))
    const input = document.querySelector<HTMLInputElement>(
      `input[aria-label="${t('tools.color.studio.hex_input_label')}"]`,
    )!

    act(() => {
      input.focus()
      type(input, '#a1')
    })
    act(() => {
      type(input, '#a1b2c3')
    })

    expect(useColorStudioStore.getState().currentHex).toBe('#a1b2c3')
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('#a1b2c3')
  })

  it('accepts the three-digit shorthand', () => {
    rendered = renderElement(createElement(ColorStudioView))
    const input = document.querySelector<HTMLInputElement>(
      `input[aria-label="${t('tools.color.studio.hex_input_label')}"]`,
    )!
    act(() => {
      type(input, 'f09')
    })
    expect(useColorStudioStore.getState().currentHex).toBe('#ff0099')
  })

  it('says so when the value is not a color', () => {
    rendered = renderElement(createElement(ColorStudioView))
    const input = document.querySelector<HTMLInputElement>(
      `input[aria-label="${t('tools.color.studio.hex_input_label')}"]`,
    )!
    act(() => {
      type(input, '#zz')
    })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain(t('tools.color.contrast.invalid'))
    expect(useColorStudioStore.getState().currentHex).toBe('#627486')
  })
})

describe('Color wheel semantics', () => {
  it('names itself and reports both channels', () => {
    rendered = renderElement(createElement(ColorStudioView))
    const wheel = document.querySelector('[role="slider"]')!
    expect(wheel.getAttribute('aria-label')).toBe(t('tools.color.studio.color_wheel'))
    expect(wheel.getAttribute('aria-label')).not.toBe(t('tools.color.studio.subtitle'))
    expect(wheel.getAttribute('aria-valuetext')).toContain('16')
  })
})

describe('Token scale strip', () => {
  it('reflows instead of clipping on a narrow surface', () => {
    useColorStudioStore.setState({ isTokenScaleModalOpen: true })
    rendered = renderElement(createElement(TokenScaleModal))
    const strip = document.querySelector('[data-testid="token-scale-strip"]')
    expect(strip?.className).toContain('grid-cols-4')
    expect(strip?.className).toContain('md:grid-cols-11')
    expect(strip?.className).not.toMatch(/(^|\s)grid-cols-11(\s|$)/)
  })
})

describe('Preset search', () => {
  it('keeps every row when the box refuses the pattern', () => {
    rendered = renderElement(createElement(UiPaletteView))
    const before = document.querySelectorAll('[data-testid="ui-palette-group"]').length
    const box = document.querySelector<HTMLInputElement>(
      `input[aria-label="${t('tools.color.ui.search_aria')}"]`,
    )!

    act(() => {
      type(box, '/(((/')
    })

    expect(document.querySelectorAll('[data-testid="ui-palette-group"]').length).toBe(before)
    expect(box.getAttribute('aria-invalid')).toBe('true')
  })

  it('matches on the initials of a Chinese name the way the sidebar boxes do', () => {
    rendered = renderElement(createElement(UiPaletteView))
    const box = document.querySelector<HTMLInputElement>(
      `input[aria-label="${t('tools.color.ui.search_aria')}"]`,
    )!
    const blue = document.querySelectorAll('[data-testid="ui-palette-group"]').length
    expect(blue).toBeGreaterThan(0)

    act(() => {
      type(box, 'blue')
    })
    expect(document.querySelectorAll('[data-testid="ui-palette-group"]').length).toBeLessThan(blue)
  })
})
