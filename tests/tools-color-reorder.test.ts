// @vitest-environment node
/**
 * Moving a saved colour or palette to a new place in the list.
 *
 * The `sort` column and the `ORDER BY sort` read were there from the start, and the update endpoints could
 * already write it — nothing in the interface ever asked to, so the whole ordering machinery was dead and a
 * reader's collection stayed in creation order forever.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { COLOR_LIST_LIMIT } from '@shared/tools/color/contract'
import { TOOLS_COLOR_SCHEMA_STATEMENTS } from '../src/worker/tools/color/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { toolsColorRoutes } from '../src/worker/routes/tools-color'
import type { AppBindings, Env } from '../src/worker/env'
import { testBindings, testR2Bucket } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER_A = 'user-alice'
const USER_B = 'user-bob'

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('/api/tools/color/*', async (c, next) => {
  const userId = c.req.header('x-test-user')
  if (userId) {
    c.set('userId', userId)
    c.set('user', {
      id: userId, username: userId, login: userId, name: userId, avatarUrl: '', role: 'member', createdAt: 0, settingsRaw: '{}',
    })
  }
  await next()
})
app.route('/api/tools/color', toolsColorRoutes)

let sqlite: DatabaseSync
let env: Env

async function call(
  method: string,
  path: string,
  body?: unknown,
  user: string | null = USER_A,
): Promise<Response> {
  const headers: Record<string, string> = { 'X-Inkstone-Client': '1', 'content-type': 'application/json' }
  if (user) headers['x-test-user'] = user
  return app.fetch(
    new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  )
}

async function createFavorites(ids: string[]): Promise<void> {
  for (const id of ids) {
    const res = await call('POST', '/api/tools/color/favorites', { id, hex: '#22aa33', name: id })
    expect(res.status).toBe(200)
  }
}

async function listFavorites(user = USER_A): Promise<Array<{ id: string; sort: number }>> {
  const res = await call('GET', '/api/tools/color/favorites', undefined, user)
  const body = await res.json<{ data: Array<{ id: string; sort: number }> }>()
  return body.data
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of TOOLS_COLOR_SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite), { FILES: testR2Bucket() })
})

describe('favorite order', () => {
  it('writes the position the reader put each colour in', async () => {
    await createFavorites(['fav_aaa1', 'fav_bbb2', 'fav_ccc3'])
    expect((await listFavorites()).map((f) => f.id)).toEqual(['fav_ccc3', 'fav_bbb2', 'fav_aaa1'])

    const res = await call('PUT', '/api/tools/color/favorites/-/order', { ids: ['fav_bbb2', 'fav_ccc3', 'fav_aaa1'] })
    expect(res.status).toBe(200)

    expect((await listFavorites()).map((f) => f.id)).toEqual(['fav_bbb2', 'fav_ccc3', 'fav_aaa1'])
    expect((await listFavorites()).map((f) => f.sort)).toEqual([0, 1, 2])
  })

  it('answers with the re-read list, so the client has one source of truth', async () => {
    await createFavorites(['fav_aaa1', 'fav_bbb2'])
    const res = await call('PUT', '/api/tools/color/favorites/-/order', { ids: ['fav_bbb2', 'fav_aaa1'] })
    const body = await res.json<{ data: Array<{ id: string }> }>()
    expect(body.data.map((f) => f.id)).toEqual(['fav_bbb2', 'fav_aaa1'])
  })

  it('leaves another account’s rows where they are', async () => {
    await createFavorites(['fav_aaa1', 'fav_bbb2'])
    await call('POST', '/api/tools/color/favorites', { id: 'fav_ddd4', hex: '#ff0000', name: 'theirs' }, USER_B)

    const res = await call('PUT', '/api/tools/color/favorites/-/order', { ids: ['fav_ddd4', 'fav_bbb2', 'fav_aaa1'] })
    expect(res.status).toBe(200)

    // The other account never ordered anything, so its row keeps the default position.
    const theirs = (await listFavorites(USER_B)).find((f) => f.id === 'fav_ddd4')
    expect(theirs!.sort).toBe(0)
    expect((await listFavorites()).map((f) => f.id)).toEqual(['fav_bbb2', 'fav_aaa1'])
  })

  it('refuses an empty list, a malformed id and more ids than a page', async () => {
    await createFavorites(['fav_aaa1'])

    expect((await call('PUT', '/api/tools/color/favorites/-/order', { ids: [] })).status).toBe(400)
    expect((await call('PUT', '/api/tools/color/favorites/-/order', { ids: ['<svg onload=1>'] })).status).toBe(400)
    expect(
      (
        await call('PUT', '/api/tools/color/favorites/-/order', {
          ids: Array.from({ length: COLOR_LIST_LIMIT + 1 }, (_, i) => `fav_${String(i).padStart(4, '0')}`),
        })
      ).status,
    ).toBe(400)
  })

  it('needs an account', async () => {
    const res = await call('PUT', '/api/tools/color/favorites/-/order', { ids: ['fav_aaa1'] }, null)
    expect(res.status).toBe(401)
  })
})

describe('palette order', () => {
  async function createPalettes(ids: string[]): Promise<void> {
    for (const id of ids) {
      const res = await call('POST', '/api/tools/color/palettes', { id, title: id, colors: [{ hex: '#22aa33' }] })
      expect(res.status).toBe(200)
    }
  }

  async function listPalettes(): Promise<Array<{ id: string; sort: number }>> {
    const res = await call('GET', '/api/tools/color/palettes')
    const body = await res.json<{ data: Array<{ id: string; sort: number }> }>()
    return body.data
  }

  it('writes the palette order the same way', async () => {
    await createPalettes(['pal_aaa1', 'pal_bbb2', 'pal_ccc3'])

    const res = await call('PUT', '/api/tools/color/palettes/-/order', { ids: ['pal_ccc3', 'pal_aaa1', 'pal_bbb2'] })
    expect(res.status).toBe(200)
    expect((await listPalettes()).map((p) => p.id)).toEqual(['pal_ccc3', 'pal_aaa1', 'pal_bbb2'])
    expect((await listPalettes()).map((p) => p.sort)).toEqual([0, 1, 2])
  })

  it('does not invent rows: an id that is not the reader’s changes nothing of theirs', async () => {
    await createPalettes(['pal_aaa1'])
    const res = await call('PUT', '/api/tools/color/palettes/-/order', { ids: ['pal_zzz9', 'pal_aaa1'] })
    expect(res.status).toBe(200)
    expect((await listPalettes()).map((p) => p.id)).toEqual(['pal_aaa1'])
  })
})
