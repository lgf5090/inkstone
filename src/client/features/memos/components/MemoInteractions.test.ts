// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import type { Memo } from '@shared/memos/types'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { ConfirmHost } from '../../../components/overlay'
import { useUi } from '../../../store/ui'
import { loadMemoDraft, MEMO_QUERY_DEFAULTS, saveMemoDraft, useMemos } from '../state'
import { MemoComments } from './MemoComments'
import { MemoComposer, memoComposerDraftScope } from './MemoComposer'
import { MemoReactions } from './MemoReactions'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  comments: { list: vi.fn(), create: vi.fn() },
  relations: { get: vi.fn(), put: vi.fn() },
  reactions: { list: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  views: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), validate: vi.fn() },
  preferences: { get: vi.fn(), patch: vi.fn() },
  spaces: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  attachments: { list: vi.fn(), upload: vi.fn(), delete: vi.fn(), batchDelete: vi.fn(), prune: vi.fn() },
}))

vi.mock('../api', () => ({ memosApi: api }))

function memo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'memo-1',
    content: 'first memo',
    title: '',
    snippet: '',
    tags: [],
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: null,
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
    rev: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

let view: RenderedElement | null = null

function setEditorValue(root: HTMLElement, value: string): void {
  const dom = root.querySelector<HTMLElement>('.cm-editor')
  const editor = dom ? EditorView.findFromDOM(dom) : null
  if (!editor) throw new Error('no memo editor')
  act(() => {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  })
}

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

function pressModEnter(target: Element): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }))
  })
}

function editorText(container: HTMLElement): string {
  return container.querySelector('.cm-content')?.textContent ?? ''
}

async function chooseFiles(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
}

beforeEach(async () => {
  await initI18n()
  localStorage.clear()
  useMemos.getState().reset()
  useMemos.setState({ items: [], status: 'ready', query: { ...MEMO_QUERY_DEFAULTS } })
  useUi.setState({ toasts: [] })
  vi.clearAllMocks()
  api.spaces.list.mockResolvedValue({ spaces: [] })
  api.preferences.get.mockResolvedValue({
    defaultVisibility: 'private',
    enableDoubleClickEdit: true,
    saveMediaMetadata: true,
    reactions: [],
    tagRules: [],
    enableLinkPreview: true,
    enableReverseGeocoding: false,
  })
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
})

describe('the memo composer', () => {
  it('restores a draft, creates the memo and clears the draft', async () => {
    const saved = memo({ id: 'new-memo', content: 'hello' })
    api.create.mockResolvedValue(saved)
    const onSaved = vi.fn()
    const scope = memoComposerDraftScope('space-1')
    saveMemoDraft('guest', scope, { content: 'hello', visibility: 'private' })
    view = renderElement(createElement(MemoComposer, { spaceId: 'space-1', onSaved }))
    await flush()
    expect(editorText(view.container)).toContain('hello')
    const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes(t('memos.composer.save')))
    expect(submit).toBeDefined()
    click(submit!)
    await flush()
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      content: 'hello',
      visibility: 'private',
      spaceId: 'space-1',
    }))
    expect(onSaved).toHaveBeenCalledWith(saved)
    expect(editorText(view.container)).not.toContain('hello')
    expect(loadMemoDraft('guest', scope)).toBeNull()
  })

  it('refuses an empty memo and explains why', async () => {
    view = renderElement(createElement(MemoComposer, {}))
    await flush()
    const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes(t('memos.composer.save')))
    expect(submit?.disabled).toBe(true)
    pressModEnter(view.container.querySelector('.cm-content')!)
    await flush()
    expect(api.create).not.toHaveBeenCalled()
    expect(view.container.textContent).toContain(t('memos.composer.empty'))
  })

  it('uploads a Live Photo pair as one motion group and inserts only the still', async () => {
    let nextId = 0
    api.attachments.upload.mockImplementation(async (input: {
      file: File
      motionGroupId?: string | null
      motionRole?: string | null
    }) => {
      nextId += 1
      return {
        id: `att-${nextId}`,
        filename: input.file.name,
        mime: input.file.type,
        size: input.file.size,
        width: null,
        height: null,
        url: `/api/memos/files/att-${nextId}`,
        thumbnailUrl: null,
        motion: input.motionGroupId
          ? { groupId: input.motionGroupId, role: input.motionRole }
          : null,
        mediaMetadata: null,
        createdAt: 100,
        memoId: null,
        memo: null,
      }
    })
    saveMemoDraft('guest', memoComposerDraftScope(null), { content: 'trip ', visibility: 'private' })
    view = renderElement(createElement(MemoComposer, {}))
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    await chooseFiles(input!, [
      new File(['still'], 'IMG_0042.HEIC', { type: 'image/heic' }),
      new File(['video'], 'IMG_0042.MOV', { type: 'video/quicktime' }),
    ])
    expect(api.attachments.upload).toHaveBeenCalledTimes(2)
    const still = api.attachments.upload.mock.calls[0]![0] as {
      motionGroupId: string
      motionRole: string
    }
    const video = api.attachments.upload.mock.calls[1]![0] as {
      motionGroupId: string
      motionRole: string
    }
    expect(still.motionRole).toBe('still')
    expect(video.motionRole).toBe('video')
    expect(still.motionGroupId).toBe(video.motionGroupId)
    expect(editorText(view.container)).toContain('![IMG_0042.HEIC](/api/memos/files/att-1)')
    expect(editorText(view.container)).not.toContain('/api/memos/files/att-2')
  })

  it('uploads a pasted file and inserts its markdown at the cursor', async () => {
    const attachment = {
      id: 'att-1',
      filename: 'photo.png',
      mime: 'image/png',
      size: 1,
      width: null,
      height: null,
      url: '/api/memos/files/att-1',
      thumbnailUrl: null,
      motion: null,
      mediaMetadata: null,
      createdAt: 100,
    }
    api.attachments.upload.mockResolvedValue(attachment)
    api.create.mockResolvedValue(memo({ id: 'new-memo', content: 'photo' }))
    saveMemoDraft('guest', memoComposerDraftScope(null), { content: 'hello ', visibility: 'private' })
    view = renderElement(createElement(MemoComposer, {}))
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    await chooseFiles(input!, [new File(['x'], 'photo.png', { type: 'image/png' })])
    expect(api.attachments.upload).toHaveBeenCalledWith(expect.objectContaining({ memoId: null }))
    expect(editorText(view.container)).toContain('![photo.png](/api/memos/files/att-1)')
    const submit = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes(t('memos.composer.save')))
    click(submit!)
    await flush()
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: ['att-1'],
      content: expect.stringContaining('![photo.png](/api/memos/files/att-1)'),
    }))
  })
})

describe('the comment section', () => {
  it('loads comments and posts a new one with the keyboard', async () => {
    api.comments.list.mockResolvedValue({
      items: [memo({ id: 'comment-1', content: 'first comment', parentId: 'memo-1' })],
      nextCursor: null,
    })
    api.comments.create.mockResolvedValue(memo({ id: 'comment-2', content: 'second comment', parentId: 'memo-1' }))
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 1 }))
    await flush()
    expect(view.container.textContent).toContain('first comment')
    setEditorValue(view.container, 'second comment')
    pressModEnter(view.container.querySelector('.cm-content')!)
    await flush()
    expect(api.comments.create).toHaveBeenCalledWith('memo-1', { content: 'second comment' })
    expect(view.container.textContent).toContain('second comment')
    expect(view.container.textContent).toContain(t('memos.comments.count', { count: 2 }))
  })

  it('edits an own comment in place', async () => {
    api.comments.list.mockResolvedValue({
      items: [memo({ id: 'comment-1', content: 'first comment', parentId: 'memo-1', rev: 3 })],
      nextCursor: null,
    })
    api.patch.mockResolvedValue(memo({ id: 'comment-1', content: 'updated comment', parentId: 'memo-1', rev: 4 }))
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 1 }))
    await flush()
    const edit = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('memos.comments.edit')}"]`)
    expect(edit).not.toBeNull()
    click(edit!)
    await flush()
    const item = view.container.querySelector<HTMLElement>('li')
    expect(item?.querySelector('.cm-content')?.textContent).toBe('first comment')
    setEditorValue(item!, 'updated comment')
    const save = [...view.container.querySelectorAll('button')].find((button) => button.textContent?.includes(t('memos.comments.save')))
    click(save!)
    await flush()
    expect(api.patch).toHaveBeenCalledWith('comment-1', { rev: 3, content: 'updated comment' })
    expect(view.container.textContent).toContain('updated comment')
  })

  it('deletes an own comment after confirmation', async () => {
    api.comments.list.mockResolvedValue({
      items: [memo({ id: 'comment-1', content: 'first comment', parentId: 'memo-1' })],
      nextCursor: null,
    })
    api.remove.mockResolvedValue({ ok: true })
    view = renderElement(createElement('div', null,
      createElement(MemoComments, { memoId: 'memo-1', initialCount: 1 }),
      createElement(ConfirmHost),
    ))
    await flush()
    const remove = view.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('memos.comments.delete')}"]`)
    expect(remove).not.toBeNull()
    click(remove!)
    await flush()
    const confirmButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(t('memos.comments.delete_confirm')))
    expect(confirmButton).toBeDefined()
    click(confirmButton!)
    await flush()
    expect(api.remove).toHaveBeenCalledWith('comment-1')
    expect(view.container.textContent).not.toContain('first comment')
  })

  it('closes comments on an archived memo', async () => {
    api.comments.list.mockResolvedValue({ items: [], nextCursor: null })
    view = renderElement(createElement(MemoComments, { memoId: 'memo-1', initialCount: 0, disabled: true }))
    await flush()
    expect(view.container.querySelector('.cm-editor')).toBeNull()
    expect(view.container.textContent).toContain(t('memos.comments.disabled'))
  })
})

describe('the reaction bar', () => {
  it('upserts a reaction through the api', async () => {
    const item = memo({ reactions: [{ type: '👍', count: 1, reacted: false }] })
    api.reactions.upsert.mockResolvedValue({ reactions: [{ type: '👍', count: 2, reacted: true }] })
    view = renderElement(createElement(MemoReactions, { memo: item }))
    const chip = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.getAttribute('aria-label') === t('memos.reactions.react_with', { emoji: '👍' }))
    expect(chip).not.toBeNull()
    click(chip!)
    await flush()
    expect(api.reactions.upsert).toHaveBeenCalledWith(item.id, { type: '👍' })
    expect(chip!.getAttribute('aria-pressed')).toBe('true')
    expect(chip!.textContent).toContain('2')
  })

  it('draws reactions read-only on an archived memo', () => {
    const item = memo({ state: 'archived', reactions: [{ type: '👍', count: 3, reacted: true }] })
    view = renderElement(createElement(MemoReactions, { memo: item, readOnly: true }))
    expect(view.container.querySelector(`button[aria-label="${t('memos.reactions.add')}"]`)).toBeNull()
    expect(view.container.textContent).toContain('3')
  })
})
