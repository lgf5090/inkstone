// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../src/client/lib/api'
import { renderElement, type RenderedElement } from '../../src/client/lib/test-render'
import { initI18n, t } from '../../src/client/lib/i18n'
import { AccountManagerDialog } from '../../src/client/features/email/AccountManagerDialog'
import { DeploymentSettingsDialog } from '../../src/client/features/email/DeploymentSettings'
import { useEmailStore } from '../../src/client/features/email/store'
import { useUi } from '../../src/client/store/ui'

const original = useEmailStore.getState()

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
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

let view: RenderedElement | null = null

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  vi.spyOn(api.email, 'getDeployment').mockResolvedValue({
    domains: [],
    provider: 'cloudflare',
    resendFrom: '',
    hasResendKey: false,
    resendKeyHint: '',
    envDomains: [],
    cloudflareSending: true,
    attachmentsAvailable: true,
    updatedAt: null,
  })
  vi.spyOn(api.email, 'updateDeployment').mockImplementation(async (patch) => ({
    domains: patch.domains ?? [],
    provider: patch.provider ?? 'cloudflare',
    resendFrom: patch.resendFrom ?? '',
    hasResendKey: Boolean(patch.resendApiKey),
    resendKeyHint: '',
    envDomains: [],
    cloudflareSending: true,
    attachmentsAvailable: true,
    updatedAt: '2026-01-02T00:00:00.000Z',
  }))
  useEmailStore.setState(original, true)
  useEmailStore.setState({
    accounts: [],
    accountsStatus: 'ready',
    accountsError: null,
    config: {
      domains: [],
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

describe('deployment settings without a mailbox', () => {
  it('offers the deployment dialog when no domain is configured', async () => {
    const onOpenDeployment = vi.fn()
    const onClose = vi.fn()
    view = renderElement(createElement(AccountManagerDialog, {
      open: true,
      onClose,
      activeAccountId: '',
      onOpenSettings: () => undefined,
      onOpenDeployment,
    }))
    await settle()

    expect(document.body.textContent).toContain(t('email.no_domain'))
    act(() => button(t('email.settings.delivery')).click())
    expect(onClose).toHaveBeenCalled()
    expect(onOpenDeployment).toHaveBeenCalled()
  })

  it('saves a domain from the standalone deployment dialog', async () => {
    const onSaved = vi.fn()
    view = renderElement(createElement(DeploymentSettingsDialog, {
      open: true,
      onClose: () => undefined,
      onSaved,
    }))
    await settle()

    change(inputFor(t('email.settings.delivery_domains')), 'mail.example.com')
    act(() => button(t('email.settings.delivery_save')).click())
    await settle()

    expect(api.email.updateDeployment).toHaveBeenCalledWith(expect.objectContaining({
      domains: ['mail.example.com'],
      provider: 'cloudflare',
    }))
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ domains: ['mail.example.com'] }))
  })
})
