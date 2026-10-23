// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailFolder, EmailMessage, EmailSummary } from '@shared/email/model'
import { renderElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { api } from '../../src/client/lib/api'
import { MessageRow } from '../../src/client/features/email/MessageRow'
import { useEmailStore } from '../../src/client/features/email/store'

const original = useEmailStore.getState()

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
]

function summary(patch: Partial<EmailSummary> = {}): EmailSummary {
  return {
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
    important: false,
    muted: false,
    followUpAt: null,
    threadId: 't1',
    threadCount: 1,
    snippet: 'The numbers are ready.',
    deliveryStatus: 'sent',
    ...patch,
  }
}

function message(patch: Partial<EmailMessage> = {}): EmailMessage {
  return {
    ...summary(),
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

function renderRow(row: EmailSummary) {
  const view = renderElement(
    createElement('ul', null,
      createElement(MessageRow, {
        message: row,
        selected: false,
        batchSelected: false,
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
  )
  return view
}

function menuItem(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label) ?? null
}

function submenuItem(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-submenu-row]')]
    .find((node) => node.textContent?.trim() === label) ?? null
}

function openContextMenu(): void {
  const row = document.querySelector('[data-email-row]')!
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }))
  })
}

beforeEach(() => {
  useEmailStore.setState(original, true)
  useEmailStore.setState({ accountId: 'a1', refresh: vi.fn().mockResolvedValue(undefined) })
})

afterEach(() => {
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
  document.body.innerHTML = ''
})

describe('message flag menus', () => {
  it('marks the message important from its menu', async () => {
    const row = summary()
    useEmailStore.setState({ messages: [row], total: 1, listStatus: 'ready' })
    const update = vi.spyOn(api.email, 'updateEmail').mockResolvedValue(message({ ...row, important: true }))
    const view = renderRow(row)

    openContextMenu()
    act(() => { menuItem(t('email.important.mark'))!.click() })
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith('a1', row.id, { important: true })
    expect(useEmailStore.getState().messages[0]?.important).toBe(true)
    view.unmount()
  })

  it('mutes and unmutes the thread from its menu', async () => {
    const row = summary({ muted: true })
    const mute = vi.spyOn(api.email, 'muteThread').mockResolvedValue(undefined)
    const view = renderRow(row)

    openContextMenu()
    act(() => { menuItem(t('email.mute.unmute'))!.click() })
    await vi.waitFor(() => expect(mute).toHaveBeenCalledTimes(1))
    expect(mute).toHaveBeenCalledWith('a1', 't1', false)
    view.unmount()
  })

  it('schedules a follow-up for tomorrow morning and clears it', async () => {
    const row = summary()
    const setFollowUp = vi.spyOn(api.email, 'setFollowUp')
      .mockResolvedValueOnce(message({ ...row, important: true, followUpAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }))
      .mockResolvedValueOnce(message({ ...row, important: true, followUpAt: null }))
    const refresh = vi.fn().mockResolvedValue(undefined)
    useEmailStore.setState({ refresh })
    const view = renderRow(row)

    openContextMenu()
    act(() => { menuItem(t('email.followup.menu'))!.click() })
    const clear = submenuItem(t('email.followup.clear'))!
    expect(clear.disabled).toBe(true)
    act(() => { submenuItem(t('email.followup.tomorrow'))!.click() })
    await vi.waitFor(() => expect(setFollowUp).toHaveBeenCalledTimes(1))
    const at = setFollowUp.mock.calls[0]![2] as string
    expect(setFollowUp.mock.calls[0]!.slice(0, 2)).toEqual(['a1', row.id])
    expect(new Date(at).getHours()).toBe(8)
    expect(new Date(at).getTime()).toBeGreaterThan(Date.now())
    expect(refresh).toHaveBeenCalledTimes(1)

    useEmailStore.setState({ messages: [{ ...row, important: true, followUpAt: at }] })
    view.unmount()
    const activeView = renderRow(summary({ important: true, followUpAt: at }))
    openContextMenu()
    act(() => { menuItem(t('email.followup.menu'))!.click() })
    act(() => { submenuItem(t('email.followup.clear'))!.click() })
    await vi.waitFor(() => expect(setFollowUp).toHaveBeenCalledTimes(2))
    expect(setFollowUp.mock.calls[1]![2]).toBeNull()
    activeView.unmount()
  })

  it('hides the flag actions for sent, draft, trash and spam', () => {
    for (const folderId of ['sent', 'draft', 'trash', 'spam']) {
      const view = renderRow(summary({ folderId }))
      openContextMenu()
      expect(menuItem(t('email.important.mark'))).toBeNull()
      expect(menuItem(t('email.mute.thread'))).toBeNull()
      expect(menuItem(t('email.followup.menu'))).toBeNull()
      view.unmount()
      document.body.innerHTML = ''
    }
  })

  it('shows important and muted indicators in the row', () => {
    const view = renderRow(summary({ important: true, muted: true }))
    const row = document.querySelector('[data-email-row]')!
    expect(row.textContent).toContain(t('email.important.badge'))
    expect(row.textContent).toContain(t('email.mute.badge'))
    view.unmount()
  })
})

describe('flag store actions', () => {
  it('rolls back an important toggle when the write fails', async () => {
    const row = message()
    useEmailStore.setState({
      messages: [row],
      total: 1,
      selectedId: row.id,
      selectedMessage: row,
      thread: [row],
      listStatus: 'ready',
      actionError: null,
    })
    const update = vi.spyOn(api.email, 'updateEmail').mockResolvedValue({ ...row, important: true })
    const applied = useEmailStore.getState().toggleImportant('a1', row.id)
    expect(useEmailStore.getState().messages[0]!.important).toBe(true)
    await expect(applied).resolves.toBe(true)
    expect(useEmailStore.getState().selectedMessage!.important).toBe(true)

    update.mockRejectedValueOnce(new Error('network down'))
    const failed = useEmailStore.getState().toggleImportant('a1', row.id)
    expect(useEmailStore.getState().messages[0]!.important).toBe(false)
    await expect(failed).resolves.toBe(false)
    expect(useEmailStore.getState().messages[0]!.important).toBe(true)
    expect(useEmailStore.getState().actionError).toBe('network down')
  })

  it('mutes every listed message of the thread and refreshes', async () => {
    const first = message({ id: 'm1', threadId: 't1' })
    const second = message({ id: 'm2', threadId: 't1' })
    const other = message({ id: 'm3', threadId: 't2' })
    const refresh = vi.fn().mockResolvedValue(undefined)
    useEmailStore.setState({
      messages: [first, second, other],
      total: 3,
      thread: [first],
      selectedMessage: first,
      listStatus: 'ready',
      refresh,
      actionError: null,
    })
    const mute = vi.spyOn(api.email, 'muteThread').mockResolvedValue(undefined)

    await expect(useEmailStore.getState().muteThread('a1', 't1', true)).resolves.toBe(true)
    expect(mute).toHaveBeenCalledWith('a1', 't1', true)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(useEmailStore.getState().messages.map((row) => row.muted)).toEqual([true, true, false])

    mute.mockRejectedValueOnce(new Error('network down'))
    await expect(useEmailStore.getState().muteThread('a1', 't2', true)).resolves.toBe(false)
    expect(useEmailStore.getState().messages.map((row) => row.muted)).toEqual([true, true, false])
    expect(useEmailStore.getState().actionError).toBe('network down')
  })

  it('applies the follow-up the server stored and reports a failure', async () => {
    const row = message()
    useEmailStore.setState({
      messages: [row],
      total: 1,
      thread: [row],
      selectedMessage: row,
      listStatus: 'ready',
      refresh: vi.fn().mockResolvedValue(undefined),
      actionError: null,
    })
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const followUp = vi.spyOn(api.email, 'setFollowUp')
      .mockResolvedValue(message({ ...row, important: true, followUpAt: at }))

    await expect(useEmailStore.getState().setFollowUp('a1', row.id, at)).resolves.toBe(true)
    expect(followUp).toHaveBeenCalledWith('a1', row.id, at)
    expect(useEmailStore.getState().messages[0]).toMatchObject({ important: true, followUpAt: at })
    expect(useEmailStore.getState().selectedMessage).toMatchObject({ important: true, followUpAt: at })

    followUp.mockRejectedValueOnce(new Error('network down'))
    await expect(useEmailStore.getState().setFollowUp('a1', row.id, null)).resolves.toBe(false)
    expect(useEmailStore.getState().actionError).toBe('network down')
  })
})
