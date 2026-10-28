// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { CredentialVault, isCredentialRecord, isScope } from '../src/worker/durable/credential-vault'

const CONNECTION_ID = '0123456789abcdefghjkmnpqrs'
const OTHER_ID = '0123456789abcdefghjkmnpqrt'
const TOKEN = 'libsql-token-abcdefghijklmnopqrstuvwxyz'

const vaultStorage = new Map<string, unknown>()

function vaultState(): DurableObjectState {
  return {
    storage: {
      async get(key: string) {
        return vaultStorage.get(key)
      },
      async put(key: string, value: unknown) {
        vaultStorage.set(key, value)
      },
    },
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return await fn()
    },
  } as unknown as DurableObjectState
}

async function call(path: '/encrypt' | '/decrypt', body: unknown): Promise<Response> {
  return await new CredentialVault(vaultState()).fetch(
    new Request(`https://credential-vault.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vaultStorage.clear()
})

describe('the database credential scope', () => {
  it('encrypts and decrypts a token under its own connection id', async () => {
    const scope = `database:${CONNECTION_ID}`
    expect(isScope(scope)).toBe(true)
    expect(isCredentialRecord(scope, { token: TOKEN })).toBe(true)

    const stored = await call('/encrypt', { scope, value: { token: TOKEN } })
    expect(stored.status).toBe(200)
    const { ciphertext } = (await stored.json()) as { ciphertext: string }
    expect(ciphertext).toMatch(/^v1\./)

    const opened = await call('/decrypt', { scope, ciphertext })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({ value: { token: TOKEN } })
  })

  it('will not open a token under another connection id', async () => {
    const scope = `database:${CONNECTION_ID}`
    const stored = await call('/encrypt', { scope, value: { token: TOKEN } })
    const { ciphertext } = (await stored.json()) as { ciphertext: string }
    const opened = await call('/decrypt', { scope: `database:${OTHER_ID}`, ciphertext })
    expect(opened.status).toBe(422)
  })

  it('only accepts a non-empty token field within the size bound', () => {
    const scope = `database:${CONNECTION_ID}`
    expect(isCredentialRecord(scope, { token: TOKEN })).toBe(true)
    expect(isCredentialRecord(scope, { secret: TOKEN })).toBe(false)
    expect(isCredentialRecord(scope, { token: '' })).toBe(false)
    expect(isCredentialRecord(scope, { token: 'x'.repeat(4 * 1024 + 1) })).toBe(false)
  })

  it('rejects malformed scopes', () => {
    for (const scope of [
      'database',
      'database:',
      'database:short',
      `database:${CONNECTION_ID}0`,
      `database:${CONNECTION_ID.slice(0, 25)}i`,
    ]) {
      expect(isScope(scope), scope).toBe(false)
    }
  })
})
