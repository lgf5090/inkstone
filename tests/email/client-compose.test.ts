// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailMessage, EmailScheduledSend, EmailSendResult } from '@shared/email/model'
import { EMAIL_ATTACHMENT_MAX_BYTES } from '@shared/email/model'
import type { HubAttachmentWithUsage } from '@shared/attachment-hub'
import { api, ApiError } from '../../src/client/lib/api'
import { attachmentHubApi } from '../../src/client/features/attachment-hub/api'
import { renderElement, stubWideShow, type RenderedElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { useUi } from '../../src/client/store/ui'
import { ComposePanel } from '../../src/client/features/email/ComposePanel'
import { MessagePane } from '../../src/client/features/email/MessagePane'
import { MailboxPage } from '../../src/client/features/email/MailboxPage'
import { useEmailStore } from '../../src/client/features/email/store'

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

const originalEmailStore = useEmailStore.getState()

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

function fileInput(label: string): HTMLInputElement {
  const found = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no file input labelled ${label}`)
  return found
}

function chooseFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function hubAttachment(overrides: Partial<HubAttachmentWithUsage> = {}): HubAttachmentWithUsage {
  return {
    id: 'att1',
    scope: 'email',
    filename: 'photo.png',
    mime: 'image/png',
    size: 3,
    width: null,
    height: null,
    url: '/api/attachments/email/files/att1',
    folderId: null,
    isStarred: false,
    isPinned: false,
    tags: [],
    ownerId: null,
    createdAt: 1,
    references: 0,
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
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

function messagePane(overrides: Partial<Parameters<typeof MessagePane>[0]> = {}) {
  return createElement(MessagePane, {
    account,
    folderId: 'inbox',
    summary: original,
    thread: [original],
    threadStatus: 'ready',
    threadError: null,
    selectedStatus: 'ready',
    selectedError: null,
    folders: [],
    compose: 'reply',
    draftId: null,
    onCompose: vi.fn(),
    onEditDraft: vi.fn(),
    onCancelCompose: vi.fn(),
    onClosed: vi.fn(),
    onReload: vi.fn(),
    onSnooze: vi.fn(async () => true),
    ...overrides,
  })
}

beforeEach(() => {
  localStorage.clear()
  const scheduledJob: EmailScheduledSend = {
    id: 'job-1',
    accountId: account.id,
    draftId: 'd1',
    sendAt: new Date(Date.now() + 9000).toISOString(),
    status: 'queued',
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  vi.spyOn(api.email, 'scheduleDraftSend').mockResolvedValue(scheduledJob)
  vi.spyOn(api.email, 'cancelScheduledSend').mockResolvedValue(undefined)
})

afterEach(() => {
  localStorage.clear()
  useEmailStore.getState().stopPolling()
  useEmailStore.setState(originalEmailStore, true)
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  useUi.setState({ toasts: [] })
})

describe('the compose panel', () => {
  it('keeps an offline draft on this device and saves it when the connection returns', async () => {
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockRejectedValue(new ApiError(0, 'offline', 'offline'))
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const first = panel('new')
    change(inputFor(t('email.compose.subject')), 'Offline subject')
    await act(async () => { button(t('email.compose.save_draft')).click() })
    await flush()
    const key = 'inkstone:email:offline-draft:v1:new:a1:new:none'
    expect(JSON.parse(localStorage.getItem(key) ?? '{}').fields.subject).toBe('Offline subject')
    expect(document.body.textContent).toContain(t('email.compose.offline_saved'))
    first.unmount()

    saveDraft.mockResolvedValue({ draftId: 'd-offline', updatedAt: Date.now() })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const restored = panel('new')
    expect(inputFor(t('email.compose.subject')).value).toBe('Offline subject')
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(saveDraft).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(key)).toBeNull()
    restored.unmount()
  })

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

  it('remounts the editor whenever the account, mode, original or draft identity changes', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const view = renderElement(messagePane())
    change(inputFor(t('email.compose.subject')), 'Unsent reply')

    view.rerender(messagePane({ compose: 'forward' }))
    expect(inputFor(t('email.compose.subject')).value).toBe('Fwd: Quarterly report')
    expect(inputFor(t('email.compose.to')).value).toBe('')
    await act(async () => {
      button(t('email.compose.save_draft')).click()
      await Promise.resolve()
    })
    expect(saveDraft.mock.calls[0]?.[1].inReplyTo).toBeUndefined()
    expect(saveDraft.mock.calls[0]?.[1].threadId).toBeUndefined()

    const anotherOriginal: EmailMessage = {
      ...original,
      id: 'm2',
      subject: 'Another report',
      sender: 'Katherine Johnson <katherine@example.com>',
      cc: null,
      threadId: 't2',
    }
    view.rerender(messagePane({ compose: 'reply', summary: anotherOriginal }))
    expect(inputFor(t('email.compose.subject')).value).toBe('Re: Another report')
    expect(recipientChip('katherine@example.com')).toBeTruthy()
    await act(async () => {
      button(t('email.compose.save_draft')).click()
      await Promise.resolve()
    })
    expect(saveDraft.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ inReplyTo: 'm2', threadId: 't2' }))

    const anotherAccount: EmailAccount = { ...account, id: 'a2', settings: { autoDraft: true } }
    view.rerender(messagePane({ account: anotherAccount, compose: 'new', summary: null }))
    expect(inputFor(t('email.compose.subject')).value).toBe('')
    expect(inputFor(t('email.compose.to')).value).toBe('')
    expect(editorText()).not.toContain('Ada Lovelace')
    expect(editorText()).not.toContain('Forwarded message')

    vi.spyOn(api.email, 'getEmail').mockResolvedValue({
      ...original,
      id: 'd2',
      folderId: 'draft',
      subject: 'Loaded draft',
      recipient: 'katherine@example.com',
      cc: null,
      body: 'Saved body',
      bodySource: 'Saved body',
      inReplyTo: null,
      threadId: null,
    })
    view.rerender(messagePane({ account: anotherAccount, compose: 'new', summary: null, draftId: 'd2' }))
    await flush()
    expect(inputFor(t('email.compose.subject')).value).toBe('Loaded draft')
    expect(recipientChip('katherine@example.com')).toBeTruthy()
    expect(editorText()).toContain('Saved body')
    view.unmount()
  })

  it('disables draft actions while loading and keeps fields typed before the response', async () => {
    vi.useFakeTimers()
    let finishLoad: ((message: EmailMessage) => void) | null = null
    vi.spyOn(api.email, 'getEmail').mockImplementation(() => new Promise((resolve) => {
      finishLoad = resolve
    }))
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1', updatedAt: 200 })
    const view = panel('new', 'd1')

    expect(button(t('email.compose.save_draft')).disabled).toBe(true)
    expect(button(t('email.compose.send')).disabled).toBe(true)
    expect(ariaButton(t('email.compose.schedule_send')).disabled).toBe(true)
    change(inputFor(t('email.compose.subject')), 'Typed before loading finished')
    await settle(2000)
    expect(saveDraft).not.toHaveBeenCalled()

    await act(async () => {
      finishLoad?.({
        ...original,
        id: 'd1',
        folderId: 'draft',
        subject: 'Server subject',
        recipient: 'grace@example.com',
        cc: null,
        body: 'Server body',
        bodySource: 'Server body',
        inReplyTo: null,
        threadId: null,
        updatedAt: 100,
      })
    })
    await flush()
    expect(inputFor(t('email.compose.subject')).value).toBe('Typed before loading finished')
    expect(recipientChip('grace@example.com')).toBeTruthy()
    expect(editorText()).toContain('Server body')
    expect(button(t('email.compose.save_draft')).disabled).toBe(false)
    expect(button(t('email.compose.send')).disabled).toBe(false)
    expect(ariaButton(t('email.compose.schedule_send')).disabled).toBe(false)

    await act(async () => {
      button(t('email.compose.save_draft')).click()
      await Promise.resolve()
    })
    expect(saveDraft.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      draftId: 'd1',
      expectedUpdatedAt: 100,
      subject: 'Typed before loading finished',
    }))
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

  it('saves a forward as a new thread instead of answering the quoted message', async () => {
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const view = panel('forward')
    await act(async () => {
      button(t('email.compose.save_draft')).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(saveDraft).toHaveBeenCalledWith('a1', expect.objectContaining({
      subject: 'Fwd: Quarterly report',
    }))
    const payload = saveDraft.mock.calls[0]?.[1]
    expect(payload?.inReplyTo).toBeUndefined()
    expect(payload?.threadId).toBeUndefined()
    expect(payload?.body).toContain('---------- Forwarded message ----------')
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

  it('asks which copy to keep when another device wrote the draft', async () => {
    vi.useFakeTimers()
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
      updatedAt: 100,
    })
    vi.spyOn(api.email, 'saveDraft').mockRejectedValueOnce(new ApiError(409, 'conflict', 'conflict', {
      server: {
        subject: 'Written elsewhere',
        recipient: 'grace@example.com',
        cc: null,
        bcc: null,
        body: '<p>Other text</p>',
        bodySource: 'Other text',
        updatedAt: 200,
      },
    }))
    const view = panel('new', 'd1')
    await flush()
    change(inputFor(t('email.compose.subject')), 'Mine')
    await settle(2000)

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(t('email.compose.draft_conflict_title'))
    act(() => { button(t('email.compose.use_server_version')).click() })
    expect(inputFor(t('email.compose.subject')).value).toBe('Written elsewhere')
    expect(editorText()).toContain('Other text')
    view.unmount()
  })

  it('uploads a chosen image inline and inserts its cid reference', async () => {
    vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const upload = vi.spyOn(attachmentHubApi, 'upload').mockResolvedValue(hubAttachment())
    const link = vi.spyOn(api.email, 'linkAttachment').mockResolvedValue({
      attachmentId: 'att1',
      contentId: 'inline-1',
      disposition: 'inline',
    })
    const view = panel('new')
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' })
    chooseFile(fileInput(t('email.compose.insert_image')), file)
    await flush()

    expect(upload).toHaveBeenCalledWith('email', file)
    expect(link).toHaveBeenCalledWith('a1', 'd1', 'att1', { inline: true })
    expect(editorText()).toContain('![photo.png](cid:inline-1)')
    expect([...view.container.querySelectorAll('li')].some((item) => item.textContent?.includes('photo.png'))).toBe(true)
    view.unmount()
  })

  it('rejects a non-image or oversized file before uploading it', async () => {
    const upload = vi.spyOn(attachmentHubApi, 'upload')
    const view = panel('new')

    chooseFile(fileInput(t('email.compose.insert_image')), new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    expect(upload).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.compose.image_type_invalid'))

    const oversized = new File(['x'], 'huge.png', { type: 'image/png' })
    Object.defineProperty(oversized, 'size', { value: EMAIL_ATTACHMENT_MAX_BYTES + 1 })
    chooseFile(fileInput(t('email.compose.insert_image')), oversized)
    expect(upload).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.compose.attachment_too_large'))
    view.unmount()
  })

  it('previews inline images through the attachment url and keeps cid in the source', async () => {
    vi.spyOn(api.email, 'getEmail').mockResolvedValue({
      ...original,
      id: 'd1',
      folderId: 'draft',
      subject: 'Inline',
      recipient: 'grace@example.com',
      cc: null,
      body: '<p><img src="cid:inline-1" alt="photo"></p>',
      bodySource: '![photo.png](cid:inline-1)',
      inReplyTo: null,
      threadId: null,
      attachments: [{
        id: 'att1',
        filename: 'photo.png',
        mime: 'image/png',
        size: 3,
        width: null,
        height: null,
        contentId: 'inline-1',
        disposition: 'inline',
        url: '/api/email/files/att1',
        createdAt: '2026-10-20T09:00:00.000Z',
      }],
    })
    const view = panel('new', 'd1')
    await flush()
    expect([...view.container.querySelectorAll('li')].some((item) => item.textContent?.includes('photo.png'))).toBe(true)

    act(() => { button(t('email.compose.preview')).click() })
    const preview = view.container.querySelector('.ink-prose')
    const image = preview?.querySelector('img')
    expect(image?.getAttribute('src')).toBe('/api/email/files/att1')
    expect(preview?.innerHTML).not.toContain('cid:')
    view.unmount()
  })
})

describe('the mailbox scheduled send manager', () => {
  it('appends history pages and can replace the current page when refreshing it', async () => {
    const first: EmailScheduledSend = {
      id: 'job-1', accountId: account.id, draftId: 'draft-1', sendAt: new Date().toISOString(),
      status: 'sent', attempts: 1, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    const second: EmailScheduledSend = { ...first, id: 'job-2', draftId: 'draft-2', status: 'failed', lastError: 'failed' }
    const list = vi.spyOn(api.email, 'listScheduledSends')
      .mockResolvedValueOnce({ items: [first], nextCursor: '200:job-1' })
      .mockResolvedValueOnce({ items: [second], nextCursor: null })
      .mockResolvedValueOnce({ items: [second], nextCursor: null })
    await useEmailStore.getState().loadScheduledSends(account.id, { history: true })
    await useEmailStore.getState().loadScheduledSends(account.id, { history: true, cursor: '200:job-1' })
    expect(useEmailStore.getState().scheduledHistory.map((job) => job.id)).toEqual(['job-1', 'job-2'])
    expect(useEmailStore.getState().scheduledHistoryRequestCursor).toBe('200:job-1')

    await useEmailStore.getState().loadScheduledSends(account.id, { history: true, cursor: '200:job-1', append: false })
    expect(useEmailStore.getState().scheduledHistory.map((job) => job.id)).toEqual(['job-2'])
    expect(list).toHaveBeenLastCalledWith(account.id, expect.objectContaining({ status: 'history', cursor: '200:job-1' }))
  })

  it('lists active and failed jobs, opens rescheduling, and cancels a queued job', async () => {
    stubWideShow()
    const active: EmailScheduledSend = {
      id: 'job-active', accountId: account.id, draftId: 'draft-active',
      sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), status: 'queued', attempts: 0, lastError: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    const failed: EmailScheduledSend = {
      id: 'job-failed', accountId: account.id, draftId: 'draft-failed',
      sendAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), status: 'failed', attempts: 3,
      lastError: 'The mail service refused the message', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    vi.spyOn(api.email, 'listFolders').mockResolvedValue([])
    vi.spyOn(api.email, 'listTags').mockResolvedValue([])
    vi.spyOn(api.email, 'listSearches').mockResolvedValue([])
    vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
    vi.spyOn(api.email, 'listContacts').mockResolvedValue([])
    vi.spyOn(api.email, 'listGroups').mockResolvedValue([])
    const list = vi.spyOn(api.email, 'listScheduledSends').mockImplementation(async (_id, params) => ({
      items: params?.status === 'history' ? (active.status === 'queued' ? [failed] : [failed, { ...active, status: 'cancelled' as const }]) : (active.status === 'queued' ? [active] : []),
      nextCursor: null,
    }))
    const cancel = vi.spyOn(api.email, 'cancelScheduledSend').mockImplementation(async () => {
      active.status = 'cancelled'
    })
    const reschedule = vi.spyOn(api.email, 'rescheduleScheduledSend').mockResolvedValue(active)
    const view = renderElement(createElement(MailboxPage, {
      account,
      address: { kind: 'mailbox', accountId: account.id, folderId: 'inbox', messageId: null, compose: null, draftId: null },
    }))
    await flush()
    act(() => { ariaButton(t('email.compose.schedule_send')).click() })
    await flush()
    expect(document.body.textContent).toContain('draft-active')
    expect(document.body.textContent).toContain('draft-failed')
    expect(document.body.textContent).toContain('The mail service refused the message')
    expect(list).toHaveBeenCalledWith(account.id, expect.objectContaining({ status: 'active' }))
    expect(list).toHaveBeenCalledWith(account.id, expect.objectContaining({ status: 'history' }))

    act(() => { ariaButton(t('common.edit')).click() })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(t('email.compose.schedule_send'))
    const picker = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-haspopup="dialog"]')
    if (!picker) throw new Error('no reschedule date picker')
    act(() => { picker.click() })
    const futureDay = [...document.querySelectorAll<HTMLButtonElement>('.grid.grid-cols-7 button')].at(-1)
    if (!futureDay) throw new Error('no reschedule calendar day')
    act(() => { futureDay.click() })
    await act(async () => { button(t('common.save')).click() })
    await flush()
    expect(reschedule).toHaveBeenCalledWith(account.id, 'job-active', expect.any(String))
    expect(Date.parse(String(reschedule.mock.calls[0]?.[2]))).toBeGreaterThan(Date.now())
    act(() => { ariaButton(t('common.delete')).click() })
    await flush()
    expect(cancel).toHaveBeenCalledWith(account.id, 'job-active')
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.compose.send_cancelled'))
    view.unmount()
  })
})
