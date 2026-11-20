import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard, ProjectComment, ProjectProperty } from '@shared/project/model'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import * as api from './api'
import * as overlay from '../../components/overlay'
import { CardDialog } from './CardDialog'
import { resetProjectSubscriptionCache } from './use-watch'

vi.mock('./api', () => ({
  patchProjectCard: vi.fn(),
  fetchCardTime: vi.fn().mockResolvedValue([]),
  startCardTimer: vi.fn(),
  stopCardTimer: vi.fn(),
  deleteCardTime: vi.fn(),
  fetchCardComments: vi.fn(),
  createCardComment: vi.fn(),
  createCardContent: vi.fn(),
  patchCardContent: vi.fn(),
  moveCardContent: vi.fn(),
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
  patchCardComment: vi.fn(),
  deleteCardComment: vi.fn(),
  projectFileUrl: vi.fn((id: string) => `/api/project/files/${id}`),
  fetchProjectSubscriptions: vi.fn().mockResolvedValue([]),
  watchProjectBlock: vi.fn().mockResolvedValue(undefined),
  unwatchProjectBlock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../store/session', () => ({
  useSession: (selector: (state: { user: { id: string } | null }) => unknown) => selector({ user: { id: 'u1' } }),
}))

vi.mock('../chat/editor-ai', () => ({
  sendForAnswerDetailed: vi.fn(),
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
      card, properties, members: [], people: {}, contents: [], siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn(),
    }))
  })
}
beforeEach(async () => {
  resetProjectSubscriptionCache()
  vi.clearAllMocks()
  vi.mocked(api.fetchCardComments).mockResolvedValue([])
  vi.mocked(api.fetchCardLinks).mockResolvedValue([])
  vi.mocked(api.listBoardFiles).mockResolvedValue([])
  vi.mocked(api.moveCardContent).mockResolvedValue({ id: 'a1', cardId: 'c1', boardId: 'b1', type: 'text', title: 'a1', fields: {}, position: 0, ...stamps })
  await initI18n()
})
afterEach(() => { view?.unmount() })

describe('the card dialog', () => {
  it('patches a select property when changed', async () => {
    vi.mocked(api.patchProjectCard).mockResolvedValue({ ...card, values: { pt: 'old', ps: 'o2' } })
    await mount()
    const trigger = document.body.querySelector<HTMLButtonElement>('button[aria-label="Status"]')
    expect(trigger).not.toBeNull()
    await act(async () => { trigger!.click() })
    const done = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((row) => row.textContent === 'Done')
    expect(done, 'no Done row in the status picker').toBeDefined()
    await act(async () => { done!.click() })
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
        card, properties, members: [], people: {}, contents: [block], siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn(),
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
      view = renderElement(createElement(CardDialog, { card, properties, members: [], people: {}, contents: [], siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh, onDelete: vi.fn() }))
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
      view = renderElement(createElement(CardDialog, { card, properties, members: [], people: {}, contents: [], siblings: [], canEdit: false, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn() }))
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
      view = renderElement(createElement(CardDialog, { card, properties, members: [], people: {}, contents: [], siblings: [], canEdit: true, onClose, onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete }))
    })
    await openMenu()
    await act(async () => { menuItem(t('project.board.delete_card')).click() })
    expect(onDelete).toHaveBeenCalledWith('c1')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('comment edit/delete, paste image, archived placeholder (D-6/D-8/D-11)', () => {
  const ownComment = { id: 'm1', cardId: 'c1', boardId: 'b1', authorId: 'u1', body: 'original', createAt: 1, updateAt: 1, deleteAt: 0 }

  function setValue(el: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  async function mountWith(contents: unknown[] = [], comments: unknown[] = []): Promise<void> {
    vi.mocked(api.fetchCardComments).mockResolvedValue(comments as never)
    await act(async () => {
      view = renderElement(createElement(CardDialog, { card, properties, members: [], people: {}, contents: contents as never, siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn() }))
    })
  }

  it('edits own comment through patchCardComment', async () => {
    vi.mocked(api.patchCardComment).mockResolvedValue({ ...ownComment, body: 'edited' })
    await mountWith([], [ownComment])
    const edit = document.body.querySelector(`button[aria-label="${t('project.card.edit_comment')}"]`) as HTMLButtonElement
    expect(edit).not.toBeNull()
    await act(async () => { edit.click() })
    const textarea = document.body.querySelector(`textarea[aria-label="${t('project.card.edit_comment')}"]`) as HTMLTextAreaElement
    await act(async () => { setValue(textarea, 'edited') })
    const save = [...document.body.querySelectorAll('button')].find((b) => b.textContent === t('common.save'))!
    await act(async () => { save.click() })
    expect(api.patchCardComment).toHaveBeenCalledWith('m1', 'edited')
  })

  it('deletes own comment through deleteCardComment', async () => {
    vi.mocked(api.deleteCardComment).mockResolvedValue(undefined)
    const confirmed = vi.spyOn(overlay, 'confirm').mockResolvedValue(true)
    await mountWith([], [ownComment])
    const del = document.body.querySelector(`button[aria-label="${t('common.delete')}"]`) as HTMLButtonElement
    await act(async () => { del.click() })
    expect(api.deleteCardComment).toHaveBeenCalledWith('m1')
    confirmed.mockRestore()
  })

  it('shows an archived placeholder when the image file is gone', async () => {
    const block = { id: 'a1', cardId: 'c1', boardId: 'b1', type: 'image', title: 'pic.png', fields: { attachmentId: 'gone' }, position: 0, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }
    await mountWith([block])
    expect(document.body.textContent).toContain(t('project.card.archived_file'))
  })

  it('uploads a pasted image and adds an image block', async () => {
    vi.mocked(api.uploadBoardFile).mockResolvedValue({ id: 'f1', boardId: 'b1', cardId: 'c1', filename: 'p.png', size: 1, contentType: 'image/png', createdBy: 'u1', createAt: 1 } as never)
    vi.mocked(api.createCardContent).mockResolvedValue({ id: 'a2', cardId: 'c1', boardId: 'b1', type: 'image', title: 'p.png', fields: { attachmentId: 'f1' }, position: 1, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 })
    await mountWith()
    const section = document.body.querySelector(`section[aria-label="${t('project.card.content')}"]`)!
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [new File(['x'], 'p.png', { type: 'image/png' })] } })
    await act(async () => { section.dispatchEvent(event) })
    expect(api.uploadBoardFile).toHaveBeenCalled()
    expect(api.createCardContent).toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'image', fields: { attachmentId: 'f1' } }))
  })
})

describe('content block reorder (D-1)', () => {
  it('move down persists the new order through the content move route', async () => {
    const blocks = ['a1', 'a2'].map((id) => ({ id, cardId: 'c1', boardId: 'b1', type: 'text' as const, title: id, fields: {}, position: 0, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }))
    await act(async () => {
      view = renderElement(createElement(CardDialog, { card: { ...card, contentOrder: ['a1', 'a2'] }, properties, members: [], people: {}, contents: blocks, siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn() }))
    })
    const down = document.body.querySelector(`[data-project-content="a1"] button[aria-label="${t('project.card.move_down')}"]`) as HTMLButtonElement
    expect(down).not.toBeNull()
    await act(async () => { down.click() })
    expect(api.moveCardContent).toHaveBeenCalledWith('a1', 'a2', 'after')
    expect(api.patchProjectCard).not.toHaveBeenCalledWith('c1', expect.objectContaining({ contentOrder: expect.anything() }))
  })

  async function mountBlocks(): Promise<void> {
    const blocks = ['a1', 'a2'].map((id) => ({ id, cardId: 'c1', boardId: 'b1', type: 'text' as const, title: id, fields: {}, position: 0, createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }))
    await act(async () => {
      view = renderElement(createElement(CardDialog, { card: { ...card, contentOrder: ['a1', 'a2'] }, properties, members: [], people: {}, contents: blocks, siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn() }))
    })
  }

  async function dragBlock(from: string, to: string, pointerType = 'mouse'): Promise<void> {
    const rows = [...document.body.querySelectorAll<HTMLElement>('[data-content-id]')]
    // jsdom lays nothing out, so the drag reads the bands a real dialog would report.
    rows.forEach((node, index) => {
      node.getBoundingClientRect = () => ({ left: 0, right: 400, top: index * 60, bottom: index * 60 + 50, width: 400, height: 50, x: 0, y: index * 60, toJSON: () => ({}) })
    })
    const grip = document.body.querySelector<HTMLElement>(`[data-content-grip="${from}"]`)!
    const fire = (type: string, y: number, target: EventTarget = window): void => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: y, button: 0, pointerId: 1, pointerType }))
    }
    const at = (id: string): number => rows.findIndex((node) => node.dataset.contentId === id) * 60
    await act(async () => { fire('pointerdown', at(from) + 10, grip) })
    if (pointerType === 'touch') await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)) })
    await act(async () => { fire('pointermove', at(to) + 25) })
    await act(async () => { fire('pointerup', at(to) + 25) })
  }

  it('dragging a block down lands it after the block it was dropped on', async () => {
    await mountBlocks()
    await dragBlock('a1', 'a2')
    expect(api.moveCardContent).toHaveBeenCalledWith('a1', 'a2', 'after')
  })

  it('a finger held on the grip drags a block up', async () => {
    await mountBlocks()
    await dragBlock('a2', 'a1', 'touch')
    expect(api.moveCardContent).toHaveBeenCalledWith('a2', 'a1', 'before')
  })
})

describe('subtask progress (UI-2)', () => {
  it('shows a progress bar with done/total for subtasks', async () => {
    const subtask = { ...card, id: 's1', parentId: 'c1', values: { ps: 'o2' } }
    const open = { ...card, id: 's2', parentId: 'c1', values: { ps: 'o1' } }
    await act(async () => {
      view = renderElement(createElement(CardDialog, { card, properties, members: [], people: {}, contents: [], siblings: [subtask, open], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn() }))
    })
    const bar = document.body.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('1')
    expect(bar.getAttribute('aria-valuemax')).toBe('2')
    expect(document.body.textContent).toContain('1/2')
  })

  it('clicking a subtask checkbox writes its status and refreshes (R2-2)', async () => {
    vi.mocked(api.patchProjectCard).mockResolvedValue({ ...card })
    const onRefresh = vi.fn()
    const open = { ...card, id: 's2', parentId: 'c1', values: { ps: 'o1' } }
    await act(async () => {
      view = renderElement(createElement(CardDialog, { card, properties, members: [], people: {}, contents: [], siblings: [open], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh, onDelete: vi.fn() }))
    })
    const checkbox = document.body.querySelector('button[role="checkbox"][aria-label="Card"]') as HTMLButtonElement
    expect(checkbox).not.toBeNull()
    await act(async () => { checkbox.click() })
    expect(api.patchProjectCard).toHaveBeenCalledWith('s2', { values: { ps: 'o2' } })
    expect(onRefresh).toHaveBeenCalled()
  })
})

describe('AI card capabilities', () => {
  it('renders AI split button and generates subtasks via sendForAnswerDetailed', async () => {
    const { sendForAnswerDetailed } = await import('../chat/editor-ai')
    vi.mocked(sendForAnswerDetailed).mockResolvedValue({
      status: 'ok',
      text: '- Task 1\n- Task 2\n- Task 3',
      provider: 'workers-ai',
      model: 'test-model',
      durationMs: 120,
    } as never)
    vi.mocked(api.createProjectCard).mockResolvedValue({ ...card, id: 's-new', parentId: 'c1' })
    const onRefresh = vi.fn()
    await act(async () => {
      view = renderElement(createElement(CardDialog, { card: { ...card, title: 'Build Landing Page' }, properties, members: [], people: {}, contents: [], siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh, onDelete: vi.fn() }))
    })

    const splitBtn = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes(t('project.card.ai_split'))
    )
    expect(splitBtn).toBeDefined()
    await act(async () => {
      splitBtn?.click()
    })

    expect(sendForAnswerDetailed).toHaveBeenCalled()
    expect(api.createProjectCard).toHaveBeenCalledWith('b1', expect.objectContaining({
      parentId: 'c1',
      title: 'Task 1',
    }))
    expect(onRefresh).toHaveBeenCalled()
  })

  it('renders multi-level breadcrumb trail and navigates to ancestors', async () => {
    const onOpen = vi.fn()
    const grandParent = { ...card, id: 'gp1', title: 'Epic Feature' }
    const parentCard = { ...card, id: 'p1', parentId: 'gp1', title: 'Backend API' }
    const childCard = { ...card, id: 'c1', parentId: 'p1', title: 'Endpoint Schema' }

    await act(async () => {
      view = renderElement(createElement(CardDialog, {
        card: childCard,
        properties,
        members: [], people: {},
        contents: [],
        siblings: [grandParent, parentCard, childCard],
        canEdit: true,
        onClose: vi.fn(),
        onUpdated: vi.fn(),
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onOpenCard: onOpen,
      }))
    })

    const nav = document.body.querySelector('nav[aria-label]')!
    expect(nav).toBeTruthy()
    expect(nav.textContent).toContain('Epic Feature')
    expect(nav.textContent).toContain('Backend API')
    expect(nav.textContent).toContain('Endpoint Schema')

    const gpBtn = [...nav.querySelectorAll('button')].find((b) => b.textContent === 'Epic Feature')
    await act(async () => { gpBtn?.click() })
    expect(onOpen).toHaveBeenCalledWith('gp1')
  })
})

describe('watching a card (R3-5)', () => {
  it('offers a watch toggle that subscribes the reader', async () => {
    await mount()
    const watch = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === t('project.watch.on'))
    expect(watch, 'no watch affordance on the card').toBeDefined()
    await act(async () => { watch!.click() })
    expect(api.watchProjectBlock).toHaveBeenCalledWith('card', 'c1')
  })

  it('starts as watching when the subscription list already names the card', async () => {
    vi.mocked(api.fetchProjectSubscriptions).mockResolvedValue([{ blockType: 'card', blockId: 'c1', subscriberId: 'u1', notifiedAt: 0, createAt: 1 }])
    await mount()
    const off = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === t('project.watch.off'))
    expect(off, 'an existing subscription is not reflected').toBeDefined()
    await act(async () => { off!.click() })
    expect(api.unwatchProjectBlock).toHaveBeenCalledWith('c1')
    vi.mocked(api.fetchProjectSubscriptions).mockResolvedValue([])
  })
})

describe('the two-pane card detail (R3-26)', () => {
  it('puts the comments beside the details rather than below them', async () => {
    await mount()
    const detail = document.querySelector('[data-card-detail="c1"]')
    expect(detail, 'no two-pane detail container').not.toBeNull()
    expect(detail!.className).toContain('md:flex-row')
    const panes = [...detail!.children]
    expect(panes).toHaveLength(2)
    expect(panes[1]!.querySelector(`[aria-label="${t('project.card.comments')}"]`)).not.toBeNull()
    expect(panes[0]!.querySelector(`[aria-label="${t('project.card.properties')}"]`)).not.toBeNull()
  })

  it('invites the first comment instead of showing an empty list', async () => {
    await mount()
    expect(document.body.textContent).toContain(t('project.card.comments_empty'))
  })
})

describe('the recurrence editor', () => {
  it('writes a weekly rule when the reader picks weekly', async () => {
    vi.mocked(api.patchProjectCard).mockResolvedValue({ ...card, recurrence: { freq: 'weekly', interval: 1 } })
    await mount()
    const trigger = document.body.querySelector<HTMLButtonElement>(`[data-card-recurrence] button[aria-label="${t('project.card.recurrence')}"]`)!
    expect(trigger).not.toBeNull()
    await act(async () => { trigger.click() })
    const weekly = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((row) => row.textContent === t('project.card.recurrence.weekly'))!
    await act(async () => { weekly.click() })
    expect(api.patchProjectCard).toHaveBeenCalledWith('c1', { recurrence: { freq: 'weekly', interval: 1 } })
  })

  it('clears the rule when the reader picks does-not-repeat', async () => {
    vi.mocked(api.patchProjectCard).mockResolvedValue({ ...card, recurrence: null })
    await act(async () => {
      view = renderElement(createElement(CardDialog, {
        card: { ...card, recurrence: { freq: 'daily', interval: 1 } }, properties, members: [], people: {}, contents: [], siblings: [], canEdit: true, onClose: vi.fn(), onUpdated: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn(),
      }))
    })
    const trigger = document.body.querySelector<HTMLButtonElement>(`[data-card-recurrence] button[aria-label="${t('project.card.recurrence')}"]`)!
    await act(async () => { trigger.click() })
    const none = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((row) => row.textContent === t('project.card.recurrence.none'))!
    await act(async () => { none.click() })
    expect(api.patchProjectCard).toHaveBeenCalledWith('c1', { recurrence: null })
  })
})
