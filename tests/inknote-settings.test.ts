// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_INKNOTE_SETTINGS } from '../src/shared/inknote/constants'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { inknoteSettingsRoutes } from '../src/worker/routes/inknote-settings'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const ALICE = '0123456789abcdefghjkmnpqrs'
const BOB = '0123456789abcdefghjkmnpqrt'

const mocks = { userId: ALICE }

function id(value: number): string {
  return String(value).padStart(26, '0')
}

let sqlite: DatabaseSync
let env: Env
let app: Hono<AppBindings>

async function send(
  method: string,
  path: string,
  body?: unknown,
  userId = ALICE,
): Promise<Response> {
  mocks.userId = userId
  return await app.request(
    `/api/inknote${path}`,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  for (const statement of SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite))
  mocks.userId = ALICE
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('/api/inknote/*', async (c, next) => {
    c.set('userId', mocks.userId)
    await next()
  })
  app.route('/api/inknote', inknoteSettingsRoutes)
})

describe('inknote settings', () => {
  it('answers defaults before the account has saved anything', async () => {
    const response = await send('GET', '/settings')
    expect(response.status).toBe(200)
    const settings = await json<{ config: unknown; updatedAt: number }>(response)
    expect(settings.updatedAt).toBe(0)
    expect(settings.config).toEqual(DEFAULT_INKNOTE_SETTINGS)
  })

  it('drops unknown fields and normalizes every value it stores', async () => {
    const response = await send('PUT', '/settings', {
      baseUpdatedAt: 0,
      config: {
        tool: 'eraser',
        penWidth: 999,
        aiPrompt: 'x'.repeat(3_000),
        openTabs: [id(1), id(1), 'not-an-id'],
        favorites: [{ tool: 'pen', color: '#123456', width: 5, style: 'normal', eraserSize: 20 }],
        unknown: 'drop me',
      },
    })
    expect(response.status).toBe(200)
    const saved = await json<{ config: Record<string, unknown>; updatedAt: number }>(response)
    expect(saved.updatedAt).toBeGreaterThan(0)
    expect(saved.config.tool).toBe('eraser')
    expect(saved.config.penWidth).toBe(30)
    expect(saved.config.aiPrompt).toBe('x'.repeat(2_000))
    expect(saved.config.openTabs).toEqual([id(1)])
    expect(saved.config).not.toHaveProperty('unknown')
    expect((saved.config.favorites as unknown[]).length).toBe(1)

    const reread = await json<{ config: Record<string, unknown>; updatedAt: number }>(
      await send('GET', '/settings'),
    )
    expect(reread).toEqual(saved)

    const bob = await json<{ config: unknown; updatedAt: number }>(await send('GET', '/settings', undefined, BOB))
    expect(bob.updatedAt).toBe(0)
    expect(bob.config).toEqual(DEFAULT_INKNOTE_SETTINGS)
  })

  it('rejects a stale baseUpdatedAt instead of overwriting another device', async () => {
    const first = await json<{ config: unknown; updatedAt: number }>(await send('PUT', '/settings', {
      config: { tool: 'pen' },
    }))
    const conflict = await send('PUT', '/settings', {
      config: { tool: 'text' },
      baseUpdatedAt: 0,
    })
    expect(conflict.status).toBe(409)
    const details = await json<{ error: { details: { current: { config: { tool: string }; updatedAt: number } } } }>(conflict)
    expect(details.error.details.current.config.tool).toBe('pen')
    expect(details.error.details.current.updatedAt).toBe(first.updatedAt)

    const accepted = await send('PUT', '/settings', {
      config: { tool: 'text' },
      baseUpdatedAt: first.updatedAt,
    })
    expect(accepted.status).toBe(200)
  })
})
