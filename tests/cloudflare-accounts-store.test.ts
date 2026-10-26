// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  accountHasFeature,
  createAccount,
  deleteAccount,
  getAccountRow,
  listAccounts,
  updateAccount,
} from '../src/worker/cloudflare/accounts'
import { readAccountCredentials } from '../src/worker/cloudflare/credentials'
import { makeCloudflareBed, seedAccount, stubCloudflare, TEST_USER, cfJson } from './cloudflare-fixtures'

const OTHER_USER = 'o'.repeat(26)

afterEach(() => vi.unstubAllGlobals())

function stubHappyCloudflare(): void {
  stubCloudflare((url) => {
    if (url.pathname.endsWith('/user')) return cfJson({ id: 'user-1' })
    if (url.pathname.endsWith('/accounts')) return cfJson([{ id: 'cf-account-1' }])
    if (url.pathname.includes('/r2/buckets')) return cfJson([])
    return new Response('not found', { status: 404 })
  })
}

describe('the account store', () => {
  it('creates an account: verifies, writes the credential file, detects the account id, probes R2', async () => {
    const bed = await makeCloudflareBed()
    stubHappyCloudflare()
    const created = await createAccount(bed.env, TEST_USER, {
      name: 'Personal',
      auth_type: 'token',
      api_token: 'token-abc',
    })
    expect(created.name).toBe('Personal')
    expect(created.cf_account_id).toBe('cf-account-1')
    expect(created.available_features).toBe('r2')
    expect(created.has_credentials).toBe(1)
    expect(await readAccountCredentials(bed.env, created.id)).toEqual({ api_token: 'token-abc' })
    expect(bed.files.objects.has(`cloudflare/txt/accounts/${created.id}.txt`)).toBe(true)
  })

  it('refuses a credential Cloudflare does not accept, and writes nothing', async () => {
    const bed = await makeCloudflareBed()
    stubCloudflare(() => Response.json({ success: false, errors: [{ message: 'Invalid API Token' }] }, { status: 403 }))
    await expect(createAccount(bed.env, TEST_USER, {
      name: 'Bad',
      auth_type: 'token',
      api_token: 'nope',
    })).rejects.toMatchObject({ status: 400 })
    const rows = await bed.env.DB.prepare('SELECT count(*) AS n FROM cloudflare_account').first<{ n: number }>()
    expect(rows?.n).toBe(0)
    expect([...bed.files.objects.keys()]).toEqual([])
  })

  it('keeps the stored token when an edit does not mention it', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER, { token: 'keep-me' })
    await updateAccount(bed.env, TEST_USER, id, { name: 'Renamed' })
    expect(await readAccountCredentials(bed.env, id)).toEqual({ api_token: 'keep-me' })
    expect((await getAccountRow(bed.env, TEST_USER, id))?.name).toBe('Renamed')
  })

  it('clears the file and the flag when the token is emptied', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    const updated = await updateAccount(bed.env, TEST_USER, id, { api_token: '' })
    expect(updated.has_credentials).toBe(0)
    expect(bed.files.objects.has(`cloudflare/txt/accounts/${id}.txt`)).toBe(false)
  })

  it('deletes the row and the credential file together', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    await deleteAccount(bed.env, TEST_USER, id)
    expect(await getAccountRow(bed.env, TEST_USER, id)).toBeNull()
    expect(bed.files.objects.has(`cloudflare/txt/accounts/${id}.txt`)).toBe(false)
  })

  it('never shows one reader another reader’s accounts', async () => {
    const bed = await makeCloudflareBed()
    await seedAccount(bed, TEST_USER, { id: 'a'.repeat(26), name: 'Mine' })
    await seedAccount(bed, OTHER_USER, { id: 'b'.repeat(26), name: 'Theirs' })
    const page = await listAccounts(bed.env, TEST_USER)
    expect(page.accounts.map((account) => account.name)).toEqual(['Mine'])
    expect(page.counts.all).toBe(1)
    await expect(getAccountRow(bed.env, TEST_USER, 'b'.repeat(26))).resolves.toBeNull()
    await expect(deleteAccount(bed.env, TEST_USER, 'b'.repeat(26))).rejects.toMatchObject({ status: 404 })
  })

  it('filters and searches without leaking the other filter’s rows', async () => {
    const bed = await makeCloudflareBed()
    await seedAccount(bed, TEST_USER, { id: 'a'.repeat(26), name: 'Alpha', active: true })
    await seedAccount(bed, TEST_USER, { id: 'b'.repeat(26), name: 'Beta', accountId: null })
    const unverified = await listAccounts(bed.env, TEST_USER, { filter: 'unverified' })
    expect(unverified.accounts.map((account) => account.name)).toEqual(['Beta'])
    const searched = await listAccounts(bed.env, TEST_USER, { search: 'Alp' })
    expect(searched.accounts.map((account) => account.name)).toEqual(['Alpha'])
    expect(searched.counts).toEqual({ all: 2, active: 2, unverified: 1 })
  })

  it('reads feature switches with the reference module’s default', () => {
    expect(accountHasFeature({ enabled_features: '' }, 'ai')).toBe(true)
    expect(accountHasFeature({ enabled_features: 'dns' }, 'ai')).toBe(false)
    expect(accountHasFeature({ enabled_features: 'ai,storage' }, 'storage')).toBe(true)
  })
})
