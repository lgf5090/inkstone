// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { EmailAccount, EmailFolder, EmailMessage } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { MessagePane, printEmailMessages } from '../../src/client/features/email/MessagePane'
import { t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'

const account: EmailAccount = {
  id: 'a1',
  address: 'owner@example.com',
  displayName: 'Owner',
  settings: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const folders: EmailFolder[] = [
  { id: 'inbox', name: 'Inbox', isDeletable: false, unreadCount: 0, totalCount: 0, parentId: null, color: null, sortOrder: 0 },
]

function message(patch: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'm1',
    folderId: 'inbox',
    subject: 'Quarterly report',
    sender: 'Ada <ada@example.com>',
    recipient: 'owner@example.com',
    cc: null,
    bcc: null,
    date: '2026-01-01T10:00:00.000Z',
    read: false,
    starred: false,
    threadId: null,
    threadCount: 1,
    snippet: 'The numbers are ready.',
    body: '<p>The numbers are ready.</p>',
    bodySource: null,
    inReplyTo: null,
    references: [],
    messageId: '<message-1@example.com>',
    rawHeaders: [],
    attachments: [],
    ...patch,
  }
}

function pane(thread: EmailMessage[] = []): RenderedElement {
  return renderElement(createElement(MessagePane, {
    account,
    folderId: 'inbox',
    summary: message(),
    thread,
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
  }))
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

let printSpy: Mock<() => void>

beforeEach(() => {
  printSpy = vi.fn()
  vi.spyOn(window.HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
    print: printSpy,
    addEventListener: vi.fn(),
  } as unknown as Window)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('the message raw actions', () => {
  it('downloads the open message as .eml through the api', async () => {
    const download = vi.spyOn(api.email, 'downloadEml').mockResolvedValue(undefined)
    const view = pane()

    await act(async () => {
      buttonByLabel(t('email.raw.download')).click()
      await Promise.resolve()
    })

    expect(download).toHaveBeenCalledWith('a1', 'm1')
    view.unmount()
  })

  it('prints the reading pane through a hidden sanitized iframe', async () => {
    const view = pane([
      message(),
      message({
        id: 'm2',
        subject: 'Second message',
        body: '<p>Second body</p><script>bad()</script>',
        attachments: [{
          id: 'att1',
          filename: 'report.pdf',
          mime: 'application/pdf',
          size: 10,
          width: null,
          height: null,
          contentId: null,
          disposition: null,
          url: '/api/email/files/att1',
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
      }),
    ])

    await act(async () => {
      buttonByLabel(t('email.raw.print')).click()
    })

    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-email-print]')
    expect(frame).toBeTruthy()
    expect(printSpy).toHaveBeenCalled()
    const html = frame!.srcdoc
    expect(html).toContain('Quarterly report')
    expect(html).toContain('<p>The numbers are ready.</p>')
    expect(html).toContain('Second message')
    expect(html).toContain('<p>Second body</p>')
    expect(html).not.toContain('<script>bad()</script>')
    expect(html).not.toContain('report.pdf')
    expect(html).not.toContain(t('email.detail.source_title'))
    frame!.remove()
    view.unmount()
  })

  it('escapes header values in the printed document', () => {
    printEmailMessages([message({ subject: 'A <B> & C', sender: 'Eve <eve@example.com>' })])

    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-email-print]')
    expect(frame).toBeTruthy()
    const html = frame!.srcdoc
    expect(html).toContain('A &lt;B&gt; &amp; C')
    expect(html).not.toContain('<h1>A <B> & C</h1>')
    expect(html).toContain('Eve &lt;eve@example.com&gt;')
    frame!.remove()
  })
})
