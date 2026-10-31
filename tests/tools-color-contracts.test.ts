// @vitest-environment node
/**
 * Contract tests for the Color Assistant: the bounds and vocabularies the client controls and the server
 * validator have to agree on. Each one here was broken in a way every existing suite walked past, because
 * the two sides each held their own copy of the number.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COLOR_AI_INTERPRET_MAX,
  COLOR_AI_PALETTE_MAX,
  COLOR_EXTRACT_MAX,
  COLOR_HISTORY_SOURCES,
  COLOR_HISTORY_WINDOW,
  COLOR_PALETTE_MAX_COLORS,
} from '../src/shared/tools/color/contract'
import {
  AddColorHistorySchema,
  AiPoeticInterpretSchema,
  CreateColorPaletteSchema,
} from '../src/shared/tools/color/schemas'
import { TOOLS_COLOR_SCHEMA_STATEMENTS } from '../src/worker/tools/color/schema'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings, Env } from '../src/worker/env'
import { toolsColorRoutes } from '../src/worker/routes/tools-color'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-alice'
const COLOR_DIR = 'src/client/features/tools/color'

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return filesUnder(full)
    return /\.(ts|tsx)$/.test(full) && !full.includes('.test.') ? [full] : []
  })
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
  const headers: Record<string, string> = { 'X-Inkstone-Client': '1', 'content-type': 'application/json' }
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
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

describe('Color history sources', () => {
  it('accepts every source the shared vocabulary names', () => {
    for (const source of COLOR_HISTORY_SOURCES) {
      expect(AddColorHistorySchema.safeParse({ hex: '#627486', source }).success, source).toBe(true)
    }
  })

  it('has no client call site naming a source outside the vocabulary', () => {
    // The store types the argument, so tsc is the real guard; this scan is the tripwire for a call site
    // that reaches around the type with a widened parameter or a cast.
    const offenders: string[] = []
    for (const file of filesUnder(COLOR_DIR)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/setCurrent(?:Color|Hex)\(\s*[\s\S]*?,\s*'([a-z_]+)'\s*\)/g)) {
        if (!(COLOR_HISTORY_SOURCES as readonly string[]).includes(match[1])) {
          offenders.push(`${file}: ${match[1]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('Color AI bounds', () => {
  it('lets the image view name every color its slider can produce', () => {
    // The slider's right-hand end used to send COLOR_EXTRACT_MAX + 1 colors to a schema capped at 12.
    const worstCase = Array.from({ length: COLOR_EXTRACT_MAX + 1 }, () => '#627486')
    expect(worstCase.length).toBe(COLOR_AI_INTERPRET_MAX)
    expect(AiPoeticInterpretSchema.safeParse({ colors: worstCase }).success).toBe(true)
  })

  it('answers with exactly the colors asked for, and says when no model ran', async () => {
    const res = await call('POST', '/api/tools/color/ai/generate', {
      seedHex: '#627486',
      style: 'modern',
      count: COLOR_AI_PALETTE_MAX,
    })
    expect(res.status).toBe(200)
    const body = await res.json<{ ok: boolean; data: { colors: unknown[]; degraded: boolean; reason?: string } }>()
    expect(body.data.colors).toHaveLength(COLOR_AI_PALETTE_MAX)
    // This harness configures no assistant model, so a truthful answer has to admit it computed the palette.
    expect(body.data.degraded).toBe(true)
    expect(body.data.reason).toBeTruthy()
  })

  it('wraps poetic interpretations so a fallback cannot read as a model answer', async () => {
    const colors = ['#627486', '#bad0bf', '#f43f5e']
    const res = await call('POST', '/api/tools/color/ai/interpret', { colors, theme: '山水画' })
    expect(res.status).toBe(200)
    const body = await res.json<{
      ok: boolean
      data: { items: Array<{ hex: string; name: string; story: string }>; degraded: boolean; reason?: string }
    }>()
    expect(body.data.items).toHaveLength(colors.length)
    expect(body.data.items.map((i) => i.hex)).toEqual(colors)
    expect(body.data.degraded).toBe(true)
  })
})

describe('Color history window', () => {
  it('lists the whole window the server keeps', async () => {
    for (let i = 0; i < COLOR_HISTORY_WINDOW + 8; i++) {
      const hex = `#${(i * 2601 + 16).toString(16).padStart(6, '0').slice(-6)}`
      const res = await call('POST', '/api/tools/color/history', { hex, source: 'picker' })
      expect(res.status, hex).toBe(200)
    }
    const list = await (await call('GET', '/api/tools/color/history')).json<{ data: unknown[] }>()
    expect(list.data).toHaveLength(COLOR_HISTORY_WINDOW)
  })

  it('does not store the same color twice in a row', async () => {
    // A second tab, or a page re-read, used to add a fresh row for the color already on top.
    await call('POST', '/api/tools/color/history', { hex: '#123456', source: 'picker' })
    await call('POST', '/api/tools/color/history', { hex: '#123456', source: 'picker' })
    await call('POST', '/api/tools/color/history', { hex: '#123456', source: 'palette' })

    const list = await (await call('GET', '/api/tools/color/history')).json<{ data: Array<{ hex: string }> }>()
    expect(list.data).toHaveLength(1)
  })
})

describe('Color palette ceiling', () => {
  it('accepts the cap and rejects one over it', () => {
    const mk = (n: number) => Array.from({ length: n }, () => ({ hex: '#627486' }))
    expect(CreateColorPaletteSchema.safeParse({ title: 't', colors: mk(COLOR_PALETTE_MAX_COLORS) }).success).toBe(true)
    expect(CreateColorPaletteSchema.safeParse({ title: 't', colors: mk(COLOR_PALETTE_MAX_COLORS + 1) }).success).toBe(false)
  })
})
