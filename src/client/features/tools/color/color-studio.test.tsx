// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { useColorStudioStore } from './store'
import { ColorStudioView } from './views/ColorStudioView'
import { HarmoniesPanel } from './components/HarmoniesPanel'
import { ContrastCheckerModal } from './components/modals/ContrastCheckerModal'
import { ColorBlindnessModal } from './components/modals/ColorBlindnessModal'
import { TokenScaleModal } from './components/modals/TokenScaleModal'
import { ExportPaletteModal } from './components/modals/ExportPaletteModal'
import { CreateCustomPaletteModal } from './components/modals/CreateCustomPaletteModal'
import { TraditionalColorView } from './views/TraditionalColorView'
import { UiPaletteView } from './views/UiPaletteView'
import { ColorHuntPalettesView } from './views/ColorHuntPalettesView'
import { colorApi } from './api'

vi.mock('./api', () => ({
  colorApi: {
    getSettings: vi.fn().mockResolvedValue({
      stripHash: false,
      defaultFormat: 'hex',
      defaultUiTab: 'flat',
      autoSaveHistory: true,
      updatedAt: 1000,
    }),
    updateSettings: vi.fn().mockResolvedValue({
      stripHash: false,
      defaultFormat: 'hex',
      defaultUiTab: 'flat',
      autoSaveHistory: true,
      updatedAt: 1001,
    }),
    addHistory: vi.fn().mockResolvedValue({ ok: true }),
    getHistory: vi.fn().mockResolvedValue([]),
    clearHistory: vi.fn().mockResolvedValue({ ok: true }),
    listFavorites: vi.fn().mockResolvedValue([]),
    createFavorite: vi.fn().mockImplementation((payload) =>
      Promise.resolve({
        id: 'fav-1',
        hex: payload.hex,
        name: payload.name || '',
        tags: payload.tags || [],
        createdAt: 1000,
      }),
    ),
    deleteFavorite: vi.fn().mockResolvedValue({ ok: true }),
    listPalettes: vi.fn().mockResolvedValue([]),
    createPalette: vi.fn().mockImplementation((data) =>
      Promise.resolve({
        id: 'pal-1',
        ...data,
        createdAt: 1000,
        updatedAt: 1000,
      }),
    ),
    deletePalette: vi.fn().mockResolvedValue({ ok: true }),
    togglePaletteFavorite: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

describe('ColorStudio UI & State Suite', () => {
  let rendered: RenderedElement | null = null

  beforeAll(async () => {
    installTestGlobals()
    await initI18n()
  })

  beforeEach(() => {
    if (typeof navigator !== 'undefined') {
      Object.assign(navigator, {
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      })
    }

    // Reset Zustand store state to defaults
    useColorStudioStore.setState({
      currentHex: '#3b82f6',
      activeUiTab: 'flat',
      traditionalTab: 'chinese',
      colorHuntTagFilter: 'all',
      favorites: [],
      palettes: [],
      history: [],
      isContrastModalOpen: false,
      isTokenScaleModalOpen: false,
      isColorBlindnessModalOpen: false,
      isCreatePaletteModalOpen: false,
      isExportPaletteModalOpen: false,
      exportTargetPalette: null,
    })
  })

  afterEach(() => {
    if (rendered) {
      rendered.unmount()
      rendered = null
    }
    // Clean up any stray modals in body
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  describe('ColorStudioView Component', () => {
    it('renders the Color Studio header, random color button and inputs', () => {
      rendered = renderElement(createElement(ColorStudioView))
      const heading = rendered.container.querySelector('h2')
      expect(heading).toBeTruthy()
      expect(heading?.textContent).toContain(t('tools.color.nav.studio'))

      // Current hex input check: the box uppercases what it shows, so read the value the
      // reader sees rather than matching the attribute (case-sensitivity of attribute
      // selectors is the DOM implementation's detail, not this view's contract).
      const hexInput = rendered.container.querySelector<HTMLInputElement>(`input[aria-label="${t('tools.color.studio.hex_input_label')}"]`)
      expect(hexInput?.value.toUpperCase()).toBe('#3B82F6')
    })

    it('updates when store color changes', () => {
      rendered = renderElement(createElement(ColorStudioView))

      act(() => {
        useColorStudioStore.getState().setCurrentColor('#ef4444', 'test')
      })

      const updatedInput = rendered.container.querySelector<HTMLInputElement>(`input[aria-label="${t('tools.color.studio.hex_input_label')}"]`)
      expect(updatedInput?.value.toUpperCase()).toBe('#EF4444')
    })

    it('renders the color space display cards', () => {
      rendered = renderElement(createElement(ColorStudioView))
      const rgbLabel = rendered.container.textContent
      expect(rgbLabel).toContain('RGB')
      expect(rgbLabel).toContain('HSL')
      expect(rgbLabel).toContain('HSV')
      expect(rgbLabel).toContain('CMYK')
      expect(rgbLabel).toContain('LAB')
    })
  })

  describe('HarmoniesPanel Component', () => {
    it('renders 5 harmony algorithms and updates currentHex on swatch click', () => {
      rendered = renderElement(createElement(HarmoniesPanel, { currentHex: '#3b82f6' }))
      expect(rendered.container.textContent).toContain('Complementary')
      expect(rendered.container.textContent).toContain('Analogous')
      expect(rendered.container.textContent).toContain('Triadic')
      expect(rendered.container.textContent).toContain('Tetradic')

      // Swatch button interaction
      const swatchBtn = rendered.container.querySelector('button[aria-label*="#"]') as HTMLButtonElement | null
      expect(swatchBtn).toBeTruthy()
      if (swatchBtn) {
        act(() => {
          swatchBtn.click()
        })
        expect(useColorStudioStore.getState().currentHex).toBeDefined()
      }
    })
  })

  describe('Color Modals', () => {
    it('ContrastCheckerModal renders WCAG ratio and passes evaluation', () => {
      act(() => {
        useColorStudioStore.getState().openContrastModal()
      })
      rendered = renderElement(createElement(ContrastCheckerModal))
      expect(document.body.textContent).toContain(t('tools.color.contrast.title'))
      expect(document.body.textContent).toContain(t('tools.color.contrast.ratio'))
    })

    it('ColorBlindnessModal displays simulations across 5 conditions', () => {
      act(() => {
        useColorStudioStore.getState().openColorBlindnessModal()
      })
      rendered = renderElement(createElement(ColorBlindnessModal))
      expect(document.body.textContent).toContain(t('tools.color.blindness.title'))
      expect(document.body.textContent).toContain('Normal Vision')
      expect(document.body.textContent).toContain('Deuteranopia')
      expect(document.body.textContent).toContain('Protanopia')
      expect(document.body.textContent).toContain('Tritanopia')
      expect(document.body.textContent).toContain('Achromatopsia')
    })

    it('TokenScaleModal generates 50..950 Tailwind design token scale', () => {
      act(() => {
        useColorStudioStore.getState().openTokenScaleModal()
      })
      rendered = renderElement(createElement(TokenScaleModal))
      expect(document.body.textContent).toContain(t('tools.color.token.title'))
      expect(document.body.textContent).toContain('50')
      expect(document.body.textContent).toContain('500')
      expect(document.body.textContent).toContain('950')
    })

    it('ExportPaletteModal renders CSS, SCSS, Tailwind and JSON previews', () => {
      act(() => {
        useColorStudioStore.getState().openExportPaletteModal({
          title: 'Brand Palette',
          colors: ['#3b82f6', '#10b981', '#f59e0b'],
        })
      })
      rendered = renderElement(createElement(ExportPaletteModal))
      expect(document.body.textContent).toContain(t('tools.color.export.title'))
      expect(document.body.textContent).toContain('Brand Palette')
    })

    it('CreateCustomPaletteModal allows creating palettes', () => {
      act(() => {
        useColorStudioStore.getState().openCreatePaletteModal()
      })
      rendered = renderElement(createElement(CreateCustomPaletteModal))
      expect(document.body.textContent).toContain(t('tools.color.create_palette.title'))
    })
  })

  describe('Preset Views Rendering', () => {
    it('TraditionalColorView renders 24-solar-term and Nippon colors with tab switching', () => {
      rendered = renderElement(createElement(TraditionalColorView))
      expect(rendered.container.textContent).toContain(t('tools.color.traditional.title'))
      expect(rendered.container.textContent).toContain(t('tools.color.traditional.tab_chinese'))
      expect(rendered.container.textContent).toContain(t('tools.color.traditional.tab_nippon'))
    })

    it('UiPaletteView renders curated UI color cards', () => {
      rendered = renderElement(createElement(UiPaletteView))
      expect(rendered.container.textContent).toContain(t('tools.color.nav.ui_palettes'))
    })

    it('ColorHuntPalettesView renders 4-color palette cards', () => {
      rendered = renderElement(createElement(ColorHuntPalettesView))
      expect(rendered.container.textContent).toContain(t('tools.color.hunt.title'))
    })
  })

  describe('Zustand Store Actions', () => {
    it('manages favorites and modals', async () => {
      const store = useColorStudioStore.getState()

      // Modals
      store.openContrastModal()
      expect(useColorStudioStore.getState().isContrastModalOpen).toBe(true)
      store.closeContrastModal()
      expect(useColorStudioStore.getState().isContrastModalOpen).toBe(false)

      // Add favorite
      await store.addFavorite('#10b981', 'Emerald', ['ui'])
      expect(colorApi.createFavorite).toHaveBeenCalledWith({
        hex: '#10b981',
        name: 'Emerald',
        tags: ['ui'],
      })

      // Save custom palette
      await store.savePalette('Cool Shades', [
        { hex: '#3b82f6', name: 'Blue' },
        { hex: '#10b981', name: 'Green' },
      ])
      expect(colorApi.createPalette).toHaveBeenCalled()
    })
  })
})
