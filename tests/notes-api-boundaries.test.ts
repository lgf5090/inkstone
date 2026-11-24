// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { notesRoutes } from '../src/worker/routes/notes'
import { searchRoutes } from '../src/worker/routes/search'
import { errorResponse } from '../src/worker/lib/errors'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-a'
const ctx: ExecutionContext = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} }
let app: Hono<AppBindings>
let env: { DB: D1Database }

beforeEach(() => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = { DB: makeD1(sqlite) }
  app = new Hono<AppBindings>()
  app.onError((err, c) => errorResponse(c, err))
  app.use('*', async (c, next) => {
    c.set('userId', USER)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/api/notes', notesRoutes)
  app.route('/api', searchRoutes)
})

async function jsonRequest(path: string, body: string): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }), env as never, ctx)
}

describe('notes API JSON boundaries', () => {
  it('rejects malformed rebuild JSON instead of treating it as an empty request', async () => {
    expect((await jsonRequest('/api/notes/rebuild-derived', '{')).status).toBe(400)
  })

  it('rejects an oversized rebuild body before acquiring a lease', async () => {
    const body = JSON.stringify({ cursor: 'a'.repeat(9 * 1024) })
    expect((await jsonRequest('/api/notes/rebuild-derived', body)).status).toBe(413)
  })

  it('rejects malformed search document JSON', async () => {
    expect((await jsonRequest('/api/search/documents', '{')).status).toBe(400)
  })

  it('rejects an oversized search document body', async () => {
    const body = JSON.stringify({ ids: ['a'.repeat(9 * 1024)] })
    expect((await jsonRequest('/api/search/documents', body)).status).toBe(413)
  })
})
