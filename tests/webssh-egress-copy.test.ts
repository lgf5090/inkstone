// @vitest-environment jsdom
// The browser copy has to name the stage; a raw platform sentence does not tell a reader whether
// the TCP connect, the SSH handshake, or the credentials failed.

import { beforeAll, describe, expect, it } from 'vitest'
import type { WebsshEgressFailure, WebsshEgressPhase } from '../src/shared/webssh/types'
import { formatEgressFailure } from '../src/client/features/webssh/egress-error'
import { setLocaleAsync } from '../src/client/lib/i18n'

function failure(phase: WebsshEgressPhase): WebsshEgressFailure {
  return {
    name: 'jsg.Error',
    message: 'proxy request failed, cannot connect to the specified address',
    phase,
    address: '1.2.3.4',
    port: 22,
    elapsedMs: 123,
    mode: 'direct',
    region: '',
  }
}

describe('egress failure copy', () => {
  beforeAll(async () => {
    await setLocaleAsync('zh-CN', false)
  })

  it('tells a TCP failure from a handshake and an authentication failure', () => {
    expect(formatEgressFailure(failure('connect'))).toContain('TCP 连接失败')
    expect(formatEgressFailure(failure('handshake'))).toContain('SSH 握手失败')
    expect(formatEgressFailure(failure('auth'))).toContain('SSH 认证失败')
    expect(formatEgressFailure(failure('connect'))).toContain('1.2.3.4:22')
    expect(formatEgressFailure(failure('connect'))).toContain('123 ms')
  })

  it('speaks English when the interface does', async () => {
    await setLocaleAsync('en-US', false)
    expect(formatEgressFailure(failure('dns'))).toContain('DNS resolution failed')
    expect(formatEgressFailure(failure('handshake'))).toContain('SSH handshake failed')
    expect(formatEgressFailure(failure('auth'))).toContain('SSH authentication failed')
  })
})
