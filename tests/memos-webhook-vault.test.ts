// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { CredentialVault, isScope } from '../src/worker/durable/credential-vault'

const WEBHOOK_ID = '0123456789abcdefghjkmnpqrs'
const OTHER_ID = '0123456789abcdefghjkmnpqrt'
const SECRET = 'whsec_abcdefghijklmnopqrstuvwxyz012345'

const vaultStorage = new Map<string, unknown>()

function vaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) { return vaultStorage.get(key) },
      async put(key: string, value: unknown) { vaultStorage.set(key, value) },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> { return await fn() },
  } as unknown as DurableObjectState
}

async function call(path: '/encrypt' | '/decrypt', body: unknown): Promise<Response> {
  return await new CredentialVault(vaultState()).fetch(new Request(`https://credential-vault.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

async function encrypt(scope: string, value: Record<string, string>): Promise<Response> {
  return await call('/encrypt', { scope, value })
}

beforeEach(() => {
  vaultStorage.clear()
})

describe('the memo webhook credential scope', () => {
  it('encrypts and decrypts a signing secret under its own webhook id', async () => {
    const scope = `memo-webhook:${WEBHOOK_ID}`
    expect(isScope(scope)).toBe(true)

    const stored = await encrypt(scope, { secret: SECRET })
    expect(stored.status).toBe(200)
    const { ciphertext } = await stored.json() as { ciphertext: string }
    expect(ciphertext).toMatch(/^v1\./)

    const opened = await call('/decrypt', { scope, ciphertext })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({ value: { secret: SECRET } })
  })

  it('will not open one webhook secret under another webhook id', async () => {
    const stored = await encrypt(`memo-webhook:${WEBHOOK_ID}`, { secret: SECRET })
    const { ciphertext } = await stored.json() as { ciphertext: string }

    const opened = await call('/decrypt', { scope: `memo-webhook:${OTHER_ID}`, ciphertext })
    expect(opened.status).toBe(422)
  })

  it('rejects a malformed scope or id', async () => {
    const malformed = [
      'memo-webhook',
      'memo-webhook:',
      'memo-webhook:short',
      `memo-webhook:${WEBHOOK_ID}0`,
      `memo-webhook:${WEBHOOK_ID.slice(0, 25)}i`,
    ]
    for (const scope of malformed) {
      expect(isScope(scope), scope).toBe(false)
      expect((await encrypt(scope, { secret: SECRET })).status, scope).toBe(400)
    }
  })

  it('accepts the secret field and nothing else', async () => {
    expect((await encrypt(`memo-webhook:${WEBHOOK_ID}`, { secret: '' })).status).toBe(400)
    expect((await encrypt(`memo-webhook:${WEBHOOK_ID}`, { signingSecret: SECRET })).status).toBe(400)
    expect((await encrypt(`memo-webhook:${WEBHOOK_ID}`, { secret: SECRET, url: 'https://example.com' })).status).toBe(400)
  })
})
