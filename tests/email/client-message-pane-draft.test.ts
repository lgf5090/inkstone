// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailFolder, EmailMessage } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { MessagePane } from '../../src/client/features/email/MessagePane'
import { useEmailStore } from '../../src/client/features/email/store'

const account: EmailAccount = {
  id: 'a1',
  address: 'owner@example.com',
  displayName: 'Owner',
  settings: { autoDraft: false },
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
}

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 1, parentId: null, color: null, sortOrder: 0 },
  { id: 'draft', name: 'Drafts', isDeletable: false, unreadCount: 0, parentId: null, color: null, sortOrder: 0 },
]

function message(patch: Partial<EmailMessage>): EmailMessage {
  return {
    id: 'm1',
    folderId: 'inbox',
    subject: 'Invoice 2041',
    sender: 'Billing Team <billing@example.com>',
    recipient: 'owner@example.com',
    cc: null,
    bcc: null,
    date: '2026-10-24T00:00:00.000Z',
    read: true,
    starred: false,
    threadId: 't1',
    threadCount: 2,
    snippet: 'Please confirm.',
    deliveryStatus: null,
    body: '<p>Please confirm.</p>',
    bodySource: 'Please confirm.',
    inReplyTo: null,
    references: [],
    messageId: '<invoice@example.com>',
    rawHeaders: [],
    attachments: [],
    ...patch,
  }
}

const original = useEmailStore.getState()
const refresh = vi.fn(async () => undefined)
let view: RenderedElement | null = null

beforeEach(() => {
  useEmailStore.setState(original, true)
  useEmailStore.setState({ refresh })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
})

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

describe('sending a draft inside a thread', () => {
  it('sends the inline draft and refreshes the thread', async () => {
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockResolvedValue({ id: 'd1', status: 'sent' })
    const onReload = vi.fn()
    const inbound = message({})
    const draft = message({
      id: 'd1',
      folderId: 'draft',
      subject: 'Re: Invoice 2041',
      sender: 'owner@example.com',
      recipient: 'Billing Team <billing@example.com>',
      body: '<p>Thanks for the invoice.</p>',
      bodySource: 'Thanks for the invoice.',
      inReplyTo: 'm1',
      messageId: null,
      deliveryStatus: 'pending',
    })

    view = renderElement(createElement(MessagePane, {
      account,
      folderId: 'inbox',
      summary: inbound,
      thread: [inbound, draft],
      threadStatus: 'ready',
      threadError: null,
      selectedStatus: 'ready',
      selectedError: null,
      folders,
      compose: null,
      draftId: null,
      onCompose: vi.fn(),
      onEditDraft: vi.fn(),
      onCancelCompose: vi.fn(),
      onClosed: vi.fn(),
      onReload,
      onSnooze: vi.fn(),
    }))

    await act(async () => {
      button(t('email.compose.send')).click()
      for (let index = 0; index < 10; index += 1) await Promise.resolve()
    })

    expect(sendDraft).toHaveBeenCalledWith('a1', 'd1', expect.objectContaining({
      to: 'billing@example.com',
      subject: 'Re: Invoice 2041',
      body: 'Thanks for the invoice.',
      bodyHtml: '<p>Thanks for the invoice.</p>',
      operationId: expect.any(String),
    }))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
