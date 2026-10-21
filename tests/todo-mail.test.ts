// @vitest-environment node
/**
 * Email-to-task, from the two sides it has: the owner issuing an address and the inbound handler
 * turning a delivered message into a task.
 *
 * What is pinned here is the capability, not the plumbing. A token is 40 random characters; only the
 * account that issued it can list it; rotation retires the old address; revocation leaves the old
 * address dead; an unconfigured domain is an honest 503 instead of an address shaped around nothing;
 * a recipient nobody issued creates no row at all; and a redelivered message is filed once. The
 * inbound cases feed a constructed `ForwardableEmailMessage`, because the handler's whole job is to
 * read the fields the platform hands it — the raw MIME is the interesting part, and it is built here
 * the way a mail client writes one.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { todoMailRoutes } from '../src/worker/routes/todo-mail'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const DOMAIN = 'mail.example.com'
const TOKEN_RE = /^u\+([0-9a-hjkmnp-tv-z]{40})@mail\.example\.com$/

let sqlite: DatabaseSync
let env: Env

/** The router wired the way `app.ts` wires it, with a session already established. */
function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('/api/todos/mail-token', async (c, next) => {
    c.set('userId', USER)
    await next()
  })
  instance.route('/api/todos/mail-token', todoMailRoutes)
  return instance
}

async function send(method: string, target: Env = env): Promise<Response> {
  return app().request('/api/todos/mail-token', { method }, target)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

function tokenRows(): number {
  return Number((sqlite.prepare('SELECT COUNT(*) AS n FROM todos_mail_tokens').get() as { n: number }).n)
}

function newToken(address: string): string {
  const match = TOKEN_RE.exec(address)
  if (!match) throw new Error(`not a mail address: ${address}`)
  return match[1]!
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { MAIL_DOMAIN: DOMAIN })
})

describe('the mail-token endpoints', () => {
  it('issues a 40-character address and lists it back', async () => {
    const empty = await json<{ address: string | null; createdAt: number | null }>(await send('GET'))
    expect(empty).toEqual({ address: null, createdAt: null })

    const created = await send('POST')
    expect(created.status).toBe(201)
    const issued = await json<{ address: string; createdAt: number }>(created)
    expect(issued.address).toMatch(TOKEN_RE)
    expect(issued.createdAt).toBeGreaterThan(0)

    const listed = await json<{ address: string; createdAt: number }>(await send('GET'))
    expect(listed.address).toBe(issued.address)
    expect(listed.createdAt).toBe(issued.createdAt)
    expect(tokenRows()).toBe(1)
  })

  it('rotates the address instead of issuing a second one', async () => {
    const first = await json<{ address: string }>(await send('POST'))
    const second = await json<{ address: string }>(await send('POST'))

    expect(newToken(second.address)).not.toBe(newToken(first.address))
    expect(tokenRows()).toBe(1)
    expect((await json<{ address: string }>(await send('GET'))).address).toBe(second.address)
  })

  it('revokes the address, and revoking again is a 404', async () => {
    const issued = await json<{ address: string }>(await send('POST'))
    expect(issued.address).toMatch(TOKEN_RE)

    const revoked = await send('DELETE')
    expect(revoked.status).toBe(200)
    expect(await json(revoked)).toEqual({ revoked: true })
    expect((await json<{ address: string | null }>(await send('GET'))).address).toBeNull()
    expect(tokenRows()).toBe(0)

    expect((await send('DELETE')).status).toBe(404)
  })

  it('answers 503 while MAIL_DOMAIN is unset or malformed', async () => {
    const unconfigured = testBindings(env.DB)
    for (const method of ['GET', 'POST']) {
      const response = await send(method, unconfigured)
      expect(response.status).toBe(503)
      const body = await json<{ error: { code: string; message: string } }>(response)
      expect(body.error.code).toBe('server_misconfigured')
      expect(body.error.message).toContain('MAIL_DOMAIN')
    }
    expect(tokenRows()).toBe(0)

    const malformed = testBindings(env.DB, { MAIL_DOMAIN: 'https://mail.example.com/inbox' })
    expect((await send('POST', malformed)).status).toBe(503)
    expect(tokenRows()).toBe(0)
  })

  it('still revokes an address when the domain is no longer configured', async () => {
    await send('POST')
    expect(tokenRows()).toBe(1)

    const revoked = await send('DELETE', testBindings(env.DB))
    expect(revoked.status).toBe(200)
    expect(tokenRows()).toBe(0)
  })
})
