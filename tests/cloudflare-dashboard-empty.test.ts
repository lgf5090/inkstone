/**
 * The dashboard with nothing to show.
 *
 * Three panels each saying "no account data yet" reads as three broken panels rather than one missing
 * step, so the screen answers the empty case once and offers the way out of it. This mount is what
 * pins that: the guide replaces the two data panels entirely, and an account that simply has no
 * resources yet keeps the per-panel wording instead of the guide.
 */
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DashboardScreen } from '../src/client/features/cloudflare/screens/DashboardScreen'
import { cfT } from '../src/client/features/cloudflare/i18n'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals } from '../src/client/lib/test-render'

vi.mock('../src/client/features/cloudflare/api/dashboard', () => ({
  getQuota: vi.fn(async () => ({ accounts: [] })),
  getAuditActions: vi.fn(async () => ({ actions: [] })),
  getDashboardResources: vi.fn(async (accountId: string) => ({ accountId, counts: [], usage: [] })),
  getDashboardZones: vi.fn(async () => ({ zones: [] })),
  getAuditLogs: vi.fn(async () => ({ logs: [], total: 0, actions: [] })),
}))

let root: Root
let container: HTMLDivElement

async function mount(): Promise<void> {
  act(() => { root.render(createElement(StrictMode, null, createElement(DashboardScreen))) })
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => { await new Promise((resolve) => { window.setTimeout(resolve, 0) }) })
  }
}

function text(): string {
  return document.body.textContent ?? ''
}

beforeEach(async () => {
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
  vi.clearAllMocks()
})

describe('the dashboard with no accounts', () => {
  it('answers once, with the way to add one, instead of three empty panels', async () => {
    await mount()
    expect(text()).toContain(cfT('cloudflare.dashboard.no_accounts_hint'))
    expect(text()).toContain(cfT('cloudflare.dashboard.add_account'))
    expect(text()).not.toContain(cfT('cloudflare.dashboard.resources.title'))
    expect(text()).not.toContain(cfT('cloudflare.dashboard.traffic.title'))
    expect(text()).not.toContain(cfT('cloudflare.dashboard.no_account_data'))
  })

  it('keeps the per-panel wording when an account exists without resources', async () => {
    const { getQuota } = await import('../src/client/features/cloudflare/api/dashboard')
    ;(getQuota as Mock).mockResolvedValue({
      accounts: [{ account_id: 'a1', account_name: 'One', resources: [] }],
    })
    await mount()
    expect(text()).toContain(cfT('cloudflare.dashboard.no_account_data'))
    expect(text()).not.toContain(cfT('cloudflare.dashboard.no_accounts_hint'))
  })
})
