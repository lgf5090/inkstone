// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessage } from '@shared/email/model'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { ThreadMessage } from '../../src/client/features/email/ThreadMessage'

const draft: EmailMessage = {
  id: 'd1',
  folderId: 'draft',
  subject: 'Re: Invoice 2041',
  sender: 'owner@example.com',
  recipient: 'Billing Team <billing@example.com>',
  cc: null,
  bcc: null,
  date: '2026-10-24T00:00:00.000Z',
  read: true,
  starred: false,
  threadId: 't1',
  threadCount: 2,
  snippet: 'Thanks for the invoice.',
  deliveryStatus: 'pending',
  body: '<p>Thanks for the invoice.</p>',
  bodySource: 'Thanks for the invoice.',
  inReplyTo: 'm1',
  references: ['m1'],
  messageId: null,
  rawHeaders: [],
  attachments: [],
}

let view: RenderedElement | null = null

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

describe('an inline draft in a thread', () => {
  it('offers send, edit and discard under its body', () => {
    const onSendDraft = vi.fn()
    const onEditDraft = vi.fn()
    const onDiscardDraft = vi.fn()
    view = renderElement(createElement(ThreadMessage, {
      message: draft,
      expanded: true,
      onToggle: vi.fn(),
      onSendDraft,
      onEditDraft,
      onDiscardDraft,
    }))

    act(() => button(t('email.compose.send')).click())
    expect(onSendDraft).toHaveBeenCalledWith(draft)
    act(() => button(t('email.detail.edit_draft')).click())
    expect(onEditDraft).toHaveBeenCalledWith(draft)
    act(() => button(t('email.detail.discard_draft')).click())
    expect(onDiscardDraft).toHaveBeenCalledWith(draft)
  })

  it('shows the usual header actions only for drafts', () => {
    view = renderElement(createElement(ThreadMessage, {
      message: { ...draft, folderId: 'inbox', recipient: 'owner@example.com' },
      expanded: true,
      onToggle: vi.fn(),
      onSendDraft: vi.fn(),
      onEditDraft: vi.fn(),
      onDiscardDraft: vi.fn(),
    }))
    expect(() => button(t('email.compose.send'))).toThrow()
  })
})
