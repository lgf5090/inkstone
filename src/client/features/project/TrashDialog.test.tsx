import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { TrashDialog } from './TrashDialog'
import * as api from './api'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchProjectTrash: vi.fn(),
  fetchBoardTrash: vi.fn(),
  restoreProjectBoard: vi.fn(),
  undeleteProjectCard: vi.fn(),
}))

let view: RenderedElement
beforeEach(async () => { vi.clearAllMocks(); await initI18n() })
afterEach(() => { view?.unmount() })

describe('the restore panel (R3-5)', () => {
  it('lists deleted cards and restores the one asked for', async () => {
    vi.mocked(api.fetchBoardTrash).mockResolvedValue([{ id: 'c9', title: 'Gone', deleteAt: 1 }])
    vi.mocked(api.undeleteProjectCard).mockResolvedValue(undefined)
    const onRestored = vi.fn()
    await act(async () => { view = renderElement(createElement(TrashDialog, { boardId: 'b1', onClose: vi.fn(), onRestored })) })
    expect(document.querySelector('[data-trash-card="c9"]')?.textContent).toContain('Gone')
    const restore = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.trash.restore')}: Gone"]`)
    expect(restore).not.toBeNull()
    await act(async () => { restore!.click() })
    expect(api.undeleteProjectCard).toHaveBeenCalledWith('c9')
    expect(onRestored).toHaveBeenCalled()
  })

  it('says so when nothing is deleted instead of showing an empty list', async () => {
    vi.mocked(api.fetchProjectTrash).mockResolvedValue([])
    await act(async () => { view = renderElement(createElement(TrashDialog, { onClose: vi.fn(), onRestored: vi.fn() })) })
    expect(document.body.textContent).toContain(t('project.trash.empty'))
  })
})
