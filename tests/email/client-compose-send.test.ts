// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailMessage, EmailScheduledSend } from '@shared/email/model'
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

const original: EmailMessage = {
  id: 'm1',
  folderId: 'inbox',
  subject: 'Quarterly report',
  sender: 'Grace Hopper <grace@example.com>',
  recipient: 'ada@example.com',
  cc: null,
  bcc: null,
  date: '2026-10-20T09:00:00.000Z',
  read: true,
  starred: false,
  threadId: 't1',
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

function labelled(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
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

function recipientChip(address: string): HTMLButtonElement {
  const label = t('email.recipients.remove', { address })
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no recipient chip for ${address}`)
  return found
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
  })
}

function panel(onSent = vi.fn()): RenderedElement {
  return renderElement(createElement(ComposePanel, {
    account,
    mode: 'new',
    draftId: null,
    original: null,
    onClose: vi.fn(),
    onSent,
  }))
}

function completeRecipient(): void {
  const to = inputFor(t('email.compose.to'))
  change(to, 'grace@example.com')
  press(to, 'Enter')
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  useUi.setState({ toasts: [] })
})

describe('the compose panel undo send window', () => {
  it('waits before sending and announces the countdown', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockResolvedValue({ id: 'd1', status: 'sent' })
    const onSent = vi.fn()
    const view = panel(onSent)
    completeRecipient()
    await act(async () => {
      button(t('email.compose.send')).click()
    })
    await flush()
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(sendDraft).not.toHaveBeenCalled()
    expect(labelled(t('email.compose.schedule_send')).disabled).toBe(true)
    expect(view.container.textContent).toContain(t('email.compose.sending_in', { seconds: 9 }))
    const undoToast = useUi.getState().toasts.find((toast) => toast.action)
    expect(undoToast?.action?.label).toBe(t('common.undo'))
    await settle(1000)
    expect(view.container.textContent).toContain(t('email.compose.sending_in', { seconds: 8 }))
    expect(sendDraft).not.toHaveBeenCalled()
    await settle(8000)
    expect(sendDraft).toHaveBeenCalledTimes(1)
    expect(onSent).toHaveBeenCalledTimes(1)
    saveDraft.mockRestore()
    sendDraft.mockRestore()
    view.unmount()
  })

  it('leaves the draft intact when the undo action runs', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockResolvedValue({ id: 'd1', status: 'sent' })
    const onSent = vi.fn()
    const view = panel(onSent)
    completeRecipient()
    await act(async () => {
      button(t('email.compose.send')).click()
    })
    await flush()
    const undo = useUi.getState().toasts.find((toast) => toast.action)?.action
    expect(undo?.label).toBe(t('common.undo'))
    act(() => { undo?.run() })
    await settle(10000)
    expect(sendDraft).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.compose.send_cancelled'))
    expect(recipientChip('grace@example.com').textContent).toContain('grace@example.com')
    expect(labelled(t('email.compose.schedule_send')).disabled).toBe(false)
    saveDraft.mockRestore()
    sendDraft.mockRestore()
    view.unmount()
  })

  it('cancels the pending send when the panel unmounts', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockResolvedValue({ id: 'd1', status: 'sent' })
    const view = panel()
    completeRecipient()
    await act(async () => {
      button(t('email.compose.send')).click()
    })
    await flush()
    view.unmount()
    await settle(10000)
    expect(sendDraft).not.toHaveBeenCalled()
    saveDraft.mockRestore()
    sendDraft.mockRestore()
  })

  it('holds autosave during the window and resumes after an undo', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockResolvedValue({ id: 'd1', status: 'sent' })
    const view = panel()
    completeRecipient()
    change(inputFor(t('email.compose.subject')), 'Hello')
    await act(async () => {
      button(t('email.compose.send')).click()
    })
    await flush()
    expect(saveDraft).toHaveBeenCalledTimes(1)
    change(inputFor(t('email.compose.subject')), 'Hello again')
    await settle(5000)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(sendDraft).not.toHaveBeenCalled()
    act(() => { useUi.getState().toasts.find((toast) => toast.action)?.action?.run() })
    await settle(2000)
    expect(sendDraft).not.toHaveBeenCalled()
    expect(saveDraft).toHaveBeenCalledTimes(2)
    saveDraft.mockRestore()
    sendDraft.mockRestore()
    view.unmount()
  })

  it('shows a failed send after the window instead of closing the panel', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockRejectedValue(new Error('The mail service refused the message'))
    const onSent = vi.fn()
    const view = panel(onSent)
    completeRecipient()
    await act(async () => {
      button(t('email.compose.send')).click()
    })
    await flush()
    await settle(9000)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('The mail service refused the message')
    expect(onSent).not.toHaveBeenCalled()
    expect(button(t('email.compose.send')).disabled).toBe(false)
    saveDraft.mockRestore()
    sendDraft.mockRestore()
    view.unmount()
  })
})

describe('the compose panel schedule send menu', () => {
  it('saves the draft and calls the schedule API for a preset', async () => {
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const scheduled: EmailScheduledSend = {
      id: 'job1',
      accountId: 'a1',
      draftId: 'd1',
      sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: 'queued',
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const scheduleDraftSend = vi.spyOn(api.email, 'scheduleDraftSend').mockResolvedValue(scheduled)
    const onSent = vi.fn()
    const view = panel(onSent)
    completeRecipient()
    act(() => { labelled(t('email.compose.schedule_send')).click() })
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.trim() === t('email.compose.schedule_in_hour'))
    if (!item) throw new Error('no schedule preset')
    await act(async () => { item.click() })
    await flush()
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(scheduleDraftSend).toHaveBeenCalledTimes(1)
    const [accountId, draftId, input] = scheduleDraftSend.mock.calls[0]!
    expect(accountId).toBe('a1')
    expect(draftId).toBe('d1')
    expect(input.operationId).toEqual(expect.any(String))
    expect(Date.parse(String(input.sendAt))).toBeGreaterThan(Date.now())
    expect(onSent).toHaveBeenCalledTimes(1)
    expect(useUi.getState().toasts.map(({ title }) => title).some((title) => title.startsWith(t('email.compose.schedule_sent', { time: '' }).trim())))
      .toBe(true)
    saveDraft.mockRestore()
    scheduleDraftSend.mockRestore()
    view.unmount()
  })

  it('keeps the panel open with an error when scheduling fails', async () => {
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const scheduleDraftSend = vi.spyOn(api.email, 'scheduleDraftSend').mockRejectedValue(new Error('Mailbox storage is not configured'))
    const onSent = vi.fn()
    const view = panel(onSent)
    completeRecipient()
    act(() => { labelled(t('email.compose.schedule_send')).click() })
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.trim() === t('email.compose.schedule_tomorrow'))
    if (!item) throw new Error('no schedule preset')
    await act(async () => { item.click() })
    await flush()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Mailbox storage is not configured')
    expect(onSent).not.toHaveBeenCalled()
    expect(labelled(t('email.compose.schedule_send')).disabled).toBe(false)
    saveDraft.mockRestore()
    scheduleDraftSend.mockRestore()
    view.unmount()
  })
})
