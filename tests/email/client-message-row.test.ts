// @vitest-environment jsdom
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { EmailSummary } from '@shared/email/model'
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

function renderRow(message: EmailSummary, callbacks: {
  onOpen?: () => void
  onToggleStar?: () => void
  onToggleRead?: () => void
  onDelete?: () => void
  onRetry?: () => void
} = {}) {
  const handlers = {
    onOpen: callbacks.onOpen ?? vi.fn(),
    onToggleStar: callbacks.onToggleStar ?? vi.fn(),
    onToggleRead: callbacks.onToggleRead ?? vi.fn(),
    onDelete: callbacks.onDelete ?? vi.fn(),
    onRetry: callbacks.onRetry ?? vi.fn(),
  }
  const view = renderElement(
    createElement('ul', null,
      createElement(MessageRow, {
        message,
        selected: false,
        searchMode: false,
        query: '',
        folders: [],
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
})
