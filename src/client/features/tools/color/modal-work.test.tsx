// @vitest-environment jsdom
/**
 * What the dialogs do while nobody is looking at them.
 *
 * `ColorApp` keeps all five modals mounted for the life of the tool and each one subscribes to
 * `currentHex`, so a single step of the hue slider re-ran `generateTokenScale`, five
 * `simulateColorBlindness` calls, a WCAG evaluation and the whole export preview. The measurements are
 * fractions of a millisecond each — the point of these tests is that the work happens on open and not
 * at all while closed, which a DOM assertion cannot see because `Modal` already renders nothing.
 */
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getColorSpaceValues } from '@shared/tools/color/spaces'
import { evaluateWcagContrast, simulateColorBlindness } from '@shared/tools/color/a11y'
import { generateTokenScale } from '@shared/tools/color/token-scale'
import { exportToCssVariables, triggerDownload } from './lib/export-engine'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, t } from '../../../lib/i18n'
import { useColorStudioStore } from './store'
import { useUi } from '../../../store/ui'
import { ColorBlindnessModal } from './components/modals/ColorBlindnessModal'
import { ContrastCheckerModal } from './components/modals/ContrastCheckerModal'
import { ExportPaletteModal } from './components/modals/ExportPaletteModal'
import { TokenScaleModal } from './components/modals/TokenScaleModal'

vi.mock('@shared/tools/color/token-scale', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/tools/color/token-scale')>()
  return { ...actual, generateTokenScale: vi.fn(actual.generateTokenScale) }
})
vi.mock('@shared/tools/color/a11y', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/tools/color/a11y')>()
  return {
    ...actual,
    simulateColorBlindness: vi.fn(actual.simulateColorBlindness),
    evaluateWcagContrast: vi.fn(actual.evaluateWcagContrast),
  }
})
vi.mock('./lib/export-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/export-engine')>()
  return { ...actual, exportToCssVariables: vi.fn(actual.exportToCssVariables), triggerDownload: vi.fn() }
})

let rendered: RenderedElement | null = null

const cssCalls = () => vi.mocked(exportToCssVariables).mock.calls.length
const tokenCalls = () => vi.mocked(generateTokenScale).mock.calls.length
const cvdCalls = () => vi.mocked(simulateColorBlindness).mock.calls.length
const wcagCalls = () => vi.mocked(evaluateWcagContrast).mock.calls.length

function setHex(hex: string): void {
  act(() => {
    useColorStudioStore.setState({ currentHex: hex, colorSpaceValues: getColorSpaceValues(hex) })
  })
}

beforeEach(async () => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
  await initI18n()
  useColorStudioStore.setState({
    currentHex: '#627486',
    colorSpaceValues: getColorSpaceValues('#627486'),
    isTokenScaleModalOpen: false,
    isColorBlindnessModalOpen: false,
    isContrastModalOpen: false,
    isExportPaletteModalOpen: false,
    exportTargetPalette: null,
  })
})

describe('closed dialogs do no work', () => {
  it('skips the token scale until the dialog opens', () => {
    rendered = renderElement(createElement(TokenScaleModal))
    expect(tokenCalls()).toBe(0)

    for (const hex of ['#ff0000', '#00ff00', '#0000ff']) setHex(hex)
    expect(tokenCalls()).toBe(0)
    expect(rendered!.container.textContent).toBe('')

    act(() => {
      useColorStudioStore.getState().openTokenScaleModal()
    })
    expect(tokenCalls()).toBeGreaterThan(0)
  })

  it('skips all five simulations until the colour-blindness dialog opens', () => {
    rendered = renderElement(createElement(ColorBlindnessModal))
    setHex('#ff8800')
    setHex('#0088ff')
    expect(cvdCalls()).toBe(0)

    act(() => {
      useColorStudioStore.getState().openColorBlindnessModal()
    })
    expect(cvdCalls()).toBe(5)
  })

  it('skips the WCAG evaluation until the contrast dialog opens', () => {
    rendered = renderElement(createElement(ContrastCheckerModal))
    setHex('#112233')
    expect(wcagCalls()).toBe(0)

    act(() => {
      useColorStudioStore.getState().openContrastModal()
    })
    // Opening seeds the background from the studio colour, so the first paint costs two evaluations.
    expect(wcagCalls()).toBeGreaterThan(0)
  })

  it('skips the export preview until the export dialog opens', () => {
    rendered = renderElement(createElement(ExportPaletteModal))
    setHex('#445566')
    setHex('#667788')
    expect(cssCalls()).toBe(0)

    act(() => {
      useColorStudioStore.getState().openExportPaletteModal({ title: 'Dusk', colors: ['#445566', '#667788'] })
    })
    expect(cssCalls()).toBeGreaterThan(0)
  })
})

describe('download file names', () => {
  function downloadNames(): string[] {
    return vi.mocked(triggerDownload).mock.calls.map((call) => call[1])
  }

  function pickFormat(label: string): void {
    const option = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find(
      (node) => node.textContent?.trim() === label,
    )!
    act(() => {
      option.click()
    })
  }

  function clickDownload(): void {
    const button = Array.from(document.querySelectorAll('button')).find((node) =>
      node.textContent?.includes(t('tools.color.export.download')),
    )!
    act(() => {
      button.click()
    })
  }

  it('slugifies the palette title into every format', () => {
    rendered = renderElement(createElement(ExportPaletteModal))
    act(() => {
      useColorStudioStore.getState().openExportPaletteModal({ title: 'Sunset Dusk', colors: ['#123456'] })
    })

    clickDownload()
    expect(downloadNames()).toEqual(['sunset-dusk.css'])

    pickFormat(t('tools.color.export.format_json'))
    clickDownload()
    expect(downloadNames()).toEqual(['sunset-dusk.css', 'sunset-dusk.json'])
  })

  it('names a Tailwind export after the palette, not after the project config', () => {
    rendered = renderElement(createElement(ExportPaletteModal))
    act(() => {
      useColorStudioStore.getState().openExportPaletteModal({ title: 'Sunset Dusk', colors: ['#123456'] })
    })

    pickFormat(t('tools.color.export.format_tailwind'))
    clickDownload()

    // `tailwind.config.js` was the literal name for every palette: exporting a second one overwrote the file
    // the first download had just placed in the reader's folder, next to the real project config.
    expect(downloadNames()).toEqual(['sunset-dusk.tailwind.js'])
  })

  it('folds an underscore in the title into the separator', () => {
    rendered = renderElement(createElement(ExportPaletteModal))
    act(() => {
      useColorStudioStore.getState().openExportPaletteModal({ title: 'Morning_Dew', colors: ['#123456'] })
    })

    clickDownload()

    // Carrying `_` through made `--color-Morning_Dew-1`, which no sheet in this app uses as a name.
    expect(vi.mocked(triggerDownload).mock.calls[0]![1]).toBe('morning-dew.css')
  })

  it('falls back to a usable name when the title has no Latin letters', () => {
    rendered = renderElement(createElement(ExportPaletteModal))
    act(() => {
      useColorStudioStore.getState().openExportPaletteModal({ title: '暮山紫', colors: ['#123456'] })
    })

    clickDownload()

    // Every character used to fail the ASCII filter, leaving `----.css` and a `--color-----1` variable.
    expect(downloadNames()).toEqual(['palette.css'])
    expect(vi.mocked(exportToCssVariables).mock.results[0]!.value).toContain('--color-palette-1:')
  })

  it('reports a download as a download', () => {
    act(() => {
      useUi.setState({ toasts: [] })
    })
    rendered = renderElement(createElement(ExportPaletteModal))
    act(() => {
      useColorStudioStore.getState().openExportPaletteModal({ title: 'Dusk', colors: ['#123456'] })
    })

    clickDownload()

    const titles = useUi.getState().toasts.map((item) => item.title)
    expect(titles).toContain(t('tools.color.toast.downloaded', { name: 'dusk.css' }))
    // The old copy reused the clipboard template with "File Downloaded" pasted into it, which told the
    // reader their download had been a copy.
    expect(titles).not.toContain(t('tools.color.toast.copied', { label: 'File Downloaded', value: 'dusk.css' }))
  })
})
