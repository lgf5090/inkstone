// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { DriveSharePage } from './DriveSharePage'

const service = vi.hoisted(() => ({
  share: vi.fn(),
  listShare: vi.fn(),
  verifyShare: vi.fn(),
  shareContentUrl: vi.fn((slug: string, path: string, download: boolean) => `/d/${slug}/${path}?download=${download}`),
}))

vi.mock('./api', () => ({ cloudDrivePublicApi: service }))

const meta = {
  name: 'Team folder',
  path: '/',
  targetKind: 'folder' as const,
  locked: false,
  hasPassword: false,
  allowDownload: true,
  disabled: false,
}

let view: RenderedElement | null = null

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
}

beforeEach(async () => {
  await initI18n()
  service.share.mockReset().mockResolvedValue(meta)
  service.listShare.mockReset().mockResolvedValue({ entries: [], cursor: null, total: 0 })
  service.verifyShare.mockReset()
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('DriveSharePage folder states', () => {
  it('does not turn a failed folder read into an empty folder', async () => {
    service.listShare.mockRejectedValueOnce(new Error('offline'))
    view = renderElement(createElement(DriveSharePage, { slug: 'share' }))
    await settle()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('clouddrive.share.folder_load_failed'))
    expect(document.body.textContent).not.toContain(t('clouddrive.share.folder_empty'))

    await act(async () => { button(t('clouddrive.retry'))!.click() })
    await settle()
    expect(service.listShare).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain(t('clouddrive.share.folder_empty'))
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('offers a retry when the share metadata cannot be read', async () => {
    service.share.mockRejectedValueOnce(new Error('offline'))
    view = renderElement(createElement(DriveSharePage, { slug: 'share' }))
    await settle()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('clouddrive.share.unavailable'))
    expect(service.listShare).not.toHaveBeenCalled()

    await act(async () => { button(t('clouddrive.retry'))!.click() })
    await settle()
    expect(service.share).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain(meta.name)
  })
})
