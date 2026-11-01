// @vitest-environment jsdom
/**
 * The tool has to speak the reader's language.
 *
 * Every string named here used to live inside the module as English data — the harmony families, the five
 * colour-vision conditions, the AI style chips, the fallback palette title — which no gate could see
 * because they were never in a JSX attribute. A Chinese interface showed two languages on one screen, and
 * the English went into saved palettes.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getHarmonies } from '@shared/tools/color/harmonies'
import { generateAlgorithmicPalettes } from '@shared/tools/color/colorspace-algorithms'
import { getColorSpaceValues } from '@shared/tools/color/spaces'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, setLocale, t } from '../../../lib/i18n'
import { useColorStudioStore } from './store'
import { algorithmName, harmonyName } from './lib/display-names'
import { HarmoniesPanel } from './components/HarmoniesPanel'
import { ColorBlindnessModal } from './components/modals/ColorBlindnessModal'
import { ExportPaletteModal } from './components/modals/ExportPaletteModal'
import { AiPaletteView } from './views/AiPaletteView'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    colorApi: {
      ...actual.colorApi,
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
      generatePalette: vi.fn().mockResolvedValue(null),
    },
  }
})

let rendered: RenderedElement | null = null

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
    })
  }
}

beforeEach(async () => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
  await initI18n()
  await setLocale('zh-CN', false)
  useColorStudioStore.setState({
    currentHex: '#627486',
    colorSpaceValues: getColorSpaceValues('#627486'),
    favorites: [],
    palettes: [],
    history: [],
    isColorBlindnessModalOpen: false,
    isExportPaletteModalOpen: false,
    exportTargetPalette: null,
    settings: { stripHash: false, defaultFormat: 'hex', defaultUiTab: 'tailwind', autoSaveHistory: false, updatedAt: 1 },
  })
})

afterEach(async () => {
  rendered?.unmount()
  rendered = null
  await setLocale('en-US', false)
})

describe('the data carries no copy', () => {
  it('hands the harmony families to the catalogue', () => {
    const harmonies = getHarmonies('#627486')
    for (const group of harmonies) {
      expect(group).not.toHaveProperty('label')
      expect(group).not.toHaveProperty('description')
    }
    expect(harmonies[0]!.type).toBe('complementary')
  })

  it('hands the algorithmic palettes to the catalogue', () => {
    for (const palette of generateAlgorithmicPalettes('#627486')) {
      expect(palette).not.toHaveProperty('name')
      expect(palette).not.toHaveProperty('description')
    }
  })

  it('resolves a harmony through the message family', () => {
    expect(harmonyName('complementary')).toBe('互补色')
    expect(harmonyName('split_complementary')).toBe('分裂互补')
    expect(harmonyName('complementary')).not.toBe('Complementary')
    expect(algorithmName('cube')).toBe('立方色板')
    expect(algorithmName('generic_gradient')).not.toBe('generic_gradient')
  })
})

describe('the screens answer in Chinese', () => {
  it('names the harmony families in the reader language', async () => {
    rendered = renderElement(createElement(HarmoniesPanel, { currentHex: '#627486' }))
    await settle()

    const text = document.body.textContent ?? ''
    expect(text).toContain('互补色')
    expect(text).not.toContain('Complementary')
    expect(text).not.toContain('maximum visual energy')
  })

  it('names the five colour-vision conditions in the reader language', async () => {
    rendered = renderElement(createElement(ColorBlindnessModal))
    act(() => {
      useColorStudioStore.getState().openColorBlindnessModal()
    })
    await settle()

    const text = document.body.textContent ?? ''
    expect(text).toContain('正常视觉')
    expect(text).toContain('绿色盲')
    expect(text).not.toContain('Normal Vision')
    expect(text).not.toContain('Green-weak')
  })

  it('lists the AI styles and tones in the reader language', async () => {
    rendered = renderElement(createElement(AiPaletteView))
    await settle()

    const style = document.querySelector<HTMLSelectElement>('select#color-ai-style')!
    const tone = document.querySelector<HTMLSelectElement>('select#color-ai-tone')!
    const styleOptions = Array.from(style.options).map((option) => option.textContent)
    const toneOptions = Array.from(tone.options).map((option) => option.textContent)

    expect(styleOptions).toContain('莫兰迪')
    expect(styleOptions).not.toContain('Morandi')
    expect(toneOptions).toContain('暖调')
    // The value the model is asked for stays the English keyword the prompt is written with.
    expect(Array.from(style.options).map((option) => option.value)).toContain('Morandi')
  })

  it('names the palette it exports when the caller had no title for it', async () => {
    rendered = renderElement(createElement(ExportPaletteModal))
    act(() => {
      // The fallback row is what the studio's own export button meets: a single colour, no saved title.
      useColorStudioStore.setState({ exportTargetPalette: null, isExportPaletteModalOpen: true })
    })
    await settle()

    expect(document.body.textContent).toContain(t('tools.color.export.default_title'))
    expect(document.body.textContent).not.toContain('Color Scheme')
  })
})
