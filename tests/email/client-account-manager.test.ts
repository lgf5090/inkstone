// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount } from '@shared/email/model'
import { initI18n, t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { AccountManagerDialog } from '../../src/client/features/email/AccountManagerDialog'
import { useEmailStore } from '../../src/client/features/email/store'

const original = useEmailStore.getState()
let view: RenderedElement | null = null

function account(id: string, address: string, displayName: string): EmailAccount {
  return {
    id,
    address,
    displayName,
    settings: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  useEmailStore.setState(original, true)
  useEmailStore.setState({
    config: { domains: ['example.com'], addresses: [], attachmentsAvailable: true, sendingAvailable: true, autoDraftAvailable: true, canCreate: true },
    configStatus: 'ready',
    accounts: [account('a1', 'owner@example.com', 'Owner'), account('a2', 'team@example.com', 'Team')],
    accountsStatus: 'ready',
  })
  window.history.replaceState(null, '', '/email')
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
})

describe('the mailbox manager dialog', () => {
  it('lists every mailbox, marks the active one, and switches on click', () => {
    view = renderElement(createElement(AccountManagerDialog, { open: true, onClose: vi.fn(), activeAccountId: 'a1', onOpenSettings: vi.fn() }))
    expect(document.body.textContent).toContain('owner@example.com')
    expect(document.body.textContent).toContain('team@example.com')
    expect(document.body.textContent).toContain(t('email.accounts.active'))
    const team = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('team@example.com'))
    expect(team).toBeTruthy()
    act(() => { team!.click() })
    expect(window.location.pathname).toBe('/email/accounts/a2/folders/inbox')
  })

  it('creates only among the configured addresses when the deployment fixes them', async () => {
    const createAccount = vi.fn().mockResolvedValue(account('a3', 'sales@example.com', 'Sales'))
    useEmailStore.setState({
      createAccount,
      config: { domains: ['example.com'], addresses: ['owner@example.com', 'sales@example.com'], attachmentsAvailable: true, sendingAvailable: true, autoDraftAvailable: true, canCreate: true },
      accounts: [account('a1', 'owner@example.com', 'Owner')],
    })
    view = renderElement(createElement(AccountManagerDialog, { open: true, onClose: vi.fn(), activeAccountId: 'a1', onOpenSettings: vi.fn() }))
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(t('email.accounts.create')))!.click() })
    expect(document.querySelector('select')).not.toBeNull()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    expect(createAccount).toHaveBeenCalledWith({ localPart: 'sales', domain: 'example.com', displayName: undefined })
  })

  it('creates a mailbox inside the same dialog', async () => {
    const createAccount = vi.fn().mockResolvedValue(account('a3', 'sales@example.com', 'Sales'))
    useEmailStore.setState({ createAccount })
    view = renderElement(createElement(AccountManagerDialog, { open: true, onClose: vi.fn(), activeAccountId: 'a1', onOpenSettings: vi.fn() }))
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(t('email.accounts.create')))!.click() })
    const local = document.querySelector<HTMLInputElement>('input[data-autofocus]')
    expect(local).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(local!, 'sales')
      local!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    expect(createAccount).toHaveBeenCalledWith({ localPart: 'sales', domain: 'example.com', displayName: undefined })
  })
})
