import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectComment, ProjectProperty } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import * as api from './api'
import { CardDialog } from './CardDialog'

vi.mock('./api', () => ({
  patchProjectCard: vi.fn(),
  fetchCardComments: vi.fn(),
  createCardComment: vi.fn(),
  createCardContent: vi.fn(),
  patchCardContent: vi.fn(),
  deleteCardContent: vi.fn(),
  fetchCardLinks: vi.fn(),
  createProjectCard: vi.fn(),
  addCardLink: vi.fn(),
  removeCardLink: vi.fn(),
  listBoardFiles: vi.fn(),
  uploadBoardFile: vi.fn(),
  deleteProjectFile: vi.fn(),
  saveCardAsTemplate: vi.fn(),
  duplicateProjectCard: vi.fn(),
  projectFileUrl: vi.fn((id: string) => `/api/project/files/${id}`),
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
      card, properties, members: [], contents: [], siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn(),
    }))
  })
}
beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(api.fetchCardComments).mockResolvedValue([])
  vi.mocked(api.fetchCardLinks).mockResolvedValue([])
  vi.mocked(api.listBoardFiles).mockResolvedValue([])
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

  it('toggles a checkbox content block through patchCardContent', async () => {
    const block = { id: 'a1', cardId: 'c1', boardId: 'b1', type: 'checkbox' as const, title: 'Step', fields: { checked: false }, position: 0, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
    vi.mocked(api.patchCardContent).mockResolvedValue({ ...block, fields: { checked: true } })
    await act(async () => {
      view = renderElement(createElement(CardDialog, {
        card, properties, members: [], contents: [block], siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn(),
      }))
    })
    const checkbox = document.body.querySelector('[data-project-content="a1"] [role="checkbox"]') as HTMLButtonElement
    expect(checkbox).not.toBeNull()
    await act(async () => { checkbox.click() })
    expect(api.patchCardContent).toHaveBeenCalledWith('a1', { fields: { checked: true } })
  })
})

describe('card actions menu (B-9)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  async function openMenu(): Promise<void> {
    const anchor = document.body.querySelector(`button[aria-label="${t('project.card.menu')}"]`) as HTMLButtonElement
    expect(anchor).not.toBeNull()
    await act(async () => { anchor.click() })
  }
  function menuItem(label: string): HTMLButtonElement {
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((entry) => entry.textContent === label) as HTMLButtonElement
    expect(item).not.toBeNull()
    return item
  }

  it('duplicates the card and refreshes the board', async () => {
    vi.mocked(api.duplicateProjectCard).mockResolvedValue({ ...card, id: 'c2' })
    const onRefresh = vi.fn()
    await act(async () => {
      view = renderElement(createElement(CardDialog, { card, properties, members: [], contents: [], siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh, onDelete: vi.fn() }))
    })
    await openMenu()
    await act(async () => { menuItem(t('project.card.duplicate')).click() })
    expect(api.duplicateProjectCard).toHaveBeenCalledWith('c1')
    expect(onRefresh).toHaveBeenCalled()
  })

  it('copies a deep link that reopens the card', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...window.navigator, clipboard: { writeText } })
    await mount()
    await openMenu()
    await act(async () => { menuItem(t('project.card.copy_link')).click() })
    expect(writeText).toHaveBeenCalledTimes(1)
    const url = String(writeText.mock.calls[0]![0])
    expect(url).toContain('/project/boards/b1?card=c1')
  })

  it('hides duplicate from viewers but keeps copy link', async () => {
    await act(async () => {
      view = renderElement(createElement(CardDialog, { card, properties, members: [], contents: [], siblings: [], canEdit: false, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn() }))
    })
    await openMenu()
    const labels = [...document.body.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent)
    expect(labels).not.toContain(t('project.card.duplicate'))
    expect(labels).not.toContain(t('project.board.delete_card'))
    expect(labels).toContain(t('project.card.copy_link'))
  })

  it('deletes the card through the host handler and closes', async () => {
    const onDelete = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      view = renderElement(createElement(CardDialog, { card, properties, members: [], contents: [], siblings: [], canEdit: true, onClose, onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete }))
    })
    await openMenu()
    await act(async () => { menuItem(t('project.board.delete_card')).click() })
    expect(onDelete).toHaveBeenCalledWith('c1')
    expect(onClose).toHaveBeenCalled()
  })
})
