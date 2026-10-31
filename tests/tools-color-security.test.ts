// @vitest-environment node
/**
 * The color module's upload and quota surface.
 *
 * These are the checks the reviewer could only describe as "the client decides" before: what content type
 * a stored poster answers with, how big it may be, and how often one account may ask for a model.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COLOR_ASSET_MAX_BYTES } from '../src/shared/tools/color/contract'
import { TOOLS_COLOR_SCHEMA_STATEMENTS } from '../src/worker/tools/color/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsColorRoutes } from '../src/worker/routes/tools-color'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-alice'
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]

function toBase64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64')
}

function testApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/tools/color/*', async (c, next) => {
    c.set('userId', USER)
    await next()
  })
  app.route('/api/tools/color', toolsColorRoutes)
  return app
}

const app = testApp()
let sqlite: DatabaseSync
let env: Env

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'X-Inkstone-Client': '1', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_COLOR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
})

afterEach(() => {
  sqlite.close()
})

describe('Color asset upload', () => {
  it('serves the format allowlist, not the MIME the client sent', async () => {
    const res = await call('POST', '/api/tools/color/assets/upload', {
      assetType: 'palette_poster',
      fileFormat: 'png',
      data: `data:text/html;base64,${toBase64(PNG)}`,
    })
    expect(res.status).toBe(200)
    const uploaded = await res.json<{ data: { id: string } }>()

    const get = await call('GET', `/api/tools/color/assets/${uploaded.data.id}`)
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toContain('image/png')
    expect(get.headers.get('x-content-type-options')).toBe('nosniff')
    expect(get.headers.get('cache-control')).toMatch(/^private/)
  })

  it('refuses bytes that are not the claimed format', async () => {
    const html = Buffer.from('<html><body>hi</body></html>').toString('base64')
    const asPng = await call('POST', '/api/tools/color/assets/upload', {
      assetType: 'palette_poster',
      fileFormat: 'png',
      data: `data:image/png;base64,${html}`,
    })
    expect(asPng.status).toBe(400)

    const scriptingSvg = await call('POST', '/api/tools/color/assets/upload', {
      assetType: 'palette_poster',
      fileFormat: 'svg',
      data: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    })
    expect(scriptingSvg.status).toBe(400)

    const plainSvg = await call('POST', '/api/tools/color/assets/upload', {
      assetType: 'palette_poster',
      fileFormat: 'svg',
      data: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="#627486"/></svg>',
    })
    expect(plainSvg.status).toBe(200)
  })

  it('turns away a payload over the ceiling', async () => {
    const big = 'A'.repeat(Math.ceil((COLOR_ASSET_MAX_BYTES * 4) / 3) + 4096)
    const res = await call('POST', '/api/tools/color/assets/upload', {
      assetType: 'palette_poster',
      fileFormat: 'png',
      data: big,
    })
    // The schema ceiling answers 400 before the body is ever decoded.
    expect(res.status).toBe(400)
  })

  it('rejects a metadata blob that is not a flat scalar map', async () => {
    const res = await call('POST', '/api/tools/color/assets/upload', {
      assetType: 'palette_poster',
      fileFormat: 'png',
      data: `data:image/png;base64,${toBase64(PNG)}`,
      metadata: { nested: { deep: { deeper: 1 } } },
    })
    expect(res.status).toBe(400)
  })
})

describe('Color write conflicts', () => {
  it('answers 409 rather than 500 when a client reuses an id', async () => {
    const first = await call('POST', '/api/tools/color/favorites', {
      id: 'col_fav_fixed0001',
      hex: '#627486',
    })
    expect(first.status).toBe(200)

    const second = await call('POST', '/api/tools/color/favorites', {
      id: 'col_fav_fixed0001',
      hex: '#627486',
    })
    expect(second.status).toBe(409)
  })

  it('refuses an id that could not have been generated by the server', async () => {
    const res = await call('POST', '/api/tools/color/favorites', {
      id: 'x'.repeat(200),
      hex: '#627486',
    })
    expect(res.status).toBe(400)
  })
})

describe('Color AI budget', () => {
  it('stops a runaway client inside the same minute', async () => {
    let lastStatus = 0
    for (let i = 0; i < 8; i++) {
      lastStatus = (await call('POST', '/api/tools/color/ai/generate', { seedHex: '#627486', count: 3 })).status
    }
    expect(lastStatus).toBe(429)
  })
})
