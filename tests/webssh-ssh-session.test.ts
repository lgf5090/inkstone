// @vitest-environment node
// W1 session lifecycle and chaos paths: handshake timeout, banner rejection, socket errors and
// configuration validation. The happy path runs against a real OpenSSH server in the live test.

import { describe, expect, it } from 'vitest'
import { SSHSession } from '../src/worker/webssh/ssh/session'
import { SSHSessionError } from '../src/worker/webssh/ssh/errors'
import { classifyHostKey } from '../src/worker/webssh/ssh/host-key'
import type { SSHConnectionConfig } from '../src/worker/webssh/ssh/types'
import { makeMemorySocket, makeTestSink } from './webssh-ssh-test-utils'

const baseConfig: SSHConnectionConfig = {
  host: '127.0.0.1',
  port: 22,
  username: 'testuser',
  authMethod: 'password',
  password: 'secret',
  cols: 120,
  rows: 40,
  term: 'xterm-256color',
}

describe('host key trust classification', () => {
  it('tells first-seen, trusted and changed apart', () => {
    expect(classifyHostKey(undefined, 'SHA256:new')).toBe('first-seen')
    expect(classifyHostKey('SHA256:same', 'SHA256:same')).toBe('trusted')
    expect(classifyHostKey('SHA256:old', 'SHA256:new')).toBe('changed')
  })
})

describe('connection config validation', () => {
  it('rejects an invalid port', () => {
    expect(() => new SSHSession(makeMemorySocket().socket, { ...baseConfig, port: 0 }, makeTestSink())).toThrow('Invalid SSH port')
  })

  it('rejects a password connection without a password', () => {
    expect(() => new SSHSession(makeMemorySocket().socket, { ...baseConfig, password: undefined }, makeTestSink())).toThrow('Password authentication requires exactly one password credential')
  })

  it('rejects a public-key connection without an OpenSSH key', () => {
    expect(() => new SSHSession(
      makeMemorySocket().socket,
      { ...baseConfig, authMethod: 'publickey', password: undefined, privateKey: 'not-a-key' },
      makeTestSink(),
    )).toThrow('Public-key authentication requires exactly one OpenSSH private key')
  })

  it('rejects an out-of-range terminal size', () => {
    expect(() => new SSHSession(makeMemorySocket().socket, { ...baseConfig, cols: 5 }, makeTestSink())).toThrow('Invalid terminal size')
  })

  it('rejects a malformed pinned fingerprint', () => {
    expect(() => new SSHSession(
      makeMemorySocket().socket,
      { ...baseConfig, expectedFingerprint: 'SHA256:not-valid' },
      makeTestSink(),
    )).toThrow('Invalid host key fingerprint')
  })
})

describe('session chaos paths', () => {
  it('fails with connection_timeout when the server never speaks', async () => {
    const memory = makeMemorySocket()
    const sink = makeTestSink()
    const session = new SSHSession(memory.socket, { ...baseConfig, handshakeTimeoutMs: 500 }, sink)
    await session.start()
    const closed = await sink.closedSignal.promise
    expect(closed.reason).toBe('error')
    expect(closed.error).toBeInstanceOf(SSHSessionError)
    expect((closed.error as SSHSessionError).code).toBe('connection_timeout')
    await session.waitForReadLoop()
  })

  it('fails with version_rejected for an SSH 1.x banner', async () => {
    const memory = makeMemorySocket()
    const sink = makeTestSink()
    const session = new SSHSession(memory.socket, baseConfig, sink)
    await session.start()
    memory.push(new TextEncoder().encode('SSH-1.5-legacy\r\n'))
    const closed = await sink.closedSignal.promise
    expect((closed.error as SSHSessionError).code).toBe('version_rejected')
    expect(closed.error?.message).toContain('does not support SSH 2.0')
    await session.waitForReadLoop()
  })

  it('fails with version_rejected for an oversized banner', async () => {
    const memory = makeMemorySocket()
    const sink = makeTestSink()
    const session = new SSHSession(memory.socket, baseConfig, sink)
    await session.start()
    memory.push(new Uint8Array(9_000).fill(0x41))
    const closed = await sink.closedSignal.promise
    expect((closed.error as SSHSessionError).code).toBe('version_rejected')
    expect(closed.error?.message).toContain('banner is too large')
    await session.waitForReadLoop()
  })

  it('reports a socket error as SSHSessionError', async () => {
    const memory = makeMemorySocket()
    const sink = makeTestSink()
    const session = new SSHSession(memory.socket, baseConfig, sink)
    await session.start()
    memory.fail(new Error('connection reset'))
    const closed = await sink.closedSignal.promise
    expect(closed.reason).toBe('error')
    expect((closed.error as SSHSessionError).code).toBe('socket_error')
    await session.waitForReadLoop()
  })

  it('rejects terminal input before the shell is ready', async () => {
    const memory = makeMemorySocket()
    const sink = makeTestSink()
    const session = new SSHSession(memory.socket, baseConfig, sink)
    await session.start()
    expect(() => session.write(new TextEncoder().encode('echo hi\n'))).toThrow('Terminal is not ready')
    session.close()
  })
})
