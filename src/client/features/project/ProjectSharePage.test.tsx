import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardBundle } from '@shared/project/model'
import { emptyProjectViewFields } from '@shared/project/model'
import { ApiError } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { ProjectSharePage } from './ProjectSharePage'
import * as api from './api'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  readPublicProjectBoard: vi.fn(),
  fetchBoardLinks: vi.fn(),
}))

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }

function bundle(): ProjectBoardBundle {
  return {
    board: { id: 'b1', ownerId: 'u1', type: 'P', minimumRole: '', title: 'Public roadmap', description: '', icon: '', showDescription: false, isTemplate: false, templateVersion: 0, ...stamps },
    properties: [{ id: 'ps', name: 'Status', type: 'select', options: [{ id: 'o1', value: 'Open', color: '' }] }],
    views: [{ id: 'v1', boardId: 'b1', title: 'Table', viewType: 'table', fields: emptyProjectViewFields(), position: 0, ...stamps }],
    cards: [{ id: 'c1', boardId: 'b1', parentId: '', title: 'Alpha', icon: '', isTemplate: false, contentOrder: [], values: { ps: 'o1' }, ...stamps }],
    contents: [],
    comments: [{ id: 'm1', cardId: 'c1', boardId: 'b1', authorId: 'u1', body: 'A public remark', createAt: 1, updateAt: 1, deleteAt: 0 }],
    members: [], role: 'viewer', cursor: 1,
  }
}

const read = vi.mocked(api.readPublicProjectBoard)
let view: RenderedElement

beforeEach(async () => { localStorage.clear(); vi.clearAllMocks(); await initI18n() })
afterEach(() => { view?.unmount() })

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mount(): Promise<void> {
  await act(async () => { view = renderElement(createElement(ProjectSharePage, { slug: 'slug1' })) })
}

describe('the public board page', () => {
  it('draws the board read-only and never asks for the member-only dependency read', async () => {
    read.mockResolvedValue(bundle())
    await mount()
    expect(read).toHaveBeenCalledWith('slug1', undefined)
    expect(view.container.textContent).toContain('Public roadmap')
    expect(view.container.textContent).toContain(t('project.share.page_readonly'))
    expect(view.container.textContent).toContain('Alpha')
    expect(view.container.querySelector(`[aria-label="${t('project.view.menu')}"]`)).toBeNull()
    expect(api.fetchBoardLinks).not.toHaveBeenCalled()
  })

  it('offers no view-settings dialog, whose Save a stranger could never spend', async () => {
    read.mockResolvedValue(bundle())
    await mount()
    for (const key of ['project.view.sort', 'project.view.filter', 'project.view.properties'] as const) {
      expect(view.container.querySelector(`[aria-label="${t(key)}"]`), `${key} is still offered`).toBeNull()
    }
  })

  it('asks for the passcode on a refusal and opens the board once it is accepted', async () => {
    read.mockRejectedValueOnce(new ApiError(401, 'unauthenticated', 'An access password is required'))
    read.mockResolvedValueOnce(bundle())
    await mount()
    const field = view.container.querySelector<HTMLInputElement>('input[type="password"]')
    expect(field, 'the passcode gate never appeared').not.toBeNull()
    expect(view.container.textContent).not.toContain('Public roadmap')
    await act(async () => {
      setInput(field!, 'secret-pass')
    })
    await act(async () => { view.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(read).toHaveBeenLastCalledWith('slug1', 'secret-pass')
    expect(view.container.textContent).toContain('Public roadmap')
  })

  it('says the passcode was wrong rather than hiding the gate', async () => {
    read.mockRejectedValueOnce(new ApiError(401, 'unauthenticated', 'required'))
    read.mockRejectedValueOnce(new ApiError(401, 'invalid_credentials', 'Incorrect passcode'))
    await mount()
    const field = view.container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      setInput(field, 'wrong')
    })
    await act(async () => { view.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(t('project.share.page_wrong_passcode'))
    expect(view.container.querySelector('input[type="password"]')).not.toBeNull()
  })

  it('tells a throttled reader to wait instead of calling the link gone', async () => {
    read.mockRejectedValue(new ApiError(429, 'too_many_attempts', 'Too many attempts'))
    await mount()
    expect(view.container.textContent).toContain(t('project.share.page_throttled'))
    expect(view.container.textContent).not.toContain(t('project.share.page_gone_title'))
  })

  it('says the board is unavailable when the link is revoked', async () => {
    read.mockRejectedValue(new ApiError(404, 'not_found', 'Share not found'))
    await mount()
    expect(view.container.textContent).toContain(t('project.share.page_gone_title'))
  })

  it('opens a card using only the public bundle, comments included', async () => {
    read.mockResolvedValue(bundle())
    await mount()
    const title = [...view.container.querySelectorAll<HTMLButtonElement>('[data-project-card] button')].find((button) => button.textContent === 'Alpha')
    expect(title, 'no card title to press').toBeDefined()
    await act(async () => { title!.click() })
    expect(document.body.textContent).toContain('A public remark')
    expect(document.body.textContent).toContain('Status')
  })
})
describe('the public card context menu', () => {
  it('offers no member link to copy, because the address it names needs a session', async () => {
    read.mockResolvedValue(bundle())
    await mount()
    const row = view.container.querySelector('[data-project-card]')
    expect(row, 'no card row to right-click').not.toBeNull()
    await act(async () => { row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const copy = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === t('project.card.copy_link'))
    expect(copy, 'the copy-link row is missing').toBeDefined()
    expect(copy!.disabled).toBe(true)
  })
})
