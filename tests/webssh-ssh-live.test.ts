// @vitest-environment node
// W1 live acceptance: the protocol core drives a real OpenSSH server over `node:net`. It is
// skipped unless a reachable test host is supplied, so a normal suite run stays self-contained.
// Run it with WEBSSH_SSH_HOST / PORT / USER / PASSWORD / FINGERPRINT pointing at the container
// described in the W1 report.

import net from 'node:net'
import { Readable, Writable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SSHSession } from '../src/worker/webssh/ssh/session'
import { SSHSessionError } from '../src/worker/webssh/ssh/errors'
import type { SSHConnectionConfig, SSHTransportSocket } from '../src/worker/webssh/ssh/types'
import { makeTestSink } from './webssh-ssh-test-utils'

const LIVE_HOST = process.env.WEBSSH_SSH_HOST
const LIVE_PORT = Number(process.env.WEBSSH_SSH_PORT ?? '22')
const LIVE_USER = process.env.WEBSSH_SSH_USER
const LIVE_PASSWORD = process.env.WEBSSH_SSH_PASSWORD
const LIVE_FINGERPRINT = process.env.WEBSSH_SSH_FINGERPRINT
const LIVE_KEX = process.env.WEBSSH_SSH_EXPECT_KEX ?? 'curve25519-sha256'
const LIVE_HOST_KEY = process.env.WEBSSH_SSH_EXPECT_HOST_KEY ?? 'ssh-ed25519'
const LIVE_HOST_KEY_TYPE = process.env.WEBSSH_SSH_EXPECT_HOST_KEY_TYPE ?? 'ssh-ed25519'
const LIVE = Boolean(LIVE_HOST && LIVE_USER && LIVE_PASSWORD && LIVE_FINGERPRINT)

const encoder = new TextEncoder()

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/webssh/${name}`, import.meta.url)), 'utf8')
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms)),
  ])
}

interface LiveSocket {
  socket: SSHTransportSocket
  destroy(): void
}

function connect(host: string, port: number): Promise<LiveSocket> {
  return new Promise((resolve, reject) => {
    const tcp = net.connect({ host, port })
    tcp.setNoDelay(true)
    // Errors reach the protocol through the readable stream; this listener only stops Node from
    // treating a reset during teardown as an unhandled event.
    tcp.on('error', () => undefined)
    tcp.once('connect', () => {
      const readable = Readable.toWeb(tcp) as unknown as ReadableStream<Uint8Array>
      const writable = Writable.toWeb(tcp) as unknown as WritableStream<Uint8Array>
      resolve({
        socket: { readable, writable, close: () => { tcp.destroy() } },
        destroy: () => { tcp.destroy() },
      })
    })
    tcp.once('error', reject)
  })
}

function config(overrides: Partial<SSHConnectionConfig> = {}): SSHConnectionConfig {
  return {
    host: LIVE_HOST as string,
    port: LIVE_PORT,
    username: LIVE_USER as string,
    authMethod: 'password',
    password: LIVE_PASSWORD as string,
    cols: 120,
    rows: 40,
    term: 'xterm-256color',
    expectedFingerprint: LIVE_FINGERPRINT as string,
    handshakeTimeoutMs: 15_000,
    ...overrides,
  }
}

describe.skipIf(!LIVE)('live OpenSSH server', () => {
  it('completes version exchange, KEX, password auth, PTY, echo and exit', async () => {
    const live = await connect(LIVE_HOST as string, LIVE_PORT)
    const sink = makeTestSink()
    const session = new SSHSession(live.socket, config(), sink)
    await session.start()

    const ready = await withTimeout(sink.readySignal.promise, 15_000, 'shell ready')
    expect(ready.kex).toBe(LIVE_KEX)
    expect(ready.cipherC2S).toBe('aes128-gcm@openssh.com')
    expect(ready.cipherS2C).toBe('aes128-gcm@openssh.com')
    expect(ready.hostKeyType).toBe(LIVE_HOST_KEY_TYPE)
    expect(ready.hostKeyAlgorithm).toBe(LIVE_HOST_KEY)
    expect(ready.hostKeyFingerprint).toBe(LIVE_FINGERPRINT)
    expect(sink.lastHostKey).toBeNull()

    session.write(encoder.encode("printf 'RESULT=%s\\n' \"$((6*7))\"\n"))
    await sink.waitForText('RESULT=42', 10_000)

    session.write(encoder.encode('exit\n'))
    const exitInfo = await withTimeout(sink.exitSignal.promise, 10_000, 'exit status')
    const closed = await withTimeout(sink.closedSignal.promise, 10_000, 'session close')
    expect(exitInfo.exitCode).toBe(0)
    expect(closed.reason).toBe('session_ended')
    await session.waitForReadLoop()
  })

  it('authenticates with an Ed25519 public key', async () => {
    const live = await connect(LIVE_HOST as string, LIVE_PORT)
    const sink = makeTestSink()
    const session = new SSHSession(live.socket, config({
      authMethod: 'publickey',
      password: undefined,
      privateKey: fixture('id_ed25519'),
    }), sink)
    await session.start()
    await withTimeout(sink.readySignal.promise, 15_000, 'shell ready')
    session.write(encoder.encode("printf 'KEY_ED25519=%s\\n' ok\n"))
    await sink.waitForText('KEY_ED25519=ok', 10_000)
    session.close()
  })

  it('authenticates with an RSA public key', async () => {
    const live = await connect(LIVE_HOST as string, LIVE_PORT)
    const sink = makeTestSink()
    const session = new SSHSession(live.socket, config({
      authMethod: 'publickey',
      password: undefined,
      privateKey: fixture('id_rsa'),
    }), sink)
    await session.start()
    await withTimeout(sink.readySignal.promise, 15_000, 'shell ready')
    session.write(encoder.encode("printf 'KEY_RSA=%s\\n' ok\n"))
    await sink.waitForText('KEY_RSA=ok', 10_000)
    session.close()
  })

  it('reports auth_failed for a wrong password', async () => {
    const live = await connect(LIVE_HOST as string, LIVE_PORT)
    const sink = makeTestSink()
    const session = new SSHSession(live.socket, config({ password: 'definitely-wrong' }), sink)
    await session.start()
    const closed = await withTimeout(sink.closedSignal.promise, 15_000, 'auth failure')
    expect(closed.reason).toBe('error')
    expect((closed.error as SSHSessionError).code).toBe('auth_failed')
    await session.waitForReadLoop()
  })

  it('blocks a changed host key the user rejects', async () => {
    const live = await connect(LIVE_HOST as string, LIVE_PORT)
    const sink = makeTestSink({ acceptHostKey: false })
    const session = new SSHSession(live.socket, config({
      expectedFingerprint: `SHA256:${'A'.repeat(43)}`,
    }), sink)
    await session.start()
    const closed = await withTimeout(sink.closedSignal.promise, 15_000, 'host key block')
    expect(sink.lastHostKey?.trust).toBe('changed')
    expect(sink.lastHostKey?.expectedFingerprint).toBe(`SHA256:${'A'.repeat(43)}`)
    expect((closed.error as SSHSessionError).code).toBe('host_key_changed')
    expect((closed.error as SSHSessionError).retryable).toBe(false)
    await session.waitForReadLoop()
  })

  it('continues after the user accepts a changed host key', async () => {
    const live = await connect(LIVE_HOST as string, LIVE_PORT)
    const sink = makeTestSink({ acceptHostKey: true })
    const session = new SSHSession(live.socket, config({
      expectedFingerprint: `SHA256:${'A'.repeat(43)}`,
    }), sink)
    await session.start()
    const ready = await withTimeout(sink.readySignal.promise, 15_000, 'shell ready')
    expect(sink.lastHostKey?.trust).toBe('changed')
    expect(ready.hostKeyFingerprint).toBe(LIVE_FINGERPRINT)
    session.close()
  })

  it('asks before trusting a first-seen host and stops when rejected', async () => {
    const live = await connect(LIVE_HOST as string, LIVE_PORT)
    const sink = makeTestSink({ acceptHostKey: false })
    const session = new SSHSession(live.socket, config({ expectedFingerprint: undefined }), sink)
    await session.start()
    const closed = await withTimeout(sink.closedSignal.promise, 15_000, 'host key block')
    expect(sink.lastHostKey?.trust).toBe('first-seen')
    expect((closed.error as SSHSessionError).code).toBe('host_key_rejected')
    await session.waitForReadLoop()
  })

  it('reports a remote disconnect while the shell is ready', async () => {
    const live = await connect(LIVE_HOST as string, LIVE_PORT)
    const sink = makeTestSink()
    const session = new SSHSession(live.socket, config(), sink)
    await session.start()
    await withTimeout(sink.readySignal.promise, 15_000, 'shell ready')
    live.destroy()
    const closed = await withTimeout(sink.closedSignal.promise, 10_000, 'remote close')
    expect(['remote_closed', 'error']).toContain(closed.reason)
    await session.waitForReadLoop()
  })
})
