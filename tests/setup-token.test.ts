import { DatabaseSync } from 'node:sqlite'
import { webcrypto } from 'node:crypto'
import { beforeAll, expect, it, vi } from 'vitest'
import { createApp } from '../src/worker/app'
import { makeD1 } from './doubles/d1-sqlite'
import type { Env } from '../src/worker/env'

vi.mock('../src/worker/lib/password', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/worker/lib/password')>(),
  hashPassword: vi.fn(async () => 'hashed'),
  validateNewPassword: vi.fn(() => null),
}))

let env: Env

beforeAll(async () => {
  vi.stubGlobal('crypto', webcrypto)
  const sqlite = new DatabaseSync(':memory:')
  env = {
    DB: makeD1(sqlite),
    ASSETS: { fetch: async () => new Response('ok') },
    SETUP_TOKEN: 'bootstrap-3cret',
  } as unknown as Env
  await createApp().fetch(new Request('http://localhost/api/health'), env)
})

async function register(body: Record<string, unknown>): Promise<Response> {
  return createApp().fetch(new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inkstone-Client': '1' },
    body: JSON.stringify(body),
  }), env)
}

it('rejects the first owner registration without the setup token', async () => {
  const response = await register({ username: 'sneaky', password: 'longenough-pass-1' })
  expect(response.status).toBe(403)
  expect(((await response.json()) as { error: { code: string } }).error.code)
    .toBe('setup_token_required')
})

it('rejects a wrong setup token', async () => {
  const response = await register({ username: 'sneaky', password: 'longenough-pass-1', setupToken: 'nope' })
  expect(response.status).toBe(403)
})

it('accepts the correct setup token and creates the owner', async () => {
  const response = await register({ username: 'owner', password: 'longenough-pass-1', setupToken: 'bootstrap-3cret' })
  expect(response.status).toBe(201)
  const body = await response.json() as { user: { role: string } }
  expect(body.user.role).toBe('owner')
})
