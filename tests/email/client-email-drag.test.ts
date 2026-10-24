// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailFolder, EmailSummary, EmailTag } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { t } from '../../src/client/lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../src/client/lib/test-render'
import { useUi } from '../../src/client/store/ui'
import { MailboxPage } from '../../src/client/features/email/MailboxPage'
import { useEmailStore } from '../../src/client/features/email/store'
import {
  EMAIL_DRAG_MIME,
  EMAIL_FOLDER_DRAG_MIME,
  decodeEmailDrag,
  decodeEmailFolderDrag,
  encodeEmailDrag,
  encodeEmailFolderDrag,
} from '../../src/client/features/email/email-drag'

const account: EmailAccount = {
  id: 'a1',
  address: 'ada@example.com',
  displayName: 'Ada',
  settings: { signature: { enabled: false, text: '' }, autoDraft: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 1, totalCount: 1, parentId: null, color: null, sortOrder: 0 },
  { id: 'sent', name: 'Sent', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'draft', name: 'Drafts', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'trash', name: 'Trash', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'spam', name: 'Spam', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'work', name: 'Work', isDeletable: true, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'projects', name: 'Projects', isDeletable: true, unreadCount: 0, totalCount: 0, parentId: 'work', color: null, sortOrder: 0 },
  { id: 'personal', name: 'Personal', isDeletable: true, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
]

const tags: EmailTag[] = [
  { id: 't-work', name: 'work', color: '#3b82f6', count: 2 },
]

function summary(patch: Partial<EmailSummary> = {}): EmailSummary {
  return {
    id: 'm1',
    folderId: 'inbox',
    subject: 'Quarterly report',
    sender: 'Ada <ada@example.com>',
    recipient: 'me@example.com',
    cc: null,
    bcc: null,
    date: '2026-01-01T10:00:00.000Z',
    read: true,
    starred: false,
    threadId: null,
    threadCount: 1,
    snippet: 'The numbers are ready.',
    deliveryStatus: 'sent',
    ...patch,
  }
}

const messages = [summary(), summary({ id: 'm2', subject: 'Second report' })]
const original = useEmailStore.getState()
const uiOriginal = useUi.getState()

function mailboxAddress() {
  return {
    kind: 'mailbox' as const,
    accountId: account.id,
    folderId: 'inbox',
    messageId: null,
    compose: null,
    draftId: null,
  }
}

function messageRow(): HTMLButtonElement {
  const row = document.querySelector<HTMLButtonElement>('button[data-email-open]')
  if (!row) throw new Error('the message list did not render a row')
  return row
}

function folderRow(folderId: string): HTMLButtonElement {
  const row = document.querySelector<HTMLButtonElement>(`button[data-email-folder-row="${folderId}"]`)
  if (!row) throw new Error(`the folder tree did not render ${folderId}`)
  return row
}

function tagRow(tagId: string): HTMLButtonElement {
  const row = document.querySelector<HTMLButtonElement>(`button[data-email-tag-row="${tagId}"]`)
  if (!row) throw new Error(`the tag tree did not render ${tagId}`)
  return row
}

function openSidebarTab(tab: string): void {
  const button = document.querySelector<HTMLButtonElement>(`[data-email-sidebar-tab="${tab}"]`)
  if (!button) throw new Error(`no sidebar tab named ${tab}`)
  act(() => button.click())
}

function dataTransfer(): DataTransfer {
  const values = new Map<string, string>()
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() { return [...values.keys()] },
    setData(type: string, value: string) { values.set(type, value) },
    getData(type: string) { return values.get(type) ?? '' },
    setDragImage: vi.fn(),
  } as unknown as DataTransfer
}

function fireDrag(target: Element, type: string, transfer: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  act(() => { target.dispatchEvent(event) })
  return event
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index++) await Promise.resolve()
  })
}

async function mount(): Promise<RenderedElement> {
  const view = renderElement(createElement(MailboxPage, { address: mailboxAddress(), account }))
  await settle()
  return view
}

beforeEach(() => {
  useEmailStore.setState(original, true)
  useUi.setState({ toasts: [] })
  stubBreakpoint(true)
  window.history.replaceState(null, '', '/email/accounts/a1/folders/inbox')
  vi.spyOn(api.email, 'listFolders').mockResolvedValue(folders)
  vi.spyOn(api.email, 'listTags').mockResolvedValue(tags)
  vi.spyOn(api.email, 'listSearches').mockResolvedValue([])
  vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: messages, totalCount: messages.length })
  vi.spyOn(api.email, 'batchEmails').mockResolvedValue({ updated: 1 })
  vi.spyOn(api.email, 'updateFolder').mockResolvedValue(folders[8]!)
  vi.spyOn(api.email, 'attachTag').mockResolvedValue(undefined)
})

afterEach(() => {
  useEmailStore.getState().stopPolling()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
  useUi.setState(uiOriginal, true)
  window.history.replaceState(null, '', '/')
  document.body.innerHTML = ''
})

describe('the email drag payloads', () => {
  it('round-trips message ids and ignores malformed or empty values', () => {
    expect(decodeEmailDrag(encodeEmailDrag(['m1', 'm2']))).toEqual(['m1', 'm2'])
    expect(decodeEmailDrag(encodeEmailDrag(['m1', 'm1', '']))).toEqual(['m1'])
    expect(decodeEmailDrag('')).toEqual([])
    expect(decodeEmailDrag('not json')).toEqual([])
    expect(decodeEmailDrag('{"emailIds":["m1",2,""]}')).toEqual(['m1'])
  })

  it('round-trips a folder id and ignores malformed values', () => {
    expect(decodeEmailFolderDrag(encodeEmailFolderDrag('work'))).toBe('work')
    expect(decodeEmailFolderDrag('')).toBeNull()
    expect(decodeEmailFolderDrag('{')).toBeNull()
    expect(decodeEmailFolderDrag('{"folderId":3}')).toBeNull()
  })
})

describe('dragging messages', () => {
  it('writes the row id, or the whole selection when that row is selected', async () => {
    const view = await mount()
    const single = dataTransfer()
    fireDrag(messageRow(), 'dragstart', single)
    expect(single.effectAllowed).toBe('move')
    expect(decodeEmailDrag(single.getData(EMAIL_DRAG_MIME))).toEqual(['m1'])

    act(() => useEmailStore.setState({ selectedIds: new Set(['m1', 'm2']) }))
    const selected = dataTransfer()
    fireDrag(messageRow(), 'dragstart', selected)
    expect(decodeEmailDrag(selected.getData(EMAIL_DRAG_MIME))).toEqual(['m1', 'm2'])
    view.unmount()
  })

  it('moves the dragged messages into a custom folder and clears the selection', async () => {
    const view = await mount()
    act(() => useEmailStore.setState({ selectedIds: new Set(['m1', 'm2']) }))
    const transfer = dataTransfer()
    fireDrag(messageRow(), 'dragstart', transfer)
    const target = folderRow('work')
    fireDrag(target, 'dragover', transfer)
    fireDrag(target, 'drop', transfer)
    await settle()

    expect(api.email.batchEmails).toHaveBeenCalledWith('a1', {
      ids: ['m1', 'm2'],
      action: 'move',
      folderId: 'work',
    })
    expect(useEmailStore.getState().selectedIds.size).toBe(0)
    view.unmount()
  })

  it('uses the trash and archive actions for their folders', async () => {
    const view = await mount()
    const toTrash = dataTransfer()
    fireDrag(messageRow(), 'dragstart', toTrash)
    fireDrag(folderRow('trash'), 'drop', toTrash)
    await settle()
    expect(api.email.batchEmails).toHaveBeenCalledWith('a1', { ids: ['m1'], action: 'trash' })

    const toArchive = dataTransfer()
    fireDrag(messageRow(), 'dragstart', toArchive)
    fireDrag(folderRow('archive'), 'drop', toArchive)
    await settle()
    expect(api.email.batchEmails).toHaveBeenCalledWith('a1', { ids: ['m1'], action: 'archive' })
    view.unmount()
  })

  it('rejects drops on Sent and Drafts with a toast', async () => {
    const view = await mount()
    const transfer = dataTransfer()
    fireDrag(messageRow(), 'dragstart', transfer)
    fireDrag(folderRow('sent'), 'drop', transfer)
    await settle()
    fireDrag(folderRow('draft'), 'drop', transfer)
    await settle()

    expect(api.email.batchEmails).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.map((toast) => toast.title)).toContain(t('email.drag.reject'))
    view.unmount()
  })
})

describe('dropping messages on tags', () => {
  it('attaches the tag to every dragged message', async () => {
    const view = await mount()
    act(() => useEmailStore.setState({ selectedIds: new Set(['m1', 'm2']) }))
    openSidebarTab('tags')
    const transfer = dataTransfer()
    fireDrag(messageRow(), 'dragstart', transfer)
    const target = tagRow('t-work')
    fireDrag(target, 'dragover', transfer)
    fireDrag(target, 'drop', transfer)
    await settle()

    expect(api.email.attachTag).toHaveBeenCalledTimes(2)
    expect(api.email.attachTag).toHaveBeenCalledWith('a1', 'm1', { tagId: 't-work' })
    expect(api.email.attachTag).toHaveBeenCalledWith('a1', 'm2', { tagId: 't-work' })
    expect(useEmailStore.getState().selectedIds.size).toBe(0)
    view.unmount()
  })
})

describe('dragging folders', () => {
  it('keeps system folders fixed and makes custom folders draggable', async () => {
    const view = await mount()
    expect(folderRow('inbox').draggable).toBe(false)
    expect(folderRow('work').draggable).toBe(true)
    view.unmount()
  })

  it('reparents a custom folder through the folder update action', async () => {
    const view = await mount()
    const transfer = dataTransfer()
    fireDrag(folderRow('personal'), 'dragstart', transfer)
    expect(decodeEmailFolderDrag(transfer.getData(EMAIL_FOLDER_DRAG_MIME))).toBe('personal')
    const target = folderRow('work')
    fireDrag(target, 'dragover', transfer)
    fireDrag(target, 'drop', transfer)
    await settle()

    expect(api.email.updateFolder).toHaveBeenCalledWith('a1', 'personal', { parentId: 'work' })
    expect(api.email.listFolders).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('rejects dropping a folder into its own descendant', async () => {
    const view = await mount()
    act(() => {
      document.querySelector<HTMLButtonElement>(
        `button[aria-label="${t('email.folder.expand', { name: 'Work' })}"]`,
      )!.click()
    })
    const transfer = dataTransfer()
    fireDrag(folderRow('work'), 'dragstart', transfer)
    fireDrag(folderRow('projects'), 'drop', transfer)
    await settle()

    expect(api.email.updateFolder).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.map((toast) => toast.title)).toContain(t('email.drag.folder_invalid'))
    view.unmount()
  })
})
