// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TOOLS_QRCODE_REQUIRED_COLUMNS,
  TOOLS_QRCODE_REQUIRED_INDEXES,
  TOOLS_QRCODE_REQUIRED_TABLES,
  TOOLS_QRCODE_SCHEMA_STATEMENTS,
} from '../src/worker/tools/qrcode/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsQrcodeRoutes } from '../src/worker/routes/tools-qrcode'
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

  app.use('/api/tools/qrcode/*', async (c, next) => {
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

  app.route('/api/tools/qrcode', toolsQrcodeRoutes)
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
  }
  let body: BodyInit | undefined
  if (options.body !== undefined) {
    if (options.body instanceof FormData) {
      body = options.body
    } else {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
  }
  return app.fetch(
    new Request(`http://localhost${path}`, { method, headers, body }),
    env,
  )
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_QRCODE_SCHEMA_STATEMENTS) {
    sqlite.exec(statement)
  }
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
})

afterEach(() => {
  sqlite.close()
})

describe('QR Code Tool D1 Schema & Database Invariants', () => {
  it('creates all 3 required tables and 3 indexes', () => {
    const tableRows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>
    const tables = new Set(tableRows.map((r) => r.name))
    for (const table of TOOLS_QRCODE_REQUIRED_TABLES) {
      expect(tables.has(table), `Table ${table} should exist`).toBe(true)
    }

    const indexRows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>
    const indexes = new Set(indexRows.map((r) => r.name))
    for (const idx of TOOLS_QRCODE_REQUIRED_INDEXES) {
      expect(indexes.has(idx), `Index ${idx} should exist`).toBe(true)
    }

    for (const [table, requiredCols] of Object.entries(TOOLS_QRCODE_REQUIRED_COLUMNS)) {
      const colRows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      const cols = new Set(colRows.map((c) => c.name))
      for (const col of requiredCols) {
        expect(cols.has(col), `Column ${col} in ${table} should exist`).toBe(true)
      }
    }
  })
})

describe('Authentication & Tenant Isolation', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await call('GET', '/api/tools/qrcode/records', { user: null })
    expect(res.status).toBe(401)
  })

  it('isolates records strictly between users', async () => {
    const createRes = await call('POST', '/api/tools/qrcode/records', {
      user: USER_A,
      body: {
        title: 'Alice Secret Note',
        contentType: 'text',
        contentRaw: 'Alice secret message',
        fileType: 'png',
      },
    })
    expect(createRes.status).toBe(201)
    const created = await json<{ data: { id: string } }>(createRes)
    const recordId = created.data.id

    const listARes = await call('GET', '/api/tools/qrcode/records', { user: USER_A })
    const listA = await json<{ data: { items: Array<{ id: string }> } }>(listARes)
    expect(listA.data.items.some((item) => item.id === recordId)).toBe(true)

    const listBRes = await call('GET', '/api/tools/qrcode/records', { user: USER_B })
    const listB = await json<{ data: { items: Array<{ id: string }> } }>(listBRes)
    expect(listB.data.items.some((item) => item.id === recordId)).toBe(false)

    const getBRes = await call('GET', `/api/tools/qrcode/records/${recordId}`, { user: USER_B })
    expect(getBRes.status).toBe(404)

    const deleteBRes = await call('DELETE', `/api/tools/qrcode/records/${recordId}`, { user: USER_B })
    expect(deleteBRes.status).toBe(404)
  })

  it('isolates settings between users', async () => {
    const putRes = await call('PUT', '/api/tools/qrcode/settings', {
      user: USER_A,
      body: {
        defaultErrorCorrection: 'H',
        defaultSize: 1500,
        defaultFormat: 'svg',
        autoSaveHistory: false,
      },
    })
    expect(putRes.status).toBe(200)

    const getARes = await call('GET', '/api/tools/qrcode/settings', { user: USER_A })
    const getA = await json<{ data: { defaultErrorCorrection: string; defaultSize: number; autoSaveHistory: boolean } }>(getARes)
    expect(getA.data.defaultErrorCorrection).toBe('H')
    expect(getA.data.defaultSize).toBe(1500)
    expect(getA.data.autoSaveHistory).toBe(false)

    const getBRes = await call('GET', '/api/tools/qrcode/settings', { user: USER_B })
    const getB = await json<{ data: { defaultErrorCorrection: string; defaultSize: number; autoSaveHistory: boolean } }>(getBRes)
    expect(getB.data.defaultErrorCorrection).toBe('Q')
    expect(getB.data.defaultSize).toBe(1000)
    expect(getB.data.autoSaveHistory).toBe(true)
  })
})

describe('Records API with R2 Storage', () => {
  it('creates, reads, downloads and deletes a record with file data in R2', async () => {
    const dummyBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const createRes = await call('POST', '/api/tools/qrcode/records', {
      user: USER_A,
      body: {
        title: 'Wifi QR',
        contentType: 'wifi',
        contentRaw: 'WIFI:S:MyWifi;T:WPA;P:secret123;;',
        fileType: 'png',
        fileData: `data:image/png;base64,${dummyBase64}`,
        options: {
          errorCorrectionLevel: 'M',
          dotShape: 'rounded',
        },
      },
    })
    expect(createRes.status).toBe(201)
    const created = await json<{
      data: {
        id: string
        r2Key: string
        fileType: string
        fileSize: number
        contentType: string
      }
    }>(createRes)

    expect(created.data.contentType).toBe('wifi')
    expect(created.data.r2Key).toMatch(/^tools\/qrcode\/png\/user-alice\/[a-z0-9-]+\.png$/)
    expect(created.data.fileSize).toBeGreaterThan(0)
    const recordId = created.data.id

    const fileRes = await call('GET', `/api/tools/qrcode/records/${recordId}/file`, { user: USER_A })
    expect(fileRes.status).toBe(200)
    expect(fileRes.headers.get('Content-Type')).toBe('image/png')
    const fileBytes = new Uint8Array(await fileRes.arrayBuffer())
    expect(fileBytes.length).toBe(created.data.fileSize)

    const listRes = await call('GET', '/api/tools/qrcode/records?contentType=wifi', { user: USER_A })
    const list = await json<{ data: { items: Array<{ id: string }>; total: number } }>(listRes)
    expect(list.data.total).toBe(1)
    expect(list.data.items[0].id).toBe(recordId)

    const delRes = await call('DELETE', `/api/tools/qrcode/records/${recordId}`, { user: USER_A })
    expect(delRes.status).toBe(200)

    const getRes = await call('GET', `/api/tools/qrcode/records/${recordId}`, { user: USER_A })
    expect(getRes.status).toBe(404)

    const fileAfterDel = await call('GET', `/api/tools/qrcode/records/${recordId}/file`, { user: USER_A })
    expect(fileAfterDel.status).toBe(404)
  })

  it('supports raw SVG vector upload and storage', async () => {
    const rawSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="black"/></svg>'
    const createRes = await call('POST', '/api/tools/qrcode/records', {
      user: USER_A,
      body: {
        title: 'Vector QR',
        contentType: 'url',
        contentRaw: 'https://inkstone.example.com',
        fileType: 'svg',
        fileData: rawSvg,
      },
    })
    expect(createRes.status).toBe(201)
    const created = await json<{ data: { id: string; r2Key: string; fileType: string } }>(createRes)
    expect(created.data.r2Key).toMatch(/^tools\/qrcode\/svg\/user-alice\/[a-z0-9-]+\.svg$/)

    const fileRes = await call('GET', `/api/tools/qrcode/records/${created.data.id}/file`, { user: USER_A })
    expect(fileRes.status).toBe(200)
    expect(fileRes.headers.get('Content-Type')).toBe('image/svg+xml')
    const text = await fileRes.text()
    expect(text).toBe(rawSvg)
  })

  it('handles search queries and pagination correctly', async () => {
    for (let i = 1; i <= 5; i++) {
      await call('POST', '/api/tools/qrcode/records', {
        user: USER_A,
        body: {
          title: `Item ${i}`,
          contentType: 'text',
          contentRaw: `Payload content ${i}`,
        },
      })
    }

    const page1Res = await call('GET', '/api/tools/qrcode/records?limit=2&offset=0', { user: USER_A })
    const page1 = await json<{ data: { items: Array<{ title: string }>; total: number } }>(page1Res)
    expect(page1.data.total).toBe(5)
    expect(page1.data.items.length).toBe(2)

    const searchRes = await call('GET', '/api/tools/qrcode/records?search=Item%203', { user: USER_A })
    const search = await json<{ data: { items: Array<{ title: string }>; total: number } }>(searchRes)
    expect(search.data.total).toBe(1)
    expect(search.data.items[0].title).toBe('Item 3')
  })
})

describe('Templates API', () => {
  it('manages built-in and user custom templates', async () => {
    sqlite
      .prepare(
        `INSERT INTO tools_qrcode_t_templates (
           user_id, id, name, category, preview_svg, options_json, is_builtin, sort, created_at, updated_at
         ) VALUES ('__builtin__', 'builtin-minimal', 'Default Minimal', 'minimal', '<svg></svg>', '{}', 1, 0, 100, 100)`,
      )
      .run()

    const listA = await json<{ data: Array<{ id: string; isBuiltin: boolean }> }>(
      await call('GET', '/api/tools/qrcode/templates', { user: USER_A }),
    )
    expect(listA.data.some((t) => t.id === 'builtin-minimal' && t.isBuiltin)).toBe(true)

    const listB = await json<{ data: Array<{ id: string; isBuiltin: boolean }> }>(
      await call('GET', '/api/tools/qrcode/templates', { user: USER_B }),
    )
    expect(listB.data.some((t) => t.id === 'builtin-minimal' && t.isBuiltin)).toBe(true)

    const delBuiltinRes = await call('DELETE', '/api/tools/qrcode/templates/builtin-minimal', { user: USER_A })
    expect(delBuiltinRes.status).toBe(403)

    const createRes = await call('POST', '/api/tools/qrcode/templates', {
      user: USER_A,
      body: {
        name: 'Alice Neon Template',
        category: 'artistic',
        options: { dotColor: '#00ffcc' },
      },
    })
    expect(createRes.status).toBe(201)
    const custom = await json<{ data: { id: string; isBuiltin: boolean } }>(createRes)
    expect(custom.data.isBuiltin).toBe(false)
    const customId = custom.data.id

    const updateRes = await call('PUT', `/api/tools/qrcode/templates/${customId}`, {
      user: USER_A,
      body: {
        name: 'Alice Neon Template v2',
        options: { dotColor: '#ff0077' },
      },
    })
    expect(updateRes.status).toBe(200)
    const updated = await json<{ data: { name: string } }>(updateRes)
    expect(updated.data.name).toBe('Alice Neon Template v2')

    const delBRes = await call('DELETE', `/api/tools/qrcode/templates/${customId}`, { user: USER_B })
    expect(delBRes.status).toBe(404)

    const delARes = await call('DELETE', `/api/tools/qrcode/templates/${customId}`, { user: USER_A })
    expect(delARes.status).toBe(200)
  })
})

describe('Logo Upload API', () => {
  it('uploads logo via JSON base64 and retrieves it', async () => {
    const dummyBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const uploadRes = await call('POST', '/api/tools/qrcode/upload-logo', {
      user: USER_A,
      body: {
        filename: 'my-logo.png',
        fileData: `data:image/png;base64,${dummyBase64}`,
      },
    })
    expect(uploadRes.status).toBe(201)
    const uploaded = await json<{ data: { key: string; size: number; logoId: string; url: string } }>(uploadRes)
    expect(uploaded.data.key).toMatch(/^tools\/qrcode\/logo\/user-alice\/[a-z0-9-]+\.png$/)
    expect(uploaded.data.size).toBeGreaterThan(0)

    const getLogoRes = await call('GET', `/api/tools/qrcode/logo/${uploaded.data.logoId}?ext=png`, { user: USER_A })
    expect(getLogoRes.status).toBe(200)
    expect(getLogoRes.headers.get('Content-Type')).toBe('image/png')
  })

  it('uploads logo via multipart/form-data', async () => {
    const formData = new FormData()
    const blob = new Blob(['test-logo-bytes'], { type: 'image/png' })
    formData.append('file', blob, 'avatar.png')

    const uploadRes = await call('POST', '/api/tools/qrcode/upload-logo', {
      user: USER_A,
      body: formData,
    })
    expect(uploadRes.status).toBe(201)
    const uploaded = await json<{ data: { key: string; size: number; logoId: string } }>(uploadRes)
    expect(uploaded.data.size).toBe(15)
  })

  it('fails gracefully with 503 if R2 storage is unavailable', async () => {
    env = testBindings(makeD1(sqlite), { FILES: undefined })

    const dummyBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const uploadRes = await call('POST', '/api/tools/qrcode/upload-logo', {
      user: USER_A,
      body: {
        filename: 'my-logo.png',
        fileData: `data:image/png;base64,${dummyBase64}`,
      },
    })
    expect(uploadRes.status).toBe(503)
    const err = await json<{ error: { code: string } }>(uploadRes)
    expect(err.error.code).toBe('storage_unavailable')
  })
})
