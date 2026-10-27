// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cfJson,
  makeCloudflareBed,
  seedAccount,
  stubCloudflare,
  TEST_USER,
  type CloudflareTestBed,
} from './cloudflare-fixtures'

const OTHER_USER = 'o'.repeat(26)
const ACCOUNT_A = 'a'.repeat(26)
const ACCOUNT_B = 'b'.repeat(26)
const ACCOUNT_C = 'c'.repeat(26)

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

interface CfCall {
  method: string
  path: string
  token: string
  body: unknown
}

interface WorkerListRow {
  type: 'worker' | 'pages'
  name: string
  accountId: string
  accountName: string
}

interface SummaryRow {
  accountId: string
  accountName: string
  requests: number
  errors: number
  cpuTimeMs: number
  workerCount: number
  pagesCount: number
}

let bed: CloudflareTestBed
let calls: CfCall[]

function stubApi(handler?: (call: CfCall) => Response | null | Promise<Response | null>): void {
  calls = []
  stubCloudflare(async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const token = (headers.Authorization ?? '').replace(/^Bearer /, '')
    const raw = init?.body
    let body: unknown = raw
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw) as unknown
      } catch {
        body = raw
      }
    }
    const call: CfCall = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace('/client/v4', ''),
      token,
      body,
    }
    calls.push(call)
    const custom = await handler?.(call)
    if (custom) return custom
    if (call.path === '/graphql') {
      return Response.json({ data: { viewer: { accounts: [] } } })
    }
    return cfJson([])
  })
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const url = path === '/' ? '/api/cloudflare/workers' : `/api/cloudflare/workers${path}`
  return bed.app.request(url, init, bed.env)
}

async function sendForm(path: string, form: FormData): Promise<Response> {
  return bed.app.request(`/api/cloudflare/workers${path}`, { method: 'POST', body: form }, bed.env)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function auditActions(): Promise<Array<{ action: string; status: string }>> {
  const rows = await bed.env.DB.prepare(
    'SELECT action, status FROM cloudflare_log WHERE user_id = ? ORDER BY rowid ASC',
  ).bind(TEST_USER).all<{ action: string; status: string }>()
  return rows.results ?? []
}

async function formMetadata(body: unknown): Promise<{ metadata: Record<string, unknown>; parts: Map<string, string> }> {
  const form = body as FormData
  const metadata = JSON.parse(await (form.get('metadata') as Blob).text()) as Record<string, unknown>
  const parts = new Map<string, string>()
  for (const [key, value] of form.entries()) {
    if (key === 'metadata') continue
    parts.set(key, await (value as Blob).text())
  }
  return { metadata, parts }
}

beforeEach(async () => {
  mocks.userId = TEST_USER
  bed = await makeCloudflareBed()
})

afterEach(() => vi.unstubAllGlobals())

describe('the merged Workers list', () => {
  it('lists Workers and Pages across accounts and keeps the half that answered', async () => {
    const a = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    const b = await seedAccount(bed, TEST_USER, { id: ACCOUNT_B, name: 'Beta', token: 'token-b', accountId: 'cf-b' })
    stubApi(({ method, path, token }) => {
      if (method === 'GET' && path === '/accounts/cf-a/workers/scripts') {
        return cfJson([
          { id: 'alpha-one', modified_on: '2026-01-02T00:00:00Z' },
          { id: 'alpha-two' },
        ])
      }
      if (method === 'GET' && path === '/accounts/cf-a/pages/projects') {
        return cfJson([{ name: 'alpha-site', latest_deployment: { created_on: '2026-01-03T00:00:00Z' } }])
      }
      if (token === 'token-b' && path.endsWith('/workers/scripts')) {
        return Response.json({ success: false, errors: [{ message: 'token revoked' }] }, { status: 403 })
      }
      if (token === 'token-b' && path.endsWith('/pages/projects')) {
        return cfJson([{ name: 'beta-site' }])
      }
      return null
    })

    const response = await send('GET', '/')
    expect(response.status).toBe(200)
    const rows = await json<WorkerListRow[]>(response)
    expect(rows.map((row) => `${row.type}:${row.name}`).sort()).toEqual([
      'pages:alpha-site',
      'pages:beta-site',
      'worker:alpha-one',
      'worker:alpha-two',
    ])
    expect(rows.find((row) => row.name === 'beta-site')).toMatchObject({
      accountId: b.id,
      accountName: 'Beta',
    })
    expect(rows.every((row) => row.accountId !== 'missing')).toBe(true)
    expect(rows.some((row) => row.accountId === a.id)).toBe(true)
  })

  it('answers /summary and /usage as static addresses before any account parameter', async () => {
    stubApi()
    const summary = await send('GET', '/summary')
    const usage = await send('GET', '/usage')
    expect(summary.status).toBe(200)
    expect(usage.status).toBe(200)
    expect(await json<unknown[]>(summary)).toEqual([])
    expect(await json<unknown[]>(usage)).toEqual([])
  })
})

describe('summary and usage', () => {
  it('reports per-account counts and today’s Workers numbers', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    let graphqlAccount = ''
    stubApi(({ method, path, body }) => {
      if (path === '/graphql') {
        const payload = body as { variables?: { accountTag?: string } }
        graphqlAccount = payload.variables?.accountTag ?? ''
        return Response.json({
          data: {
            viewer: {
              accounts: [{
                workers: [{ sum: { requests: 100, errors: 5, subrequests: 20, cpuTimeUs: 2000 } }],
                pages: [{ sum: { requests: 10, errors: 1 } }],
              }],
            },
          },
        })
      }
      if (method === 'GET' && path === '/accounts/cf-a/workers/scripts') {
        return cfJson([{ id: 'one' }, { id: 'two' }])
      }
      if (method === 'GET' && path === '/accounts/cf-a/pages/projects') {
        return cfJson([{ name: 'site' }])
      }
      return null
    })

    const summary = await json<SummaryRow[]>(await send('GET', '/summary'))
    expect(summary).toEqual([{
      accountId: ACCOUNT_A,
      accountName: 'Alpha',
      requests: 110,
      errors: 6,
      subrequests: 20,
      cpuTimeMs: 2,
      workerCount: 2,
      pagesCount: 1,
    }])
    expect(graphqlAccount).toBe('cf-a')

    const usage = await json<Array<{ accountId: string; requests: number }>>(await send('GET', '/usage'))
    expect(usage).toEqual([expect.objectContaining({ accountId: ACCOUNT_A, requests: 110 })])
  })
})

describe('Worker settings endpoints', () => {
  it('lists, writes and deletes secrets and audits the mutations', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => {
      if (path === '/accounts/cf-a/workers/scripts/demo/secrets' && method === 'GET') {
        return cfJson([{ name: 'TOKEN', type: 'secret_text' }])
      }
      if (path === '/accounts/cf-a/workers/scripts/demo/secrets' && method === 'PUT') {
        return cfJson({ name: 'TOKEN', type: 'secret_text' })
      }
      if (path === '/accounts/cf-a/workers/scripts/demo/secrets/TOKEN' && method === 'DELETE') {
        return cfJson({ name: 'TOKEN' })
      }
      if (path === '/accounts/cf-a/workers/scripts/demo/settings') {
        return cfJson({
          compatibility_date: '2024-11-01',
          bindings: [
            { type: 'plain_text', name: 'API_URL', text: 'https://example.com' },
            { type: 'secret_text', name: 'TOKEN' },
            { type: 'kv_namespace', name: 'CACHE', namespace_id: 'kv-1' },
          ],
        })
      }
      return null
    })

    const secrets = await json<Array<{ name: string }>>(await send('GET', `/${ACCOUNT_A}/workers/demo/secrets`))
    expect(secrets).toEqual([{ name: 'TOKEN', type: 'secret_text' }])

    const put = await send('PUT', `/${ACCOUNT_A}/workers/demo/secrets`, {
      name: 'TOKEN',
      type: 'secret_text',
      text: 's3cret',
    })
    expect(put.status).toBe(200)
    const write = calls.find((call) => call.method === 'PUT' && call.path.endsWith('/secrets'))
    expect(write?.body).toEqual({ name: 'TOKEN', type: 'secret_text', text: 's3cret' })

    await send('DELETE', `/${ACCOUNT_A}/workers/demo/secrets/TOKEN`)

    const config = await json<{
      vars: Array<{ name: string; secret: boolean }>
      bindings: Array<{ type: string; name: string; existingId?: string }>
    }>(await send('GET', `/${ACCOUNT_A}/workers/demo/config`))
    expect(config.vars).toEqual([
      { name: 'API_URL', value: 'https://example.com', secret: false },
      { name: 'TOKEN', value: '', secret: true },
    ])
    expect(config.bindings).toEqual([
      { type: 'kv', name: 'CACHE', mode: 'existing', existingId: 'kv-1' },
    ])
    expect((await auditActions()).map((row) => row.action)).toEqual(['update_secret', 'delete_secret'])
  })

  it('reads and replaces cron triggers', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => {
      if (path === '/accounts/cf-a/workers/scripts/demo/schedules' && method === 'GET') {
        return cfJson({ schedules: [{ id: 'cron-1', cron: '0 * * * *' }] })
      }
      if (path === '/accounts/cf-a/workers/scripts/demo/schedules' && method === 'PUT') {
        return cfJson({ schedules: [{ id: 'cron-1', cron: '*/5 * * * *' }] })
      }
      return null
    })

    const read = await json<{ schedules: Array<{ cron: string }> }>(
      await send('GET', `/${ACCOUNT_A}/workers/demo/schedules`),
    )
    expect(read.schedules[0]?.cron).toBe('0 * * * *')

    const put = await send('PUT', `/${ACCOUNT_A}/workers/demo/schedules`, { crons: ['*/5 * * * *'] })
    expect(put.status).toBe(200)
    const write = calls.find((call) => call.method === 'PUT' && call.path.endsWith('/schedules'))
    expect(write?.body).toEqual([{ cron: '*/5 * * * *' }])
    expect((await auditActions()).map((row) => row.action)).toContain('update_schedules')
  })

  it('lists, creates and deletes routes only with a zone', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => {
      if (path === '/zones/zone-1/workers/routes' && method === 'GET') {
        return cfJson([{ id: 'route-1', pattern: 'example.com/*', script: 'demo' }])
      }
      if (path === '/zones/zone-1/workers/routes' && method === 'POST') {
        return cfJson({ id: 'route-2', pattern: 'demo.example.com/*' })
      }
      if (path === '/zones/zone-1/workers/routes/route-1' && method === 'DELETE') {
        return cfJson({ id: 'route-1' })
      }
      return null
    })

    const missing = await send('GET', `/${ACCOUNT_A}/workers/demo/routes`)
    expect(missing.status).toBe(400)

    const routes = await json<Array<{ pattern: string }>>(
      await send('GET', `/${ACCOUNT_A}/workers/demo/routes?zone_id=zone-1`),
    )
    expect(routes[0]?.pattern).toBe('example.com/*')

    await send('POST', `/${ACCOUNT_A}/workers/demo/routes`, {
      zone_id: 'zone-1',
      pattern: 'demo.example.com/*',
    })
    const create = calls.find((call) => call.method === 'POST' && call.path === '/zones/zone-1/workers/routes')
    expect(create?.body).toEqual({ pattern: 'demo.example.com/*', script: 'demo' })

    await send('DELETE', `/${ACCOUNT_A}/workers/demo/routes/route-1?zone_id=zone-1`)
    expect(calls.some((call) => call.method === 'DELETE' && call.path === '/zones/zone-1/workers/routes/route-1')).toBe(true)
    expect((await auditActions()).map((row) => row.action)).toEqual([
      'create_worker_route',
      'delete_worker_route',
    ])
  })

  it('rejects an invalid worker name before building an upstream URL', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    stubApi()
    const response = await send('GET', `/${ACCOUNT_A}/workers/Bad_Name`)
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe('Pages endpoints', () => {
  it('reads and patches a project and its bindings', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => {
      if (path === '/accounts/cf-a/pages/projects/site' && method === 'GET') {
        return cfJson({ id: 'proj-1', name: 'site', production_branch: 'main' })
      }
      if (path === '/accounts/cf-a/pages/projects/site' && method === 'PATCH') {
        return cfJson({ id: 'proj-1', name: 'site' })
      }
      if (path === '/accounts/cf-a/pages/projects/site/domains' && method === 'POST') {
        return cfJson({ name: 'www.example.com' })
      }
      return null
    })

    const project = await json<{ name: string }>(await send('GET', `/${ACCOUNT_A}/pages/site/project`))
    expect(project.name).toBe('site')

    const patch = await send('PATCH', `/${ACCOUNT_A}/pages/site/project`, {
      deployment_configs: { production: { env_vars: { A: { type: 'plain_text', value: '1' } } } },
    })
    expect(patch.status).toBe(200)
    const update = calls.find((call) => call.method === 'PATCH' && call.path === '/accounts/cf-a/pages/projects/site')
    expect(update?.body).toEqual({
      deployment_configs: { production: { env_vars: { A: { type: 'plain_text', value: '1' } } } },
    })

    await send('PUT', `/${ACCOUNT_A}/pages/site/bindings`, {
      deployment_configs: { production: { kv_namespaces: { CACHE: { namespace_id: 'kv-1' } } } },
    })
    const bindings = calls
      .filter((call) => call.method === 'PATCH' && call.path === '/accounts/cf-a/pages/projects/site')
      .at(-1)
    expect(bindings?.body).toEqual({
      deployment_configs: { production: { kv_namespaces: { CACHE: { namespace_id: 'kv-1' } } } },
    })

    await send('POST', `/${ACCOUNT_A}/pages/site/domains`, { hostname: 'www.example.com' })
    const domain = calls.find((call) => call.method === 'POST' && call.path.endsWith('/domains'))
    expect(domain?.body).toEqual({ name: 'www.example.com' })
    expect((await auditActions()).map((row) => row.action).sort()).toEqual([
      'create_pages_domain',
      'update_pages_bindings',
      'update_pages_project',
    ])
  })

  it('deletes a Pages project and audits it', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    stubApi(({ method, path }) => (
      method === 'DELETE' && path === '/accounts/cf-a/pages/projects/site' ? cfJson({ id: 'proj-1' }) : null
    ))
    const response = await send('DELETE', `/${ACCOUNT_A}/pages/site`)
    expect(response.status).toBe(200)
    expect((await auditActions()).map((row) => row.action)).toEqual(['delete_pages_project'])
  })
})

describe('deployment uploads', () => {
  it('sends Worker metadata with the module, bindings and variables', async () => {
    const a = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    let uploaded: { metadata: Record<string, unknown>; parts: Map<string, string> } | null = null
    stubApi(({ method, path, body }) => {
      if (method === 'PUT' && path === '/accounts/cf-a/workers/scripts/demo') {
        return (async () => {
          uploaded = await formMetadata(body)
          return cfJson({ id: 'demo' })
        })()
      }
      if (path === '/accounts/cf-a/workers/subdomain') {
        return cfJson({ subdomain: 'acme' })
      }
      return null
    })

    const form = new FormData()
    form.append('targets', JSON.stringify([{ accountId: a.id, workerName: 'demo' }]))
    form.append('script', new File(['export default { fetch() { return new Response("ok") } }'], 'worker.js', {
      type: 'application/javascript',
    }))
    form.append('vars', JSON.stringify([
      { name: 'PLAIN', value: 'plain-value', secret: false },
      { name: 'SECRET', value: 'secret-value', secret: true },
    ]))
    form.append('bindings', JSON.stringify([{ type: 'ai', name: 'AI' }]))

    const response = await sendForm('/batch-deploy', form)
    expect(response.status).toBe(200)
    const answer = await json<{
      total: number
      succeeded: number
      failed: number
      results: Array<{ accountId: string; workerName: string; success: boolean; url?: string }>
    }>(response)
    expect(answer).toMatchObject({ total: 1, succeeded: 1, failed: 0 })
    expect(answer.results[0]).toMatchObject({
      accountId: a.id,
      workerName: 'demo',
      success: true,
      url: 'https://demo.acme.workers.dev',
    })

    expect(uploaded).not.toBeNull()
    expect(uploaded!.metadata).toMatchObject({
      main_module: 'worker.js',
      compatibility_date: '2024-11-01',
    })
    expect(uploaded!.metadata.bindings).toEqual(expect.arrayContaining([
      { type: 'ai', name: 'AI' },
      { type: 'plain_text', name: 'PLAIN', text: 'plain-value' },
      { type: 'secret_text', name: 'SECRET', text: 'secret-value' },
    ]))
    expect(uploaded!.parts.get('worker.js')).toContain('export default')
    expect((await auditActions()).map((row) => row.action)).toEqual(['deploy_worker'])
  })

  it('keeps the successful targets when another account fails', async () => {
    const a = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    const b = await seedAccount(bed, TEST_USER, { id: ACCOUNT_B, name: 'Beta', token: 'token-b', accountId: 'cf-b' })
    stubApi(({ method, path, token }) => {
      if (method === 'PUT' && path === '/accounts/cf-a/workers/scripts/demo') return cfJson({ id: 'demo' })
      if (method === 'PUT' && path === '/accounts/cf-b/workers/scripts/demo') {
        return Response.json({ success: false, errors: [{ message: 'script rejected' }] }, { status: 400 })
      }
      if (path.endsWith('/workers/subdomain')) return cfJson({ subdomain: 'acme' })
      if (token === 'token-b' && path.endsWith('/workers/subdomain')) return cfJson({})
      return null
    })

    const form = new FormData()
    form.append('targets', JSON.stringify([
      { accountId: a.id, workerName: 'demo' },
      { accountId: b.id, workerName: 'demo' },
    ]))
    form.append('script', new File(['export default {}'], 'worker.js', { type: 'application/javascript' }))

    const answer = await json<{
      total: number
      succeeded: number
      failed: number
      results: Array<{ accountId: string; success: boolean; error?: string }>
    }>(await sendForm('/batch-deploy', form))
    expect(answer).toMatchObject({ total: 2, succeeded: 1, failed: 1 })
    expect(answer.results.find((row) => row.accountId === a.id)).toMatchObject({ success: true })
    expect(answer.results.find((row) => row.accountId === b.id)).toMatchObject({
      success: false,
      error: 'script rejected',
    })
    const audit = await auditActions()
    expect(audit.filter((row) => row.action === 'deploy_worker').map((row) => row.status).sort()).toEqual(['error', 'success'])
  })
})

describe('environment sync', () => {
  function stubEnvSync(): void {
    stubApi(({ method, path, body }) => {
      if (path === '/accounts/cf-a/workers/scripts/src/settings') {
        return cfJson({
          compatibility_date: '2024-11-01',
          bindings: [
            { type: 'plain_text', name: 'API_URL', text: 'https://a.example.com' },
            { type: 'secret_text', name: 'TOKEN' },
          ],
        })
      }
      if (path === '/accounts/cf-a/workers/scripts/src/secrets') {
        return cfJson([{ name: 'TOKEN', type: 'secret_text' }])
      }
      if (path === '/accounts/cf-b/workers/scripts/dst/settings') {
        return cfJson({
          compatibility_date: '2024-11-01',
          bindings: [{ type: 'plain_text', name: 'API_URL', text: 'https://b.example.com' }],
        })
      }
      if (path === '/accounts/cf-b/workers/scripts/dst/secrets' && method === 'GET') {
        return cfJson([])
      }
      if (path === '/accounts/cf-b/workers/scripts/dst/secrets' && method === 'PUT') {
        return cfJson({ name: 'TOKEN' })
      }
      if (path === '/accounts/cf-b/workers/scripts/dst' && method === 'GET') {
        return new Response('export default { fetch() { return new Response("dst") } }', {
          headers: { 'Content-Type': 'application/javascript' },
        })
      }
      if (path === '/accounts/cf-b/workers/scripts/dst' && method === 'PUT') {
        return cfJson({ id: 'dst' })
      }
      if (path === '/accounts/cf-b/workers/subdomain') {
        return cfJson({ subdomain: 'beta' })
      }
      return null
    })
  }

  it('previews missing secrets and changed plain variables', async () => {
    const a = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    const b = await seedAccount(bed, TEST_USER, { id: ACCOUNT_B, name: 'Beta', token: 'token-b', accountId: 'cf-b' })
    stubEnvSync()

    const preview = await json<{
      source: { vars: Array<{ name: string; value: string }>; secrets: string[] }
      previews: Array<{
        missing: Array<{ name: string; type: string }>
        changed: Array<{ name: string; source: string; target: string }>
      }>
    }>(await send('POST', '/env-sync/preview', {
      source: { accountId: a.id, workerName: 'src' },
      targets: [{ accountId: b.id, workerName: 'dst' }],
    }))

    expect(preview.source).toEqual({
      vars: [{ name: 'API_URL', value: 'https://a.example.com' }],
      secrets: ['TOKEN'],
    })
    expect(preview.previews[0]?.missing).toEqual([{ name: 'TOKEN', type: 'secret_text' }])
    expect(preview.previews[0]?.changed).toEqual([{
      name: 'API_URL',
      source: 'https://a.example.com',
      target: 'https://b.example.com',
    }])
  })

  it('applies selected secrets and plain variables to a target', async () => {
    const a = await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    const b = await seedAccount(bed, TEST_USER, { id: ACCOUNT_B, name: 'Beta', token: 'token-b', accountId: 'cf-b' })
    stubEnvSync()

    const results = await json<Array<{ success: boolean; applied: string[] }>>(
      await send('POST', '/env-sync/execute', {
        source: { accountId: a.id, workerName: 'src' },
        targets: [{ accountId: b.id, workerName: 'dst' }],
        keys: ['API_URL', 'TOKEN'],
        secretValues: { TOKEN: 'rotated' },
      }),
    )
    expect(results[0]).toMatchObject({ success: true })
    expect(results[0]?.applied.sort()).toEqual(['API_URL', 'TOKEN'])

    const secretWrite = calls.find((call) => call.method === 'PUT' && call.path.endsWith('/dst/secrets'))
    expect(secretWrite?.body).toEqual({ name: 'TOKEN', type: 'secret_text', text: 'rotated' })

    const scriptWrite = calls.find((call) => call.method === 'PUT' && call.path === '/accounts/cf-b/workers/scripts/dst')
    const uploaded = await formMetadata(scriptWrite?.body)
    expect(uploaded.metadata.bindings).toEqual([
      { type: 'plain_text', name: 'API_URL', text: 'https://a.example.com' },
    ])
    expect((await auditActions()).map((row) => row.action)).toContain('env_sync')
  })
})

describe('account ownership', () => {
  it('answers 404 for another reader’s account without calling Cloudflare', async () => {
    await seedAccount(bed, TEST_USER, { id: ACCOUNT_A, name: 'Alpha', token: 'token-a', accountId: 'cf-a' })
    const other = await seedAccount(bed, OTHER_USER, { id: ACCOUNT_C, name: 'Theirs', token: 'token-c', accountId: 'cf-c' })
    stubApi()

    const detail = await send('GET', `/${other.id}/workers/demo`)
    expect(detail.status).toBe(404)
    const deleted = await send('DELETE', `/${other.id}/workers/demo`)
    expect(deleted.status).toBe(404)
    const pages = await send('GET', `/${other.id}/pages/site/project`)
    expect(pages.status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})
