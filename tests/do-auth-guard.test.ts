import { evaluateInternalGuard } from '../src/worker/lib/internal-auth'
import { webcrypto } from 'node:crypto'
import { beforeAll, expect, it, vi } from 'vitest'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { SyncHub } from '../src/worker/realtime/sync-hub'
import { testBindings, testD1 } from './doubles/bindings'
import type { Env } from '../src/worker/env'

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

/**
 * Both objects read one binding, `DO_AUTH_KEY`, so every case here is that key present, blank or
 * absent on top of a real `Env`.
 */
function bindings(overrides: Partial<Env> = {}): Env {
  return testBindings(testD1(), overrides)
}

function vaultState() {
  return {
    storage: { get: () => null, put: () => {}, delete: () => true, list: () => [] },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  } as unknown as DurableObjectState
}

function hubState() {
  return {
    id: { name: 'user', toString: () => 'user' },
    storage: { get: () => null, put: () => {}, delete: () => true, list: () => [] },
    getWebSockets: () => [],
    acceptWebSocket: () => {},
    waitUntil: () => {},
  } as unknown as DurableObjectState
}

it('rejects credential vault fetches without the internal key', async () => {
  const vault = new CredentialVault(vaultState(), bindings({ DO_AUTH_KEY: 'sekrit' }))
  const response = await vault.fetch(new Request('https://vault.internal/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }))
  expect(response.status).toBe(401)
})

it('rejects a wrong internal key', async () => {
  const vault = new CredentialVault(vaultState(), bindings({ DO_AUTH_KEY: 'sekrit' }))
  const response = await vault.fetch(new Request('https://vault.internal/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inkstone-Internal': 'wrong' },
    body: '{}',
  }))
  expect(response.status).toBe(401)
})

it('passes requests through when the key matches or the guard is unconfigured', async () => {
  const guarded = new CredentialVault(vaultState(), bindings({ DO_AUTH_KEY: 'sekrit' }))
  const ok = await guarded.fetch(new Request('https://vault.internal/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inkstone-Internal': 'sekrit' },
    body: '{}',
  }))
  expect(ok.status).toBe(400)
  const unconfigured = new CredentialVault(vaultState(), bindings())
  const open = await unconfigured.fetch(new Request('https://vault.internal/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }))
  expect(open.status).not.toBe(401)
})

it('rejects sync hub notify without the internal key but serves it when unset', async () => {
  const guarded = new SyncHub(hubState(), bindings({ DO_AUTH_KEY: 'sekrit' }))
  const denied = await guarded.fetch(new Request('https://sync-hub.internal/notify', {
    method: 'POST',
    body: '{}',
  }))
  expect(denied.status).toBe(401)
  const permitted = await guarded.fetch(new Request('https://sync-hub.internal/notify', {
    method: 'POST',
    headers: { 'X-Inkstone-Internal': 'sekrit' },
    body: '{}',
  }))
  expect(permitted.status).toBe(204)
  const open = new SyncHub(hubState(), bindings())
  const served = await open.fetch(new Request('https://sync-hub.internal/notify', {
    method: 'POST',
    body: '{}',
  }))
  expect(served.status).toBe(204)
})

it('treats a blank DO_AUTH_KEY as a misconfiguration rather than an open guard', async () => {
  const request = new Request('https://vault.internal/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  expect(evaluateInternalGuard(bindings({ DO_AUTH_KEY: '' }), request)).toBe('misconfigured')
  expect(evaluateInternalGuard(bindings({ DO_AUTH_KEY: '   ' }), request)).toBe('misconfigured')
  expect(evaluateInternalGuard(bindings(), request)).toBe('allowed')

  const vault = new CredentialVault(vaultState(), bindings({ DO_AUTH_KEY: '' }))
  expect((await vault.fetch(request)).status).toBe(500)

  const hub = new SyncHub(hubState(), bindings({ DO_AUTH_KEY: '' }))
  expect((await hub.fetch(new Request('https://hub.internal/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }))).status).toBe(500)
})
