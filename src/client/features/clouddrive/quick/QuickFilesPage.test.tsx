// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useCloudDriveStore } from '../store'
import { QuickFilesPage } from './QuickFilesPage'

const recent = vi.hoisted(() => vi.fn())

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    clouddriveApi: { ...actual.clouddriveApi, recent },
  }
})

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
  recent.mockReset()
  useCloudDriveStore.setState({ refreshKey: 0 })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('QuickFilesPage read states', () => {
  it('keeps the loading state distinct from an empty recent list', async () => {
    let resolve!: (value: { files: []; cursor: null }) => void
    recent.mockReturnValue(new Promise((done) => { resolve = done }))
    view = renderElement(createElement(QuickFilesPage, { mode: 'recent' }))
    await settle()

    expect(document.querySelector('[role="status"]')?.textContent).toContain(t('clouddrive.loading'))
    expect(document.body.textContent).not.toContain(t('clouddrive.empty.recent'))

    await act(async () => { resolve({ files: [], cursor: null }) })
    await settle()
    expect(document.body.textContent).toContain(t('clouddrive.empty.recent'))
  })

  it('shows a retryable failure instead of claiming there are no starred files', async () => {
    recent.mockRejectedValueOnce(new Error('offline'))
    view = renderElement(createElement(QuickFilesPage, { mode: 'starred' }))
    await settle()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('clouddrive.error.internal'))
    expect(document.body.textContent).not.toContain(t('clouddrive.empty.starred'))

    recent.mockResolvedValueOnce({ files: [], cursor: null })
    await act(async () => { button(t('clouddrive.retry'))!.click() })
    await settle()
    expect(recent).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain(t('clouddrive.empty.starred'))
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
})
