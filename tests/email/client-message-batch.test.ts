// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailFolder, EmailMessage, EmailSummary } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { useEmailStore } from '../../src/client/features/email/store'
import { MessageBatchBar } from '../../src/client/features/email/MessageBatchBar'
import { MessageList } from '../../src/client/features/email/MessageList'
import { ConfirmHost } from '../../src/client/components/overlay'
import { t } from '../../src/client/lib/i18n'
import { renderElement } from '../../src/client/lib/test-render'

const original = useEmailStore.getState()

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 2, parentId: null, color: null, sortOrder: 0 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'trash', name: 'Trash', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
]

function message(patch: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'm1',
    folderId: 'inbox',
    subject: 'Quarterly report',
    sender: 'Ada <ada@example.com>',
    recipient: 'me@example.com',
    cc: null,
    bcc: null,
    date: '2026-01-01T10:00:00.000Z',
    read: false,
    starred: false,
    threadId: null,
    threadCount: 1,
    snippet: 'The numbers are ready.',
    body: '<p>The numbers are ready.</p>',
    bodySource: null,
    inReplyTo: null,
    references: [],
    messageId: null,
    rawHeaders: [],
    attachments: [],
    ...patch,
  }
}

function buttonByText(label: string, root: HTMLElement = document.documentElement): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function setupSelection(ids: string[] = ['m1', 'm2']): void {
  const rows = [message(), message({ id: 'm2', subject: 'Second' })]
  useEmailStore.setState({
    messages: rows,
    total: rows.length,
    accountId: 'a1',
    folderId: 'inbox',
    listMode: 'folder',
    page: 1,
    listStatus: 'ready',
    folders,
    selectedIds: new Set(ids),
    selectionAnchorId: ids[ids.length - 1] ?? null,
  })
}

function Harness() {
  const selectedIds = useEmailStore((state) => state.selectedIds)
  const batchEmails = useEmailStore((state) => state.batchEmails)
  const clearSelection = useEmailStore((state) => state.clearSelection)
  return createElement('div', { className: 'relative' },
    createElement(MessageBatchBar, {
      selectedCount: selectedIds.size,
      folders,
      onClear: clearSelection,
      onAction: (action, folderId) => batchEmails('a1', action, folderId),
    }),
    createElement(ConfirmHost))
}

function mockBatch(): ReturnType<typeof vi.spyOn> {
  vi.spyOn(api.email, 'listFolders').mockResolvedValue(folders)
  vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
  return vi.spyOn(api.email, 'batchEmails').mockResolvedValue({ updated: 2 })
}

beforeEach(() => {
  useEmailStore.setState(original, true)
})

afterEach(() => {
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
  document.body.innerHTML = ''
})

describe('the email batch bar', () => {
  it('runs a flag action on the selected ids and clears the selection', async () => {
    setupSelection()
    const batch = mockBatch()
    const view = renderElement(createElement(Harness))
    expect(document.querySelector('[data-email-batch-bar]')?.textContent).toContain(t('email.batch.selected', { count: 2 }))

    await act(async () => {
      buttonByText(t('email.list.mark_read')).click()
      await Promise.resolve()
    })
    expect(batch).toHaveBeenCalledWith('a1', { ids: ['m1', 'm2'], action: 'read' })
    expect(useEmailStore.getState().selectedIds.size).toBe(0)
    expect(document.querySelector('[data-email-batch-bar]')).toBeNull()
    view.unmount()
  })

  it('moves the selection through the folder menu', async () => {
    setupSelection()
    const batch = mockBatch()
    const view = renderElement(createElement(Harness))

    act(() => { buttonByText(t('email.message.move_to')).click() })
    const archive = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.trim() === t('email.folder.archive'))
    expect(archive).toBeTruthy()
    await act(async () => {
      archive!.click()
      await Promise.resolve()
    })
    expect(batch).toHaveBeenCalledWith('a1', { ids: ['m1', 'm2'], action: 'move', folderId: 'archive' })
    view.unmount()
  })

  it('asks before trashing and cancels without a request', async () => {
    setupSelection()
    const batch = mockBatch()
    const view = renderElement(createElement(Harness))

    await act(async () => {
      buttonByText(t('email.detail.delete')).click()
      await Promise.resolve()
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog!.textContent).toContain(t('email.batch.delete_title'))
    expect(batch).not.toHaveBeenCalled()

    await act(async () => {
      buttonByText(t('common.cancel'), dialog!).click()
      await Promise.resolve()
    })
    expect(batch).not.toHaveBeenCalled()
    expect(useEmailStore.getState().selectedIds.size).toBe(2)

    await act(async () => {
      buttonByText(t('email.detail.delete')).click()
      await Promise.resolve()
    })
    const confirmDialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => {
      buttonByText(t('email.detail.delete'), confirmDialog).click()
      await Promise.resolve()
    })
    expect(batch).toHaveBeenCalledWith('a1', { ids: ['m1', 'm2'], action: 'trash' })
    view.unmount()
  })

  it('clears the selection when Escape is pressed', () => {
    setupSelection()
    const view = renderElement(createElement(Harness))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(useEmailStore.getState().selectedIds.size).toBe(0)
    expect(document.querySelector('[data-email-batch-bar]')).toBeNull()
    view.unmount()
  })
})

describe('the message list select-all checkbox', () => {
  it('reports the mixed state and selects or clears the page', () => {
    const rows: EmailSummary[] = [message(), message({ id: 'm2' })]
    const onSelectAll = vi.fn()
    const view = renderElement(createElement(MessageList, {
      messages: rows,
      total: rows.length,
      status: 'ready',
      error: null,
      page: 1,
      refreshing: false,
      searchMode: false,
      query: '',
      folderId: 'inbox',
      folders,
      tags: [],
      selectedId: null,
      selectedIds: new Set(['m1']),
      dragEnabled: true,
      focusFilter: 'all',
      focusedInboxEnabled: true,
      onFocusFilterChange: vi.fn(),
      onOpen: vi.fn(),
      onToggleSelect: vi.fn(),
      onSelectAll,
      onToggleStar: vi.fn(),
      onToggleRead: vi.fn(),
      onMove: vi.fn(),
      onArchive: vi.fn(),
      onTag: vi.fn(),
      onDelete: vi.fn(),
      onRetry: vi.fn(),
      onPage: vi.fn(),
      onReload: vi.fn(),
      onManageTrash: vi.fn(),
      onCompose: vi.fn(),
    }))
    const header = document.querySelector<HTMLButtonElement>(
      `[role="checkbox"][aria-label="${t('email.list.select_all')}"]`,
    )
    expect(header?.getAttribute('aria-checked')).toBe('mixed')
    act(() => { header!.click() })
    expect(onSelectAll).toHaveBeenCalledWith(true)

    view.rerender(createElement(MessageList, {
      messages: rows,
      total: rows.length,
      status: 'ready',
      error: null,
      page: 1,
      refreshing: false,
      searchMode: false,
      query: '',
      folderId: 'inbox',
      folders,
      tags: [],
      selectedId: null,
      selectedIds: new Set(['m1', 'm2']),
      dragEnabled: true,
      focusFilter: 'all',
      focusedInboxEnabled: true,
      onFocusFilterChange: vi.fn(),
      onOpen: vi.fn(),
      onToggleSelect: vi.fn(),
      onSelectAll,
      onToggleStar: vi.fn(),
      onToggleRead: vi.fn(),
      onMove: vi.fn(),
      onArchive: vi.fn(),
      onTag: vi.fn(),
      onDelete: vi.fn(),
      onRetry: vi.fn(),
      onPage: vi.fn(),
      onReload: vi.fn(),
      onManageTrash: vi.fn(),
      onCompose: vi.fn(),
    }))
    const all = document.querySelector<HTMLButtonElement>(
      `[role="checkbox"][aria-label="${t('email.list.select_all')}"]`,
    )
    expect(all?.getAttribute('aria-checked')).toBe('true')
    act(() => { all!.click() })
    expect(onSelectAll).toHaveBeenLastCalledWith(false)
    view.unmount()
  })
})
