// @vitest-environment jsdom
import { act, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { initI18n, t } from '../../../lib/i18n'
import { useToolsStore } from '../store'
import { ColorApp } from './ColorApp'
import { colorApi } from './api'
import { getColorSpaceValues } from '@shared/tools/color/spaces'
import { useColorStudioStore } from './store'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    colorApi: {
      getSettings: vi.fn().mockResolvedValue({
        stripHash: false,
        defaultFormat: 'hex',
        defaultUiTab: 'tailwind',
        autoSaveHistory: true,
        updatedAt: 1,
      }),
      updateSettings: vi.fn().mockImplementation(async (partial: Record<string, unknown>) => ({
        stripHash: false,
        defaultFormat: 'hex',
        defaultUiTab: 'tailwind',
        autoSaveHistory: true,
        updatedAt: 2,
        ...partial,
      })),
      addHistory: vi.fn().mockResolvedValue({}),
      listHistory: vi.fn().mockResolvedValue([]),
      listFavorites: vi.fn().mockResolvedValue([]),
      listPalettes: vi.fn().mockResolvedValue([]),
    },
  }
})

let rendered: RenderedElement | null = null

beforeEach(async () => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  installTestGlobals()
  await initI18n()
  vi.mocked(colorApi.updateSettings).mockClear()
  useColorStudioStore.setState({
    settings: {
      stripHash: false,
      defaultFormat: 'hex',
      defaultUiTab: 'tailwind',
      autoSaveHistory: true,
      updatedAt: 1,
    },
  })
})

async function openSettings() {
  rendered = renderElement(createElement(ColorApp))
  act(() => {
    useToolsStore.setState({ activeColorView: 'settings' })
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('Color settings surface', () => {
  it('is reachable from the module shell', async () => {
    await openSettings()
    expect(document.body.textContent).toContain(t('tools.color.settings.title'))
  })

  it('sends each control to the server and keeps the answer', async () => {
    await openSettings()

    const format = document.querySelector<HTMLSelectElement>('select#color-default-format')!
    await act(async () => {
      format.value = 'rgb'
      format.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(colorApi.updateSettings).toHaveBeenLastCalledWith({ defaultFormat: 'rgb' })
    expect(useColorStudioStore.getState().settings.defaultFormat).toBe('rgb')

    const toggle = document.querySelector<HTMLButtonElement>('button#color-strip-hash')!
    await act(async () => {
      toggle.click()
    })
    expect(colorApi.updateSettings).toHaveBeenLastCalledWith({ stripHash: true })
    expect(useColorStudioStore.getState().settings.stripHash).toBe(true)

    const history = document.querySelector<HTMLButtonElement>('button#color-auto-save')!
    await act(async () => {
      history.click()
    })
    expect(colorApi.updateSettings).toHaveBeenLastCalledWith({ autoSaveHistory: false })
  })

  it('names every control it draws', async () => {
    await openSettings()
    for (const id of ['color-default-format', 'color-default-tab']) {
      const control = document.getElementById(id)
      expect(control, id).toBeTruthy()
      expect(document.querySelector(`label[for="${id}"]`), `label for ${id}`).toBeTruthy()
    }
    for (const id of ['color-strip-hash', 'color-auto-save']) {
      expect(document.getElementById(id)?.getAttribute('aria-label'), id).toBeTruthy()
    }
  })
})

describe('Settings are honored where they are read', () => {
  it('opens UI Palettes on the configured tab', async () => {
    // ColorApp refetches settings on mount, so the value under test has to come from the server.
    vi.mocked(colorApi.getSettings).mockResolvedValueOnce({
      stripHash: false,
      defaultFormat: 'hex',
      defaultUiTab: 'antd',
      autoSaveHistory: true,
      updatedAt: 1,
    })
    useColorStudioStore.setState({
      settings: {
        stripHash: false,
        defaultFormat: 'hex',
        defaultUiTab: 'antd',
        autoSaveHistory: true,
        updatedAt: 1,
      },
    })
    rendered = renderElement(createElement(ColorApp))
    act(() => {
      useToolsStore.setState({ activeColorView: 'ui_palettes' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    const selected = [...document.querySelectorAll('[role="radio"][aria-checked="true"]')].map((t) => t.textContent)
    expect(selected.some((label) => label?.includes('Ant Design'))).toBe(true)
  })

  it('copies in the configured format', async () => {
    vi.mocked(colorApi.getSettings).mockResolvedValueOnce({
      stripHash: false,
      defaultFormat: 'rgb',
      defaultUiTab: 'tailwind',
      autoSaveHistory: false,
      updatedAt: 1,
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    useColorStudioStore.setState({
      settings: {
        stripHash: false,
        defaultFormat: 'rgb',
        defaultUiTab: 'tailwind',
        autoSaveHistory: false,
        updatedAt: 1,
      },
      currentHex: '#627486',
      colorSpaceValues: getColorSpaceValues('#627486'),
    })
    rendered = renderElement(createElement(ColorApp))
    act(() => {
      useToolsStore.setState({ activeColorView: 'studio' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    const copyButton = document.querySelector<HTMLButtonElement>('button[aria-label="' + t('tools.color.studio.copy_all') + '"]')!
    await act(async () => {
      copyButton.click()
    })
    expect(writeText).toHaveBeenCalledWith('rgb(98, 116, 134)')
  })
})
