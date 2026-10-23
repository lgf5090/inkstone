// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailAccountSettings } from '@shared/email/model'
import { EMAIL_LEGACY_SIGNATURE_ID } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { initI18n, t } from '../../src/client/lib/i18n'
import { ConfirmHost } from '../../src/client/components/overlay'
import { AccountSettingsPage } from '../../src/client/features/email/AccountSettingsPage'
import { useEmailStore } from '../../src/client/features/email/store'
import { useUi } from '../../src/client/store/ui'

const original = useEmailStore.getState()

const account: EmailAccount = {
  id: 'a1',
  address: 'ada@example.com',
  displayName: 'Ada',
  settings: {
    signature: { enabled: true, text: 'Ada Lovelace' },
    autoDraft: false,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const multiAccount: EmailAccount = {
  ...account,
  settings: {
    signatures: [
      { id: 'work', name: 'Work', text: 'Ada at work', enabled: true },
      { id: 'personal', name: 'Personal', text: 'Ada at home', enabled: true },
    ],
    defaultSignatureId: 'work',
    autoDraft: false,
  },
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

function inputFor(label: string): HTMLInputElement {
  const target = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim() === label)
  if (!target?.htmlFor) throw new Error(`no field labelled ${label}`)
  const input = document.getElementById(target.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`field ${label} is not an input`)
  return input
}

function change(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function textareaFor(label: string): HTMLTextAreaElement {
  const target = [...document.querySelectorAll('label')].find((node) => node.textContent?.trim() === label)
  if (!target?.htmlFor) throw new Error(`no field labelled ${label}`)
  const field = document.getElementById(target.htmlFor)
  if (!(field instanceof HTMLTextAreaElement)) throw new Error(`field ${label} is not a textarea`)
  return field
}

function changeTextarea(area: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

function buttonIn(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
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

function switchFor(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
    .find((node) => node.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no switch labelled ${label}`)
  return found
}

let view: RenderedElement | null = null

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.spyOn(api.email, 'getAutoDraftStatus').mockResolvedValue({
    status: null,
    reason: null,
    attempts: 0,
    updatedAt: null,
  })
  vi.spyOn(api.email, 'getDeployment').mockResolvedValue({
    domains: [],
    provider: 'cloudflare',
    resendFrom: '',
    hasResendKey: false,
    resendKeyHint: '',
    envDomains: ['example.com'],
    updatedAt: null,
  })
  vi.spyOn(api.email, 'updateDeployment').mockImplementation(async (patch) => ({
    domains: patch.domains ?? [],
    provider: patch.provider ?? 'cloudflare',
    resendFrom: patch.resendFrom ?? '',
    hasResendKey: Boolean(patch.resendApiKey),
    resendKeyHint: patch.resendApiKey ? patch.resendApiKey.slice(-4) : '',
    envDomains: ['example.com'],
    updatedAt: '2026-01-02T00:00:00.000Z',
  }))
  useEmailStore.setState(original, true)
  useEmailStore.setState({
    accounts: [account],
    accountsStatus: 'ready',
    accountsError: null,
    config: {
      domains: ['example.com'],
      addresses: [],
      attachmentsAvailable: true,
      sendingAvailable: true,
      autoDraftAvailable: true,
      canCreate: true,
    },
    configStatus: 'ready',
  })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
  useUi.setState({ toasts: [] })
})

describe('the mailbox settings page', () => {
  it('searches sections and saves reply-to plus deployment delivery settings', async () => {
    const update = vi.spyOn(api.email, 'updateAccount').mockImplementation(async (id, body) => ({
      ...account,
      id,
      settings: (body.settings ?? account.settings) as EmailAccountSettings,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    const deploymentUpdate = vi.mocked(api.email.updateDeployment)
    view = renderElement(createElement(AccountSettingsPage, { accountId: 'a1' }))
    await settle()

    const search = document.querySelector<HTMLInputElement>(`input[aria-label="${t('email.settings.search_placeholder')}"]`)
    expect(search).not.toBeNull()
    change(search!, '回复')
    expect(document.body.textContent).toContain(t('email.settings.reply_to'))

    change(inputFor(t('email.settings.reply_to')), 'replies@example.com')
    const delivery = [...document.querySelectorAll<HTMLButtonElement>('aside nav button')]
      .find((node) => node.textContent?.trim() === t('email.settings.delivery'))
    expect(delivery).toBeTruthy()
    act(() => delivery!.click())
    change(inputFor(t('email.settings.delivery_domains')), 'mail.example.com')
    const provider = [...document.querySelectorAll('select')]
      .find((node) => node.closest('[hidden]') === null) as HTMLSelectElement | undefined
    expect(provider).toBeTruthy()
    act(() => {
      provider!.value = 'resend'
      provider!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    change(inputFor(t('email.settings.delivery_resend_from')), 'Inkstone <mail@example.com>')
    change(inputFor(t('email.settings.delivery_resend_key')), 're_test_key_1234')

    act(() => { button(t('email.settings.save')).click() })
    await settle()
    expect(update.mock.calls[0]?.[1].settings).toMatchObject({ replyTo: 'replies@example.com' })
    expect(deploymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      domains: ['mail.example.com'],
      provider: 'resend',
      resendFrom: 'Inkstone <mail@example.com>',
      resendApiKey: 're_test_key_1234',
    }))
  })

  it('saves the display name and the full settings object', async () => {
    const update = vi.spyOn(api.email, 'updateAccount').mockImplementation(async (id, body) => {
      const settings = (body.settings ?? account.settings) as EmailAccountSettings
      const next = {
        ...account,
        id,
        displayName: body.displayName ?? account.displayName,
        settings,
        updatedAt: '2026-01-02T00:00:00.000Z',
      }
      return next
    })
    view = renderElement(createElement(AccountSettingsPage, { accountId: 'a1' }))
    await settle()
    change(inputFor(t('email.settings.display_name')), 'Grace Hopper')
    act(() => { button(t('email.settings.save')).click() })
    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith('a1', {
      displayName: 'Grace Hopper',
      settings: {
        signatures: [{
          id: EMAIL_LEGACY_SIGNATURE_ID,
          name: t('email.signatures.untitled'),
          text: 'Ada Lovelace',
          enabled: true,
        }],
        defaultSignatureId: EMAIL_LEGACY_SIGNATURE_ID,
        autoDraft: false,
        focusedInbox: true,
        vacation: { enabled: false, start: null, end: null, subject: '', body: '' },
      },
    })
    expect(useEmailStore.getState().accounts[0]!.displayName).toBe('Grace Hopper')
  })

  it('saves a signature list and its default without the legacy signature field', async () => {
    useEmailStore.setState({ accounts: [multiAccount] })
    const update = vi.spyOn(api.email, 'updateAccount').mockImplementation(async (id, body) => ({
      ...multiAccount,
      id,
      settings: body.settings as EmailAccountSettings,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    view = renderElement(createElement(AccountSettingsPage, { accountId: 'a1' }))
    await settle()
    act(() => { button(t('email.settings.save')).click() })
    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    const settings = update.mock.calls[0]?.[1].settings as EmailAccountSettings | undefined
    expect(settings).toEqual({
      signatures: [
        { id: 'work', name: 'Work', text: 'Ada at work', enabled: true },
        { id: 'personal', name: 'Personal', text: 'Ada at home', enabled: true },
      ],
      defaultSignatureId: 'work',
      autoDraft: false,
      focusedInbox: true,
      vacation: { enabled: false, start: null, end: null, subject: '', body: '' },
    })
    expect(settings).not.toHaveProperty('signature')
  })

  it('adds a signature and makes it the default when the mailbox has none', async () => {
    useEmailStore.setState({ accounts: [{ ...account, settings: { autoDraft: false } }] })
    const update = vi.spyOn(api.email, 'updateAccount').mockImplementation(async (id, body) => ({
      ...account,
      id,
      settings: body.settings as EmailAccountSettings,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    view = renderElement(createElement(AccountSettingsPage, { accountId: 'a1' }))
    await settle()
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    act(() => { button(t('email.settings.signatures_add')).click() })
    change(inputFor(t('email.settings.signature_name')), 'Support')
    changeTextarea(textareaFor(t('email.settings.signature_text')), 'Ada supports you')
    act(() => { button(t('email.settings.save')).click() })
    await settle()
    const settings = update.mock.calls[0]?.[1].settings as EmailAccountSettings | undefined
    expect(settings?.signatures).toEqual([{
      id: expect.any(String),
      name: 'Support',
      text: 'Ada supports you',
      enabled: true,
    }])
    expect(settings?.defaultSignatureId).toBe(settings?.signatures?.[0]?.id)
  })

  it('requires another default before deleting the current one', async () => {
    useEmailStore.setState({ accounts: [multiAccount] })
    const update = vi.spyOn(api.email, 'updateAccount').mockImplementation(async (id, body) => ({
      ...multiAccount,
      id,
      settings: body.settings as EmailAccountSettings,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    view = renderElement(createElement('div', null,
      createElement(AccountSettingsPage, { accountId: 'a1' }),
      createElement(ConfirmHost)))
    await settle()
    act(() => { ariaButton(t('email.settings.signatures_delete', { name: 'Work' })).click() })
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(useUi.getState().toasts.map(({ title }) => title)).toContain(t('email.settings.signatures_default_required'))

    act(() => { ariaButton(t('email.settings.signatures_make_default', { name: 'Personal' })).click() })
    expect(ariaButton(t('email.settings.signatures_make_default', { name: 'Personal' })).getAttribute('aria-checked')).toBe('true')
    act(() => { ariaButton(t('email.settings.signatures_delete', { name: 'Work' })).click() })
    await settle()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('Work')
    act(() => { buttonIn(dialog!, t('common.delete')).click() })
    await settle()
    act(() => { button(t('email.settings.save')).click() })
    await settle()
    expect(update.mock.calls[0]?.[1].settings).toEqual({
      signatures: [{ id: 'personal', name: 'Personal', text: 'Ada at home', enabled: true }],
      defaultSignatureId: 'personal',
      autoDraft: false,
      focusedInbox: true,
      vacation: { enabled: false, start: null, end: null, subject: '', body: '' },
    })
  })

  it('round-trips the vacation window, subject and body', async () => {
    const vacationAccount: EmailAccount = {
      ...account,
      settings: {
        autoDraft: false,
        vacation: {
          enabled: true,
          start: Date.parse('2026-05-01T09:00'),
          end: Date.parse('2026-05-03T18:30'),
          subject: 'Out of office',
          body: 'Back on Monday',
        },
      },
    }
    useEmailStore.setState({ accounts: [vacationAccount] })
    const update = vi.spyOn(api.email, 'updateAccount').mockImplementation(async (id, body) => ({
      ...vacationAccount,
      id,
      settings: body.settings as EmailAccountSettings,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    view = renderElement(createElement(AccountSettingsPage, { accountId: 'a1' }))
    await settle()

    expect(inputFor(t('email.settings.vacation_start')).value).toBe('2026-05-01T09:00')
    expect(inputFor(t('email.settings.vacation_end')).value).toBe('2026-05-03T18:30')
    expect(inputFor(t('email.settings.vacation_subject')).value).toBe('Out of office')
    expect(textareaFor(t('email.settings.vacation_body')).value).toBe('Back on Monday')

    change(inputFor(t('email.settings.vacation_start')), '2026-05-02T08:00')
    change(inputFor(t('email.settings.vacation_end')), '')
    change(inputFor(t('email.settings.vacation_subject')), 'Away')
    changeTextarea(textareaFor(t('email.settings.vacation_body')), 'Back soon')
    act(() => { button(t('email.settings.save')).click() })
    await settle()

    expect(update).toHaveBeenCalledTimes(1)
    const settings = update.mock.calls[0]?.[1].settings as EmailAccountSettings | undefined
    expect(settings?.vacation).toEqual({
      enabled: true,
      start: Date.parse('2026-05-02T08:00'),
      end: null,
      subject: 'Away',
      body: 'Back soon',
    })
  })

  it('saves the vacation switch state', async () => {
    const update = vi.spyOn(api.email, 'updateAccount').mockImplementation(async (id, body) => ({
      ...account,
      id,
      settings: body.settings as EmailAccountSettings,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    view = renderElement(createElement(AccountSettingsPage, { accountId: 'a1' }))
    await settle()
    expect(switchFor(t('email.settings.vacation')).getAttribute('aria-checked')).toBe('false')
    act(() => { switchFor(t('email.settings.vacation')).click() })
    expect(switchFor(t('email.settings.vacation')).getAttribute('aria-checked')).toBe('true')
    act(() => { button(t('email.settings.save')).click() })
    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    const settings = update.mock.calls[0]?.[1].settings as EmailAccountSettings | undefined
    expect(settings?.vacation?.enabled).toBe(true)
  })

  it('saves the focused inbox switch state', async () => {
    const update = vi.spyOn(api.email, 'updateAccount').mockImplementation(async (id, body) => ({
      ...account,
      id,
      settings: body.settings as EmailAccountSettings,
      updatedAt: '2026-01-02T00:00:00.000Z',
    }))
    view = renderElement(createElement(AccountSettingsPage, { accountId: 'a1' }))
    await settle()
    expect(switchFor(t('email.settings.focused_inbox')).getAttribute('aria-checked')).toBe('true')
    act(() => { switchFor(t('email.settings.focused_inbox')).click() })
    expect(switchFor(t('email.settings.focused_inbox')).getAttribute('aria-checked')).toBe('false')
    act(() => { button(t('email.settings.save')).click() })
    await settle()
    expect(update).toHaveBeenCalledTimes(1)
    const settings = update.mock.calls[0]?.[1].settings as EmailAccountSettings | undefined
    expect(settings?.focusedInbox).toBe(false)
  })

  it('validates the vacation window before saving', async () => {
    const update = vi.spyOn(api.email, 'updateAccount').mockResolvedValue(account)
    view = renderElement(createElement(AccountSettingsPage, { accountId: 'a1' }))
    await settle()

    change(inputFor(t('email.settings.vacation_start')), 'tomorrow')
    act(() => { button(t('email.settings.save')).click() })
    await settle()
    expect(update).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('email.settings.vacation_invalid'))

    change(inputFor(t('email.settings.vacation_start')), '2026-05-03T09:00')
    change(inputFor(t('email.settings.vacation_end')), '2026-05-01T09:00')
    act(() => { button(t('email.settings.save')).click() })
    await settle()
    expect(update).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('email.settings.vacation_order'))
  })

  it('states the last automatic draft attempt instead of leaving it silent', async () => {
    vi.spyOn(api.email, 'getAutoDraftStatus').mockResolvedValue({
      status: 'skipped',
      reason: 'injection',
      attempts: 1,
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    view = renderElement(createElement(AccountSettingsPage, { accountId: 'a1' }))
    await settle()
    const status = document.querySelector('[role="status"]')
    expect(status?.textContent).toContain(t('email.settings.auto_draft_skipped_injection'))
  })
})
