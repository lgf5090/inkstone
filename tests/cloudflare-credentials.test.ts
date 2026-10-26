// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  accountCredentialKey,
  readAccountCredentials,
  writeAccountCredentials,
} from '../src/worker/cloudflare/credentials'
import { makeCloudflareBed, seal } from './cloudflare-fixtures'
import { testBindings } from './doubles/bindings'

const ACCOUNT = 'a'.repeat(26)
const OTHER = 'b'.repeat(26)

describe('the R2 credential file', () => {
  it('stores ciphertext under cloudflare/txt/accounts/<id>.txt', async () => {
    const bed = await makeCloudflareBed()
    const stored = await writeAccountCredentials(bed.env, ACCOUNT, { api_token: 'super-secret-token' })
    expect(stored).toBe(true)
    const bytes = bed.files.objects.get(accountCredentialKey(ACCOUNT))
    expect(bytes).toBeDefined()
    const text = new TextDecoder().decode(bytes!)
    expect(text.startsWith('v1.')).toBe(true)
    expect(text.includes('super-secret-token')).toBe(false)
  })

  it('merges patches, clears a field with an empty string, and deletes the file when empty', async () => {
    const bed = await makeCloudflareBed()
    await writeAccountCredentials(bed.env, ACCOUNT, { api_token: 'token-1' })
    await writeAccountCredentials(bed.env, ACCOUNT, { password: 'login-pass' })
    expect(await readAccountCredentials(bed.env, ACCOUNT)).toEqual({ api_token: 'token-1', password: 'login-pass' })

    const stillThere = await writeAccountCredentials(bed.env, ACCOUNT, { password: '' })
    expect(stillThere).toBe(true)
    expect(await readAccountCredentials(bed.env, ACCOUNT)).toEqual({ api_token: 'token-1' })

    const hasAny = await writeAccountCredentials(bed.env, ACCOUNT, { api_token: '' })
    expect(hasAny).toBe(false)
    expect(bed.files.objects.has(accountCredentialKey(ACCOUNT))).toBe(false)
    expect(await readAccountCredentials(bed.env, ACCOUNT)).toBeNull()
  })

  it('refuses a bundle sealed for another account', async () => {
    const bed = await makeCloudflareBed()
    await bed.files.put(accountCredentialKey(ACCOUNT), seal(`cloudflare-account:${OTHER}`, { api_token: 'stolen' }))
    expect(await readAccountCredentials(bed.env, ACCOUNT)).toBeNull()
  })

  it('answers 503 when the deployment has no bucket, rather than falling back to plaintext', async () => {
    const bed = await makeCloudflareBed()
    const env = testBindings(bed.db)
    await expect(writeAccountCredentials(env, ACCOUNT, { api_token: 'x' })).rejects.toMatchObject({
      status: 503,
      code: 'storage_unavailable',
    })
    await expect(readAccountCredentials(env, ACCOUNT)).rejects.toMatchObject({ status: 503 })
  })
})
