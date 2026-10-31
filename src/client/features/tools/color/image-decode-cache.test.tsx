// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractPaletteFromPixels } from '@shared/tools/color/quantize'
import { getColorSpaceValues } from '@shared/tools/color/spaces'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, t } from '../../../lib/i18n'
import { useColorStudioStore } from './store'
import { ImagePaletteView } from './views/ImagePaletteView'
import { useUi } from '../../../store/ui'

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
    },
  }
})
vi.mock('@shared/tools/color/quantize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/tools/color/quantize')>()
  return { ...actual, extractPaletteFromPixels: vi.fn(actual.extractPaletteFromPixels) }
})

let rendered: RenderedElement | null = null

/** Pixels read back from the fake canvas: every one transparent black, which the quantizer still accepts. */
const getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({
  data: new Uint8ClampedArray(width * height * 4),
  width,
  height,
  colorSpace: 'srgb',
}))

const quantizeCalls = () => vi.mocked(extractPaletteFromPixels).mock.calls.map((call) => call[1])

/** Whether a picture of this size has to be shrunk before it reaches the quantizer. */
const SAMPLE_WIDTH = 900
const SAMPLE_HEIGHT = 600
const MAX_DIMENSION = 320

class FakeImage {
  static fails = false

  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = SAMPLE_WIDTH
  naturalHeight = SAMPLE_HEIGHT
  private source = ''

  get src(): string {
    return this.source
  }

  set src(value: string) {
    this.source = value
    // The decode is handed back on a later turn, so a request started earlier can still answer last.
    setTimeout(() => {
      if (FakeImage.fails) this.onerror?.()
      else this.onload?.()
    }, 0)
  }
}

function slider(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[type="range"]')!
}

function moveSliderTo(value: number): void {
  const input = slider()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // The shared slider commits the draft on release, which is what a keyboard or pointer drag ends with.
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
  })
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
  }
}

const toastTitles = () => useUi.getState().toasts.map((item) => item.title)

beforeEach(async () => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
  FakeImage.fails = false
  vi.stubGlobal('Image', FakeImage)
  vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => ({ drawImage: vi.fn(), getImageData })) as never,
  )
  await initI18n()
  act(() => {
    useUi.setState({ toasts: [] })
    useColorStudioStore.setState({
      currentHex: '#627486',
      colorSpaceValues: getColorSpaceValues('#627486'),
    })
  })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('decode cache', () => {
  it('decodes once and re-quantizes for every other count on the slider', async () => {
    rendered = renderElement(createElement(ImagePaletteView))
    await settle()

    expect(getImageData).toHaveBeenCalledTimes(1)
    expect(quantizeCalls()).toEqual([8])

    moveSliderTo(9)
    await settle()
    moveSliderTo(10)
    await settle()

    // Three counts asked for, one decode paid for: each step used to reload the file, redraw the canvas
    // and read its pixels back before throwing all of that away on the next step.
    expect(quantizeCalls()).toEqual([8, 9, 10])
    expect(getImageData).toHaveBeenCalledTimes(1)
  })

  it('shrinks the picture to the processing ceiling before reading pixels', async () => {
    rendered = renderElement(createElement(ImagePaletteView))
    await settle()

    const call = getImageData.mock.calls[0]!
    expect(call[0]).toBe(0)
    expect(call[1]).toBe(0)
    expect(call[2]).toBe(MAX_DIMENSION)
    expect(call[3]).toBe(Math.round((SAMPLE_HEIGHT * MAX_DIMENSION) / SAMPLE_WIDTH))
  })

  it('names the failure when the picture cannot be decoded', async () => {
    FakeImage.fails = true
    rendered = renderElement(createElement(ImagePaletteView))
    await settle()

    expect(toastTitles()).toContain(t('tools.color.toast.extract_failed'))
    // The spinner is a promise the panel can no longer keep: leaving it spinning hides the message.
    expect(document.querySelector('[aria-busy="true"], .animate-spin')).toBeNull()
  })
})
