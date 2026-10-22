// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import type { Memo, MemoAttachment } from '@shared/memos/types'
import { ApiError } from '../../../lib/api'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useUi } from '../../../store/ui'
import { useMemos } from '../state'
import { MemoComments } from './MemoComments'

const api = vi.hoisted(() => ({
  patch: vi.fn(),
  remove: vi.fn(),
  comments: { list: vi.fn(), create: vi.fn() },
  preferences: { get: vi.fn() },
  attachments: { upload: vi.fn(), delete: vi.fn() },
}))

vi.mock('../api', () => ({ memosApi: api }))

function memo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'comment-1',
    content: 'first comment',
    title: '',
    snippet: '',
    tags: [],
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: 'memo-1',
    location: null,
    properties: {
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: false,
    },
    attachments: [],
    reactions: [],
    relations: [],
    commentCount: 0,
    rev: 3,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

function attachment(overrides: Partial<MemoAttachment> = {}): MemoAttachment {
  return {
    id: 'att-1',
    filename: 'notes.txt',
    mime: 'text/plain',
    size: 12,
    width: null,
    height: null,
    url: '/api/memos/files/att-1',
    thumbnailUrl: null,
    motion: null,
    mediaMetadata: null,
    createdAt: 100,
    ...overrides,
  }
}

let view: RenderedElement | null = null

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === text)
  if (!found) throw new Error(`no button named ${text}`)
  return found
}

function buttonLabelled(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

function editorView(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>('.cm-editor')
  const found = dom ? EditorView.findFromDOM(dom) : null
  if (!found) throw new Error('no memo editor')
  return found
}

function setEditorValue(container: HTMLElement, value: string): void {
  const editor = editorView(container)
  act(() => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  })
}

async function chooseFiles(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  return input
}

beforeEach(async () => {
  await initI18n()
  localStorage.clear()
  useMemos.getState().reset()
  useUi.setState({ toasts: [] })
  vi.clearAllMocks()
  api.comments.list.mockResolvedValue({ items: [], nextCursor: null })
  api.attachments.delete.mockResolvedValue({ ok: true })
  api.preferences.get.mockResolvedValue({
    defaultVisibility: 'private',
    enableDoubleClickEdit: true,
    saveMediaMetadata: true,
    reactions: [],
    tagRules: [],
    enableLinkPreview: true,
    enableReverseGeocoding: false,
    transcriptionProviderId: null,
    transcriptionModel: null,
    transcriptionLanguage: '',
    transcriptionPrompt: '',
  })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the comment composer', () => {
  it('uploads an attachment and posts its id with the comment', async () => {
    const uploaded = attachment()
    api.attachments.upload.mockResolvedValue(uploaded)
    api.comments.create.mockResolvedValue(memo({ content: 'hello', attachments: [uploaded] }))
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 0 }))
    await flush()

    setEditorValue(view.container, 'hello')
    await chooseFiles(fileInput(view.container), [new File(['notes'], 'notes.txt', { type: 'text/plain' })])
    expect(api.attachments.upload).toHaveBeenCalledWith(expect.objectContaining({ memoId: null }))
    expect(view.container.textContent).toContain('notes.txt')

    click(buttonNamed(t('memos.comments.submit')))
    await flush()

    expect(api.comments.create).toHaveBeenCalledWith('memo-1', {
      content: 'hello',
      attachmentIds: ['att-1'],
    })
    expect(view.container.textContent).toContain('hello')
    expect(view.container.querySelector('[data-memo-attachments]')).not.toBeNull()
    expect(view.container.textContent).toContain('notes.txt')
  })

  it('rolls back uploaded attachments when posting fails', async () => {
    const uploaded = attachment()
    api.attachments.upload.mockResolvedValue(uploaded)
    api.comments.create.mockRejectedValue(new ApiError(500, 'internal', 'Comment failed.'))
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 0 }))
    await flush()

    setEditorValue(view.container, 'hello')
    await chooseFiles(fileInput(view.container), [new File(['notes'], 'notes.txt', { type: 'text/plain' })])
    click(buttonNamed(t('memos.comments.submit')))
    await flush()

    expect(api.attachments.delete).toHaveBeenCalledWith('att-1')
    expect(view.container.textContent).not.toContain('notes.txt')
    expect(view.container.textContent).toContain('Comment failed.')
    expect(view.container.textContent).toContain('hello')
  })

  it('renders the attachments of an existing comment', async () => {
    api.comments.list.mockResolvedValue({
      items: [memo({ content: 'with photo', attachments: [attachment({ id: 'att-2', filename: 'photo.jpg', mime: 'image/jpeg' })] })],
      nextCursor: null,
    })
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 1 }))
    await flush()

    expect(view.container.textContent).toContain('with photo')
    expect(view.container.querySelector('[data-memo-attachments]')).not.toBeNull()
    expect(view.container.querySelector('img')?.getAttribute('alt')).toBe('photo.jpg')
  })
})

describe('the comment editor', () => {
  it('saves new content and removed attachments', async () => {
    api.comments.list.mockResolvedValue({
      items: [memo({ content: 'first comment', attachments: [attachment({ filename: 'photo.jpg', mime: 'image/jpeg' })] })],
      nextCursor: null,
    })
    api.patch.mockResolvedValue(memo({ content: 'updated comment', attachments: [] }))
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 1 }))
    await flush()

    click(buttonLabelled(t('memos.comments.edit')))
    await flush()
    click(buttonLabelled(t('memos.comments.remove_attachment', { name: 'photo.jpg' })))
    setEditorValue(view.container, 'updated comment')
    click(buttonNamed(t('memos.comments.save')))
    await flush()

    expect(api.patch).toHaveBeenCalledWith('comment-1', {
      rev: 3,
      content: 'updated comment',
      attachmentIds: [],
    })
    expect(view.container.textContent).toContain('updated comment')
  })

  it('uploads a new attachment before patching the comment', async () => {
    const uploaded = attachment({ id: 'att-3', filename: 'new.txt' })
    api.comments.list.mockResolvedValue({ items: [memo()], nextCursor: null })
    api.attachments.upload.mockResolvedValue(uploaded)
    api.patch.mockResolvedValue(memo({ content: 'first comment', attachments: [uploaded], rev: 4 }))
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 1 }))
    await flush()

    click(buttonLabelled(t('memos.comments.edit')))
    await flush()
    await chooseFiles(fileInput(view.container), [new File(['new'], 'new.txt', { type: 'text/plain' })])
    expect(api.attachments.upload).toHaveBeenCalledWith(expect.objectContaining({ memoId: null }))
    click(buttonNamed(t('memos.comments.save')))
    await flush()

    expect(api.patch).toHaveBeenCalledWith('comment-1', {
      rev: 3,
      content: 'first comment',
      attachmentIds: ['att-3'],
    })
  })

  it('closes the composer on an archived memo', async () => {
    api.comments.list.mockResolvedValue({ items: [], nextCursor: null })
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 0, disabled: true }))
    await flush()

    expect(view.container.querySelector('.cm-editor')).toBeNull()
    expect(view.container.textContent).toContain(t('memos.comments.disabled'))
  })
})
