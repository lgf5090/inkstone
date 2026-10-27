// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { resetCatalogCache } from '../src/worker/cloudflare/catalog'
import { makeCloudflareBed, readJson, seedAccount, TEST_USER } from './cloudflare-fixtures'

vi.mock('../src/worker/middleware/auth', () => ({
  requireClientHeader: async (_c: unknown, next: () => Promise<void>) => { await next() },
  loadSession: async (_c: unknown, next: () => Promise<void>) => { await next() },
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'u'.repeat(26))
    await next()
  },
}))

const CF_ACCOUNT = 'b'.repeat(32)
const SCRIPT = 'export default { fetch: () => new Response("ok") }'
const README = '# Template\n\nHello.'

interface CatalogOptions {
  templates: unknown[]
  status?: number
}

const catalogs = new Map<string, CatalogOptions>()
let multipartCalls: Array<{ path: string; form: FormData }> = []
let jsonCalls: Array<{ path: string; method: string; body: unknown }> = []

beforeEach(() => {
  resetCatalogCache()
  catalogs.clear()
  multipartCalls = []
  jsonCalls = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    if (url.hostname === 'catalog.test') {
      if (url.pathname.endsWith('/readme.md')) return new Response(README, { headers: { 'content-type': 'text/markdown' } })
      const entry = catalogs.get(url.pathname)
      if (!entry) return new Response('not found', { status: 404 })
      if (entry.status && entry.status >= 400) return new Response('nope', { status: entry.status })
      return Response.json({ templates: entry.templates })
    }
    if (url.hostname === 'files.test') {
      return new Response(SCRIPT, { headers: { 'content-type': 'application/javascript' } })
    }
    if (url.hostname === 'zip.test') {
      const zip = zipSync({ 'index.html': strToU8('<h1>hi</h1>'), 'assets/app.js': strToU8('console.log(1)') })
      return new Response(zip, { headers: { 'content-type': 'application/zip' } })
    }
    if (url.hostname !== 'api.cloudflare.com') throw new Error(`unexpected host ${url.hostname}`)

    const path = url.pathname
    if (init?.body instanceof FormData) {
      multipartCalls.push({ path, form: init.body })
      if (path.endsWith('/deployments')) return Response.json({ success: true, result: { url: 'https://demo.pages.dev' } })
      return Response.json({ success: true, result: {} })
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    jsonCalls.push({ path, method: init?.method ?? 'GET', body })
    if (path.endsWith('/workers/subdomain')) return Response.json({ success: true, result: { subdomain: 'acme' } })
    if (path.endsWith('/pages/projects') && init?.method === 'POST') return Response.json({ success: true, result: {} })
    if (path.includes('/pages/projects/') && (!init?.method || init.method === 'GET')) {
      return Response.json({ success: false, errors: [{ message: 'not found' }] }, { status: 404 })
    }
    return Response.json({ success: true, result: {} })
  })
})

afterEach(() => vi.unstubAllGlobals())

async function send(bed: Awaited<ReturnType<typeof makeCloudflareBed>>, method: string, path: string, body?: unknown) {
  return bed.app.request(`/api/cloudflare/store${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }, bed.env)
}

function workerTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hello-worker',
    name: 'Hello Worker',
    description: 'A tiny worker',
    version: '1.0.0',
    type: 'worker',
    source: { kind: 'url', url: 'https://files.test/worker.js' },
    readmeUrl: 'https://catalog.test/readme.md',
    bindings: [{ type: 'kv', name: 'CACHE', title: 'Cache' }],
    env: { GREETING: 'hello' },
    ...overrides,
  }
}

function pagesTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hello-pages',
    name: 'Hello Pages',
    version: '1.0.0',
    type: 'pages',
    source: { kind: 'url', url: 'https://zip.test/site.zip' },
    ...overrides,
  }
}

describe('the template store', () => {
  it('seeds the default sources once per reader', async () => {
    const bed = await makeCloudflareBed()
    expect(await readJson<{ ok: boolean }>(await send(bed, 'POST', '/init'))).toEqual({ ok: true })
    await send(bed, 'POST', '/init')
    const sources = await readJson<{ sources: Array<{ name: string }> }>(await send(bed, 'GET', '/sources'))
    expect(sources.sources.length).toBe(3)
    const other = await readJson<{ sources: unknown[] }>(await send(bed, 'GET', '/sources'))
    expect(other.sources.length).toBe(3)
  })

  it('refuses a non-https source, an invalid catalog and a duplicate', async () => {
    const bed = await makeCloudflareBed()
    catalogs.set('/catalog.json', { templates: [workerTemplate()] })
    expect((await send(bed, 'POST', '/sources', { url: 'http://example.com/catalog.json', name: 'Bad' })).status).toBe(400)
    catalogs.set('/broken.json', { templates: [], status: 500 })
    const broken = await send(bed, 'POST', '/sources', { url: 'https://catalog.test/broken.json', name: 'Empty' })
    expect([400, 502]).toContain(broken.status)
    const ok = await send(bed, 'POST', '/sources', { url: 'https://catalog.test/catalog.json', name: 'Mine' })
    expect(ok.status).toBe(201)
    expect((await send(bed, 'POST', '/sources', { url: 'https://catalog.test/catalog.json', name: 'Again' })).status).toBe(409)
  })

  it('merges sources, keeps the first copy of a template, and counts providers', async () => {
    const bed = await makeCloudflareBed()
    catalogs.set('/a.json', { templates: [workerTemplate(), pagesTemplate()] })
    catalogs.set('/b.json', { templates: [workerTemplate({ description: 'second source copy' })] })
    await send(bed, 'POST', '/sources', { url: 'https://catalog.test/a.json', name: 'A' })
    await send(bed, 'POST', '/sources', { url: 'https://catalog.test/b.json', name: 'B' })
    const result = await readJson<{ templates: Array<{ template: { id: string; description?: string }; sourceCount: number }> }>(
      await send(bed, 'GET', '/templates'),
    )
    expect(result.templates.map((row) => row.template.id)).toEqual(['hello-worker', 'hello-pages'])
    const shared = result.templates.find((row) => row.template.id === 'hello-worker')!
    expect(shared.sourceCount).toBe(2)
    expect(shared.template.description).toBe('A tiny worker')
  })

  it('reads the README and reports a source that cannot be downloaded at preflight', async () => {
    const bed = await makeCloudflareBed()
    const { id: accountId } = await seedAccount(bed, TEST_USER)
    catalogs.set('/a.json', { templates: [workerTemplate()] })
    await send(bed, 'POST', '/sources', { url: 'https://catalog.test/a.json', name: 'A' })
    const ok = await readJson<{ ok: boolean; sourceOk: boolean }>(await send(bed, 'POST', '/preflight', {
      accountId,
      templateId: 'hello-worker',
      name: 'my-worker',
    }))
    expect(ok).toMatchObject({ ok: true, sourceOk: true })

    catalogs.set('/b.json', { templates: [workerTemplate({ id: 'broken', source: { kind: 'url', url: 'https://missing.test/worker.js' } })] })
    await send(bed, 'POST', '/sources', { url: 'https://catalog.test/b.json', name: 'B' })
    const bad = await readJson<{ ok: boolean; sourceOk: boolean; sourceError?: string }>(await send(bed, 'POST', '/preflight', {
      accountId,
      templateId: 'broken',
      name: 'my-worker',
    }))
    expect(bad.ok).toBe(false)
    expect(bad.sourceOk).toBe(false)
    expect(bad.sourceError).toBeTruthy()
  })

  it('deploys a worker with its bindings and secrets in the metadata', async () => {
    const bed = await makeCloudflareBed()
    const { id: accountId } = await seedAccount(bed, TEST_USER)
    catalogs.set('/a.json', { templates: [workerTemplate()] })
    await send(bed, 'POST', '/sources', { url: 'https://catalog.test/a.json', name: 'A' })
    const response = await send(bed, 'POST', '/deploy', {
      accountId,
      templateId: 'hello-worker',
      name: 'my-worker',
      bindingSelections: { CACHE: 'kv:ns-1' },
      secretValues: { TOKEN: 'secret-value' },
    })
    expect([200, 201]).toContain(response.status)
    expect(await readJson<{ success: boolean; url?: string }>(response)).toMatchObject({ success: true, url: 'https://my-worker.acme.workers.dev' })
    const call = multipartCalls.find((entry) => entry.path.endsWith('/workers/scripts/my-worker'))
    expect(call).toBeTruthy()
    const metadata = JSON.parse(await (call!.form.get('metadata') as Blob).text()) as {
      main_module: string
      bindings: Array<{ type: string; name: string; namespace_id?: string; text?: string }>
    }
    expect(metadata.main_module).toBe('worker.js')
    expect(metadata.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'kv_namespace', name: 'CACHE', namespace_id: 'ns-1' }),
      expect.objectContaining({ type: 'secret_text', name: 'TOKEN', text: 'secret-value' }),
    ]))
    const script = await (call!.form.get('worker.js') as Blob).text()
    expect(script).toContain('new Response')
  })

  it('deploys a pages template through a direct upload with a manifest', async () => {
    const bed = await makeCloudflareBed()
    const { id: accountId } = await seedAccount(bed, TEST_USER)
    catalogs.set('/p.json', { templates: [pagesTemplate()] })
    await send(bed, 'POST', '/sources', { url: 'https://catalog.test/p.json', name: 'P' })
    const response = await send(bed, 'POST', '/deploy', {
      accountId,
      templateId: 'hello-pages',
      name: 'my-site',
    })
    expect([200, 201]).toContain(response.status)
    expect(await readJson<{ success: boolean; url?: string }>(response)).toMatchObject({ success: true, url: 'https://demo.pages.dev' })
    expect(jsonCalls.some((call) => call.path.endsWith('/pages/projects') && call.method === 'POST')).toBe(true)
    const upload = multipartCalls.find((entry) => entry.path.endsWith('/pages/projects/my-site/deployments'))
    expect(upload).toBeTruthy()
    const manifest = JSON.parse(await (upload!.form.get('manifest') as Blob).text()) as Record<string, string>
    expect(Object.values(manifest).sort()).toEqual(['/assets/app.js', '/index.html'])
  })

  it('reports one failed target in a batch instead of failing the call', async () => {
    const bed = await makeCloudflareBed()
    const { id: accountId } = await seedAccount(bed, TEST_USER)
    catalogs.set('/a.json', { templates: [workerTemplate()] })
    await send(bed, 'POST', '/sources', { url: 'https://catalog.test/a.json', name: 'A' })
    const result = await readJson<{ total: number; succeeded: number; failed: number; results: Array<{ success: boolean }> }>(
      await send(bed, 'POST', '/deploy-batch', {
        deployments: [
          { accountId, templateId: 'hello-worker', name: 'one' },
          { accountId: 'o'.repeat(26), templateId: 'hello-worker', name: 'two' },
        ],
      }),
    )
    expect(result).toMatchObject({ total: 2, succeeded: 1, failed: 1 })
    expect(result.results.filter((row) => !row.success).length).toBe(1)
  })

  it('keeps a reader’s sources private', async () => {
    const bed = await makeCloudflareBed()
    catalogs.set('/a.json', { templates: [workerTemplate()] })
    await send(bed, 'POST', '/sources', { url: 'https://catalog.test/a.json', name: 'A' })
    const mine = await readJson<{ sources: unknown[] }>(await send(bed, 'GET', '/sources'))
    expect(mine.sources.length).toBe(1)
    const rows = await bed.env.DB.prepare('SELECT user_id FROM cloudflare_catalog_source').all<{ user_id: string }>()
    expect(rows.results?.every((row) => row.user_id === TEST_USER)).toBe(true)
  })
})
