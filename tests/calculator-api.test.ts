// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CALCULATOR_REQUIRED_COLUMNS,
  CALCULATOR_REQUIRED_INDEXES,
  CALCULATOR_REQUIRED_TABLES,
  CALCULATOR_SCHEMA_STATEMENTS,
} from '../src/worker/tools/calculator/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsCalculatorRoutes } from '../src/worker/routes/tools-calculator'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER_A = 'user-alice'
const USER_B = 'user-bob'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

interface CallOptions {
  user?: string | null
  body?: unknown
}

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/tools/calculator/*', async (c, next) => {
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
  app.route('/api/tools/calculator', toolsCalculatorRoutes)
  return app
}

const app = testApp()
let sqlite: DatabaseSync
let env: Env

async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const userId = options.user === undefined ? USER_A : options.user
  const headers: Record<string, string> = {}
  if (userId) headers['x-test-user'] = userId
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-Inkstone-Client'] = '1'
    headers['content-type'] = 'application/json'
  }
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }), env)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of CALCULATOR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})

describe('calculator API', () => {
  it('creates every required table, column and index', () => {
    for (const table of CALCULATOR_REQUIRED_TABLES) {
      const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
      expect(row, `Table ${table} must exist`).toBeTruthy()
      const columns = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((entry) => entry.name)
      for (const column of CALCULATOR_REQUIRED_COLUMNS[table] ?? []) expect(columns).toContain(column)
    }
    for (const index of CALCULATOR_REQUIRED_INDEXES) {
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index)).toBeTruthy()
    }
  })

  it('rejects unauthenticated access', async () => {
    const response = await call('GET', '/api/tools/calculator/settings', { user: null })
    expect(response.status).toBe(401)
  })

  it('stores settings per user', async () => {
    const defaults = await call('GET', '/api/tools/calculator/settings')
    expect((await read<{ data: { defaultView: string } }>(defaults)).data.defaultView).toBe('standard')
    const updated = await call('PUT', '/api/tools/calculator/settings', { body: { defaultView: 'graph', angleMode: 'rad' } })
    expect(updated.status).toBe(200)
    expect((await read<{ data: { defaultView: string } }>(updated)).data.defaultView).toBe('graph')
    const other = await call('GET', '/api/tools/calculator/settings', { user: USER_B })
    expect((await read<{ data: { defaultView: string } }>(other)).data.defaultView).toBe('standard')
  })

  it('keeps unrelated settings on a partial update', async () => {
    const updated = await call('PUT', '/api/tools/calculator/settings', {
      body: { defaultView: 'graph', angleMode: 'rad', graphTheme: 'light', graphLineWidth: 4 },
    })
    expect(updated.status).toBe(200)
    const partial = await call('PUT', '/api/tools/calculator/settings', {
      body: { graphXMin: -5, graphXMax: 5, graphYMin: -3, graphYMax: 3 },
    })
    expect(partial.status).toBe(200)
    const data = (await read<{ data: { defaultView: string; angleMode: string; graphTheme: string; graphLineWidth: number; graphXMin: number; graphXMax: number } }>(partial)).data
    expect(data.defaultView).toBe('graph')
    expect(data.angleMode).toBe('rad')
    expect(data.graphTheme).toBe('light')
    expect(data.graphLineWidth).toBe(4)
    expect(data.graphXMin).toBe(-5)
    expect(data.graphXMax).toBe(5)
  })

  it('trims history to twenty entries per mode', async () => {
    for (let index = 0; index < 21; index++) {
      const response = await call('POST', '/api/tools/calculator/history', {
        body: {
          id: `hist-${String(index).padStart(2, '0')}`,
          mode: 'standard',
          expression: `${index} + 1`,
          result: String(index + 1),
          tokens: [],
          commands: [131, 93, 132, 121],
          radix: 10,
          createdAt: index,
        },
      })
      expect(response.status).toBe(200)
    }
    const list = await call('GET', '/api/tools/calculator/history?mode=standard')
    const entries = (await read<{ data: Array<{ id: string }> }>(list)).data
    expect(entries).toHaveLength(20)
    expect(entries.some((entry) => entry.id === 'hist-00')).toBe(false)
  })

  it('isolates history between users', async () => {
    await call('POST', '/api/tools/calculator/history', {
      body: { id: 'hist-one', mode: 'scientific', expression: '1 + 1', result: '2', tokens: [], commands: [], radix: 10, createdAt: 1 },
    })
    const denied = await call('DELETE', '/api/tools/calculator/history/hist-one', { user: USER_B })
    expect(denied.status).toBe(404)
    const list = await call('GET', '/api/tools/calculator/history', { user: USER_B })
    expect((await read<{ data: unknown[] }>(list)).data).toHaveLength(0)
  })

  it('truncates memory to one hundred entries', async () => {
    const memory = Array.from({ length: 101 }, (_, index) => ({ id: `mem-${index}`, value: { n: String(index), d: '1' }, sort: index, createdAt: index }))
    const response = await call('PUT', '/api/tools/calculator/memory', { body: memory })
    expect(response.status).toBe(200)
    expect((await read<{ data: unknown[] }>(response)).data).toHaveLength(100)
  })

  it('stores the graph session', async () => {
    const body = {
      equations: [{ id: 'eq-one', expression: 'y = x^2', colorIndex: 0, lineStyle: 'solid', isEnabled: true }],
      variables: [{ name: 'a', value: 1, min: -10, max: 10, step: 0.1 }],
      viewport: { xMin: -5, xMax: 5, yMin: -5, yMax: 10 },
    }
    const put = await call('PUT', '/api/tools/calculator/graph', { body })
    expect(put.status).toBe(200)
    const get = await call('GET', '/api/tools/calculator/graph')
    const data = (await read<{ data: { equations: Array<{ expression: string }>; viewport: { xMax: number } } }>(get)).data
    expect(data.equations[0].expression).toBe('y = x^2')
    expect(data.viewport.xMax).toBe(5)
  })

  it('validates, serves and deletes an asset without crossing users', async () => {
    const upload = await call('POST', '/api/tools/calculator/assets', {
      body: { kind: 'graph_png', fileFormat: 'png', dataBase64: PNG, metadata: { test: true } },
    })
    expect(upload.status).toBe(200)
    const asset = (await read<{ data: { id: string; r2Key: string } }>(upload)).data
    expect(asset.r2Key.startsWith(`calculator/images/${USER_A}/`)).toBe(true)

    const file = await call('GET', `/api/tools/calculator/assets/${asset.id}/file`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toContain('image/png')
    expect(file.headers.get('x-content-type-options')).toBe('nosniff')

    const denied = await call('GET', `/api/tools/calculator/assets/${asset.id}/file`, { user: USER_B })
    expect(denied.status).toBe(404)

    const removed = await call('DELETE', `/api/tools/calculator/assets/${asset.id}`)
    expect(removed.status).toBe(200)
    const missing = await call('GET', `/api/tools/calculator/assets/${asset.id}/file`)
    expect(missing.status).toBe(404)
  })

  it('fetches, caches and force-refreshes ECB rates', async () => {
    const xml = `<gesmes:Envelope><Cube time="2026-11-01"><Cube currency="USD" rate="1.1"/><Cube currency="CNY" rate="8.0"/><Cube currency="JPY" rate="170"/><Cube currency="GBP" rate="0.85"/><Cube currency="CHF" rate="0.94"/><Cube currency="AUD" rate="1.7"/><Cube currency="CAD" rate="1.5"/><Cube currency="HKD" rate="8.6"/><Cube currency="KRW" rate="1500"/><Cube currency="SGD" rate="1.4"/><Cube currency="INR" rate="93"/><Cube currency="NZD" rate="1.8"/></Cube></gesmes:Envelope>`
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => xml })
    vi.stubGlobal('fetch', fetchMock)
    const first = await call('GET', '/api/tools/calculator/rates')
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { data: { base: string; rates: Record<string, number>; stale: boolean } }
    expect(firstBody.data.base).toBe('EUR')
    expect(firstBody.data.rates.USD).toBe(1.1)
    expect(firstBody.data.stale).toBe(false)
    const second = await call('GET', '/api/tools/calculator/rates')
    expect(second.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const forced = await call('GET', '/api/tools/calculator/rates?force=1')
    expect(forced.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns 503 when rates cannot be fetched and nothing is cached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const response = await call('GET', '/api/tools/calculator/rates')
    expect(response.status).toBe(503)
  })

  it('rejects a fake PNG payload', async () => {
    const upload = await call('POST', '/api/tools/calculator/assets', {
      body: { kind: 'graph_png', fileFormat: 'png', dataBase64: Buffer.from('not a png').toString('base64') },
    })
    expect(upload.status).toBe(400)
  })
})
