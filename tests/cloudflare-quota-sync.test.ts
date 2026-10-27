// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  makeCloudflareBed,
  seedAccount,
  stubCloudflare,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'
import { utcDay } from '../src/worker/cloudflare/usage'

const ACCOUNT_A = 'a'.repeat(26)
const ACCOUNT_B = 'b'.repeat(26)
const ACCOUNT_C = 'c'.repeat(26)

interface QuotaBody {
  accounts: Array<{ account_id: string; resources: Array<{ resource: string; count: number }> }>
}

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let bed: CloudflareTestBed

beforeEach(async () => {
  bed = await makeCloudflareBed()
  mocks.userId = TEST_USER
})

function tokenOf(init?: RequestInit): string {
  const headers = (init?.headers ?? {}) as Record<string, string>
  return (headers.Authorization ?? '').replace(/^Bearer /, '')
}

describe('the quota sync wave', () => {
  it('asks for every account at once instead of one after another', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'ta', accountId: 'cf-a' })
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_B, name: 'Beta', token: 'tb', accountId: 'cf-b' })
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_C, name: 'Gamma', token: 'tc', accountId: 'cf-c' })

    let inFlight = 0
    let peak = 0
    stubCloudflare(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
      return Response.json({
        data: { viewer: { accounts: [{ total: [{ sum: { totalNeurons: 7 } }], byModel: [] }] } },
      })
    })

    const response = await bed.app.request('/api/cloudflare/quota', {}, bed.env)
    expect(response.status).toBe(200)
    // A serial walk over accounts and products holds the peak at one request at a time.
    expect(peak).toBeGreaterThan(1)
  })

  it('keeps the other accounts’ numbers when one account fails', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'ta', accountId: 'cf-a' })
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_B, name: 'Beta', token: 'tb', accountId: 'cf-b' })
    stubCloudflare(async (_url, init) => {
      if (tokenOf(init) === 'tb') return new Response('boom', { status: 500 })
      return Response.json({
        data: { viewer: { accounts: [{ total: [{ sum: { totalNeurons: 11 } }], byModel: [] }] } },
      })
    })

    const response = await bed.app.request('/api/cloudflare/quota', {}, bed.env)
    expect(response.status).toBe(200)
    const body = await response.json() as QuotaBody
    expect(body.accounts).toHaveLength(2)
    const alpha = body.accounts.find((account) => account.account_id === ACCOUNT_A)
    const beta = body.accounts.find((account) => account.account_id === ACCOUNT_B)
    expect(alpha?.resources.find((resource) => resource.resource === 'ai_neurons')?.count).toBe(11)
    expect(beta?.resources.find((resource) => resource.resource === 'ai_neurons')?.count ?? 0).toBe(0)
  })

  it('answers from the stored numbers and refreshes behind the response', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'ta', accountId: 'cf-a' })
    await bed.env.DB.prepare(
      `INSERT INTO cloudflare_quota_usage (user_id, account_id, resource, date, count)
       VALUES (?, ?, 'ai_neurons', ?, 42)`,
    )
      .bind(TEST_USER, ACCOUNT_A, utcDay())
      .run()
    let calls = 0
    stubCloudflare(async () => {
      calls += 1
      // A refresh nobody is waiting for: a blocking read would never answer.
      return new Promise<Response>(() => {})
    })

    const response = await bed.app.request('/api/cloudflare/quota', {}, bed.env)
    expect(response.status).toBe(200)
    const body = await response.json() as QuotaBody
    expect(body.accounts[0]?.resources.find((resource) => resource.resource === 'ai_neurons')?.count).toBe(42)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBeGreaterThan(0)
  })
})
