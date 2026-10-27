// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cfJson,
  makeCloudflareBed,
  readJson,
  seedAccount,
  stubCloudflare,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'

const OTHER_USER = 'o'.repeat(26)
/** seedAccount's default Cloudflare account id. */
const CF_ACCOUNT = 'b'.repeat(32)

const mocks = vi.hoisted(() => ({ userId: 'u'.repeat(26) }))
vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

interface GraphqlBody {
  query: string
  variables: Record<string, string>
}

interface ErrorBody {
  error: { code: string; message: string }
}

interface ResourcesBody {
  accountId: string
  counts: Array<{ key: string; count: number | null }>
  usage: Array<{ key: string; value: number | null; limit: number; isBytes: boolean }>
}

interface TrafficBody {
  zoneId: string
  zoneName: string
  granularity: 'hour' | 'day'
  labels: string[]
  series: {
    requests: number[]
    visitors: number[]
    pageViews: number[]
    bytes: number[]
  }
}

interface AuditBody {
  logs: Array<{
    id: string
    account_name: string | null
    action: string
    target: string | null
    detail: string | null
    status: string
    created_at: number
  }>
  total: number
  actions: string[]
}

function graphqlBody(init?: RequestInit): GraphqlBody {
  return JSON.parse(String(init?.body)) as GraphqlBody
}

function countsOf(body: ResourcesBody): Record<string, number | null> {
  return Object.fromEntries(body.counts.map((row) => [row.key, row.count]))
}

function valuesOf(body: ResourcesBody): Record<string, number | null> {
  return Object.fromEntries(body.usage.map((row) => [row.key, row.value]))
}

let logSequence = 0

async function seedLog(
  bed: CloudflareTestBed,
  userId: string,
  row: {
    action: string
    accountId: string | null
    target?: string
    detail?: string
    status?: 'success' | 'error'
    createdAt: number
  },
): Promise<void> {
  logSequence += 1
  await bed.env.DB.prepare(
    `INSERT INTO cloudflare_log (id, user_id, account_id, action, target, detail, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `log-${logSequence}`,
      userId,
      row.accountId,
      row.action,
      row.target ?? null,
      row.detail ?? null,
      row.status ?? 'success',
      row.createdAt,
    )
    .run()
}

beforeEach(() => {
  mocks.userId = TEST_USER
  logSequence = 0
})

afterEach(() => vi.unstubAllGlobals())

describe('the dashboard resources endpoint', () => {
  it('maps every product, filters zones to the account, and leaves a failing product without a number', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    const graphqlCalls: GraphqlBody[] = []
    let dnsCalls = 0

    stubCloudflare((url, init) => {
      const path = url.pathname
      if (path.endsWith('/graphql')) {
        const body = graphqlBody(init)
        graphqlCalls.push(body)
        if (body.query.includes('CfWorkersRequestsToday')) {
          return Response.json({ data: { viewer: { accounts: [{
            workersInvocationsAdaptive: [{ sum: { requests: 120 } }],
          }] } } })
        }
        if (body.query.includes('CfKvReadsToday')) {
          return Response.json({ data: { viewer: { accounts: [{
            kvOperationsAdaptiveGroups: [
              { sum: { requests: 7 }, dimensions: { actionType: 'read' } },
              { sum: { requests: 99 }, dimensions: { actionType: 'write' } },
            ],
          }] } } })
        }
        if (body.query.includes('CfD1WritesToday')) {
          return Response.json({ data: { viewer: { accounts: [{
            d1AnalyticsAdaptiveGroups: [{ sum: { writeQueries: 3 } }],
          }] } } })
        }
        if (body.query.includes('CfR2Storage')) {
          return Response.json({ data: { viewer: { accounts: [{
            r2StorageAdaptiveGroups: [
              { dimensions: { bucketName: 'one', datetime: '2026-10-26T00:00:00Z' }, max: { payloadSize: 100 } },
              { dimensions: { bucketName: 'one', datetime: '2026-10-27T00:00:00Z' }, max: { payloadSize: 200 } },
              { dimensions: { bucketName: 'two', datetime: '2026-10-27T00:00:00Z' }, max: { payloadSize: 50 } },
            ],
          }] } } })
        }
        return new Response('unknown query', { status: 400 })
      }
      if (path.endsWith('/client/v4/zones')) {
        return cfJson([
          { id: 'z1', name: 'example.com', account: { id: CF_ACCOUNT } },
          { id: 'z2', name: 'other.com', account: { id: 'elsewhere' } },
        ])
      }
      if (path.includes('/dns_records')) {
        dnsCalls += 1
        return Response.json({ success: true, errors: [], result: [], result_info: { total_count: 5 } })
      }
      if (path.endsWith('/workers/scripts')) return cfJson([{}, {}])
      if (path.endsWith('/pages/projects')) return cfJson([{}])
      if (path.endsWith('/r2/buckets')) {
        return Response.json({ success: true, errors: [], result: { buckets: [{}] } })
      }
      if (path.endsWith('/storage/kv/namespaces')) return cfJson([{}, {}, {}])
      if (path.endsWith('/d1/database')) return new Response('d1 unavailable', { status: 500 })
      return new Response('not found', { status: 404 })
    })

    const response = await bed.app.request(
      `/api/cloudflare/dashboard/resources?accountId=${id}`,
      {},
      bed.env,
    )
    expect(response.status).toBe(200)
    const body = await readJson<ResourcesBody>(response)
    expect(countsOf(body)).toEqual({
      domains: 1,
      workers: 2,
      pages: 1,
      dns: 5,
      r2: 1,
      kv: 3,
      d1: null,
    })
    expect(valuesOf(body)).toEqual({
      workers_requests: 120,
      kv_reads: 7,
      d1_writes: 3,
      r2_storage: 250,
    })
    expect(dnsCalls).toBe(1)

    expect(graphqlCalls).toHaveLength(4)
    const workers = graphqlCalls.find((call) => call.query.includes('CfWorkersRequestsToday'))
    expect(workers).toBeDefined()
    expect(workers?.variables.accountTag).toBe(CF_ACCOUNT)
    expect(workers?.query).toContain('workersInvocationsAdaptive')
    expect(workers?.query).toContain('datetime_geq: $start')
    expect(Date.parse(workers?.variables.start ?? '')).toBeLessThanOrEqual(
      Date.parse(workers?.variables.end ?? ''),
    )
  })

  it('answers 404 for another reader’s account and 400 when the Cloudflare account id is missing', async () => {
    const bed = await makeCloudflareBed()
    const other = await seedAccount(bed, OTHER_USER, { id: 'o'.repeat(26) })
    const missing = await seedAccount(bed, TEST_USER, { id: 'm'.repeat(26), accountId: null })
    stubCloudflare(() => {
      throw new Error('no Cloudflare call should be made')
    })

    const foreign = await bed.app.request(
      `/api/cloudflare/dashboard/resources?accountId=${other.id}`,
      {},
      bed.env,
    )
    expect(foreign.status).toBe(404)

    const noAccountId = await bed.app.request(
      `/api/cloudflare/dashboard/resources?accountId=${missing.id}`,
      {},
      bed.env,
    )
    expect(noAccountId.status).toBe(400)
    expect((await readJson<ErrorBody>(noAccountId)).error.code).toBe('cloudflare_not_configured')
  })
})

describe('the dashboard traffic endpoint', () => {
  it('maps hourly adaptive groups into labels and the four series', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    const graphqlCalls: GraphqlBody[] = []

    stubCloudflare((url, init) => {
      if (url.pathname.endsWith('/zones/zone-1')) {
        return cfJson({ id: 'zone-1', name: 'example.com', account: { id: CF_ACCOUNT } })
      }
      if (url.pathname.endsWith('/graphql')) {
        graphqlCalls.push(graphqlBody(init))
        return Response.json({ data: { viewer: { zones: [{
          httpRequests1hGroups: [
            {
              dimensions: { datetime: '2026-10-27T09:00:00Z' },
              sum: { requests: 20, pageViews: 8, bytes: 200 },
              uniq: { uniques: 4 },
            },
            {
              dimensions: { datetime: '2026-10-27T08:00:00Z' },
              sum: { requests: 10, pageViews: 3, bytes: 100 },
              uniq: { uniques: 2 },
            },
          ],
        }] } } })
      }
      return new Response('not found', { status: 404 })
    })

    const response = await bed.app.request(
      `/api/cloudflare/dashboard/traffic?accountId=${id}&zoneId=zone-1&days=1`,
      {},
      bed.env,
    )
    expect(response.status).toBe(200)
    const body = await readJson<TrafficBody>(response)
    expect(body.granularity).toBe('hour')
    expect(body.labels).toEqual(['08:00', '09:00'])
    expect(body.series).toEqual({
      requests: [10, 20],
      visitors: [2, 4],
      pageViews: [3, 8],
      bytes: [100, 200],
    })
    const graphql = graphqlCalls[0]
    expect(graphql?.query).toContain('httpRequests1hGroups')
    expect(graphql?.variables.zoneTag).toBe('zone-1')
    expect(Date.parse(graphql?.variables.since ?? '')).toBeLessThan(
      Date.parse(graphql?.variables.until ?? ''),
    )
  })

  it('uses day labels for a multi-day window', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    const graphqlCalls: GraphqlBody[] = []

    stubCloudflare((url, init) => {
      if (url.pathname.endsWith('/zones/zone-1')) {
        return cfJson({ id: 'zone-1', name: 'example.com', account: { id: CF_ACCOUNT } })
      }
      if (url.pathname.endsWith('/graphql')) {
        graphqlCalls.push(graphqlBody(init))
        return Response.json({ data: { viewer: { zones: [{
          httpRequests1dGroups: [
            {
              dimensions: { date: '2026-10-26' },
              sum: { requests: 5, pageViews: 1, bytes: 50 },
              uniq: { uniques: 1 },
            },
            {
              dimensions: { date: '2026-10-27' },
              sum: { requests: 6, pageViews: 2, bytes: 60 },
              uniq: { uniques: 2 },
            },
          ],
        }] } } })
      }
      return new Response('not found', { status: 404 })
    })

    const response = await bed.app.request(
      `/api/cloudflare/dashboard/traffic?accountId=${id}&zoneId=zone-1&days=7`,
      {},
      bed.env,
    )
    expect(response.status).toBe(200)
    const body = await readJson<TrafficBody>(response)
    expect(body.granularity).toBe('day')
    expect(body.labels).toEqual(['10-26', '10-27'])
    const graphql = graphqlCalls[0]
    expect(graphql?.query).toContain('httpRequests1dGroups')
    expect(graphql?.query).toContain('dimensions { date }')
    expect(graphql?.query).toContain('orderBy: [date_ASC]')
  })

  it('refuses a zone that belongs to a different account without asking GraphQL', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    let graphqlCalls = 0

    stubCloudflare((url) => {
      if (url.pathname.endsWith('/zones/zone-1')) {
        return cfJson({ id: 'zone-1', name: 'example.com', account: { id: 'another-account' } })
      }
      if (url.pathname.endsWith('/graphql')) {
        graphqlCalls += 1
        return Response.json({ data: { viewer: { zones: [] } } })
      }
      return new Response('not found', { status: 404 })
    })

    const response = await bed.app.request(
      `/api/cloudflare/dashboard/traffic?accountId=${id}&zoneId=zone-1&days=7`,
      {},
      bed.env,
    )
    expect(response.status).toBe(404)
    expect(graphqlCalls).toBe(0)
  })
})

describe('the audit log endpoint', () => {
  it('filters, sorts and pages the reader’s own rows and joins the account name', async () => {
    const bed = await makeCloudflareBed()
    const mine = await seedAccount(bed, TEST_USER, { id: 'a'.repeat(26), name: 'Mine' })
    const second = await seedAccount(bed, TEST_USER, { id: 'c'.repeat(26), name: 'Second' })
    const theirAccount = await seedAccount(bed, OTHER_USER, { id: 'd'.repeat(26), name: 'Theirs' })

    await seedLog(bed, TEST_USER, {
      action: 'deploy_worker',
      accountId: mine.id,
      target: 'worker-a',
      detail: 'deployed ok',
      createdAt: Date.UTC(2026, 0, 1, 10),
    })
    await seedLog(bed, TEST_USER, {
      action: 'create_dns',
      accountId: second.id,
      target: 'example.com',
      detail: 'created A',
      createdAt: Date.UTC(2026, 0, 2, 10),
    })
    await seedLog(bed, TEST_USER, {
      action: 'deploy_worker',
      accountId: mine.id,
      target: 'worker-b',
      detail: 'failed',
      status: 'error',
      createdAt: Date.UTC(2026, 0, 3, 10),
    })
    await seedLog(bed, OTHER_USER, {
      action: 'delete_worker',
      accountId: theirAccount.id,
      target: 'their-worker',
      createdAt: Date.UTC(2026, 0, 4, 10),
    })

    const first = await bed.app.request(
      '/api/cloudflare/audit-log?action=deploy_worker&pageSize=1&page=1&sort=created_at',
      {},
      bed.env,
    )
    expect(first.status).toBe(200)
    const firstPage = await readJson<AuditBody>(first)
    expect(firstPage.total).toBe(2)
    expect(firstPage.logs).toHaveLength(1)
    expect(firstPage.logs[0]?.target).toBe('worker-a')
    expect(firstPage.logs[0]?.account_name).toBe('Mine')
    expect(firstPage.actions).toEqual(['create_dns', 'deploy_worker'])

    const secondPage = await readJson<AuditBody>(await bed.app.request(
      '/api/cloudflare/audit-log?action=deploy_worker&pageSize=1&page=2&sort=created_at',
      {},
      bed.env,
    ))
    expect(secondPage.logs[0]?.target).toBe('worker-b')

    const searched = await readJson<AuditBody>(await bed.app.request(
      '/api/cloudflare/audit-log?q=example',
      {},
      bed.env,
    ))
    expect(searched.total).toBe(1)
    expect(searched.logs[0]?.action).toBe('create_dns')

    const dated = await readJson<AuditBody>(await bed.app.request(
      '/api/cloudflare/audit-log?from=2026-01-02&to=2026-01-02',
      {},
      bed.env,
    ))
    expect(dated.total).toBe(1)
    expect(dated.logs[0]?.target).toBe('example.com')

    const actions = await readJson<{ actions: string[] }>(await bed.app.request(
      '/api/cloudflare/audit-log/actions',
      {},
      bed.env,
    ))
    expect(actions.actions).toEqual(['create_dns', 'deploy_worker'])
  })

  it('never returns another reader’s rows or actions', async () => {
    const bed = await makeCloudflareBed()
    const theirAccount = await seedAccount(bed, OTHER_USER, { id: 'd'.repeat(26), name: 'Theirs' })
    await seedLog(bed, OTHER_USER, {
      action: 'delete_worker',
      accountId: theirAccount.id,
      target: 'their-worker',
      createdAt: Date.UTC(2026, 0, 4, 10),
    })

    const list = await readJson<AuditBody>(await bed.app.request(
      '/api/cloudflare/audit-log',
      {},
      bed.env,
    ))
    expect(list.total).toBe(0)
    expect(list.logs).toEqual([])
    expect(list.actions).toEqual([])

    mocks.userId = OTHER_USER
    const own = await readJson<AuditBody>(await bed.app.request(
      '/api/cloudflare/audit-log',
      {},
      bed.env,
    ))
    expect(own.total).toBe(1)
    expect(own.logs[0]?.target).toBe('their-worker')
    expect(own.logs[0]?.account_name).toBe('Theirs')
  })
})
