// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount } from '@shared/email/model'
import { initI18n, t } from '../../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { confirm } from '../../src/client/components/overlay'
import { EmailAccountSwitcher } from '../../src/client/features/email/EmailAccountSwitcher'
import { useEmailStore } from '../../src/client/features/email/store'

vi.mock('../../src/client/components/overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/components/overlay')>()
  return { ...actual, confirm: vi.fn(async () => false) }
})

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

const accounts = [account('a1', 'owner@example.com', 'Owner'), account('a2', 'team@example.com', 'Team')]
const original = useEmailStore.getState()

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.mocked(confirm).mockReset()
  vi.mocked(confirm).mockResolvedValue(false)
  useEmailStore.setState(original, true)
  useEmailStore.setState({ accounts, accountsStatus: 'ready' })
  window.history.replaceState(null, '', '/email')
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
})

function trigger(): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.getAttribute('aria-label') === t('email.accounts.switch'))
  if (!found) throw new Error('the account switcher trigger did not render')
  return found
}

function accountRow(address: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[data-account-row]')]
    .find((node) => node.textContent?.includes(address))
  if (!found) throw new Error(`no account row for ${address}`)
  return found
}

describe('the mailbox switcher', () => {
  it('opens a dropdown of mailboxes and switches on selection', () => {
    view = renderElement(createElement(EmailAccountSwitcher, {
      accounts,
      activeAccountId: 'a1',
      onManageAccounts: vi.fn(),
    }))
    expect(trigger().textContent).toContain('Owner')
    expect(trigger().textContent).toContain('owner@example.com')
    act(() => trigger().click())
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('team@example.com')

    act(() => accountRow('team@example.com').click())
    expect(window.location.pathname).toBe('/email/accounts/a2/folders/inbox')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reveals settings and delete actions on every mailbox row', () => {
    view = renderElement(createElement(EmailAccountSwitcher, {
      accounts,
      activeAccountId: 'a1',
      onManageAccounts: vi.fn(),
    }))
    act(() => trigger().click())
    const settings = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .filter((node) => node.getAttribute('aria-label') === t('email.header.settings'))
    expect(settings).toHaveLength(2)
    const remove = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .filter((node) => node.getAttribute('aria-label') === t('email.accounts.delete_address', { address: 'team@example.com' }))
    expect(remove).toHaveLength(1)
  })

  it('routes account settings and starts mailbox creation from the footer rows', () => {
    const onManageAccounts = vi.fn()
    view = renderElement(createElement(EmailAccountSwitcher, {
      accounts,
      activeAccountId: 'a1',
      onManageAccounts,
    }))
    act(() => trigger().click())
    const settings = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .filter((node) => node.getAttribute('aria-label') === t('email.header.settings'))
    act(() => settings[1]!.click())
    expect(window.location.pathname).toBe('/email/accounts/a2/settings')

    act(() => trigger().click())
    const create = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === t('email.accounts.create'))
    expect(create).toBeTruthy()
    act(() => create!.click())
    expect(onManageAccounts).toHaveBeenCalledWith(true)
  })
})
