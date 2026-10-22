// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailAccount, EmailAccountSettings } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { t } from '../../src/client/lib/i18n'
import { AccountSettingsPage } from '../../src/client/features/email/AccountSettingsPage'
import { useEmailStore } from '../../src/client/features/email/store'

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

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button named ${label}`)
  return found
}

let view: RenderedElement | null = null

beforeEach(() => {
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
})

describe('the mailbox settings page', () => {
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
        signature: { enabled: true, text: 'Ada Lovelace' },
        autoDraft: false,
      },
    })
    expect(useEmailStore.getState().accounts[0]!.displayName).toBe('Grace Hopper')
  })
})
