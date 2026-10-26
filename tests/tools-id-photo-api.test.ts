// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TOOLS_ID_PHOTO_REQUIRED_COLUMNS,
  TOOLS_ID_PHOTO_REQUIRED_INDEXES,
  TOOLS_ID_PHOTO_REQUIRED_TABLES,
  TOOLS_ID_PHOTO_SCHEMA_STATEMENTS,
} from '../src/worker/tools/id-photo/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsIdPhotoRoutes } from '../src/worker/routes/tools-id-photo'
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

  app.use('/api/tools/id-photo/*', async (c, next) => {
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

  app.route('/api/tools/id-photo', toolsIdPhotoRoutes)
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
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  return app.fetch(
    new Request(`http://localhost${path}`, { method, headers, body }),
    env,
  )
}

describe('ID Photo Tool D1 Schema & Invariants', () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    for (const statement of TOOLS_ID_PHOTO_SCHEMA_STATEMENTS) {
      sqlite.exec(statement)
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it('creates all 3 required tables and 3 indexes', () => {
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((row: unknown) => (row as { name: string }).name)

    for (const table of TOOLS_ID_PHOTO_REQUIRED_TABLES) {
      expect(tables).toContain(table)
    }

    const indexes = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all()
      .map((row: unknown) => (row as { name: string }).name)

    for (const index of TOOLS_ID_PHOTO_REQUIRED_INDEXES) {
      expect(indexes).toContain(index)
    }

    for (const [table, columns] of Object.entries(TOOLS_ID_PHOTO_REQUIRED_COLUMNS)) {
      const tableCols = sqlite
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row: unknown) => (row as { name: string }).name)

      for (const col of columns) {
        expect(tableCols, `Table ${table} must contain column ${col}`).toContain(col)
      }
    }
  })
})

describe('ID Photo Routes, Tenant Isolation & R2 Storage', () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    for (const statement of TOOLS_ID_PHOTO_SCHEMA_STATEMENTS) {
      sqlite.exec(statement)
    }
    const bucket = testR2Bucket()
    env = testBindings(makeD1(sqlite), {
      FILES: bucket,
    })
  })

  afterEach(() => {
    sqlite.close()
  })

  it('rejects unauthenticated requests with 401', async () => {
    const res = await call('GET', '/api/tools/id-photo/records', { user: null })
    expect(res.status).toBe(401)
  })

  it('creates, lists, reads, downloads and deletes ID photo record with R2 files', async () => {
    const fakeImageBase64 = 'data:image/jpeg;base64,' + btoa('fake-jpeg-photo-bytes')
    const fakePrintBase64 = 'data:image/jpeg;base64,' + btoa('fake-print-sheet-bytes')

    const createRes = await call('POST', '/api/tools/id-photo/records', {
      user: USER_A,
      body: {
        title: 'My 1 Inch Photo',
        specId: 'cn_one_inch',
        specName: '标准一寸',
        widthPx: 295,
        heightPx: 413,
        widthMm: 25,
        heightMm: 35,
        dpi: 300,
        bgColor: '#ffffff',
        options: { brightness: 10, smoothness: 20 },
        fileData: fakeImageBase64,
        printFileData: fakePrintBase64,
        fileType: 'jpg',
      },
    })

    expect(createRes.status).toBe(201)
    const createdJson = (await createRes.json()) as { ok: boolean; data: { id: string; r2Key: string; printR2Key: string } }
    expect(createdJson.ok).toBe(true)
    const recordId = createdJson.data.id
    expect(createdJson.data.r2Key).toBe(`tools/id_photo/jpg/${USER_A}/${recordId}.jpg`)
    expect(createdJson.data.printR2Key).toBe(`tools/id_photo/print/${USER_A}/${recordId}_print.jpg`)

    // Verify list
    const listRes = await call('GET', '/api/tools/id-photo/records', { user: USER_A })
    expect(listRes.status).toBe(200)
    const listJson = (await listRes.json()) as { ok: boolean; data: { records: Array<{ id: string; title: string }>; total: number } }
    expect(listJson.data.total).toBe(1)
    expect(listJson.data.records[0].id).toBe(recordId)
    expect(listJson.data.records[0].title).toBe('My 1 Inch Photo')

    // Verify isolation - user B should have 0 records
    const listBRes = await call('GET', '/api/tools/id-photo/records', { user: USER_B })
    const listBJson = (await listBRes.json()) as { ok: boolean; data: { total: number } }
    expect(listBJson.data.total).toBe(0)

    // Download single photo
    const downloadRes = await call('GET', `/api/tools/id-photo/records/${recordId}/file`, { user: USER_A })
    expect(downloadRes.status).toBe(200)
    expect(downloadRes.headers.get('content-type')).toBe('image/jpeg')
    const text = await downloadRes.text()
    expect(text).toBe('fake-jpeg-photo-bytes')

    // Download print sheet
    const downloadPrintRes = await call('GET', `/api/tools/id-photo/records/${recordId}/print-file`, { user: USER_A })
    expect(downloadPrintRes.status).toBe(200)
    const printText = await downloadPrintRes.text()
    expect(printText).toBe('fake-print-sheet-bytes')

    // Delete record
    const deleteRes = await call('DELETE', `/api/tools/id-photo/records/${recordId}`, { user: USER_A })
    expect(deleteRes.status).toBe(200)

    // Verify deleted
    const getRes = await call('GET', `/api/tools/id-photo/records/${recordId}`, { user: USER_A })
    expect(getRes.status).toBe(404)
  })

  it('manages custom specs and user settings with tenant isolation', async () => {
    // Create custom spec
    const createSpecRes = await call('POST', '/api/tools/id-photo/specs', {
      user: USER_A,
      body: {
        name: 'Custom Visa 40x50',
        category: 'custom',
        countryCode: 'XX',
        widthMm: 40,
        heightMm: 50,
        dpi: 300,
        recommendedBgColors: ['#ffffff', '#438EDB'],
        faceRatioMin: 0.65,
        faceRatioMax: 0.75,
      },
    })

    expect(createSpecRes.status).toBe(201)
    const specJson = (await createSpecRes.json()) as { ok: boolean; data: { id: string; name: string } }
    expect(specJson.data.name).toBe('Custom Visa 40x50')
    const specId = specJson.data.id

    // User A can list it
    const listSpecsRes = await call('GET', '/api/tools/id-photo/specs', { user: USER_A })
    const listSpecsJson = (await listSpecsRes.json()) as { ok: boolean; data: Array<{ id: string }> }
    expect(listSpecsJson.data.length).toBe(1)
    expect(listSpecsJson.data[0].id).toBe(specId)

    // User B cannot see user A's custom spec
    const listSpecsBRes = await call('GET', '/api/tools/id-photo/specs', { user: USER_B })
    const listSpecsBJson = (await listSpecsBRes.json()) as { ok: boolean; data: Array<{ id: string }> }
    expect(listSpecsBJson.data.length).toBe(0)

    // Settings API
    const getSettingsRes = await call('GET', '/api/tools/id-photo/settings', { user: USER_A })
    expect(getSettingsRes.status).toBe(200)
    const settingsJson = (await getSettingsRes.json()) as { ok: boolean; data: { defaultSpecId: string; defaultDpi: number } }
    expect(settingsJson.data.defaultSpecId).toBe('cn_one_inch')
    expect(settingsJson.data.defaultDpi).toBe(300)

    const updateSettingsRes = await call('PUT', '/api/tools/id-photo/settings', {
      user: USER_A,
      body: {
        defaultSpecId: 'intl_us_passport',
        defaultBgColor: '#004098',
        printPaperSize: '5inch',
      },
    })
    expect(updateSettingsRes.status).toBe(200)
    const updatedJson = (await updateSettingsRes.json()) as { ok: boolean; data: { defaultSpecId: string; defaultBgColor: string } }
    expect(updatedJson.data.defaultSpecId).toBe('intl_us_passport')
    expect(updatedJson.data.defaultBgColor).toBe('#004098')

    // User B's settings remain untouched
    const getSettingsBRes = await call('GET', '/api/tools/id-photo/settings', { user: USER_B })
    const settingsBJson = (await getSettingsBRes.json()) as { ok: boolean; data: { defaultSpecId: string } }
    expect(settingsBJson.data.defaultSpecId).toBe('cn_one_inch')

    // Delete custom spec
    const deleteSpecRes = await call('DELETE', `/api/tools/id-photo/specs/${specId}`, { user: USER_A })
    expect(deleteSpecRes.status).toBe(200)
  })
})
