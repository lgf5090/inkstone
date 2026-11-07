// @vitest-environment node
// Structured outbound failures: the platform can reject with a non-Error object, so the description
// has to walk the cause chain instead of trusting the outer wrapper's message.

import { describe, expect, it } from 'vitest'
import { describeError, toEgressFailure, WEBSSH_EGRESS_MESSAGE_MAX } from '../src/worker/webssh/egress-error'
import {
  openSshSocket,
  resolveSshTarget,
  WebsshConnectionError,
  type ConnectImpl,
} from '../src/worker/webssh/connection'

const target = { host: '93.184.216.34', port: 22, address: '93.184.216.34', family: 4 as const, devOverride: false }

function socketLike(overrides: Record<string, unknown>): Socket {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
    close: () => undefined,
    ...overrides,
  } as unknown as Socket
}

describe('describeError', () => {
  it('reads a Workers-style object that is not an Error', () => {
    expect(describeError({
      name: 'jsg.Error',
      message: 'proxy request failed, cannot connect to the specified address',
    })).toEqual({
      name: 'jsg.Error',
      message: 'proxy request failed, cannot connect to the specified address',
    })
  })

  it('walks the cause chain to the deepest useful message', () => {
    const outer = new Error('Could not open a TCP connection', {
      cause: { name: 'jsg.Error', message: 'proxy request failed' },
    })
    expect(describeError(outer)).toEqual({ name: 'jsg.Error', message: 'proxy request failed' })
  })

  it('keeps the outer message when a cause is less specific', () => {
    const outer = new Error('SSH authentication failed', { cause: new Error('[object Object]') })
    expect(describeError(outer)).toEqual({ name: 'Error', message: 'SSH authentication failed' })
  })

  it('falls back to String for an object without a message', () => {
    const value = { toString: () => 'blocked by the edge' }
    expect(describeError(value)).toEqual({ name: 'Error', message: 'blocked by the edge' })
  })

  it('handles a string rejection', () => {
    expect(describeError('connection refused')).toEqual({ name: 'Error', message: 'connection refused' })
  })
})

describe('toEgressFailure', () => {
  it('flattens the stage, endpoint, elapsed time and reserved region', () => {
    const failure = toEgressFailure(new Error('refused'), {
      phase: 'connect',
      address: '93.184.216.34',
      port: 22,
      startedAt: 1_000,
      mode: 'direct',
      region: 'apac',
      now: 1_250,
    })
    expect(failure).toEqual({
      name: 'Error',
      message: 'refused',
      phase: 'connect',
      address: '93.184.216.34',
      port: 22,
      elapsedMs: 250,
      mode: 'direct',
      region: 'apac',
    })
  })

  it('truncates a long platform message', () => {
    const failure = toEgressFailure(new Error('x'.repeat(600)), {
      phase: 'connect',
      address: '93.184.216.34',
      port: 22,
      startedAt: 1_000,
      mode: 'direct',
      region: '',
      now: 1_001,
    })
    expect(failure.message).toHaveLength(WEBSSH_EGRESS_MESSAGE_MAX)
    expect(failure.message.endsWith('...')).toBe(true)
  })
})

describe('openSshSocket opened promise', () => {
  it('wraps a non-Error opened rejection and keeps its message', async () => {
    const connect: ConnectImpl = () => socketLike({
      opened: Promise.reject({ name: 'jsg.Error', message: 'proxy request failed, cannot connect to the specified address' }),
    })
    let caught: unknown
    try {
      await openSshSocket(target, connect)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WebsshConnectionError)
    expect((caught as WebsshConnectionError).code).toBe('connect_failed')
    expect(describeError(caught)).toEqual({
      name: 'jsg.Error',
      message: 'proxy request failed, cannot connect to the specified address',
    })
  })

  it('times out a silent opened promise', async () => {
    const connect: ConnectImpl = () => socketLike({ opened: new Promise(() => undefined) })
    let caught: unknown
    try {
      await openSshSocket(target, connect, { timeoutMs: 20 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WebsshConnectionError)
    expect((caught as WebsshConnectionError).code).toBe('connect_failed')
    expect(describeError(caught).message).toContain('timed out after 20 ms')
  })

  it('still accepts a test transport without an opened promise', async () => {
    const connect: ConnectImpl = () => socketLike({})
    await expect(openSshSocket(target, connect)).resolves.toBeTruthy()
  })
})

describe('resolved target shape', () => {
  it('keeps the address the socket must use', async () => {
    const resolved = await resolveSshTarget('93.184.216.34', 22)
    expect(resolved).toEqual(target)
  })
})
