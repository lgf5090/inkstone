// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TOOLS_COLOR_REQUIRED_COLUMNS,
  TOOLS_COLOR_REQUIRED_INDEXES,
  TOOLS_COLOR_REQUIRED_TABLES,
  TOOLS_COLOR_SCHEMA_STATEMENTS,
} from '../src/worker/tools/color/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsColorRoutes } from '../src/worker/routes/tools-color'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER_A = 'user-alice'
const USER_B = 'user-bob'

interface CallOptions {
  user?: string | null
  body?: unknown
}

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))

  // Simulate authentication middleware
  app.use('/api/tools/color/*', async (c, next) => {
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

  app.route('/api/tools/color', toolsColorRoutes)
  return app
}

const app = testApp()

let sqlite: DatabaseSync
let env: Env

async function call(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const userId = options.user === undefined ? USER_A : options.user
  const headers: Record<string, string> = {}
  if (userId) {
    headers['x-test-user'] = userId
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['X-Inkstone-Client'] = '1'
    headers['content-type'] = 'application/json'
  }
  const body = options.body !== undefined ? JSON.stringify(options.body) : undefined
  return app.fetch(
    new Request(`http://localhost${path}`, { method, headers, body }),
    env,
  )
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_COLOR_SCHEMA_STATEMENTS) {
    sqlite.exec(statement)
  }
  env = testBindings(makeD1(sqlite), {
    FILES: testR2Bucket(),
  })
})

afterEach(() => {
  sqlite.close()
})

describe('Color Assistant D1 Schema & Tenant Isolation', () => {
  it('creates all 5 required tables and 5 indexes', () => {
    for (const table of TOOLS_COLOR_REQUIRED_TABLES) {
      const row = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
      expect(row, `Table ${table} must exist`).toBeTruthy()

      const pragma = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      const actualCols = pragma.map((c) => c.name)
      const expectedCols = TOOLS_COLOR_REQUIRED_COLUMNS[table] || []
      for (const col of expectedCols) {
        expect(actualCols, `Column ${col} in ${table}`).toContain(col)
      }
    }

    for (const index of TOOLS_COLOR_REQUIRED_INDEXES) {
      const row = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get(index)
      expect(row, `Index ${index} must exist`).toBeTruthy()
    }
  })

  it('strictly isolates settings, favorites, palettes, history between users', async () => {
    // User A creates a favorite
    const resA = await call('POST', '/api/tools/color/favorites', {
      user: USER_A,
      body: { name: 'Emerald', hex: '#2ecc71', tags: ['green'] },
    })
    expect(resA.status).toBe(200)

    // User B lists favorites -> must be empty
    const resB = await call('GET', '/api/tools/color/favorites', { user: USER_B })
    const dataB = await resB.json<{ ok: boolean; data: unknown[] }>()
    expect(dataB.data).toHaveLength(0)

    // User A creates a palette
    await call('POST', '/api/tools/color/palettes', {
      user: USER_A,
      body: {
        title: 'Sunset',
        colors: [{ hex: '#ff512f' }, { hex: '#dd2476' }],
      },
    })

    // User B lists palettes -> must be empty
    const palB = await call('GET', '/api/tools/color/palettes', { user: USER_B })
    const palDataB = await palB.json<{ ok: boolean; data: unknown[] }>()
    expect(palDataB.data).toHaveLength(0)
  })
})

describe('Color Assistant Settings Routes', () => {
  it('handles GET and PUT /settings', async () => {
    const getRes = await call('GET', '/api/tools/color/settings')
    expect(getRes.status).toBe(200)
    const initial = await getRes.json<{ ok: boolean; data: { stripHash: boolean; defaultFormat: string } }>()
    expect(initial.data.stripHash).toBe(false)
    expect(initial.data.defaultFormat).toBe('hex')

    const putRes = await call('PUT', '/api/tools/color/settings', {
      body: { stripHash: true, defaultFormat: 'rgb' },
    })
    expect(putRes.status).toBe(200)
    const updated = await putRes.json<{ ok: boolean; data: { stripHash: boolean; defaultFormat: string } }>()
    expect(updated.data.stripHash).toBe(true)
    expect(updated.data.defaultFormat).toBe('rgb')
  })
})

describe('Color Assistant Favorites Routes', () => {
  it('creates, lists with filter, updates and deletes favorites', async () => {
    const createRes = await call('POST', '/api/tools/color/favorites', {
      body: {
        name: 'Ocean Blue',
        hex: '#0078d4',
        tags: ['blue', 'ui'],
        note: 'Brand primary',
      },
    })
    expect(createRes.status).toBe(200)
    const created = await createRes.json<{ ok: boolean; data: { id: string; hex: string } }>()
    const id = created.data.id
    expect(created.data.hex).toBe('#0078d4')

    // Filter by tag
    const listRes = await call('GET', '/api/tools/color/favorites?tag=blue')
    const listData = await listRes.json<{ ok: boolean; data: Array<{ id: string }> }>()
    expect(listData.data).toHaveLength(1)
    expect(listData.data[0].id).toBe(id)

    // Update
    const updateRes = await call('PUT', `/api/tools/color/favorites/${id}`, {
      body: { name: 'Deep Ocean Blue' },
    })
    expect(updateRes.status).toBe(200)

    // Delete
    const delRes = await call('DELETE', `/api/tools/color/favorites/${id}`)
    expect(delRes.status).toBe(200)

    // List after delete
    const listAfter = await call('GET', '/api/tools/color/favorites')
    const afterData = await listAfter.json<{ ok: boolean; data: unknown[] }>()
    expect(afterData.data).toHaveLength(0)
  })
})

describe('Color Assistant Palettes Routes', () => {
  it('creates, lists, toggles favorite and deletes palettes', async () => {
    const createRes = await call('POST', '/api/tools/color/palettes', {
      body: {
        title: 'Retro Neon',
        colors: [{ hex: '#f72585' }, { hex: '#7209b7' }, { hex: '#4cc9f0' }],
        sourceType: 'colorhunt',
        tags: ['neon', 'retro'],
        isFavorite: true,
      },
    })
    expect(createRes.status).toBe(200)
    const created = await createRes.json<{ ok: boolean; data: { id: string; isFavorite: boolean } }>()
    const id = created.data.id
    expect(created.data.isFavorite).toBe(true)

    // Toggle favorite
    const toggleRes = await call('POST', `/api/tools/color/palettes/${id}/favorite`)
    expect(toggleRes.status).toBe(200)
    const toggled = await toggleRes.json<{ ok: boolean; data: { isFavorite: boolean } }>()
    expect(toggled.data.isFavorite).toBe(false)

    // Delete
    const delRes = await call('DELETE', `/api/tools/color/palettes/${id}`)
    expect(delRes.status).toBe(200)
  })
})

describe('Color Assistant History Routes', () => {
  it('adds history and clears history', async () => {
    await call('POST', '/api/tools/color/history', {
      body: { hex: '#627486', source: 'studio' },
    })
    await call('POST', '/api/tools/color/history', {
      body: { hex: '#2ecc71', source: 'eyedropper' },
    })

    const listRes = await call('GET', '/api/tools/color/history')
    const list = await listRes.json<{ ok: boolean; data: Array<{ hex: string }> }>()
    expect(list.data).toHaveLength(2)

    await call('DELETE', '/api/tools/color/history')
    const emptyRes = await call('GET', '/api/tools/color/history')
    const emptyList = await emptyRes.json<{ ok: boolean; data: unknown[] }>()
    expect(emptyList.data).toHaveLength(0)
  })
})

describe('Color Assistant AI & Assets Routes', () => {
  it('handles /ai/generate and /ai/interpret with graceful fallback', async () => {
    const genRes = await call('POST', '/api/tools/color/ai/generate', {
      body: { seedHex: '#627486', style: '现代简约', count: 5 },
    })
    expect(genRes.status).toBe(200)
    const genData = await genRes.json<{ ok: boolean; data: { colors: Array<{ hex: string }> } }>()
    expect(genData.data.colors.length).toBeGreaterThanOrEqual(4)

    const interRes = await call('POST', '/api/tools/color/ai/interpret', {
      body: { colors: ['#627486', '#bad0bf'], theme: '山水画' },
    })
    expect(interRes.status).toBe(200)
    const interData = await interRes.json<{ ok: boolean; data: Array<{ name: string; story: string }> }>()
    expect(interData.data).toHaveLength(2)
    expect(interData.data[0].name).toBeTruthy()
    expect(interData.data[0].story).toBeTruthy()
  })

  it('uploads color poster asset to R2 in canonical path and serves it', async () => {
    const svgData = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="#627486"/></svg>'
    const uploadRes = await call('POST', '/api/tools/color/assets/upload', {
      body: {
        assetType: 'palette_poster',
        fileFormat: 'svg',
        data: svgData,
        metadata: { title: 'My Palette' },
      },
    })
    expect(uploadRes.status).toBe(200)
    const uploaded = await uploadRes.json<{
      ok: boolean
      data: { id: string; r2Key: string; downloadUrl: string }
    }>()
    expect(uploaded.data.r2Key).toContain('tools/color/svg/')

    // Download asset
    const getAssetRes = await call('GET', `/api/tools/color/assets/${uploaded.data.id}`)
    expect(getAssetRes.status).toBe(200)
    expect(getAssetRes.headers.get('content-type')).toContain('image/svg+xml')
    const text = await getAssetRes.text()
    expect(text).toContain('<svg')
  })
})
