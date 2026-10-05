import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale, initI18n, setLocaleAsync, t } from '../../lib/i18n'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'
import { SettingsPanel } from './SettingsPanel'
import { settingsLoaders } from './sections'

vi.mock('./AccountSettings', () => new Promise(() => {}))
vi.mock('./EditorSettings', () => ({
  EditorSettings: () => createElement('input', { 'aria-label': 'Draft', defaultValue: '' }),
}))
vi.mock('./SyncSettings', () => ({
  SyncSettings: () => createElement('div', { 'data-setting-title': t('settings.realtime_sync') }),
}))
vi.mock('./sections', async (original) => ({
  ...await original<typeof import('./sections')>(),
  scheduleSettingsWarmup: () => () => {},
  warmSettingsSection: vi.fn(),
}))

let root: Root
let container: HTMLDivElement
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  Element.prototype.scrollIntoView = vi.fn()
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) await act(() => root.unmount())
  container?.remove()
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  Element.prototype.scrollIntoView = originalScrollIntoView
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('settings panel responsiveness', () => {
  it('retries a failed section without reloading the application', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(settingsLoaders, 'sync')
      .mockRejectedValueOnce(new Error('Chunk unavailable'))
      .mockResolvedValue({ default: () => createElement('p', null, 'Recovered section') })
    await act(() => root.render(createElement(SettingsPanel, { onClose: vi.fn() })))
    const button = [...document.querySelectorAll('nav button')].find((node) => node.textContent === t('settings.sync'))!
    await act(async () => {
      (button as HTMLButtonElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const error = document.querySelector('[role="alert"]')!
    expect(error).not.toBeNull()
    await act(async () => {
      error.querySelector('button')!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('Recovered section')
  })
  it('opens immediately and keeps navigation and dismissal usable while a section is loading', async () => {
    const onClose = vi.fn()
    await act(() => root.render(createElement(SettingsPanel, { onClose })))
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain(t('settings.interface_language'))

    const select = async (label: string) => {
      const button = [...dialog.querySelectorAll('nav button')].find((node) => node.textContent === label)!
      await act(() => (button as HTMLButtonElement).click())
    }
    await select(t('settings.account'))
    expect(dialog.querySelector('[role="status"]')).not.toBeNull()
    expect(dialog.querySelector('[aria-current="page"]')?.textContent).toBe(t('settings.account'))

    await select(t('settings.appearance'))
    expect(dialog.querySelector('[aria-hidden="false"] [role="status"]')).toBeNull()
    expect(dialog.textContent).toContain(t('settings.interface_language'))

    await select(t('settings.account'))
    const close = dialog.querySelector<HTMLButtonElement>(`button[aria-label="${t('common.close')}"]`)!
    await act(() => close.click())
    expect(onClose).toHaveBeenCalledOnce()
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('retains visited content, drafts and scroll position and remembers the last section after reopening', async () => {
    const onClose = vi.fn()
    await act(() => root.render(createElement(SettingsPanel, { onClose })))
    const select = async (label: string) => {
      const button = [...document.querySelectorAll('nav button')].find((node) => node.textContent === label)!
      await act(async () => {
        (button as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    await select(t('settings.editor'))
    const input = document.querySelector<HTMLInputElement>('[aria-label="Draft"]')!
    expect(input).not.toBeNull()
    input.value = 'Unsaved draft'
    const body = input.closest<HTMLDivElement>('[aria-hidden="false"]')!
    body.scrollTop = 140
    await select(t('settings.appearance'))
    expect(body.hidden).toBe(true)
    expect(body.hasAttribute('inert')).toBe(true)
    await select(t('settings.editor'))
    expect(document.querySelector('[aria-label="Draft"]')).toBe(input)
    expect(input.value).toBe('Unsaved draft')
    expect(body.scrollTop).toBe(140)

    await act(() => root.render(null))
    await act(() => root.render(createElement(SettingsPanel, { onClose })))
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe(t('settings.editor'))
    expect(document.querySelector<HTMLInputElement>('[aria-label="Draft"]')?.value).toBe('')
  })
})

const searchInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!

function searchInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`input[aria-label="${t('settings.search_placeholder')}"]`)!
}

async function typeQuery(value: string) {
  await act(() => {
    searchInputValue.call(searchInput(), value)
    searchInput().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('settings search', () => {
  it('narrows the section list to matches and keeps the pages mounted but inert', async () => {
    await act(() => root.render(createElement(SettingsPanel, { onClose: vi.fn() })))
    const dialog = document.querySelector('[role="dialog"]')!
    await typeQuery(t('settings.empty_trash'))
    const results = [...dialog.querySelectorAll('[data-settings-hit]')].map((node) => node.textContent)
    expect(results.some((text) => text.includes(t('settings.empty_trash')))).toBe(true)
    const navLabels = [...dialog.querySelectorAll('nav button')].map((node) => node.textContent!)
    expect(navLabels.some((label) => label.startsWith(t('settings.data')))).toBe(true)
    expect(navLabels.some((label) => label.startsWith(t('settings.appearance')))).toBe(false)
    expect(dialog.querySelector('[data-settings-page="appearance"]')!.hasAttribute('inert')).toBe(true)
    await typeQuery('')
    expect([...dialog.querySelectorAll('nav button')].map((node) => node.textContent)).toContain(t('settings.appearance'))
    expect(dialog.querySelector('[data-settings-page="appearance"]')!.hasAttribute('inert')).toBe(false)
  })

  it('says so when nothing matches', async () => {
    await act(() => root.render(createElement(SettingsPanel, { onClose: vi.fn() })))
    await typeQuery('nosuchsettinganywhere')
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(t('settings.search_no_results'))
  })

  it('jumps to a setting in a section that has not been opened yet', async () => {
    await act(() => root.render(createElement(SettingsPanel, { onClose: vi.fn() })))
    const dialog = document.querySelector('[role="dialog"]')!
    await typeQuery(t('settings.realtime_sync'))
    await act(() => (dialog.querySelector<HTMLButtonElement>('[data-settings-hit]')!).click())
    expect(searchInput().value).toBe('')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    const page = dialog.querySelector('[data-settings-page="sync"]')!
    expect(page.hasAttribute('inert')).toBe(false)
    expect(page.querySelector('[data-settings-target]')?.getAttribute('data-setting-title')).toBe(t('settings.realtime_sync'))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('opens the first match from the keyboard', async () => {
    await act(() => root.render(createElement(SettingsPanel, { onClose: vi.fn() })))
    await typeQuery(t('settings.theme'))
    await act(() => searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(searchInput().value).toBe('')
    expect(document.querySelector('[data-settings-target]')?.getAttribute('data-setting-title')).toBe(t('settings.theme'))
  })

  it('marks the section instead of spinning when the exact row is not rendered', async () => {
    await act(() => root.render(createElement(SettingsPanel, { onClose: vi.fn() })))
    const dialog = document.querySelector('[role="dialog"]')!
    await typeQuery(t('settings.polling_interval'))
    await act(() => (dialog.querySelector<HTMLButtonElement>('[data-settings-hit]')!).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    const page = dialog.querySelector('[data-settings-page="sync"]')!
    expect(page.getAttribute('data-settings-target')).toBe('section')
    expect(page.querySelector('[data-settings-target="row"]')).toBeNull()
  })

  it('recomputes the result list when the language changes while searching', async () => {
    const original = getLocale()
    await act(() => root.render(createElement(SettingsPanel, { onClose: vi.fn() })))
    const dialog = document.querySelector('[role="dialog"]')!
    await typeQuery(t('settings.theme'))
    const first = () => dialog.querySelector('[data-settings-hit]')!.textContent!
    expect(first()).toContain((original === 'zh-CN' ? ZH_CN_MESSAGES : EN_US_MESSAGES)['settings.theme'])
    const next = original === 'en-US' ? 'zh-CN' : 'en-US'
    try {
      await act(async () => {
        await setLocaleAsync(next, false)
      })
      expect(first()).toContain((next === 'zh-CN' ? ZH_CN_MESSAGES : EN_US_MESSAGES)['settings.theme'])
    }
    finally {
      await act(async () => {
        await setLocaleAsync(original, false)
      })
    }
  })

  it('clears the query on escape before it closes the panel', async () => {
    const onClose = vi.fn()
    await act(() => root.render(createElement(SettingsPanel, { onClose })))
    await typeQuery(t('settings.theme'))
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).not.toHaveBeenCalled()
    expect(searchInput().value).toBe('')
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
