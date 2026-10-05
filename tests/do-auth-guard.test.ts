import { webcrypto } from 'node:crypto'
import { beforeAll, expect, it, vi } from 'vitest'
import { CredentialVault } from '../src/worker/durable/credential-vault'
import { SyncHub } from '../src/worker/realtime/sync-hub'

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

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
  const vault = new CredentialVault(vaultState(), { DO_AUTH_KEY: 'sekrit' } as never)
  const response = await vault.fetch(new Request('https://vault.internal/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }))
  expect(response.status).toBe(401)
})

it('rejects a wrong internal key', async () => {
  const vault = new CredentialVault(vaultState(), { DO_AUTH_KEY: 'sekrit' } as never)
  const response = await vault.fetch(new Request('https://vault.internal/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inkstone-Internal': 'wrong' },
    body: '{}',
  }))
  expect(response.status).toBe(401)
})

it('passes requests through when the key matches or the guard is unconfigured', async () => {
  const guarded = new CredentialVault(vaultState(), { DO_AUTH_KEY: 'sekrit' } as never)
  const ok = await guarded.fetch(new Request('https://vault.internal/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inkstone-Internal': 'sekrit' },
    body: '{}',
  }))
  expect(ok.status).toBe(400)
  const unconfigured = new CredentialVault(vaultState(), {} as never)
  const open = await unconfigured.fetch(new Request('https://vault.internal/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }))
  expect(open.status).not.toBe(401)
})

it('rejects sync hub notify without the internal key but serves it when unset', async () => {
  const guarded = new SyncHub(hubState(), { DO_AUTH_KEY: 'sekrit' } as never)
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
  const open = new SyncHub(hubState(), {} as never)
  const served = await open.fetch(new Request('https://sync-hub.internal/notify', {
    method: 'POST',
    body: '{}',
  }))
  expect(served.status).toBe(204)
})
