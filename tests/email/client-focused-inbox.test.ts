// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailFolder, EmailSummary } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { initI18n, t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { MessageList } from '../../src/client/features/email/MessageList'
import { useEmailStore } from '../../src/client/features/email/store'

const original = useEmailStore.getState()

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
]

function message(patch: Partial<EmailSummary> = {}): EmailSummary {
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
    snippet: 'The numbers are ready.',
    ...patch,
  }
}

function listProps(overrides: Partial<Parameters<typeof MessageList>[0]> = {}): Parameters<typeof MessageList>[0] {
  return {
    messages: [message()],
    total: 1,
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
    selectedIds: new Set<string>(),
    dragEnabled: true,
    focusFilter: 'all',
    focusedInboxEnabled: true,
    readFilter: 'all',
    onReadFilterChange: vi.fn(),
    onFocusFilterChange: vi.fn(),
    onOpen: vi.fn(),
    onToggleSelect: vi.fn(),
    onSelectAll: vi.fn(),
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
    ...overrides,
  }
}

let view: RenderedElement | null = null

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  useEmailStore.setState(original, true)
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
})

describe('the focused inbox list control', () => {
  it('shows All, Focused and Other on the inbox and reports the chosen filter', () => {
    const onFocusFilterChange = vi.fn()
    view = renderElement(createElement(MessageList, listProps({ onFocusFilterChange })))
    const group = document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${t('email.focus.filter')}"]`)
    expect(group).not.toBeNull()
    const labels = [...group!.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent?.trim())
    expect(labels).toEqual([t('email.focus.all'), t('email.focus.focused'), t('email.focus.other')])
    const other = [...group!.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((radio) => radio.textContent?.trim() === t('email.focus.other'))
    act(() => { other!.click() })
    expect(onFocusFilterChange).toHaveBeenCalledWith('other')
  })

  it('hides the control on other folders and when the account disables the focused inbox', () => {
    view = renderElement(createElement(MessageList, listProps({ folderId: 'archive' })))
    expect(document.querySelector(`[role="radiogroup"][aria-label="${t('email.focus.filter')}"]`)).toBeNull()
    view.unmount()

    view = renderElement(createElement(MessageList, listProps({ focusedInboxEnabled: false })))
    expect(document.querySelector(`[role="radiogroup"][aria-label="${t('email.focus.filter')}"]`)).toBeNull()
  })

  it('names the empty view after the chosen focus filter', () => {
    const empty = { messages: [], total: 0 }
    view = renderElement(createElement(MessageList, listProps({ ...empty, focusFilter: 'focused' })))
    expect(document.body.textContent).toContain(t('email.list.empty.focused'))
    view.unmount()

    view = renderElement(createElement(MessageList, listProps({ ...empty, focusFilter: 'other' })))
    expect(document.body.textContent).toContain(t('email.list.empty.other'))
    view.unmount()

    view = renderElement(createElement(MessageList, listProps({ ...empty })))
    expect(document.body.textContent).toContain(t('email.list.empty.inbox'))
  })

  it('passes the read filter to the list call', async () => {
    const list = vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
    useEmailStore.setState({ readFilter: 'unread' })
    await useEmailStore.getState().loadList('a1', 'inbox')
    expect(list.mock.calls.at(-1)?.[1]?.is_read).toBe('0')
    useEmailStore.setState({ readFilter: 'read' })
    await useEmailStore.getState().loadList('a1', 'inbox')
    expect(list.mock.calls.at(-1)?.[1]?.is_read).toBe('1')
    useEmailStore.setState({ readFilter: 'all' })
    await useEmailStore.getState().loadList('a1', 'inbox')
    expect(list.mock.calls.at(-1)?.[1]?.is_read).toBeUndefined()
  })

  it('passes the focus filter to the list call and resets it outside the inbox', async () => {
    const list = vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
    useEmailStore.getState().setFocusFilter('focused')
    await useEmailStore.getState().loadList('a1', 'inbox', 1, { silent: true })
    expect(list.mock.calls.at(-1)?.[1]).toMatchObject({ folder: 'inbox', focused: '1' })

    useEmailStore.getState().setFocusFilter('other')
    await useEmailStore.getState().loadList('a1', 'inbox', 1, { silent: true })
    expect(list.mock.calls.at(-1)?.[1]).toMatchObject({ folder: 'inbox', focused: '0' })

    useEmailStore.getState().setFocusFilter('focused')
    await useEmailStore.getState().loadList('a1', 'archive', 1, { silent: true })
    expect(list.mock.calls.at(-1)?.[1]?.focused).toBeUndefined()
    expect(useEmailStore.getState().focusFilter).toBe('all')

    await useEmailStore.getState().loadList('a1', 'inbox', 1, { silent: true })
    expect(list.mock.calls.at(-1)?.[1]?.focused).toBeUndefined()
  })
})
