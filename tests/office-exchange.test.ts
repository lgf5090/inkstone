// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The exchange contract: an empty variable hides the actions, a set one enables them and is read once.
 */

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the office exchange endpoint', () => {
  it('is disabled when the variable is empty', async () => {
    vi.stubEnv('VITE_UNIVER_EXCHANGE_ENDPOINT', '')
    vi.resetModules()
    const mod = await import('../src/client/features/office/office-exchange')
    expect(mod.officeExchangeEnabled()).toBe(false)
    expect(mod.officeExchangeEndpoint()).toBe('')
  })

  it('is enabled and trailing-slash free when set', async () => {
    vi.stubEnv('VITE_UNIVER_EXCHANGE_ENDPOINT', 'https://exchange.example/')
    vi.resetModules()
    const mod = await import('../src/client/features/office/office-exchange')
    expect(mod.officeExchangeEnabled()).toBe(true)
    expect(mod.officeExchangeEndpoint()).toBe('https://exchange.example')
  })
})
