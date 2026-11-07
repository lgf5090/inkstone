// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { CredentialVault, isCredentialRecord, isScope } from '../src/worker/durable/credential-vault'
import type { Env } from '../src/worker/env'
import { decryptWebsshSecret, encryptWebsshSecret } from '../src/worker/lib/crypto'
import { newId } from '../src/worker/lib/id'
import { testBindings, testD1, testDurableObjectNamespace } from './doubles/bindings'

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

function makeEnv(): Env {
  return testBindings(testD1(), {
    CREDENTIAL_VAULT: testDurableObjectNamespace((request) =>
      new CredentialVault(vaultState()).fetch(request),
    ),
  })
}

beforeEach(() => {
  vaultStorage.clear()
})

describe('the WebSSH credential scope', () => {
  it('accepts only a webssh scope and its three known fields', () => {
    const id = newId()
    expect(isScope(`webssh:${id}`)).toBe(true)
    expect(isScope(`webssh:${id.slice(0, 25)}`)).toBe(false)
    expect(isCredentialRecord(`webssh:${id}`, { password: 'secret' })).toBe(true)
    expect(isCredentialRecord(`webssh:${id}`, { privateKey: 'key', passphrase: 'pass' })).toBe(true)
    expect(isCredentialRecord(`webssh:${id}`, { unknown: 'nope' })).toBe(false)
    expect(isCredentialRecord(`webssh:${id}`, { password: '' })).toBe(false)
    expect(isCredentialRecord(`webssh:${id}`, { password: 'x'.repeat(17 * 1024) })).toBe(false)
  })

  it('writes ciphertext, never the plaintext, and reads it back by row id', async () => {
    const env = makeEnv()
    const id = newId()
    const ciphertext = await encryptWebsshSecret(env, id, {
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
      passphrase: 'unlock-me',
    })
    expect(ciphertext.startsWith('v1.')).toBe(true)
    expect(ciphertext).not.toContain('BEGIN OPENSSH')
    expect(ciphertext).not.toContain('unlock-me')

    const opened = await decryptWebsshSecret(env, id, ciphertext)
    expect(opened).toEqual({
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
      passphrase: 'unlock-me',
    })
  })

  it('refuses to decrypt a ciphertext under another row id', async () => {
    const env = makeEnv()
    const id = newId()
    const other = newId()
    const ciphertext = await encryptWebsshSecret(env, id, { password: 'secret' })
    expect(await decryptWebsshSecret(env, other, ciphertext)).toBeNull()
  })

  it('rejects an empty or over-wide record before it reaches the vault', async () => {
    const env = makeEnv()
    const id = newId()
    await expect(encryptWebsshSecret(env, id, {})).rejects.toThrow('invalid_webssh_credential')
    const overWide = { password: 'secret', privateKey: 'key', passphrase: 'pass', extra: 'nope' }
    await expect(encryptWebsshSecret(env, id, overWide)).rejects.toThrow('invalid_webssh_credential')
  })
})
