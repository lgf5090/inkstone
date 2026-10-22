// @vitest-environment jsdom
import { act, createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailMessage } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { ComposePanel } from '../../src/client/features/email/ComposePanel'

const account: EmailAccount = {
  id: 'a1',
  address: 'ada@example.com',
  displayName: 'Ada',
  settings: {
    signature: { enabled: true, text: 'Ada Lovelace' },
    autoDraft: true,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const original: EmailMessage = {
  id: 'm1',
  folderId: 'inbox',
  subject: 'Quarterly report',
  sender: 'Grace Hopper <grace@example.com>',
  recipient: 'ada@example.com',
  cc: 'team@example.com',
  bcc: null,
  date: '2026-10-20T09:00:00.000Z',
  read: true,
  starred: false,
  threadId: 't1',
  threadCount: 2,
  body: '<p>The numbers are ready.</p>',
  bodySource: 'The numbers are ready.',
  inReplyTo: null,
  references: [],
  messageId: '<m1@example.com>',
  rawHeaders: [],
  attachments: [],
}

function inputFor(label: string): HTMLInputElement {
  const target = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim().replace(/\s*\*$/, '') === label)
  if (!target?.htmlFor) throw new Error(`no field labelled ${label}`)
  const input = document.getElementById(target.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`field ${label} is not an input`)
  return input
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function change(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function panel(mode: 'new' | 'reply' | 'reply-all' | 'forward', draftId: string | null = null): RenderedElement {
  return renderElement(createElement(ComposePanel, {
    account,
    mode,
    draftId,
    original: mode === 'new' ? null : original,
    onClose: vi.fn(),
    onSent: vi.fn(),
  }))
}

describe('the compose panel', () => {
  it('states the recipient error instead of sending without one', () => {
    const saveDraft = vi.spyOn(api.email, 'saveDraft')
    const view = panel('new')
    expect(inputFor(t('email.compose.to')).value).toBe('')
    expect(inputFor(t('email.compose.subject')).value).toBe('')
    expect(document.querySelector('.cm-content')?.textContent).toContain('Ada Lovelace')

    act(() => { button(t('email.compose.send')).click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('email.compose.error_no_recipient'))
    expect(saveDraft).not.toHaveBeenCalled()
    saveDraft.mockRestore()
    view.unmount()
  })

  it('prefills a reply from the message and keeps the quote in the editor', () => {
    const view = panel('reply')
    expect(inputFor(t('email.compose.to')).value).toBe('Grace Hopper <grace@example.com>')
    expect(inputFor(t('email.compose.subject')).value).toBe('Re: Quarterly report')
    expect(() => inputFor(t('email.compose.cc'))).toThrow()
    expect(document.querySelector('.cm-content')?.textContent).toContain('The numbers are ready.')
    expect(document.querySelector('.cm-content')?.textContent).toContain('wrote:')
    view.unmount()
  })

  it('adds everyone but the mailbox itself when replying to all', () => {
    const view = panel('reply-all')
    expect(inputFor(t('email.compose.to')).value).toBe('Grace Hopper <grace@example.com>')
    expect(inputFor(t('email.compose.cc')).value).toBe('team@example.com')
    view.unmount()
  })

  it('saves a reply against the message it answers', async () => {
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const view = panel('reply')
    await act(async () => {
      button(t('email.compose.save_draft')).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(saveDraft).toHaveBeenCalledWith('a1', expect.objectContaining({
      inReplyTo: 'm1',
      threadId: 't1',
      subject: 'Re: Quarterly report',
    }))
    expect(saveDraft.mock.calls[0]?.[1].body).toContain('> On')
    saveDraft.mockRestore()
    view.unmount()
  })

  it('shows a failed send and keeps the message editable for a retry', async () => {
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockRejectedValue(new Error('The mail service refused the message'))
    const view = panel('new')
    change(inputFor(t('email.compose.to')), 'grace@example.com')
    change(inputFor(t('email.compose.subject')), 'Hello')
    await act(async () => {
      button(t('email.compose.send')).click()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    expect(sendDraft).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('The mail service refused the message')
    expect(button(t('email.compose.send')).disabled).toBe(false)
    saveDraft.mockRestore()
    sendDraft.mockRestore()
    view.unmount()
  })

  it('reveals Cc and Bcc only when asked', () => {
    const view = panel('new')
    expect(() => inputFor(t('email.compose.cc'))).toThrow()
    act(() => { button(t('email.compose.show_cc')).click() })
    expect(inputFor(t('email.compose.cc')).value).toBe('')
    expect(inputFor(t('email.compose.bcc')).value).toBe('')
    view.unmount()
  })
})
