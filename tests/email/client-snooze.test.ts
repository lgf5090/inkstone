// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailFolder, EmailSummary } from '@shared/email/model'
import { renderElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { api } from '../../src/client/lib/api'
import { MessageRow } from '../../src/client/features/email/MessageRow'
import { emailSnoozeOptions, useEmailStore } from '../../src/client/features/email/store'

const original = useEmailStore.getState()

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
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
    threadId: null,
    threadCount: 1,
    snippet: 'The numbers are ready.',
    deliveryStatus: 'sent',
    ...patch,
  }
}

function renderRow(message: EmailSummary) {
  const view = renderElement(
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
  )
  return view
}

function menuItem(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label) ?? null
}

function submenuItem(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[data-submenu-row]')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no submenu row named ${label}`)
  return found
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

describe('email snooze UI', () => {
  it('offers presets in the message menu and sends a future timestamp', async () => {
    const message = summary()
    const snooze = vi.spyOn(api.email, 'snoozeEmail').mockResolvedValue({
      id: message.id,
      snoozedUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    })
    const view = renderRow(message)

    openContextMenu()
    const snoozeRow = menuItem(t('email.snooze.menu'))
    expect(snoozeRow).not.toBeNull()
    act(() => { snoozeRow!.click() })

    act(() => { submenuItem(t('email.snooze.tomorrow')).click() })
    await vi.waitFor(() => expect(snooze).toHaveBeenCalledTimes(1))

    expect(snooze.mock.calls[0]![0]).toBe('a1')
    expect(snooze.mock.calls[0]![1]).toBe(message.id)
    const until = new Date(snooze.mock.calls[0]![2] as string)
    expect(until.getTime()).toBeGreaterThan(Date.now())
    expect(until.getHours()).toBe(8)
    view.unmount()
  })

  it('offers the later-today and next-week presets', () => {
    const now = new Date()
    const options = emailSnoozeOptions(now)
    expect(options.map((option) => option.preset)).toEqual(['later_today', 'tomorrow', 'next_week'])
    const later = new Date(options[0]!.until)
    expect(later.getTime() - now.getTime()).toBe(3 * 60 * 60 * 1000)
    const nextWeek = new Date(options[2]!.until)
    const expected = new Date(now)
    expected.setDate(expected.getDate() + 7)
    expected.setHours(8, 0, 0, 0)
    expect(nextWeek.getHours()).toBe(8)
    expect(nextWeek.getTime()).toBe(expected.getTime())
  })

  it('hides the snooze menu for sent, draft, trash and spam', () => {
    for (const folderId of ['sent', 'draft', 'trash', 'spam']) {
      const view = renderRow(summary({ folderId }))
      openContextMenu()
      expect(menuItem(t('email.snooze.menu'))).toBeNull()
      view.unmount()
      document.body.innerHTML = ''
    }
  })

  it('refreshes after a successful snooze and reports a failed one', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    useEmailStore.setState({ refresh })
    const snooze = vi.spyOn(api.email, 'snoozeEmail').mockResolvedValue({
      id: 'm1',
      snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString()

    await expect(useEmailStore.getState().snoozeMessage('a1', 'm1', until)).resolves.toBe(true)
    expect(snooze).toHaveBeenCalledWith('a1', 'm1', until)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(useEmailStore.getState().actionError).toBeNull()

    snooze.mockRejectedValueOnce(new Error('network down'))
    await expect(useEmailStore.getState().snoozeMessage('a1', 'm1', until)).resolves.toBe(false)
    expect(useEmailStore.getState().actionError).toBe('network down')
  })
})
