// @vitest-environment jsdom
/**
 * The picker's two doors.
 *
 * `accept` only filters the file dialog: a picture dragged onto the panel reaches the handler with whatever
 * type the operating system felt like reporting, and used to be read whole into React state as a data URL.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLOR_ASSET_MAX_BYTES } from '@shared/tools/color/contract'
import { getColorSpaceValues } from '@shared/tools/color/spaces'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, t } from '../../../lib/i18n'
import { useColorStudioStore } from './store'
import { ImagePaletteView, imageFileRejection } from './views/ImagePaletteView'
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

let rendered: RenderedElement | null = null

const max = Math.floor(COLOR_ASSET_MAX_BYTES / (1024 * 1024))

beforeEach(async () => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.clearAllMocks()
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
})

describe('source file guard', () => {
  it('refuses a file that is not a picture', () => {
    expect(imageFileRejection({ type: 'text/plain', size: 10 })).toEqual({
      key: 'tools.color.image.reject_not_image',
    })
  })

  it('refuses an unlabelled drag, which is what a file with no reported type arrives as', () => {
    expect(imageFileRejection({ type: '', size: 10 })).toEqual({
      key: 'tools.color.image.reject_not_image',
    })
  })

  it('refuses a picture over the ceiling instead of holding its base64 in state', () => {
    expect(imageFileRejection({ type: 'image/png', size: COLOR_ASSET_MAX_BYTES + 1 })).toEqual({
      key: 'tools.color.image.reject_too_large',
      params: { max },
    })
  })

  it('accepts a picture inside the ceiling, the SVG sample included', () => {
    expect(imageFileRejection({ type: 'image/png', size: 64 })).toBeNull()
    expect(imageFileRejection({ type: 'image/svg+xml', size: 64 })).toBeNull()
    expect(imageFileRejection({ type: 'image/webp', size: COLOR_ASSET_MAX_BYTES })).toBeNull()
  })

  it('names the ceiling it applied in the message', () => {
    const rejection = imageFileRejection({ type: 'image/png', size: COLOR_ASSET_MAX_BYTES + 1 })!
    expect(t(rejection.key, rejection.params)).toBe(t('tools.color.image.reject_too_large', { max }))
    expect(t(rejection.key, rejection.params)).toContain(String(max))
  })
})

describe('picker', () => {
  it('keeps the file input rendered, unnamed and out of the tab order', async () => {
    // `hidden` is `display:none`, and an input that is not laid out cannot open a dialog in every engine.
    // It must stay invisible-but-rendered, and it must not become a second, nameless stop on the tab ring:
    // the drop zone and the upload button are the controls a reader meets.
    rendered = renderElement(createElement(ImagePaletteView))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input, 'the picker vanished from the tree').toBeTruthy()
    expect(input!.className, 'the picker is display:none again').not.toContain('hidden')
    expect(input!.className).toContain('sr-only')
    expect(input!.getAttribute('aria-hidden')).toBe('true')
    expect(input!.tabIndex).toBe(-1)
  })

  it('clears the input so the same file can be chosen twice', async () => {
    rendered = renderElement(createElement(ImagePaletteView))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    // jsdom will not accept a filename written by a test, and it fires `change` whether or not the value
    // changed — so the recorder is the only way to see the reset the browser actually depends on.
    const written: string[] = []
    Object.defineProperty(input, 'value', {
      get: () => 'C:\\fakepath\\notes.txt',
      set: (next: string) => written.push(next),
      configurable: true,
    })
    await act(async () => {
      Object.defineProperty(input, 'files', {
        value: [new File(['not a picture'], 'notes.txt', { type: 'text/plain' })],
        configurable: true,
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 5))
    })

    // The browser compares values: leaving the rejected name in place means a second pick of the same file
    // fires no change event, and the panel stays showing the picture the reader already replaced.
    expect(written).toContain('')
    expect(useUi.getState().toasts.map((item) => item.title)).toContain(
      t('tools.color.image.reject_not_image'),
    )
  })
})
