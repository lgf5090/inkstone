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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import type { AppBindings, Env } from '../src/worker/env'
import { errorResponse } from '../src/worker/lib/errors'
import { todoMailRoutes } from '../src/worker/routes/todo-mail'
import { MAX_INBOUND_MAIL_BYTES } from '../src/worker/email/inbound'
import worker from '../src/worker/index'
import { AssistantStore } from '../src/worker/assistant/store'
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

interface MailOptions {
  to: string
  from?: string
  subject?: string
  body?: string
  messageId?: string | null
  contentType?: string
  raw?: string
  rawSize?: number
}

function rawMessage(options: MailOptions): string {
  const messageId = options.messageId === undefined ? '<m1@example.com>' : options.messageId
  return [
    `From: Sender <${options.from ?? 'sender@example.com'}>`,
    `To: ${options.to}`,
    `Subject: ${options.subject ?? 'Buy milk'}`,
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    `Content-Type: ${options.contentType ?? 'text/plain; charset=utf-8'}`,
    '',
    options.body ?? 'Bring two bottles.',
  ].join('\r\n')
}

/** One delivery as the platform hands it over: envelope addresses, headers, and a raw MIME stream. */
function mailMessage(options: MailOptions): ForwardableEmailMessage {
  const from = options.from ?? 'sender@example.com'
  const messageId = options.messageId === undefined ? '<m1@example.com>' : options.messageId
  const blob = new Blob([options.raw ?? rawMessage(options)])
  return {
    from,
    to: options.to,
    headers: new Headers(messageId ? { 'message-id': messageId } : {}),
    raw: blob.stream(),
    rawSize: options.rawSize ?? blob.size,
    setReject: () => {},
    forward: async () => ({ messageId: 'forwarded' }),
    reply: async () => ({ messageId: 'replied' }),
  } as unknown as ForwardableEmailMessage
}

async function deliver(message: ForwardableEmailMessage, target: Env = env): Promise<void> {
  await worker.email!(message, target, {} as ExecutionContext)
}

async function issueAddress(target: Env = env): Promise<string> {
  const response = await send('POST', target)
  expect(response.status).toBe(201)
  return (await json<{ address: string }>(response)).address
}

async function tasks(): Promise<{ title: string; description: string }[]> {
  return await new AssistantStore(env.DB, USER, env).listTasks()
}

function messageRows(): number {
  return Number((sqlite.prepare('SELECT COUNT(*) AS n FROM todos_mail_messages').get() as { n: number }).n)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { MAIL_DOMAIN: DOMAIN })
})

// Restore here, not inside a test: `mockRestore` also clears the calls the assertions read.
afterEach(() => {
  vi.restoreAllMocks()
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

describe('the inbound email handler', () => {
  it('turns a plain-text message into a task for the addressed account', async () => {
    const address = await issueAddress()

    await deliver(mailMessage({ to: address }))

    const [task] = await tasks()
    expect(task).toBeDefined()
    expect(task!.title).toBe('Buy milk')
    expect(task!.description).toBe('From: sender@example.com via email\n\nBring two bottles.')
    expect(messageRows()).toBe(1)
  })

  it('records the envelope sender rather than the forgeable From header', async () => {
    const address = await issueAddress()
    const raw = [
      'From: CEO <ceo@bank.example>',
      `To: ${address}`,
      'Subject: Payroll',
      'Message-ID: <spoof@example.net>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Change the account number.',
    ].join('\r\n')

    await deliver(mailMessage({ to: address, from: 'attacker@example.net', raw }))

    const [task] = await tasks()
    expect(task!.description.split('\n')[0]).toBe('From: attacker@example.net via email')
    expect(task!.description).not.toContain('ceo@bank.example')
  })

  it('writes nothing for an unknown token, a foreign domain or a revoked address', async () => {
    const address = await issueAddress()
    const token = newToken(address)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await deliver(mailMessage({ to: `u+${'z'.repeat(40)}@${DOMAIN}`, messageId: '<unknown@example.com>' }))
    await deliver(mailMessage({ to: `u+${token}@other.example.com`, messageId: '<foreign@example.com>' }))
    expect(await tasks()).toHaveLength(0)
    expect(messageRows()).toBe(0)

    expect((await send('DELETE')).status).toBe(200)
    await deliver(mailMessage({ to: address, messageId: '<revoked@example.com>' }))
    expect(await tasks()).toHaveLength(0)
    expect(messageRows()).toBe(0)

    // One line per drop, each naming the reason and none repeating the recipient's token.
    expect(warn.mock.calls).toHaveLength(3)
    expect(warn.mock.calls.every(([line]) => String(line).includes('dropped'))).toBe(true)
    expect(warn.mock.calls.every(([line]) => !String(line).includes(token))).toBe(true)
  })

  it('files a redelivered Message-ID once', async () => {
    const address = await issueAddress()
    const message = mailMessage({ to: address, messageId: '<same@example.com>' })

    await deliver(message)
    await deliver(mailMessage({ to: address, messageId: '<same@example.com>' }))

    expect(await tasks()).toHaveLength(1)
  })

  it('falls back to a digest when the message has no Message-ID', async () => {
    const address = await issueAddress()
    const raw = rawMessage({ to: address, messageId: null })
    await deliver(mailMessage({ to: address, messageId: null, raw }))
    await deliver(mailMessage({ to: address, messageId: null, raw }))

    expect(await tasks()).toHaveLength(1)
  })

  it('caps the title at 300 characters and the whole note at 10,000', async () => {
    const address = await issueAddress()
    const origin = 'From: sender@example.com via email'

    await deliver(mailMessage({ to: address, subject: 'S'.repeat(350), body: 'b'.repeat(12_000) }))

    const [task] = await tasks()
    expect(task!.title).toHaveLength(300)
    expect(task!.description).toHaveLength(10_000)
    expect(task!.description.startsWith(`${origin}\n\n`)).toBe(true)
  })

  it('reads the plain-text alternative and decodes an encoded subject', async () => {
    const address = await issueAddress()
    const raw = [
      'From: Sender <sender@example.com>',
      `To: ${address}`,
      'Subject: =?utf-8?B?Q2Fmw6kgcnVu?=',
      'Message-ID: <alternative@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain body',
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML body</p>',
      '--alt--',
      '',
    ].join('\r\n')

    await deliver(mailMessage({ to: address, raw }))

    const [task] = await tasks()
    expect(task!.title).toBe('Café run')
    expect(task!.description.endsWith('Plain body')).toBe(true)
    expect(task!.description).not.toContain('<p>')
  })

  it('drops an oversized message and logs it', async () => {
    const address = await issueAddress()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await deliver(mailMessage({ to: address, rawSize: MAX_INBOUND_MAIL_BYTES + 1 }))

    expect(await tasks()).toHaveLength(0)
    expect(messageRows()).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped'))
  })

  it('drops a message with no plain-text body and logs it', async () => {
    const address = await issueAddress()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = rawMessage({ to: address, messageId: '<empty@example.com>', body: '' })

    await deliver(mailMessage({ to: address, messageId: '<empty@example.com>', raw }))

    expect(await tasks()).toHaveLength(0)
    expect(messageRows()).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped'))
  })

  it('drops everything while MAIL_DOMAIN is unset', async () => {
    const address = await issueAddress()
    const unconfigured = testBindings(env.DB)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await deliver(mailMessage({ to: address }), unconfigured)

    expect(await tasks()).toHaveLength(0)
    expect(messageRows()).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MAIL_DOMAIN'))
  })
})
