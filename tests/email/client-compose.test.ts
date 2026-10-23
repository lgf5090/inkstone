// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailMessage, EmailSendResult } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { useUi } from '../../src/client/store/ui'
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

const multiSignatureAccount: EmailAccount = {
  ...account,
  settings: {
    signatures: [
      { id: 'work', name: 'Work', text: 'Ada at work', enabled: true },
      { id: 'personal', name: 'Personal', text: 'Ada at home', enabled: true },
    ],
    defaultSignatureId: 'work',
    autoDraft: true,
  },
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

function ariaButton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

function editorText(): string {
  return document.querySelector('.cm-content')?.textContent ?? ''
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function change(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(input: HTMLInputElement, key: string): void {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function recipientChip(address: string): HTMLButtonElement {
  const label = t('email.recipients.remove', { address })
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no recipient chip for ${address}`)
  return found
}

function panel(
  mode: 'new' | 'reply' | 'reply-all' | 'forward',
  draftId: string | null = null,
  accountOverride: EmailAccount = account,
): RenderedElement {
  return renderElement(createElement(ComposePanel, {
    account: accountOverride,
    mode,
    draftId,
    original: mode === 'new' ? null : original,
    onClose: vi.fn(),
    onSent: vi.fn(),
  }))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  useUi.setState({ toasts: [] })
})

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

  it('asks for a body before sending an otherwise complete message', () => {
    const saveDraft = vi.spyOn(api.email, 'saveDraft')
    const view = panel('new', null, {
      ...account,
      settings: { ...account.settings, signature: { enabled: false, text: '' } },
    })
    const to = inputFor(t('email.compose.to'))
    change(to, 'grace@example.com')
    press(to, 'Enter')
    act(() => { button(t('email.compose.send')).click() })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('email.compose.error_empty'))
    expect(saveDraft).not.toHaveBeenCalled()
    saveDraft.mockRestore()
    view.unmount()
  })

  it('prefills a reply from the message and keeps the quote in the editor', () => {
    const view = panel('reply')
    expect(recipientChip('grace@example.com').textContent).toContain('Grace Hopper')
    expect(inputFor(t('email.compose.to')).value).toBe('')
    expect(inputFor(t('email.compose.subject')).value).toBe('Re: Quarterly report')
    expect(() => inputFor(t('email.compose.cc'))).toThrow()
    expect(document.querySelector('.cm-content')?.textContent).toContain('The numbers are ready.')
    expect(document.querySelector('.cm-content')?.textContent).toContain('wrote:')
    view.unmount()
  })

  it('adds everyone but the mailbox itself when replying to all', () => {
    const view = panel('reply-all')
    expect(recipientChip('grace@example.com').textContent).toContain('Grace Hopper')
    expect(recipientChip('team@example.com')).toBeTruthy()
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
      to: 'grace@example.com',
      inReplyTo: 'm1',
      threadId: 't1',
      subject: 'Re: Quarterly report',
    }))
    expect(saveDraft.mock.calls[0]?.[1].body).toContain('> On')
    saveDraft.mockRestore()
    view.unmount()
  })

  it('shows a failed send and keeps the message editable for a retry', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockRejectedValue(new Error('The mail service refused the message'))
    const view = panel('new')
    const to = inputFor(t('email.compose.to'))
    change(to, 'grace@example.com')
    press(to, 'Enter')
    change(inputFor(t('email.compose.subject')), 'Hello')
    await act(async () => {
      button(t('email.compose.send')).click()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    expect(sendDraft).not.toHaveBeenCalled()
    await settle(9000)
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

  it('autosaves an edit once the typing pause passes', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const view = panel('new')
    change(inputFor(t('email.compose.subject')), 'Hello')
    await settle(1000)
    expect(saveDraft).not.toHaveBeenCalled()
    await settle(700)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(saveDraft.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ subject: 'Hello', draftId: undefined }))
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(t('email.compose.saved'))
    expect(useUi.getState().toasts).toEqual([])
    saveDraft.mockRestore()
    view.unmount()
  })

  it('keeps a single draft when edits land during a save', async () => {
    vi.useFakeTimers()
    let finishFirst: (() => void) | null = null
    const saveDraft = vi.spyOn(api.email, 'saveDraft')
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirst = () => resolve({ draftId: 'd1' })
      }))
      .mockResolvedValueOnce({ draftId: 'd1' })
    const view = panel('new')
    change(inputFor(t('email.compose.subject')), 'First')
    await settle(1700)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    change(inputFor(t('email.compose.subject')), 'Second')
    await settle(1700)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    await act(async () => {
      finishFirst?.()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    await settle(1700)
    expect(saveDraft).toHaveBeenCalledTimes(2)
    expect(saveDraft.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ subject: 'Second', draftId: 'd1' }))
    saveDraft.mockRestore()
    view.unmount()
  })

  it('leaves untouched new and reply panels alone', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft')
    const fresh = panel('new')
    await settle(4000)
    expect(saveDraft).not.toHaveBeenCalled()
    fresh.unmount()
    const reply = panel('reply')
    await settle(4000)
    expect(saveDraft).not.toHaveBeenCalled()
    saveDraft.mockRestore()
    reply.unmount()
  })

  it('shows a failed autosave and retries after the next edit', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft')
      .mockRejectedValueOnce(new Error('Draft storage unavailable'))
      .mockResolvedValueOnce({ draftId: 'd1' })
    const view = panel('new')
    change(inputFor(t('email.compose.subject')), 'Hello')
    await settle(1700)
    const status = view.container.querySelector('[role="status"]')
    expect(status?.textContent).toContain(t('email.compose.save_failed'))
    expect(status?.textContent).toContain('Draft storage unavailable')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(inputFor(t('email.compose.subject')).value).toBe('Hello')
    expect(useUi.getState().toasts).toEqual([])
    change(inputFor(t('email.compose.subject')), 'Hello again')
    await settle(1700)
    expect(saveDraft).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(t('email.compose.saved'))
    saveDraft.mockRestore()
    view.unmount()
  })

  it('holds autosave while a message is being sent', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    let finishSend: (() => void) | null = null
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockImplementation(() => new Promise<EmailSendResult>((resolve) => {
      finishSend = () => resolve({ id: 'd1', status: 'sent' })
    }))
    const view = panel('new')
    const to = inputFor(t('email.compose.to'))
    change(to, 'grace@example.com')
    press(to, 'Enter')
    change(inputFor(t('email.compose.subject')), 'Hello')
    await act(async () => {
      button(t('email.compose.send')).click()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(sendDraft).not.toHaveBeenCalled()
    change(inputFor(t('email.compose.subject')), 'Hello while sending')
    await settle(5000)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    await settle(4000)
    expect(sendDraft).toHaveBeenCalledTimes(1)
    await act(async () => {
      finishSend?.()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    await settle(5000)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.compose.sent'))
    saveDraft.mockRestore()
    sendDraft.mockRestore()
    view.unmount()
  })

  it('still announces a manual save', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const view = panel('new')
    change(inputFor(t('email.compose.subject')), 'Hello')
    await act(async () => {
      button(t('email.compose.save_draft')).click()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.compose.draft_saved'))
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(t('email.compose.saved'))
    await settle(3000)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    saveDraft.mockRestore()
    view.unmount()
  })

  it('prefills a new message with the default signature', () => {
    const view = panel('new', null, multiSignatureAccount)
    expect(editorText()).toContain('Ada at work')
    expect(editorText()).not.toContain('Ada at home')
    view.unmount()
  })

  it('swaps the reply signature without touching the quote or duplicating it', () => {
    const view = panel('reply', null, multiSignatureAccount)
    expect(editorText()).toContain('Ada at work')
    act(() => { ariaButton(t('email.compose.signature')).click() })
    act(() => { button('Personal').click() })
    expect(editorText()).toContain('Ada at home')
    expect(editorText()).not.toContain('Ada at work')
    expect(editorText()).toContain('The numbers are ready.')
    expect(editorText()).toContain('wrote:')
    expect(occurrences(editorText(), '--')).toBe(1)

    act(() => { ariaButton(t('email.compose.signature')).click() })
    act(() => { button('Work').click() })
    expect(editorText()).toContain('Ada at work')
    expect(editorText()).not.toContain('Ada at home')
    expect(editorText()).toContain('The numbers are ready.')
    expect(occurrences(editorText(), '--')).toBe(1)
    view.unmount()
  })

  it('inserts the chosen signature into a draft that has none', async () => {
    vi.spyOn(api.email, 'getEmail').mockResolvedValue({
      ...original,
      id: 'd1',
      folderId: 'draft',
      subject: 'Hello',
      recipient: 'grace@example.com',
      cc: null,
      body: 'Hello there',
      bodySource: 'Hello there',
      inReplyTo: null,
      threadId: null,
    })
    const view = panel('new', 'd1', multiSignatureAccount)
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    expect(editorText()).toContain('Hello there')
    expect(editorText()).not.toContain('Ada at work')
    act(() => { ariaButton(t('email.compose.signature')).click() })
    act(() => { button('Personal').click() })
    expect(editorText()).toContain('Ada at home')
    expect(occurrences(editorText(), 'Ada at home')).toBe(1)
    expect(editorText()).toContain('Hello there')
    view.unmount()
  })
})
