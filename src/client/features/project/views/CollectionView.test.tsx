import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAttachment } from '@shared/project/model'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { CollectionView } from './CollectionView'
import * as api from '../api'
import * as overlay from '../../../components/overlay'

let view: RenderedElement
beforeEach(async () => { await initI18n() })
afterEach(() => { view?.unmount(); vi.restoreAllMocks() })

const boardFile: ProjectAttachment = {
  id: 'f1', userId: 'u1', boardId: 'b1', cardId: null, filename: 'a.png', mime: 'image/png',
  size: 10, storage: 'r2', objectKey: 'k', width: null, height: null, thumbnailKey: null,
  createdAt: 1, updatedAt: 1,
}
const cardFile: ProjectAttachment = { ...boardFile, id: 'f2', cardId: 'c1' }

async function render(): Promise<void> {
  await act(async () => {
    view = renderElement(createElement(CollectionView, { boardId: 'b1', canEdit: true, onOpenCard: vi.fn() }))
  })
}

async function preview(id: string): Promise<HTMLElement> {
  const thumb = view.container.querySelector<HTMLButtonElement>(`[data-collection-file="${id}"] .pv-file-thumb`)!
  await act(async () => { thumb.click() })
  return view.container.querySelector<HTMLElement>(`[data-file-preview="${id}"]`)!
}

const deleteButton = (panel: HTMLElement): HTMLButtonElement | undefined =>
  [...panel.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === t('project.collection.delete_file'))

describe('the collection read states', () => {
  it('shows a retryable error instead of an empty shelf', async () => {
    const list = vi.spyOn(api, 'listBoardFiles').mockRejectedValue(new TypeError('Failed to fetch'))
    await render()
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(t('project.common.load_failed'))
    expect(view.container.textContent).not.toContain(t('project.collection.empty'))
    list.mockResolvedValueOnce([boardFile])
    await act(async () => { [...view.container.querySelectorAll('button')].find((button) => button.textContent === t('project.common.retry'))!.click() })
    expect(view.container.querySelector('[data-collection-file="f1"]')).not.toBeNull()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('clears a previous read error after a successful upload reload', async () => {
    const list = vi.spyOn(api, 'listBoardFiles').mockRejectedValue(new TypeError('Failed to fetch'))
    vi.spyOn(api, 'uploadBoardFile').mockResolvedValue(boardFile)
    await render()
    expect(view.container.querySelector('[role="alert"]')).not.toBeNull()
    list.mockResolvedValueOnce([boardFile])
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.png', { type: 'image/png' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(view.container.querySelector('[role="alert"]')).toBeNull()
    expect(view.container.querySelector('[data-collection-file="f1"]')).not.toBeNull()
  })

  it('does not render an HTTP error body as a text preview', async () => {
    vi.spyOn(api, 'listBoardFiles').mockResolvedValue([{ ...boardFile, mime: 'text/plain', filename: 'a.txt' }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }))
    await render()
    const panel = await preview('f1')
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain(t('project.common.load_failed'))
    expect(panel.querySelector('pre')).toBeNull()
  })
})

describe('the collection preview delete affordance', () => {
  it('deletes a board-level attachment after confirmation and reloads the shelf', async () => {
    const list = vi.spyOn(api, 'listBoardFiles').mockResolvedValue([boardFile])
    const del = vi.spyOn(api, 'deleteProjectFile').mockResolvedValue(undefined)
    const confirmed = vi.spyOn(overlay, 'confirm').mockResolvedValue(true)
    await render()
    const panel = await preview('f1')
    const button = deleteButton(panel)!
    expect(button).toBeDefined()
    await act(async () => { button.click() })
    expect(confirmed).toHaveBeenCalled()
    expect(del).toHaveBeenCalledWith('f1')
    expect(list).toHaveBeenCalledTimes(2)
    list.mockRestore()
    del.mockRestore()
    confirmed.mockRestore()
  })

  it('keeps card attachments on the card dialog instead of offering a delete here', async () => {
    const list = vi.spyOn(api, 'listBoardFiles').mockResolvedValue([cardFile])
    await render()
    const panel = await preview('f2')
    expect(deleteButton(panel)).toBeUndefined()
    list.mockRestore()
  })
})
