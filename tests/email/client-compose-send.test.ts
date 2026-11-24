// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
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

const scheduledJob: EmailScheduledSend = {
  id: 'job-1',
  accountId: account.id,
  draftId: 'd1',
  sendAt: '2026-01-01T00:00:00.000Z',
  status: 'queued',
  attempts: 0,
  lastError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

let scheduleDraftSend: MockInstance
let cancelScheduledSend: MockInstance

beforeEach(() => {
  // The undo window is a queued server send; these cases measure the panel, not the route.
  scheduleDraftSend = vi.spyOn(api.email, 'scheduleDraftSend').mockResolvedValue(scheduledJob)
  cancelScheduledSend = vi.spyOn(api.email, 'cancelScheduledSend').mockResolvedValue(undefined)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  useUi.setState({ toasts: [] })
})

describe('the compose panel undo send window', () => {
  it('saves the visible edits before queueing an existing draft', async () => {
    vi.useFakeTimers()
    vi.spyOn(api.email, 'getEmail').mockResolvedValue({
      ...original,
      id: 'd1',
      folderId: 'draft',
      recipient: 'grace@example.com',
      subject: 'Saved subject',
      body: '<p>Saved body</p>',
      bodySource: 'Saved body',
      inReplyTo: null,
      threadId: null,
    })
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const view = renderElement(createElement(ComposePanel, {
      account, mode: 'new', draftId: 'd1', original: null, onClose: vi.fn(), onSent: vi.fn(),
    }))
    await flush()
    change(inputFor(t('email.compose.subject')), 'Visible subject')
    await act(async () => { button(t('email.compose.send')).click() })
    await flush()

    expect(saveDraft).toHaveBeenCalledWith(account.id, expect.objectContaining({ draftId: 'd1', subject: 'Visible subject' }))
    expect(saveDraft.mock.invocationCallOrder[0]).toBeLessThan(scheduleDraftSend.mock.invocationCallOrder[0]!)
    saveDraft.mockRestore()
    view.unmount()
  })

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
    // The window lives on the server: a queued job whose send time is nine seconds out.
    expect(scheduleDraftSend).toHaveBeenCalledTimes(1)
    expect(sendDraft).not.toHaveBeenCalled()
    expect(labelled(t('email.compose.schedule_send')).disabled).toBe(true)
    expect(view.container.textContent).toContain(t('email.compose.sending_in', { seconds: 9 }))
    const undoToast = useUi.getState().toasts.find((toast) => toast.action)
    expect(undoToast?.action?.label).toBe(t('common.undo'))
    await settle(1000)
    expect(view.container.textContent).toContain(t('email.compose.sending_in', { seconds: 8 }))
    expect(sendDraft).not.toHaveBeenCalled()
    await settle(8000)
    expect(cancelScheduledSend).toHaveBeenCalledWith(account.id, 'job-1')
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
    expect(cancelScheduledSend).toHaveBeenCalledWith(account.id, 'job-1')
    expect(sendDraft).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.compose.send_cancelled'))
    expect(recipientChip('grace@example.com').textContent).toContain('grace@example.com')
    expect(labelled(t('email.compose.schedule_send')).disabled).toBe(false)
    saveDraft.mockRestore()
    sendDraft.mockRestore()
    view.unmount()
  })

  it('leaves the queued send with the server when the panel unmounts', async () => {
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
    // The tab closed inside the window, so this panel cannot send — and must not cancel either: the
    // queued job is the delivery that survives the page.
    expect(sendDraft).not.toHaveBeenCalled()
    expect(cancelScheduledSend).not.toHaveBeenCalled()
    saveDraft.mockRestore()
    sendDraft.mockRestore()
  })

  it('still cancels the queued send when undo runs after the panel unmounts', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockResolvedValue({ id: 'd1', status: 'sent' })
    const view = panel()
    completeRecipient()
    await act(async () => {
      button(t('email.compose.send')).click()
    })
    await flush()
    const undo = useUi.getState().toasts.find((toast) => toast.action)?.action
    expect(undo?.label).toBe(t('common.undo'))

    view.unmount()
    act(() => { undo?.run() })
    await flush()
    expect(cancelScheduledSend).toHaveBeenCalledWith(account.id, 'job-1')
    expect(sendDraft).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.compose.send_cancelled'))
  })

  it('keeps undo bound to the job when the panel unmounts before queueing finishes', async () => {
    vi.useFakeTimers()
    let finishQueue: ((job: EmailScheduledSend) => void) | null = null
    scheduleDraftSend.mockImplementation(() => new Promise((resolve) => {
      finishQueue = resolve
    }))
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockResolvedValue({ id: 'd1', status: 'sent' })
    const view = panel()
    completeRecipient()
    await act(async () => {
      button(t('email.compose.send')).click()
    })
    await flush()
    expect(scheduleDraftSend).toHaveBeenCalledTimes(1)
    view.unmount()

    await act(async () => { finishQueue?.(scheduledJob) })
    await flush()
    const undo = useUi.getState().toasts.find((toast) => toast.action)?.action
    expect(undo?.label).toBe(t('common.undo'))
    act(() => { undo?.run() })
    await flush()
    expect(cancelScheduledSend).toHaveBeenCalledWith(account.id, 'job-1')
    expect(sendDraft).not.toHaveBeenCalled()
  })

  it('reports a queueing failure and keeps the draft instead of starting a tab-only timer', async () => {
    vi.useFakeTimers()
    scheduleDraftSend.mockRejectedValue(new Error('Scheduled sending is unavailable'))
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockResolvedValue({ id: 'd1', status: 'sent' })
    const onSent = vi.fn()
    const view = panel(onSent)
    completeRecipient()
    change(inputFor(t('email.compose.subject')), 'Keep this draft')
    await act(async () => {
      button(t('email.compose.send')).click()
    })
    await flush()

    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Scheduled sending is unavailable')
    expect(useUi.getState().toasts.some((toast) => toast.tone === 'danger' && toast.title === 'Scheduled sending is unavailable')).toBe(true)
    expect(useUi.getState().toasts.some((toast) => toast.action)).toBe(false)
    expect(inputFor(t('email.compose.subject')).value).toBe('Keep this draft')
    expect(recipientChip('grace@example.com')).toBeTruthy()
    expect(button(t('email.compose.send')).disabled).toBe(false)
    await settle(10000)
    expect(sendDraft).not.toHaveBeenCalled()
    expect(cancelScheduledSend).not.toHaveBeenCalled()
    expect(onSent).not.toHaveBeenCalled()
    view.unmount()
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

  it('schedules a custom date and time through the date picker', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T10:00:00.000Z'))
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    const onSent = vi.fn()
    const view = panel(onSent)
    completeRecipient()
    act(() => { labelled(t('email.compose.schedule_send')).click() })
    const custom = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.trim() === t('preview.kanban_select_date'))
    if (!custom) throw new Error('no custom schedule item')
    act(() => { custom.click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const picker = dialog?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
    if (!picker) throw new Error('no custom date picker')
    act(() => { picker.click() })
    const days = [...document.querySelectorAll<HTMLButtonElement>('.grid.grid-cols-7 button')]
    const futureDay = days.at(-1)
    if (!futureDay) throw new Error('no calendar day')
    act(() => { futureDay.click() })
    await act(async () => { button(t('email.compose.schedule_send')).click() })
    await flush()

    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(scheduleDraftSend).toHaveBeenCalledTimes(1)
    const sendAt = Date.parse(String(scheduleDraftSend.mock.calls[0]?.[2].sendAt))
    expect(sendAt).toBeGreaterThan(Date.now())
    expect(onSent).toHaveBeenCalledTimes(1)
    saveDraft.mockRestore()
    view.unmount()
  })

  it('keeps the saved draft and shows an error when scheduling fails', async () => {
    vi.useFakeTimers()
    const saveDraft = vi.spyOn(api.email, 'saveDraft').mockResolvedValue({ draftId: 'd1' })
    scheduleDraftSend.mockRejectedValue(new Error('Mailbox storage is not configured'))
    const sendDraft = vi.spyOn(api.email, 'sendDraft').mockResolvedValue({ id: 'd1', status: 'sent' })
    const onSent = vi.fn()
    const view = panel(onSent)
    completeRecipient()
    change(inputFor(t('email.compose.subject')), 'Keep this scheduled draft')
    act(() => { labelled(t('email.compose.schedule_send')).click() })
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.trim() === t('email.compose.schedule_tomorrow'))
    if (!item) throw new Error('no schedule preset')
    await act(async () => { item.click() })
    await flush()
    expect(saveDraft).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Mailbox storage is not configured')
    expect(onSent).not.toHaveBeenCalled()
    expect(labelled(t('email.compose.schedule_send')).disabled).toBe(false)
    expect(inputFor(t('email.compose.subject')).value).toBe('Keep this scheduled draft')
    expect(recipientChip('grace@example.com')).toBeTruthy()
    await settle(2 * 24 * 60 * 60 * 1000)
    expect(sendDraft).not.toHaveBeenCalled()
    expect(cancelScheduledSend).not.toHaveBeenCalled()
    view.unmount()
  })
})
