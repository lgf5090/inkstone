import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectShare } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { ShareDialog } from './ShareDialog'
import * as api from './api'
import { confirm } from '../../components/overlay'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  getProjectShare: vi.fn(),
  putProjectShare: vi.fn(),
  deleteProjectShare: vi.fn(),
}))

vi.mock('../../components/overlay', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../components/overlay')>(),
  confirm: vi.fn(),
}))

const share: ProjectShare = {
  slug: 'share-slug', boardId: 'b1', hasPassword: true, expiresAt: null, views: 3,
  showComments: false, intake: { enabled: false, editable: false, title: '', propertyIds: [], requiredPropertyIds: [] }, createdAt: 1,
}

let view: RenderedElement

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  await initI18n()
  vi.clearAllMocks()
  vi.mocked(api.getProjectShare).mockResolvedValue(share)
  vi.mocked(api.putProjectShare).mockImplementation(async (_boardId, patch) => ({ ...share, ...patch, hasPassword: patch.password !== null }))
  vi.mocked(confirm).mockResolvedValue(true)
})

afterEach(() => { view?.unmount() })

describe('share password controls', () => {
  it('keeps an empty save unchanged and removes a password only after explicit confirmation', async () => {
    await act(async () => { view = renderElement(createElement(ShareDialog, { boardId: 'b1', onClose: vi.fn() })) })
    await vi.waitFor(() => expect(document.querySelector('input[type="password"]')).toBeTruthy())
    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    const form = input.closest('form')!
    await act(async () => { form.requestSubmit() })
    expect(api.putProjectShare).not.toHaveBeenCalled()

    await act(async () => { setInput(input, 'replacement-pass') })
    await act(async () => { form.requestSubmit() })
    expect(api.putProjectShare).toHaveBeenCalledWith('b1', { password: 'replacement-pass' })

    const remove = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(t('project.share.remove_password')))
    expect(remove).toBeTruthy()
    await act(async () => { remove!.click() })
    expect(confirm).toHaveBeenCalled()
    expect(api.putProjectShare).toHaveBeenCalledWith('b1', { password: null })
  })
})
