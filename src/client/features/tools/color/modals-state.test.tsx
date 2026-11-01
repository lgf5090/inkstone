// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getColorSpaceValues, hslToRgb, rgbToHex } from '@shared/tools/color/spaces'
import type { GradientConfig } from '@shared/tools/color/types'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, t } from '../../../lib/i18n'
import { useColorStudioStore } from './store'
import { ContrastCheckerModal } from './components/modals/ContrastCheckerModal'
import { CreateCustomPaletteModal } from './components/modals/CreateCustomPaletteModal'
import { GradientBarController } from './components/GradientBarController'
import { colorApi } from './api'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    colorApi: {
      getSettings: vi.fn().mockResolvedValue({
        stripHash: false,
        defaultFormat: 'hex',
        defaultUiTab: 'flat_ui',
        autoSaveHistory: false,
        updatedAt: 1,
      }),
      addHistory: vi.fn().mockResolvedValue({}),
      listHistory: vi.fn().mockResolvedValue([]),
      listFavorites: vi.fn().mockResolvedValue([]),
      listPalettes: vi.fn().mockResolvedValue([]),
      createFavorite: vi.fn().mockResolvedValue({ id: 'f', hex: '#000000' }),
      createPalette: vi.fn().mockResolvedValue({ id: 'p', title: 'x', colors: [] }),
      deletePalette: vi.fn().mockResolvedValue({ ok: true }),
      togglePaletteFavorite: vi.fn().mockResolvedValue({ id: 'p', isFavorite: true }),
    },
  }
})

let rendered: RenderedElement | null = null

function hexInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])')].filter(
    (input) => input.maxLength === 7,
  )
}

/**
 * Types into a controlled input the way a keyboard does.
 *
 * Assigning `.value` directly leaves React's own tracker convinced nothing changed, so the synthetic event
 * never reaches the component and the assertions read a form that was never filled.
 */
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
    currentHex: '#c2703d',
    favorites: [],
    palettes: [],
    history: [],
    isContrastModalOpen: false,
    isCreatePaletteModalOpen: false,
    settings: { stripHash: false, defaultFormat: 'hex', defaultUiTab: 'flat_ui', autoSaveHistory: false, updatedAt: 1 },
  })
})

describe('ContrastCheckerModal', () => {
  it('starts from the color on screen, not the one the app booted with', () => {
    useColorStudioStore.setState({ currentHex: '#1f6f4a' })
    rendered = renderElement(createElement(ContrastCheckerModal))
    act(() => {
      useColorStudioStore.getState().openContrastModal()
    })

    const [fg, bg] = hexInputs(document.body)
    expect(fg.value.toLowerCase()).toBe('#ffffff')
    expect(bg.value.toLowerCase()).toBe('#1f6f4a')
  })

  it('refuses to score a value it cannot read', () => {
    rendered = renderElement(createElement(ContrastCheckerModal))
    act(() => {
      useColorStudioStore.getState().openContrastModal()
    })

    const [fg] = hexInputs(document.body)
    act(() => {
      type(fg, 'zzz')
    })

    expect(document.body.querySelector('[data-testid="contrast-ratio"]')).toBeNull()
    expect(document.body.querySelector('[role="status"]')).toBeTruthy()
    expect(fg.getAttribute('aria-invalid')).toBe('true')
  })

  it('scores a valid pair', () => {
    rendered = renderElement(createElement(ContrastCheckerModal))
    act(() => {
      useColorStudioStore.getState().openContrastModal()
    })
    expect(document.body.textContent).toContain(t('tools.color.contrast.ratio'))
    expect(document.body.querySelector('[data-testid="contrast-ratio"]')).toBeTruthy()
    expect(document.body.querySelector('[role="status"]')).toBeNull()
  })
})

describe('CreateCustomPaletteModal', () => {
  const titleInput = () => document.querySelector<HTMLInputElement>('input[maxlength="100"]')!

  it('seeds the first row with the color on screen and resets between openings', async () => {
    useColorStudioStore.setState({ currentHex: '#0a1428' })
    rendered = renderElement(createElement(CreateCustomPaletteModal))
    act(() => {
      useColorStudioStore.getState().openCreatePaletteModal()
    })

    expect(hexInputs(document.body)[0].value.toLowerCase()).toBe('#0a1428')

    act(() => {
      type(titleInput(), '草稿')
    })
    act(() => {
      useColorStudioStore.getState().closeCreatePaletteModal()
    })
    act(() => {
      useColorStudioStore.getState().openCreatePaletteModal()
    })

    expect(titleInput().value).toBe('')
  })

  it('stays open when the save fails', async () => {
    const createPalette = vi.mocked(colorApi.createPalette)
    createPalette.mockRejectedValueOnce(new Error('quota'))

    rendered = renderElement(createElement(CreateCustomPaletteModal))
    act(() => {
      useColorStudioStore.getState().openCreatePaletteModal()
    })

    await act(async () => {
      type(titleInput(), '保存失败也要留下')
    })
    const saveButton = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === t('tools.color.create_palette.save'),
    )!
    await act(async () => {
      saveButton.click()
    })

    expect(createPalette).toHaveBeenCalledTimes(1)
    expect(useColorStudioStore.getState().isCreatePaletteModalOpen).toBe(true)
  })

  it('closes once the palette is stored', async () => {
    rendered = renderElement(createElement(CreateCustomPaletteModal))
    act(() => {
      useColorStudioStore.getState().openCreatePaletteModal()
    })
    await act(async () => {
      type(titleInput(), '可保存')
    })
    const saveButton = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === t('tools.color.create_palette.save'),
    )!
    await act(async () => {
      saveButton.click()
    })

    expect(useColorStudioStore.getState().isCreatePaletteModalOpen).toBe(false)
  })
})

describe('GradientBarController stops', () => {
  const initial: GradientConfig = {
    type: 'linear',
    angle: 90,
    useOklabInterpolation: false,
    stops: [
      { id: 'a', color: '#ff0000', offset: 0 },
      { id: 'b', color: '#0000ff', offset: 100 },
    ],
  }

  function Harness() {
    const [config, setConfig] = useState<GradientConfig>(initial)
    const [active, setActive] = useState('a')
    return (
      <div>
        <GradientBarController
          config={config}
          onChange={setConfig}
          activeStopId={active}
          onSelectStop={setActive}
        />
        <span id="count">{config.stops.length}</span>
        <span id="ids">{config.stops.map((s) => s.id).join(',')}</span>
      </div>
    )
  }

  it('selects a stop when the click lands on it instead of stacking another', () => {
    rendered = renderElement(createElement(Harness))
    const track = document.querySelector('button[aria-label]' ) as HTMLButtonElement
    const box = { left: 0, width: 100 } as DOMRect
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ ...box, top: 0, height: 28, right: 100, bottom: 28, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)

    // 0% is where stop `a` already sits.
    act(() => {
      track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1 }))
    })
    expect(document.getElementById('count')!.textContent).toBe('2')

    act(() => {
      track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50 }))
    })
    expect(document.getElementById('count')!.textContent).toBe('3')
    const ids = document.getElementById('ids')!.textContent!.split(',')
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('Studio sliders', () => {
  it('moves the hue without disturbing the other two channels', async () => {
    const { ColorStudioView } = await import('./views/ColorStudioView')
    rendered = renderElement(createElement(ColorStudioView))
    const hueSlider = document.querySelectorAll<HTMLInputElement>('input[type="range"]')[0]

    // Several seeds on purpose: a color whose rounded HSL happens to survive the round trip would pass
    // either implementation, and the rounded one is the bug this pins.
    const seeds = Array.from({ length: 40 }, (_, i) =>
      rgbToHex({ r: (i * 7919) % 256, g: (i * 104729) % 256, b: (i * 15485863) % 256 }, true),
    )

    for (const start of seeds) {
      const base = getColorSpaceValues(start).hslExact
      act(() => {
        useColorStudioStore.setState({ currentHex: start, colorSpaceValues: getColorSpaceValues(start) })
      })
      const nextHue = (Math.round(base.h) + 30) % 360

      act(() => {
        type(hueSlider, String(nextHue))
      })

      const expected = rgbToHex(hslToRgb({ h: nextHue, s: base.s, l: base.l }), true)
      expect(useColorStudioStore.getState().currentHex, start).toBe(expected)
    }
  })
})
