// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The routes call `requireAuth`; this file's fake session is the one the fixtures mount.
const mocks = vi.hoisted(() => ({ userId: 'u'.repeat(26) }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
  requireOwner: async (_c: unknown, next: () => Promise<void>) => {
    await next()
  },
}))

import { readAccountCredentials } from '../src/worker/cloudflare/credentials'
import {
  accountCredentialPath,
  cfJson,
  makeCloudflareBed,
  readJson,
  seedAccount,
  stubCloudflare,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'

const OTHER_USER = 'o'.repeat(26)
const FIRST = 'a'.repeat(26)
const SECOND = 'b'.repeat(26)
const THIRD = 'c'.repeat(26)

let bed: CloudflareTestBed

beforeEach(async () => {
  mocks.userId = TEST_USER
  bed = await makeCloudflareBed()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const url = path === '/' ? '/api/cloudflare/accounts' : `/api/cloudflare/accounts${path}`
  return bed.app.request(url, init, bed.env)
}

async function sendForm(path: string, form: FormData): Promise<Response> {
  return bed.app.request(`/api/cloudflare/accounts${path}`, { method: 'POST', body: form }, bed.env)
}

function stubHappyCloudflare(rejectedTokens: readonly string[] = []): void {
  stubCloudflare((url, init) => {
    const headers = new Headers(init?.headers)
    const token = headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? headers.get('X-Auth-Key') ?? ''
    if (url.pathname.endsWith('/user')) {
      if (rejectedTokens.includes(token)) {
        return Response.json({ success: false, errors: [{ message: 'Invalid API Token' }] }, { status: 403 })
      }
      return cfJson({ id: 'user-1' })
    }
    if (url.pathname.endsWith('/accounts')) return cfJson([{ id: 'cf-account-1' }])
    if (url.pathname.includes('/r2/buckets')) return cfJson([])
    return new Response('not found', { status: 404 })
  })
}

async function auditActions(): Promise<string[]> {
  const rows = await bed.env.DB.prepare(
    'SELECT action FROM cloudflare_log WHERE user_id = ? ORDER BY created_at ASC, action ASC',
  )
    .bind(TEST_USER)
    .all<{ action: string }>()
  return (rows.results ?? []).map((row) => row.action)
}

interface AccountPageBody {
  accounts: Array<{ id: string; name: string; is_demo: boolean }>
  total: number
  counts: { all: number; active: number; unverified: number }
  quota: Array<{ account_id: string }>
}

describe('GET /accounts', () => {
  it('paginates, filters and searches within one reader', async () => {
    await seedAccount(bed, TEST_USER, { id: FIRST, name: 'Alpha', accountId: 'cf-a' })
    await seedAccount(bed, TEST_USER, { id: SECOND, name: 'Beta', accountId: null })
    await seedAccount(bed, TEST_USER, { id: THIRD, name: 'Gamma', active: false })

    const paged = await readJson<AccountPageBody>(await send('GET', '?page=1&pageSize=2'))
    expect(paged.total).toBe(3)
    expect(paged.accounts).toHaveLength(2)
    expect(paged.counts).toEqual({ all: 3, active: 2, unverified: 1 })
    expect(paged.quota).toHaveLength(2)

    const secondPage = await readJson<AccountPageBody>(await send('GET', '?page=2&pageSize=2'))
    expect(secondPage.accounts).toHaveLength(1)
    expect(secondPage.total).toBe(3)

    const unverified = await readJson<AccountPageBody>(await send('GET', '?filter=unverified'))
    expect(unverified.accounts.map((account) => account.name)).toEqual(['Beta'])

    const active = await readJson<AccountPageBody>(await send('GET', '?filter=active'))
    expect(active.accounts.map((account) => account.name).sort()).toEqual(['Alpha', 'Beta'])

    const searched = await readJson<AccountPageBody>(await send('GET', '?search=Gam'))
    expect(searched.accounts.map((account) => account.name)).toEqual(['Gamma'])
  })
})

describe('POST /accounts', () => {
  it('verifies, writes the sealed file, detects the account id and probes R2', async () => {
    stubHappyCloudflare()
    const response = await send('POST', '/', { name: 'Personal', auth_type: 'token', api_token: 'tok-1' })
    expect(response.status).toBe(201)
    const account = await readJson<{
      id: string
      cf_account_id: string | null
      available_features: string
      has_credentials: number
    }>(response)
    expect(account.cf_account_id).toBe('cf-account-1')
    expect(account.available_features).toBe('r2')
    expect(account.has_credentials).toBe(1)
    expect(bed.files.objects.has(accountCredentialPath(account.id))).toBe(true)
    expect(await readAccountCredentials(bed.env, account.id)).toEqual({ api_token: 'tok-1' })
    expect(await auditActions()).toEqual(['create_account'])
  })

  it('refuses a credential Cloudflare rejects and writes nothing', async () => {
    stubCloudflare(() => Response.json(
      { success: false, errors: [{ message: 'Invalid API Token' }] },
      { status: 403 },
    ))
    const response = await send('POST', '/', { name: 'Bad', auth_type: 'token', api_token: 'nope' })
    expect(response.status).toBe(400)
    const rows = await bed.env.DB.prepare('SELECT count(*) AS n FROM cloudflare_account').first<{ n: number }>()
    expect(rows?.n).toBe(0)
    expect([...bed.files.objects.keys()]).toEqual([])
  })
})

describe('PUT /accounts/:id', () => {
  it('keeps the stored token when the edit does not mention it, and clears it when emptied', async () => {
    const { id } = await seedAccount(bed, TEST_USER, { token: 'keep-me' })

    const renamed = await send('PUT', `/${id}`, { name: 'Renamed' })
    expect(renamed.status).toBe(200)
    expect((await readJson<{ name: string }>(renamed)).name).toBe('Renamed')
    expect(await readAccountCredentials(bed.env, id)).toEqual({ api_token: 'keep-me' })

    const cleared = await send('PUT', `/${id}`, { api_token: '' })
    expect(cleared.status).toBe(200)
    expect(await readAccountCredentials(bed.env, id)).toBeNull()
    expect(bed.files.objects.has(accountCredentialPath(id))).toBe(false)
    expect(await auditActions()).toEqual(['update_account', 'update_account'])
  })
})

describe('GET /accounts/:id/credentials', () => {
  it('decrypts the bundle and records the view without the secret', async () => {
    const { id } = await seedAccount(bed, TEST_USER, { token: 'secret-token' })
    const response = await send('GET', `/${id}/credentials`)
    expect(response.status).toBe(200)
    const credentials = await readJson<{ api_token: string; api_key: string | null; password: string | null }>(response)
    expect(credentials.api_token).toBe('secret-token')
    expect(credentials.api_key).toBeNull()
    expect(credentials.password).toBeNull()

    const logs = await bed.env.DB.prepare(
      'SELECT action, detail FROM cloudflare_log WHERE user_id = ?',
    )
      .bind(TEST_USER)
      .all<{ action: string; detail: string | null }>()
    expect(logs.results).toEqual([{ action: 'view_credentials', detail: 'auth_type=token' }])
    expect(JSON.stringify(logs.results)).not.toContain('secret-token')
  })
})

describe('DELETE /accounts/:id', () => {
  it('removes the credential file and the row together', async () => {
    const { id } = await seedAccount(bed, TEST_USER)
    const response = await send('DELETE', `/${id}`)
    expect(response.status).toBe(200)
    expect(bed.files.objects.has(accountCredentialPath(id))).toBe(false)
    const row = await bed.env.DB.prepare('SELECT id FROM cloudflare_account WHERE id = ?').bind(id).first()
    expect(row).toBeNull()
    expect(await auditActions()).toEqual(['delete_account'])
  })
})

describe('POST /accounts/:id/test', () => {
  it('re-verifies and stores what the credential can reach', async () => {
    stubHappyCloudflare()
    const { id } = await seedAccount(bed, TEST_USER, { token: 'test-token', accountId: 'cf-existing' })
    const response = await send('POST', `/${id}/test`)
    expect(response.status).toBe(200)
    expect(await readJson<{ ok: boolean; cf_account_id: string; available_features: string }>(response)).toEqual({
      ok: true,
      cf_account_id: 'cf-existing',
      available_features: 'r2',
    })
    const row = await bed.env.DB.prepare(
      'SELECT available_features FROM cloudflare_account WHERE id = ?',
    )
      .bind(id)
      .first<{ available_features: string }>()
    expect(row?.available_features).toBe('r2')
    expect(await auditActions()).toEqual(['test_account'])
  })

  it('answers 404 for another reader’s account', async () => {
    const { id } = await seedAccount(bed, OTHER_USER, { id: 'z'.repeat(26) })
    expect((await send('POST', `/${id}/test`)).status).toBe(404)
  })
})

describe('POST /accounts/import-csv', () => {
  it('dedupes, extracts the name and keeps a failed row from stopping the rest', async () => {
    stubHappyCloudflare(['key-3'])
    const csv = [
      'email,apiKey,password',
      'lauren.bailey2701@x,key-1,pw',
      'lauren.bailey2701@x,key-2,',
      'not-an-email,key-3,',
      'second@y,key-3,',
    ].join('\n')
    const form = new FormData()
    form.append('file', new File([csv], 'accounts.csv', { type: 'text/csv' }))
    const response = await sendForm('/import-csv', form)
    expect(response.status).toBe(200)
    const body = await readJson<{
      summary: { total: number; success: number; skipped: number; error: number }
      results: Array<{ email: string; name: string; status: string; message?: string }>
    }>(response)
    expect(body.summary).toEqual({ total: 4, success: 1, skipped: 1, error: 2 })
    expect(body.results[0]).toMatchObject({ email: 'lauren.bailey2701@x', name: 'bailey2701', status: 'success' })
    expect(body.results[1]).toMatchObject({ status: 'skipped' })
    expect(body.results[2]).toMatchObject({ status: 'error' })
    expect(body.results[3]).toMatchObject({ status: 'error' })

    const created = await bed.env.DB.prepare(
      'SELECT name, cf_account_id, has_credentials FROM cloudflare_account WHERE user_id = ?',
    )
      .bind(TEST_USER)
      .all<{ name: string; cf_account_id: string | null; has_credentials: number }>()
    expect(created.results).toEqual([{ name: 'bailey2701', cf_account_id: 'cf-account-1', has_credentials: 1 }])
    expect(await auditActions()).toEqual(['create_account'])
  })

  it('imports without calling Cloudflare when skipVerify is set', async () => {
    stubCloudflare(() => {
      throw new Error('skipVerify must not call Cloudflare')
    })
    const form = new FormData()
    form.append('file', new File(['email,apiKey\nskip@example.com,key-4'], 'accounts.csv', { type: 'text/csv' }))
    form.append('skipVerify', '1')
    const response = await sendForm('/import-csv', form)
    expect(response.status).toBe(200)
    const body = await readJson<{ summary: { success: number } }>(response)
    expect(body.summary.success).toBe(1)
    const row = await bed.env.DB.prepare(
      'SELECT cf_account_id, has_credentials, name FROM cloudflare_account WHERE user_id = ?',
    )
      .bind(TEST_USER)
      .first<{ cf_account_id: string | null; has_credentials: number; name: string }>()
    expect(row).toEqual({ cf_account_id: null, has_credentials: 1, name: 'skip' })
  })

  it('rejects a file without the required header', async () => {
    const form = new FormData()
    form.append('file', new File(['name,key\nA,b'], 'accounts.csv', { type: 'text/csv' }))
    const response = await sendForm('/import-csv', form)
    expect(response.status).toBe(400)
  })
})

describe('batch endpoints', () => {
  it('sets features and deletes in one call, reporting each account', async () => {
    await seedAccount(bed, TEST_USER, { id: FIRST, name: 'One' })
    await seedAccount(bed, TEST_USER, { id: SECOND, name: 'Two' })

    const features = await send('POST', '/batch/features', { ids: [FIRST, SECOND], enabled_features: 'ai,dns' })
    expect(features.status).toBe(200)
    const featuresBody = await readJson<{ summary: { total: number; success: number } }>(features)
    expect(featuresBody.summary).toMatchObject({ total: 2, success: 2 })
    const enabled = await bed.env.DB.prepare(
      'SELECT enabled_features FROM cloudflare_account WHERE id = ?',
    )
      .bind(FIRST)
      .first<{ enabled_features: string }>()
    expect(enabled?.enabled_features).toBe('ai,dns')

    const deleted = await send('POST', '/batch/delete', { ids: [SECOND, 'm'.repeat(26)] })
    expect(deleted.status).toBe(200)
    const deletedBody = await readJson<{ summary: { success: number; error: number } }>(deleted)
    expect(deletedBody.summary).toMatchObject({ success: 1, error: 1 })
    expect(bed.files.objects.has(accountCredentialPath(SECOND))).toBe(false)
    expect(bed.files.objects.has(accountCredentialPath(FIRST))).toBe(true)
  })

  it('tests unverified accounts and refreshes their account id', async () => {
    stubHappyCloudflare()
    const { id } = await seedAccount(bed, TEST_USER, { id: THIRD, token: 'test-token', accountId: null })
    const response = await send('POST', '/test-batch', { onlyUnverified: true })
    expect(response.status).toBe(200)
    const body = await readJson<{
      summary: { total: number; success: number; error: number; skipped: number }
      results: Array<{ id: string; status: string }>
    }>(response)
    expect(body.summary).toEqual({ total: 1, success: 1, skipped: 0, error: 0 })
    expect(body.results[0]).toMatchObject({ id, status: 'success' })
    const row = await bed.env.DB.prepare(
      'SELECT cf_account_id FROM cloudflare_account WHERE id = ?',
    )
      .bind(id)
      .first<{ cf_account_id: string | null }>()
    expect(row?.cf_account_id).toBe('cf-account-1')
  })

  it('skips every proxy row with the Workers reason and writes no setting', async () => {
    await seedAccount(bed, TEST_USER, { id: FIRST })
    const response = await send('POST', '/batch/proxy', { ids: [FIRST] })
    expect(response.status).toBe(200)
    const body = await readJson<{
      summary: { total: number; success: number; skipped: number; error: number }
      results: Array<{ status: string; message: string }>
    }>(response)
    expect(body.summary).toEqual({ total: 1, success: 0, skipped: 1, error: 0 })
    expect(body.results[0]).toMatchObject({ status: 'skipped' })
    expect(body.results[0]?.message).toContain('Workers')
    const settings = await bed.env.DB.prepare('SELECT count(*) AS n FROM cloudflare_setting').first<{ n: number }>()
    expect(settings?.n).toBe(0)
  })
})

describe('ownership', () => {
  it('answers 404, never 403, for every per-account route of another reader', async () => {
    const { id } = await seedAccount(bed, OTHER_USER, { id: 'z'.repeat(26), token: 'theirs' })

    expect((await send('GET', `/${id}/credentials`)).status).toBe(404)
    expect((await send('PUT', `/${id}`, { name: 'Mine now' })).status).toBe(404)
    expect((await send('PATCH', `/${id}/features`, { enabled_features: 'ai' })).status).toBe(404)
    expect((await send('POST', `/${id}/clear-exhausted`)).status).toBe(404)
    expect((await send('DELETE', `/${id}`)).status).toBe(404)
    expect((await send('POST', `/${id}/test`)).status).toBe(404)

    const row = await bed.env.DB.prepare('SELECT name FROM cloudflare_account WHERE id = ?')
      .bind(id)
      .first<{ name: string }>()
    expect(row?.name).toBe('Test account')
  })

  it('does not reveal another reader’s account through a batch call', async () => {
    const { id } = await seedAccount(bed, OTHER_USER, { id: 'y'.repeat(26) })
    const response = await send('POST', '/batch/features', { ids: [id], enabled_features: 'ai' })
    const body = await readJson<{ summary: { error: number }; results: Array<{ status: string }> }>(response)
    expect(body.summary.error).toBe(1)
    expect(body.results[0]?.status).toBe('error')
  })
})
