// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { WebsshEgressFailure } from '../src/shared/webssh/types'
import { regionRetryTarget } from '../src/client/features/webssh/transport/region-retry'

function failure(overrides: Partial<WebsshEgressFailure> = {}): WebsshEgressFailure {
  return {
    name: 'Error',
    message: 'proxy request failed',
    phase: 'connect',
    address: '1.2.3.4',
    port: 22,
    elapsedMs: 10,
    mode: 'direct',
    region: 'apac',
    ...overrides,
  }
}

describe('region retry', () => {
  it('moves once when the server marks the failure retryable', () => {
    expect(regionRetryTarget(failure({ retryable: true, retryRegion: 'weur' }), false)).toBe('weur')
  })

  it('never moves twice', () => {
    expect(regionRetryTarget(failure({ retryable: true, retryRegion: 'weur' }), true)).toBeNull()
  })

  it('does not move on a credential or host-key failure', () => {
    expect(regionRetryTarget(failure({ retryable: false, retryRegion: 'weur' }), false)).toBeNull()
  })

  it('does nothing without a structured failure', () => {
    expect(regionRetryTarget(undefined, false)).toBeNull()
  })
})
