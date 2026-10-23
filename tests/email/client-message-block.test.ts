// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailFolder, EmailSummary } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { ConfirmHost } from '../../src/client/components/overlay'
import { MessageRow } from '../../src/client/features/email/MessageRow'
import { useEmailStore } from '../../src/client/features/email/store'
import { useUi } from '../../src/client/store/ui'

const original = useEmailStore.getState()

const message: EmailSummary = {
  id: 'm1',
  folderId: 'inbox',
  subject: 'Quarterly report',
  sender: 'Ada Lovelace <ada@example.com>',
  recipient: 'me@example.com',
  cc: null,
  bcc: null,
  date: new Date().toISOString(),
  read: false,
  starred: false,
  threadId: null,
  threadCount: 1,
  snippet: 'The numbers are ready.',
  deliveryStatus: 'sent',
}

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 1, parentId: null, color: null, sortOrder: 0 },
]

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

function harness(): RenderedElement {
  return renderElement(createElement('div', null,
    createElement('ul', null,
      createElement(MessageRow, {
        message,
        selected: false,
        batchSelected: false,
        selectedIds: new Set<string>(),
        dragEnabled: true,
        searchMode: false,
        query: '',
        folders,
        tags: [],
        onOpen: vi.fn(),
        onToggleSelect: vi.fn(),
        onToggleStar: vi.fn(),
        onToggleRead: vi.fn(),
        onMove: vi.fn(),
        onArchive: vi.fn(),
        onTag: vi.fn(),
        onDelete: vi.fn(),
        onRetry: vi.fn(),
      })),
    createElement(ConfirmHost)))
}

function menuItem(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no menu item named ${label}`)
  return found
}

function openBlockDialog(): HTMLElement {
  const row = document.querySelector('[data-email-row]')!
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }))
  })
  act(() => { menuItem(t('email.rules.block_sender')).click() })
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  if (!dialog) throw new Error('block sender dialog did not open')
  return dialog
}

let view: RenderedElement | null = null

beforeEach(() => {
  vi.spyOn(api.email, 'blockSender').mockResolvedValue({
    address: 'ada@example.com',
    messageId: message.id,
    folderId: 'spam',
  })
  vi.spyOn(api.email, 'listFolders').mockResolvedValue(folders)
  vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
  useUi.setState({ toasts: [] })
  useEmailStore.setState(original, true)
  useEmailStore.setState({
    accountId: 'a1',
    folderId: 'inbox',
    listMode: 'folder',
    page: 1,
    messages: [message],
    total: 1,
    listStatus: 'ready',
  })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('blocking a sender from the message row', () => {
  it('confirms, calls the API and removes the message from the list', async () => {
    view = harness()
    const dialog = openBlockDialog()
    expect(dialog.textContent).toContain(t('email.rules.block_sender_title', { sender: 'Ada Lovelace' }))

    await act(async () => {
      const confirmButton = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent?.trim() === t('email.rules.block_sender'))!
      confirmButton.click()
      await Promise.resolve()
    })
    await settle()

    expect(api.email.blockSender).toHaveBeenCalledWith('a1', 'm1')
    expect(useEmailStore.getState().messages).toEqual([])
    expect(useUi.getState().toasts.some((toast) => toast.title === t('email.rules.block_sender_done'))).toBe(true)
  })

  it('does nothing when the confirmation is cancelled', async () => {
    view = harness()
    const dialog = openBlockDialog()

    await act(async () => {
      const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent?.trim() === t('common.cancel'))!
      cancel.click()
      await Promise.resolve()
    })
    await settle()

    expect(api.email.blockSender).not.toHaveBeenCalled()
    expect(useEmailStore.getState().messages).toHaveLength(1)
  })
})
