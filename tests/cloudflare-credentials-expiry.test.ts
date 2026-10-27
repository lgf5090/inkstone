/**
 * How long a decrypted credential stays on screen.
 *
 * The dialog exists to show a secret, so the interesting question is when it stops showing it: the
 * value leaves after a minute, and it leaves again when the dialog closes. Seeing it a second time
 * has to be asked for, which is also what keeps the audit trail honest — every reveal is a fetch.
 */
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { CloudflareAccount } from '@shared/cloudflare/model'
import { CredentialsDialog } from '../src/client/features/cloudflare/screens/accounts/CredentialsDialog'
import { cfT } from '../src/client/features/cloudflare/i18n'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals } from '../src/client/lib/test-render'

vi.mock('../src/client/features/cloudflare/api/accounts', () => ({
  accountsApi: {
    credentials: vi.fn(async () => ({
      id: 'a1',
      name: 'One',
      auth_type: 'token',
      email: null,
      cf_account_id: null,
      api_token: 'tok-secret',
      api_key: null,
      password: null,
    })),
  },
}))

const ACCOUNT: CloudflareAccount = {
  id: 'a1',
  user_id: 'u1',
  name: 'One',
  auth_type: 'token',
  email: null,
  cf_account_id: null,
  is_active: 1,
  enabled_features: '',
  available_features: '',
  has_credentials: 1,
  is_demo: false,
  created_at: 1,
  updated_at: 1,
}

let root: Root
let container: HTMLDivElement

async function flush(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

function secretFields(): HTMLInputElement[] {
  return [...document.body.querySelectorAll<HTMLInputElement>('input[type=password]')]
}

async function mount(open: boolean): Promise<void> {
  act(() => {
    root.render(createElement(StrictMode, null, createElement(CredentialsDialog, {
      open,
      account: ACCOUNT,
      onClose: () => {},
    })))
  })
  await flush()
}

beforeEach(async () => {
  vi.useFakeTimers()
  installTestGlobals()
  await initI18n()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the credential viewer', () => {
  it('shows the secret, then takes it away by itself', async () => {
    const { accountsApi } = await import('../src/client/features/cloudflare/api/accounts')
    await mount(true)
    expect(secretFields().map((field) => field.value)).toEqual(['tok-secret'])

    act(() => { vi.advanceTimersByTime(59_000) })
    expect(secretFields().map((field) => field.value)).toEqual(['tok-secret'])

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(secretFields()).toEqual([])
    expect(document.body.textContent).toContain(cfT('cloudflare.accounts.cred_hidden'))

    const reveal = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === cfT('cloudflare.accounts.cred_reveal'))
    if (!reveal) throw new Error('no reveal control after the secret hid itself')
    await act(async () => { reveal.click() })
    await flush()
    expect(secretFields().map((field) => field.value)).toEqual(['tok-secret'])
    expect((accountsApi.credentials as Mock).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('drops the secret as soon as the dialog closes', async () => {
    await mount(true)
    expect(secretFields()).toHaveLength(1)
    await mount(false)
    expect(secretFields()).toEqual([])
    expect(document.body.textContent).not.toContain(cfT('cloudflare.accounts.cred_hidden'))
  })
})
