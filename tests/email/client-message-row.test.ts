// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailFolder, EmailSummary, EmailTag } from '@shared/email/model'
import { renderElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { MessageRow } from '../../src/client/features/email/MessageRow'

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

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 1, parentId: null, color: null, sortOrder: 0 },
  { id: 'archive', name: 'Archive', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
  { id: 'work', name: 'Work', isDeletable: true, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
]

const tags: EmailTag[] = [
  { id: 'tag-work', name: 'work', color: null, count: 2 },
]

function renderRow(message: EmailSummary, callbacks: {
  onOpen?: () => void
  onToggleSelect?: (modifiers: { shiftKey: boolean }) => void
  onToggleStar?: () => void
  onToggleRead?: () => void
  onMove?: (folderId: string) => void
  onArchive?: () => void
  onTag?: (tag: EmailTag) => void
  onDelete?: () => void
  onRetry?: () => void
} = {}, batchSelected = false) {
  const handlers = {
    onOpen: callbacks.onOpen ?? vi.fn(),
    onToggleSelect: callbacks.onToggleSelect ?? vi.fn(),
    onToggleStar: callbacks.onToggleStar ?? vi.fn(),
    onToggleRead: callbacks.onToggleRead ?? vi.fn(),
    onMove: callbacks.onMove ?? vi.fn(),
    onArchive: callbacks.onArchive ?? vi.fn(),
    onTag: callbacks.onTag ?? vi.fn(),
    onDelete: callbacks.onDelete ?? vi.fn(),
    onRetry: callbacks.onRetry ?? vi.fn(),
  }
  const view = renderElement(
    createElement('ul', null,
      createElement(MessageRow, {
        message,
        selected: false,
        batchSelected,
        searchMode: false,
        query: '',
        folders,
        tags,
        ...handlers,
      })),
  )
  return { view, handlers }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function menuItem(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no menu item named ${label}`)
  return found
}

function openContextMenu(): void {
  const row = document.querySelector('[data-email-row]')!
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }))
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the message row', () => {
  it('opens from one real button and keeps the star outside it', () => {
    const { view, handlers } = renderRow(summary())
    const main = document.querySelector<HTMLButtonElement>('button[data-email-open]')!
    expect(main.tagName).toBe('BUTTON')
    expect(main.querySelectorAll('button')).toHaveLength(0)
    expect(document.querySelector('[data-unread]')).not.toBeNull()
    expect(main.textContent).toContain('Ada Lovelace')
    expect(main.textContent).toContain('Quarterly report')

    const star = button(t('email.list.star'))
    expect(main.contains(star)).toBe(false)
    act(() => { main.click() })
    expect(handlers.onOpen).toHaveBeenCalledTimes(1)
    act(() => { star.click() })
    expect(handlers.onToggleStar).toHaveBeenCalledTimes(1)
    expect(handlers.onOpen).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('selects from its own checkbox without opening the row and reports Shift', () => {
    const { view, handlers } = renderRow(summary())
    const main = document.querySelector<HTMLButtonElement>('button[data-email-open]')!
    const box = document.querySelector<HTMLButtonElement>('[role="checkbox"]')!
    expect(box.getAttribute('aria-label')).toBe(t('email.list.select', { subject: 'Quarterly report' }))
    expect(box.getAttribute('aria-checked')).toBe('false')
    expect(main.contains(box)).toBe(false)

    act(() => { box.click() })
    expect(handlers.onToggleSelect).toHaveBeenCalledWith({ shiftKey: false })
    expect(handlers.onOpen).not.toHaveBeenCalled()

    act(() => {
      box.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    })
    expect(handlers.onToggleSelect).toHaveBeenLastCalledWith({ shiftKey: true })
    view.unmount()

    const checked = renderRow(summary(), {}, true)
    expect(document.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
    checked.view.unmount()
  })

  it('shows thread, draft, reply and send state without nesting controls', () => {
    const { view } = renderRow(summary({
      read: true,
      starred: true,
      threadCount: 3,
      hasDraft: true,
      needsReply: true,
      deliveryStatus: 'failed',
    }))
    const main = document.querySelector<HTMLButtonElement>('button[data-email-open]')!
    expect(document.querySelector('[data-unread]')).toBeNull()
    expect(main.textContent).toContain('3')
    expect(main.textContent).toContain(t('email.list.draft'))
    expect(main.textContent).toContain(t('email.list.needs_reply'))
    expect(main.textContent).toContain(t('email.list.send_failed'))
    expect(button(t('email.list.unstar')).getAttribute('aria-pressed')).toBe('true')
    expect(button(t('email.list.retry_send'))).toBeTruthy()
    expect(main.contains(button(t('email.list.delete')))).toBe(false)
    view.unmount()
  })

  it('opens the row menu from a right click and runs the archive action', () => {
    const { view, handlers } = renderRow(summary())
    openContextMenu()
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(menuItem(t('email.message.open'))).toBeTruthy()
    expect(menuItem(t('email.message.move_to')).getAttribute('aria-haspopup')).toBe('menu')
    act(() => { menuItem(t('email.message.archive')).click() })
    expect(handlers.onArchive).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    view.unmount()
  })

  it('moves and tags from submenus without leaving the menu open', () => {
    const { view, handlers } = renderRow(summary())
    openContextMenu()
    act(() => { menuItem(t('email.message.move_to')).click() })
    const archiveRow = [...document.querySelectorAll<HTMLButtonElement>('[data-submenu-row]')]
      .find((node) => node.textContent?.trim() === t('email.folder.archive'))
    expect(archiveRow).toBeTruthy()
    act(() => { archiveRow!.click() })
    expect(handlers.onMove).toHaveBeenCalledWith('archive')
    expect(document.querySelector('[role="menu"]')).toBeNull()

    openContextMenu()
    act(() => { menuItem(t('email.message.tag')).click() })
    const tagRow = [...document.querySelectorAll<HTMLButtonElement>('[data-submenu-row]')]
      .find((node) => node.textContent?.trim() === 'work')
    expect(tagRow).toBeTruthy()
    act(() => { tagRow!.click() })
    expect(handlers.onTag).toHaveBeenCalledWith(tags[0])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    view.unmount()
  })

  it('opens the row menu with Shift+F10 and focuses its first item', () => {
    const { view } = renderRow(summary())
    const main = document.querySelector<HTMLButtonElement>('button[data-email-open]')!
    act(() => {
      main.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
    expect(document.activeElement?.textContent).toContain(t('email.message.open'))
    view.unmount()
  })
})
