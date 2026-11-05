// @vitest-environment node
/**
 * The panel's routes, against a real Hono app and a real D1 double.
 *
 * The download endpoint is the one that matters most: it is the only route that answers with bytes, and
 * its bounds are the difference between a measurement and a server asked to stream a terabyte.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  TOOLS_NETWORK_PANEL_REQUIRED_COLUMNS,
  TOOLS_NETWORK_PANEL_REQUIRED_INDEXES,
  TOOLS_NETWORK_PANEL_REQUIRED_TABLES,
  TOOLS_NETWORK_PANEL_SCHEMA_STATEMENTS,
} from '../src/worker/tools/network-panel/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsNetworkPanelRoutes } from '../src/worker/routes/tools-network-panel'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-panel'

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/tools/network-panel/*', async (c, next) => {
    const userId = c.req.header('x-test-user')
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: userId,
        login: userId,
        name: userId,
        avatarUrl: '',
        role: 'member',
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  app.route('/api/tools/network-panel', toolsNetworkPanelRoutes)
  return app
}

const app = testApp()
let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_NETWORK_PANEL_SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = { ...testBindings, DB: makeD1(sqlite) } as unknown as Env
})

async function call(
  method: string,
  path: string,
  options: { user?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const userId = options.user === undefined ? USER : options.user
  const headers: Record<string, string> = { ...options.headers }
  if (userId) headers['x-test-user'] = userId
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-Inkstone-Client'] = '1'
    headers['content-type'] = 'application/json'
  }
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    env,
  )
}

describe('network panel schema contract', () => {
  it('declares the three tables and their indexes', () => {
    expect(TOOLS_NETWORK_PANEL_REQUIRED_TABLES).toEqual([
      'tools_NetworkPanel_settings',
      'tools_NetworkPanel_nodes',
      'tools_NetworkPanel_runs',
    ])
    expect(TOOLS_NETWORK_PANEL_REQUIRED_INDEXES).toHaveLength(2)
    expect(Object.keys(TOOLS_NETWORK_PANEL_REQUIRED_COLUMNS)).toEqual([...TOOLS_NETWORK_PANEL_REQUIRED_TABLES])
  })
})

describe('network panel routes', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await call('GET', '/api/tools/network-panel/settings', { user: null })
    expect(response.status).toBe(401)
  })

  it('reads and writes one settings row', async () => {
    const first = await call('GET', '/api/tools/network-panel/settings')
    expect(first.status).toBe(200)
    const body = await first.json() as { data: { threads: number; nodeId: string } }
    expect(body.data.threads).toBe(8)
    expect(body.data.nodeId).toBe('builtin')

    const saved = await call('PUT', '/api/tools/network-panel/settings', {
      body: { threads: 24, maxSpeedBps: 1024 * 1024 },
    })
    expect(saved.status).toBe(200)
    const savedBody = await saved.json() as { data: { threads: number; maxSpeedBps: number; showChart: boolean } }
    expect(savedBody.data.threads).toBe(24)
    expect(savedBody.data.maxSpeedBps).toBe(1024 * 1024)
    expect(savedBody.data.showChart).toBe(false)
  })

  it('validates a settings patch instead of storing nonsense', async () => {
    const bad = await call('PUT', '/api/tools/network-panel/settings', { body: { threads: 500 } })
    expect(bad.status).toBe(400)
    const badSpeed = await call('PUT', '/api/tools/network-panel/settings', { body: { maxSpeedBps: -1 } })
    expect(badSpeed.status).toBe(400)
  })

  it('adds an address, refuses a non-http one, and deletes it', async () => {
    const created = await call('POST', '/api/tools/network-panel/nodes', {
      body: { label: 'Custom', url: '/api/tools/network-panel/download' },
    })
    expect(created.status).toBe(201)
    const body = await created.json() as { data: { id: string; label: string } }
    expect(body.data.label).toBe('Custom')

    const refused = await call('POST', '/api/tools/network-panel/nodes', {
      body: { label: 'Bad', url: 'javascript:alert(1)' },
    })
    expect(refused.status).toBe(400)

    const removed = await call('DELETE', `/api/tools/network-panel/nodes/${body.data.id}`)
    expect(removed.status).toBe(200)
    const again = await call('DELETE', `/api/tools/network-panel/nodes/${body.data.id}`)
    expect(again.status).toBe(404)
  })

  it('records a finished test and counts it in the history', async () => {
    const recorded = await call('POST', '/api/tools/network-panel/runs', {
      body: {
        node_label: 'This deployment',
        node_url: '/api/tools/network-panel/download',
        bytes_used: 4096,
        avg_speed_bps: 2048,
        duration_ms: 2000,
        threads: 8,
        stop_reason: 'manual',
      },
    })
    expect(recorded.status).toBe(201)
    const history = await call('GET', '/api/tools/network-panel/runs?limit=10&offset=0')
    const body = await history.json() as {
      data: { total: number; items: unknown[]; summary: { bytes: number; best_speed_bps: number } }
    }
    expect(body.data.total).toBe(1)
    expect(body.data.items).toHaveLength(1)
    expect(body.data.summary.bytes).toBe(4096)
    expect(body.data.summary.best_speed_bps).toBe(2048)

    const cleared = await call('DELETE', '/api/tools/network-panel/runs')
    expect(cleared.status).toBe(200)
    const after = await call('GET', '/api/tools/network-panel/runs')
    const afterBody = await after.json() as { data: { total: number } }
    expect(afterBody.data.total).toBe(0)
  })

  it('refuses a run that did not happen', async () => {
    const response = await call('POST', '/api/tools/network-panel/runs', {
      body: {
        node_label: '',
        node_url: '/x',
        bytes_used: -1,
        avg_speed_bps: 1,
        duration_ms: 1,
        threads: 1,
        stop_reason: 'manual',
      },
    })
    expect(response.status).toBe(400)
  })

  it('answers the measured payload with the requested length and no cache', async () => {
    const response = await call('GET', '/api/tools/network-panel/download?bytes=1000')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('1000')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('content-encoding')).toBe('identity')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes.byteLength).toBe(1000)
    expect(bytes.some((value) => value !== 0)).toBe(true)
  })

  it('clamps a hand-edited length instead of streaming it', async () => {
    const tooBig = await call('GET', '/api/tools/network-panel/download?bytes=999999999999')
    expect(tooBig.headers.get('content-length')).toBe('67108864')
    await tooBig.body?.cancel()

    const zero = await call('GET', '/api/tools/network-panel/download?bytes=0')
    expect(zero.headers.get('content-length')).toBe('1')
    await zero.body?.cancel()
  })

  it('reports the request identity it actually has and no invented geography', async () => {
    const response = await call('GET', '/api/tools/network-panel/info', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    })
    const body = await response.json() as {
      data: { ip: string | null; country: string | null; edge_geo: boolean }
    }
    expect(body.data.ip).toBe('203.0.113.9')
    expect(body.data.country).toBeNull()
    expect(body.data.edge_geo).toBe(false)
  })

  it('answers the latency clock with a timestamp and no cache', async () => {
    const response = await call('GET', '/api/tools/network-panel/ping')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { t: number }
    expect(typeof body.t).toBe('number')
  })
})
