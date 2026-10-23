// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailFolder, EmailMessage } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { hotkeyText, listHotkeys } from '../../src/client/lib/hotkeys'
import { t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { MailboxPage } from '../../src/client/features/email/MailboxPage'
import { useEmailStore } from '../../src/client/features/email/store'

const account: EmailAccount = {
  id: 'a1',
  address: 'ada@example.com',
  displayName: 'Ada',
  settings: { signature: { enabled: false, text: '' }, autoDraft: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 1, parentId: null, color: null, sortOrder: 0 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'trash', name: 'Trash', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
]

const message: EmailMessage = {
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
  body: '<p>The numbers are ready.</p>',
  bodySource: 'The numbers are ready.',
  inReplyTo: null,
  references: [],
  messageId: null,
  rawHeaders: [],
  attachments: [],
}

const original = useEmailStore.getState()

function mailboxAddress(folderId: string, messageId: string | null = null) {
  return { kind: 'mailbox' as const, accountId: account.id, folderId, messageId, compose: null, draftId: null }
}

function mount(folderId: string, messageId: string | null = null): RenderedElement {
  return renderElement(createElement(MailboxPage, { address: mailboxAddress(folderId, messageId), account }))
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function searchInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${t('email.search.placeholder')}"]`)
  if (!input) throw new Error('the list search input is not on screen')
  return input
}

beforeEach(() => {
  useEmailStore.setState(original, true)
  window.history.replaceState(null, '', '/email/accounts/a1/folders/inbox')
  vi.spyOn(api.email, 'listFolders').mockResolvedValue(folders)
  vi.spyOn(api.email, 'listTags').mockResolvedValue([])
  vi.spyOn(api.email, 'listSearches').mockResolvedValue([])
  vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
  vi.spyOn(api.email, 'getEmail').mockResolvedValue(message)
})

afterEach(() => {
  useEmailStore.getState().stopPolling()
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
  window.history.replaceState(null, '', '/')
  document.body.innerHTML = ''
})

describe('the mailbox keyboard shortcuts', () => {
  it('opens a new message on c', async () => {
    const view = mount('inbox')
    await flush()

    press(window, 'c')

    expect(window.location.pathname).toBe('/email/accounts/a1/folders/inbox')
    expect(new URLSearchParams(window.location.search).get('compose')).toBe('new')
    view.unmount()
  })

  it('replies only once a message is open', async () => {
    const view = mount('inbox', 'm1')
    expect(useEmailStore.getState().selectedMessage).toBeNull()

    press(window, 'r')
    expect(window.location.search).not.toContain('compose')

    await flush()
    expect(useEmailStore.getState().selectedMessage?.id).toBe('m1')

    press(window, 'r')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('compose')).toBe('reply')
    expect(params.get('message')).toBe('m1')
    view.unmount()
  })

  it('replies all and forwards with a and f', async () => {
    const view = mount('inbox', 'm1')
    await flush()

    press(window, 'a')
    expect(new URLSearchParams(window.location.search).get('compose')).toBe('reply-all')

    window.history.replaceState(null, '', '/email/accounts/a1/folders/inbox?message=m1')
    press(window, 'f')
    expect(new URLSearchParams(window.location.search).get('compose')).toBe('forward')
    view.unmount()
  })

  it('focuses the list search input on slash', async () => {
    const view = mount('inbox')
    await flush()
    const input = searchInput()
    expect(document.activeElement).not.toBe(input)

    press(window, '/')

    expect(document.activeElement).toBe(input)
    view.unmount()
  })

  it('goes to the inbox after g then i', async () => {
    window.history.replaceState(null, '', '/email/accounts/a1/folders/archive')
    const view = mount('archive')
    await flush()
    expect(window.location.pathname).toBe('/email/accounts/a1/folders/archive')

    press(window, 'g')
    press(window, 'i')

    expect(window.location.pathname).toBe('/email/accounts/a1/folders/inbox')
    expect(window.location.search).toBe('')
    view.unmount()
  })

  it('ignores shortcuts typed into an input and while a dialog is open', async () => {
    window.history.replaceState(null, '', '/email/accounts/a1/folders/archive')
    const view = mount('archive')
    await flush()
    const input = searchInput()
    act(() => input.focus())

    press(input, 'c')
    press(input, 'g')
    press(input, 'i')

    expect(window.location.pathname).toBe('/email/accounts/a1/folders/archive')
    expect(window.location.search).toBe('')

    press(window, 'g')
    press(input, 'i')
    expect(window.location.pathname).toBe('/email/accounts/a1/folders/archive')

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    press(window, 'c')
    expect(window.location.search).toBe('')
    dialog.remove()
    view.unmount()
  })

  it('clears the batch selection on Escape', async () => {
    const view = mount('inbox')
    await flush()
    act(() => useEmailStore.setState({ selectedIds: new Set(['m1']) }))
    expect(useEmailStore.getState().selectedIds.size).toBe(1)

    press(window, 'Escape')

    expect(useEmailStore.getState().selectedIds.size).toBe(0)
    view.unmount()
  })

  it('lists the mailbox keys under the email group while mounted', async () => {
    const view = mount('inbox')
    await flush()
    const prefix = listHotkeys().find((hotkey) => hotkey.id === 'email-inbox-prefix')
    expect(prefix).toBeTruthy()
    expect(hotkeyText(prefix!.group)).toBe(t('email.shortcuts.group'))
    view.unmount()
  })

  it('unregisters every email hotkey on unmount', async () => {
    const view = mount('inbox')
    await flush()
    expect(listHotkeys().some((hotkey) => hotkey.id.startsWith('email-'))).toBe(true)

    press(window, 'g')
    view.unmount()
    expect(listHotkeys().some((hotkey) => hotkey.id.startsWith('email-'))).toBe(false)

    press(window, 'i')
    press(window, 'c')
    expect(window.location.search).toBe('')
    expect(window.location.pathname).toBe('/email/accounts/a1/folders/inbox')
  })
})
