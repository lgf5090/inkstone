// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailFolder, EmailMessage } from '@shared/email/model'
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
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 0, totalCount: 1, parentId: null, color: null, sortOrder: 0 },
]

function message(patch: Partial<EmailMessage>): EmailMessage {
  return {
    id: 'm1',
    folderId: 'inbox',
    subject: 'Markdown mail',
    sender: 'Alice <alice@example.com>',
    recipient: 'owner@example.com',
    cc: null,
    bcc: null,
    date: '2026-10-24T00:00:00.000Z',
    read: true,
    starred: false,
    threadId: 't1',
    threadCount: 1,
    snippet: 'Markdown',
    deliveryStatus: null,
    body: '# Title',
    bodySource: null,
    inReplyTo: null,
    references: [],
    messageId: '<md@example.com>',
    rawHeaders: [],
    attachments: [],
    ...patch,
  }
}

let view: RenderedElement | null = null

beforeEach(() => {
  useEmailStore.setState({ refresh: vi.fn(async () => undefined) })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function until(selector: string): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    if (document.querySelector(selector)) return
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)) })
  }
  throw new Error(`no ${selector}`)
}

function pane(summary: EmailMessage) {
  return createElement(MessagePane, {
    account,
    folderId: 'inbox',
    summary,
    thread: [summary],
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
    onReload: vi.fn(),
    onSnooze: vi.fn(),
  })
}

describe('markdown in the reading pane', () => {
  it('renders an obvious markdown message with the notes reading pipeline and can switch back', async () => {
    const body = ['# 标题', '', '> [!TIP] 提示', '', '- [ ] 任务'].join('\n')
    view = renderElement(pane(message({ body })))
    await settle()
    await until('.ink-prose')

    expect(document.querySelector('.ink-prose')).not.toBeNull()
    expect(document.body.textContent).toContain('标题')
    expect(document.body.textContent).toContain('提示')
    expect(document.querySelector('iframe')).toBeNull()

    act(() => button(t('email.detail.show_plain')).click())
    await settle()
    expect(document.querySelector('.ink-prose')).toBeNull()
    expect(document.querySelector('iframe')).not.toBeNull()
  })

  it('keeps formatted HTML on the HTML reader and offers no markdown switch', async () => {
    view = renderElement(pane(message({ body: '<p><strong>Hello</strong> <a href="https://example.com">there</a></p>' })))
    await settle()

    expect(document.querySelector('iframe')).not.toBeNull()
    expect(document.querySelector('.ink-prose')).toBeNull()
    expect([...document.querySelectorAll('button')].some((node) => node.getAttribute('aria-label') === t('email.detail.render_markdown'))).toBe(false)
  })
})
