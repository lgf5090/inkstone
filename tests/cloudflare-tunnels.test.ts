// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCloudflareBed, readJson, seedAccount, stubCloudflare, TEST_USER } from './cloudflare-fixtures'

vi.mock('../src/worker/middleware/auth', () => ({
  requireClientHeader: async (_c: unknown, next: () => Promise<void>) => { await next() },
  loadSession: async (_c: unknown, next: () => Promise<void>) => { await next() },
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'u'.repeat(26))
    await next()
  },
}))

afterEach(() => vi.unstubAllGlobals())

const CF_ACCOUNT = 'b'.repeat(32)
const ZONE = { id: 'zone-1', name: 'example.com', status: 'active' }
const TUNNEL = { id: 'tunnel-1', name: 'home', status: 'inactive', created_at: '2026-01-01T00:00:00Z', connections: [] }

function stubTunnels(options: {
  onConfigPut?: (body: unknown) => void
  onDnsPost?: (body: unknown) => void
  failDns?: boolean
} = {}): void {
  stubCloudflare((url, init) => {
    const path = url.pathname
    if (path.endsWith('/zones') || path.endsWith('/zones/')) {
      return Response.json({ success: true, result: [ZONE], result_info: { total_pages: 1 } })
    }
    if (path.endsWith('/cfd_tunnel') && (!init?.method || init.method === 'GET')) {
      return Response.json({ success: true, result: [TUNNEL], result_info: { total_pages: 1 } })
    }
    if (path.endsWith('/cfd_tunnel') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { name?: string }
      return Response.json({ success: true, result: { ...TUNNEL, id: 'tunnel-2', name: body.name ?? 'new' } })
    }
    if (path.endsWith('/token')) return Response.json({ success: true, result: 'tunnel-token-value' })
    if (path.endsWith('/connections')) {
      return Response.json({ success: true, result: [{ id: 'c1', colo_name: 'HKG', version: '2026.1', ip: '1.2.3.4' }] })
    }
    if (path.endsWith('/configurations') && (!init?.method || init.method === 'GET')) {
      return Response.json({ success: true, result: { config: { ingress: [{ hostname: 'a.example.com', service: 'http://localhost:80' }, { service: 'http_status:404' }] } } })
    }
    if (path.endsWith('/configurations') && init?.method === 'PUT') {
      options.onConfigPut?.(JSON.parse(String(init.body ?? '{}')))
      return Response.json({ success: true, result: JSON.parse(String(init.body ?? '{}')) })
    }
    if (path.endsWith('/dns_records') && init?.method === 'POST') {
      options.onDnsPost?.(JSON.parse(String(init.body ?? '{}')))
      if (options.failDns) return Response.json({ success: false, errors: [{ message: 'record already exists 81053' }] }, { status: 400 })
      return Response.json({ success: true, result: { id: 'rec-1' } })
    }
    if (init?.method === 'DELETE' && /\/cfd_tunnel\/tunnel-[^/]+$/.test(path)) {
      return Response.json({ success: true, result: { id: path.split('/').pop() } })
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: `unexpected ${init?.method ?? 'GET'} ${path}` }] }), { status: 404 })
  })
}

async function send(bed: Awaited<ReturnType<typeof makeCloudflareBed>>, method: string, path: string, body?: unknown) {
  return bed.app.request(`/api/cloudflare/tunnels${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }, bed.env)
}

describe('the tunnels surface', () => {
  it('lists accounts with tunnels and maps a tunnel with its connections', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    stubTunnels()
    const accounts = await readJson<Array<{ id: string }>>(await send(bed, 'GET', '/accounts'))
    expect(accounts.map((account) => account.id)).toEqual([id])
    const tunnels = await readJson<Array<{ id: string; status: string }>>(await send(bed, 'GET', `/accounts/${id}/tunnels`))
    expect(tunnels).toEqual([expect.objectContaining({ id: 'tunnel-1', status: 'inactive' })])
    expect(await readJson<Array<{ id: string }>>(await send(bed, 'GET', `/accounts/${id}/tunnels/tunnel-1/connections`))).toEqual([expect.objectContaining({ id: 'c1' })])
  })

  it('creates a tunnel and returns its token', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    stubTunnels()
    const created = await send(bed, 'POST', `/accounts/${id}/tunnels`, { name: 'home' })
    expect(created.status).toBe(201)
    expect(await readJson<{ name: string }>(created)).toMatchObject({ name: 'home' })
    const token = await readJson<{ token: string }>(await send(bed, 'GET', `/accounts/${id}/tunnels/tunnel-1/token`))
    expect(token.token).toBe('tunnel-token-value')
    const audit = await bed.env.DB.prepare('SELECT action FROM cloudflare_log WHERE user_id = ?').bind(TEST_USER).all<{ action: string }>()
    expect(audit.results?.map((row) => row.action)).toContain('create_tunnel')
  })

  it('saves ingress with the catch-all forced last, and refuses a catch-all in the middle', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    let saved: unknown = null
    stubTunnels({ onConfigPut: (body) => { saved = body } })
    const ok = await send(bed, 'PUT', `/accounts/${id}/tunnels/tunnel-1/config`, {
      ingress: [{ hostname: 'b.example.com', service: 'http://localhost:8080' }],
    })
    expect(ok.status).toBe(200)
    expect(saved).toEqual({ config: { ingress: [{ hostname: 'b.example.com', service: 'http://localhost:8080' }, { service: 'http_status:404' }] } })

    const bad = await send(bed, 'PUT', `/accounts/${id}/tunnels/tunnel-1/config`, {
      ingress: [{ service: 'http_status:404' }, { hostname: 'c.example.com', service: 'http://localhost:1' }],
    })
    expect(bad.status).toBe(400)

    const badHost = await send(bed, 'PUT', `/accounts/${id}/tunnels/tunnel-1/config`, {
      ingress: [{ hostname: 'not a host', service: 'http://localhost:1' }],
    })
    expect(badHost.status).toBe(400)
  })

  it('runs the wizard in create mode: tunnel, CNAME, ingress with a catch-all', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    let dns: unknown = null
    let config: unknown = null
    stubTunnels({ onDnsPost: (body) => { dns = body }, onConfigPut: (body) => { config = body } })
    const response = await send(bed, 'POST', `/accounts/${id}/wizard`, {
      mode: 'create',
      tunnelName: 'origin',
      hostname: 'app.example.com',
      protocol: 'http',
      port: 3000,
    })
    expect(response.status).toBe(201)
    expect(await readJson<{ tunnelId: string; cnameTarget: string }>(response)).toMatchObject({
      tunnelId: 'tunnel-2',
      cnameTarget: 'tunnel-2.cfargotunnel.com',
    })
    expect(dns).toMatchObject({ type: 'CNAME', name: 'app.example.com', proxied: true })
    expect(config).toEqual({ config: { ingress: [{ hostname: 'app.example.com', service: 'http://localhost:3000' }, { service: 'http_status:404' }] } })
  })

  it('rolls the new tunnel back when the DNS record cannot be created', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    const deletes: string[] = []
    stubTunnels({ failDns: true })
    const original = globalThis.fetch
    // Wrap the stub once more to observe the rollback DELETE.
    const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
      if (init?.method === 'DELETE') deletes.push(url.pathname)
      return original(input as RequestInfo, init)
    })
    vi.stubGlobal('fetch', wrapped)
    const response = await send(bed, 'POST', `/accounts/${id}/wizard`, {
      mode: 'create',
      hostname: 'app.example.com',
      protocol: 'http',
      port: 3000,
    })
    expect(response.status).toBe(409)
    expect(deletes.some((path) => path.endsWith('/cfd_tunnel/tunnel-2'))).toBe(true)
  })

  it('refuses invalid wizard input and a hostname outside the account’s zones', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    stubTunnels()
    expect((await send(bed, 'POST', `/accounts/${id}/wizard`, { mode: 'create', hostname: 'bad host', port: 80 })).status).toBe(400)
    expect((await send(bed, 'POST', `/accounts/${id}/wizard`, { mode: 'create', hostname: 'app.example.com', port: 0 })).status).toBe(400)
    expect((await send(bed, 'POST', `/accounts/${id}/wizard`, { mode: 'create', hostname: 'app.other.net', port: 80 })).status).toBe(400)
  })

  it('answers an unknown rule phase with 400 and another reader’s account with 404', async () => {
    const bed = await makeCloudflareBed()
    const { id } = await seedAccount(bed, TEST_USER)
    stubTunnels()
    const phase = await send(bed, 'GET', `/accounts/${id}/zones/zone-1/rules/not-a-phase`)
    expect(phase.status).toBe(400)
    const foreign = await send(bed, 'GET', `/accounts/${'o'.repeat(26)}/tunnels`)
    expect(foreign.status).toBe(404)
  })
})
