import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectComment, ProjectProperty } from '@shared/project/model'
import { initI18n } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import * as api from './api'
import { CardDialog } from './CardDialog'

vi.mock('./api', () => ({
  patchProjectCard: vi.fn(),
  fetchCardComments: vi.fn(),
  createCardComment: vi.fn(),
}))

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
const card: ProjectCard = { id: 'c1', boardId: 'b1', parentId: '', title: 'Card', icon: '', isTemplate: false, contentOrder: [], values: { pt: 'old' }, ...stamps }
const properties: ProjectProperty[] = [
  { id: 'pt', name: 'Notes', type: 'text', options: [] },
  { id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }, { id: 'o2', value: 'Done', color: '' }] },
]

let view: RenderedElement
async function mount(): Promise<void> {
  await act(async () => {
    view = renderElement(createElement(CardDialog, {
      card, properties, members: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(),
    }))
  })
}
beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(api.fetchCardComments).mockResolvedValue([])
  await initI18n()
})
afterEach(() => { view?.unmount() })

describe('the card dialog', () => {
  it('patches a select property when changed', async () => {
    vi.mocked(api.patchProjectCard).mockResolvedValue({ ...card, values: { pt: 'old', ps: 'o2' } })
    await mount()
    const select = document.body.querySelector('select[aria-label="Status"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    await act(async () => {
      select.value = 'o2'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.patchProjectCard).toHaveBeenCalledWith('c1', { values: { ps: 'o2' } })
  })

  it('posts a comment and appends it to the list', async () => {
    const comment: ProjectComment = { id: 'm1', cardId: 'c1', boardId: 'b1', authorId: 'u1', body: 'Hello', createAt: 1, updateAt: 1, deleteAt: 0 }
    vi.mocked(api.createCardComment).mockResolvedValue(comment)
    await mount()
    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(textarea, 'Hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = textarea.closest('form') as HTMLFormElement
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(api.createCardComment).toHaveBeenCalledWith('c1', 'Hello')
    expect(document.body.textContent).toContain('Hello')
  })
})