// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { DriveRequestPage } from './DriveRequestPage'

const service = vi.hoisted(() => ({
  fileRequest: vi.fn(),
  verifyRequest: vi.fn(),
  uploadToRequest: vi.fn(),
}))

vi.mock('./api', () => ({ cloudDrivePublicApi: service }))

const info = {
  name: 'Homework drop',
  hasPassword: false,
  expiresAt: null,
  maxFiles: 2,
  maxBytes: 1000,
  maxFileBytes: 500,
  receivedFiles: 0,
  receivedBytes: 0,
}

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

beforeEach(async () => {
  await initI18n()
  service.fileRequest.mockReset().mockResolvedValue(info)
  service.verifyRequest.mockReset()
  service.uploadToRequest.mockReset().mockResolvedValue({ name: 'answer.txt' })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('DriveRequestPage states and refusals', () => {
  it('offers a retry when the upload link cannot be read', async () => {
    service.fileRequest.mockRejectedValueOnce(new Error('offline'))
    view = renderElement(createElement(DriveRequestPage, { slug: 'request' }))
    await settle()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('clouddrive.request.unavailable'))
    await act(async () => { button(t('clouddrive.retry'))!.click() })
    await settle()
    expect(service.fileRequest).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain(info.name)
  })

  it('turns a refused upload into a visible error without an unhandled rejection', async () => {
    service.uploadToRequest.mockRejectedValueOnce(new Error('refused'))
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    try {
      view = renderElement(createElement(DriveRequestPage, { slug: 'request' }))
      await settle()
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', { configurable: true, value: [new File(['answer'], 'answer.txt')] })
      await act(async () => { button(t('clouddrive.request.upload'))!.click() })
      await settle()

      expect(service.uploadToRequest).toHaveBeenCalledTimes(1)
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('clouddrive.request.upload_failed'))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('unhandledrejection', unhandled)
    }
  })
})
