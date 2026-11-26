// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLOUDDRIVE_SETTINGS } from '@shared/clouddrive/settings'
import { ConfirmHost } from '../../../components/overlay'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { CloudDriveSettingsPage } from './CloudDriveSettingsPage'

const api = vi.hoisted(() => ({ settings: vi.fn(), purge: vi.fn() }))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, clouddriveApi: { ...actual.clouddriveApi, settings: api.settings, purge: api.purge } }
})

const settings = { ...DEFAULT_CLOUDDRIVE_SETTINGS, webdavHasPassword: false }
let view: RenderedElement | null = null

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
}

function mount(): void {
  view = renderElement(createElement('div', null,
    createElement(CloudDriveSettingsPage, { owner: true }),
    createElement(ConfirmHost),
  ))
}

beforeEach(async () => {
  await initI18n()
  api.settings.mockReset().mockResolvedValue({ settings })
  api.purge.mockReset().mockResolvedValue({ deleted: 2, failed: 0 })
  useUi.setState({ toasts: [] })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useUi.setState({ toasts: [] })
})

describe('CloudDriveSettingsPage states and refusals', () => {
  it('shows loading until settings arrive', async () => {
    let resolve!: (value: { settings: typeof settings }) => void
    api.settings.mockReturnValue(new Promise((done) => { resolve = done }))
    mount()
    await settle()

    expect(document.querySelector('[role="status"]')?.textContent).toContain(t('clouddrive.loading'))
    expect(document.body.textContent).not.toContain(t('clouddrive.settings.title'))

    await act(async () => { resolve({ settings }) })
    await settle()
    expect(document.body.textContent).toContain(t('clouddrive.settings.title'))
  })

  it('offers a retry when settings cannot be read', async () => {
    api.settings.mockRejectedValueOnce(new Error('offline'))
    mount()
    await settle()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('clouddrive.settings.load_failed'))
    await act(async () => { button(t('clouddrive.retry'))!.click() })
    await settle()
    expect(api.settings).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain(t('clouddrive.settings.title'))
  })

  it('handles a refused purge without an unhandled rejection', async () => {
    api.purge.mockRejectedValueOnce(new Error('refused'))
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    try {
      mount()
      await settle()
      await act(async () => { button(t('clouddrive.settings.empty_trash'))!.click() })
      await settle()
      await act(async () => { button(t('overlay.confirm'))!.click() })
      await settle()

      expect(api.purge).toHaveBeenCalledWith({ all: true })
      expect(useUi.getState().toasts.at(-1)?.title).toBe(t('clouddrive.settings.empty_trash_failed'))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('unhandledrejection', unhandled)
    }
  })
})
