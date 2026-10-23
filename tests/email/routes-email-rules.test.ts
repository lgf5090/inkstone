// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EmailBlockedSender, EmailFilter } from '../../src/shared/email/rules'
import { SCHEMA_STATEMENTS } from '../../src/worker/db/schema'
import { createEmailAccount } from '../../src/worker/email/account-store'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore, type EmailData } from '../../src/worker/email/mailbox-store'
import type { AppBindings, Env } from '../../src/worker/env'
import { errorResponse } from '../../src/worker/lib/errors'
import { newId } from '../../src/worker/lib/id'
import { emailRulesRoutes } from '../../src/worker/routes/email-rules'
import { makeD1 } from '../doubles/d1-sqlite'
import { makeSqlExec } from '../doubles/do-sqlite'
import { fakeEmailMailboxNamespace } from '../doubles/email-mailbox'
import { testBindings } from '../doubles/bindings'

let sqlite: DatabaseSync
let store: MailboxStore
let env: Env
let userId: string
let userRole: 'owner' | 'member'
let accountId: string

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('/api/email/*', async (c, next) => {
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: 'owner',
        login: 'owner',
        name: 'Owner',
        avatarUrl: '',
        role: userRole,
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  instance.route('/api/email', emailRulesRoutes)
  return instance
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return await app().request(`/api/email${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return (await json<{ error: { code: string; message: string } }>(response)).error
}

function mailboxNamespace(target: MailboxStore): DurableObjectNamespace {
  const base = fakeEmailMailboxNamespace(target)
  return {
    ...base,
    get: ((id: DurableObjectId) => {
      const stub = base.get(id) as unknown as Record<string, unknown>
      stub.listFilters = () => target.listFilters()
      stub.getFilter = (filterId: string) => target.getFilter(filterId)
      stub.createFilter = (input: Parameters<MailboxStore['createFilter']>[0]) => target.createFilter(input)
      stub.updateFilter = (filterId: string, patch: Parameters<MailboxStore['updateFilter']>[1]) =>
        target.updateFilter(filterId, patch)
      stub.deleteFilter = (filterId: string) => target.deleteFilter(filterId)
      stub.listBlockedSenders = () => target.listBlockedSenders()
      stub.addBlockedSender = (address: string) => target.addBlockedSender(address)
      stub.removeBlockedSender = (address: string) => target.removeBlockedSender(address)
      return stub as unknown as DurableObjectStub
    }) as DurableObjectNamespace['get'],
  } as DurableObjectNamespace
}

function seedMessage(id: string, overrides: Partial<EmailData> = {}): void {
  expect(store.createEmail('inbox', {
    id,
    subject: 'Subject',
    sender: 'Alice <alice@example.com>',
    recipient: 'owner@example.com',
    date: 1_700_000_000_000,
    body: '<p>Hello</p>',
    ...overrides,
  })).toBe(true)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  const db = makeD1(sqlite)
  const sql = makeSqlExec(sqlite)
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
  userId = newId()
  userRole = 'owner'
  env = testBindings(db, { EMAIL_MAILBOX: mailboxNamespace(store) })
  accountId = (await createEmailAccount(db, {
    userId,
    address: 'owner@example.com',
    displayName: 'Owner',
  })).id
})

const filterBody = {
  name: 'Invoices',
  enabled: true,
  conditions: [{ field: 'subjectContains', value: 'invoice' }],
  actions: [{ type: 'moveTo', folder: 'Archive' }, { type: 'markRead' }],
}

describe('email rules route auth and ownership', () => {
  it('rejects anonymous callers and members', async () => {
    userId = ''
    const anonymous = await call('GET', `/accounts/${accountId}/filters`)
    expect(anonymous.status).toBe(401)
    expect((await errorOf(anonymous)).code).toBe('unauthenticated')

    userId = newId()
    userRole = 'member'
    const member = await call('GET', `/accounts/${accountId}/blocklist`)
    expect(member.status).toBe(403)
    expect((await errorOf(member)).code).toBe('forbidden')
  })

  it('treats another account as absent', async () => {
    userId = newId()
    for (const path of ['filters', 'blocklist']) {
      const response = await call('GET', `/accounts/${accountId}/${path}`)
      expect(response.status).toBe(404)
      expect((await errorOf(response)).code).toBe('email_account_not_found')
    }
  })
})

describe('email filter routes', () => {
  it('creates, lists, updates and deletes a filter', async () => {
    const created = await call('POST', `/accounts/${accountId}/filters`, filterBody)
    expect(created.status).toBe(201)
    const filter = await json<EmailFilter>(created)
    expect(filter.name).toBe('Invoices')
    expect(filter.actions).toEqual([
      { type: 'moveTo', folder: 'archive' },
      { type: 'markRead' },
    ])

    const listed = await json<EmailFilter[]>(await call('GET', `/accounts/${accountId}/filters`))
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(filter.id)

    const patched = await call('PATCH', `/accounts/${accountId}/filters/${filter.id}`, {
      enabled: false,
      name: 'Renamed',
    })
    expect(patched.status).toBe(200)
    expect(await json<EmailFilter>(patched)).toMatchObject({ enabled: false, name: 'Renamed' })

    expect((await call('DELETE', `/accounts/${accountId}/filters/${filter.id}`)).status).toBe(204)
    expect(await json<EmailFilter[]>(await call('GET', `/accounts/${accountId}/filters`))).toEqual([])
    expect((await call('DELETE', `/accounts/${accountId}/filters/${filter.id}`)).status).toBe(404)
  })

  it('validates bodies, ids and move targets', async () => {
    const invalid = await call('POST', `/accounts/${accountId}/filters`, { name: '' })
    expect(invalid.status).toBe(400)
    expect((await errorOf(invalid)).code).toBe('bad_request')

    const missing = await call('PATCH', `/accounts/${accountId}/filters/${newId()}`, { enabled: false })
    expect(missing.status).toBe(404)

    const created = await json<EmailFilter>(await call('POST', `/accounts/${accountId}/filters`, filterBody))
    const empty = await call('PATCH', `/accounts/${accountId}/filters/${created.id}`, {})
    expect(empty.status).toBe(400)

    const unknownFolder = await call('POST', `/accounts/${accountId}/filters`, {
      ...filterBody,
      actions: [{ type: 'moveTo', folder: 'No such folder' }],
    })
    expect(unknownFolder.status).toBe(404)
    expect((await errorOf(unknownFolder)).code).toBe('email_folder_not_found')
  })

  it('refuses a filter beyond the rule cap', async () => {
    for (let index = 0; index < 20; index += 1) {
      expect(store.createFilter({
        name: `Rule ${index}`,
        enabled: true,
        conditions: [{ field: 'subjectContains', value: 'x' }],
        actions: [{ type: 'markRead' }],
      })).not.toBeNull()
    }
    const response = await call('POST', `/accounts/${accountId}/filters`, filterBody)
    expect(response.status).toBe(409)
    expect((await errorOf(response)).code).toBe('conflict')
  })
})

describe('email blocklist routes', () => {
  it('normalizes, adds, lists and removes blocked senders', async () => {
    const created = await call('POST', `/accounts/${accountId}/blocklist`, { address: 'Alice <ALICE@example.com>' })
    expect(created.status).toBe(201)
    expect((await json<EmailBlockedSender>(created)).address).toBe('alice@example.com')

    const duplicate = await call('POST', `/accounts/${accountId}/blocklist`, { address: 'alice@example.com' })
    expect(duplicate.status).toBe(201)

    const listed = await json<EmailBlockedSender[]>(await call('GET', `/accounts/${accountId}/blocklist`))
    expect(listed.map((entry) => entry.address)).toEqual(['alice@example.com'])

    const removed = await call('DELETE', `/accounts/${accountId}/blocklist/${encodeURIComponent('alice@example.com')}`)
    expect(removed.status).toBe(204)
    expect(await json<EmailBlockedSender[]>(await call('GET', `/accounts/${accountId}/blocklist`))).toEqual([])

    expect((await call('DELETE', `/accounts/${accountId}/blocklist/alice@example.com`)).status).toBe(404)
    const invalid = await call('POST', `/accounts/${accountId}/blocklist`, { address: 'not-an-address' })
    expect(invalid.status).toBe(400)
  })
})

describe('email block-sender route', () => {
  it('blocks the sender and moves the message to spam', async () => {
    const messageId = newId()
    seedMessage(messageId, { sender: 'Alice <alice@example.com>' })

    const response = await call('POST', `/accounts/${accountId}/emails/${messageId}/block-sender`)
    expect(response.status).toBe(200)
    expect(await json<{ address: string; messageId: string; folderId: string }>(response)).toEqual({
      address: 'alice@example.com',
      messageId,
      folderId: 'spam',
    })
    expect(store.getEmail(messageId)?.folder_id).toBe('spam')
    const listed = await json<EmailBlockedSender[]>(await call('GET', `/accounts/${accountId}/blocklist`))
    expect(listed.map((entry) => entry.address)).toEqual(['alice@example.com'])
  })

  it('answers unknown messages and unparseable senders', async () => {
    expect((await call('POST', `/accounts/${accountId}/emails/${newId()}/block-sender`)).status).toBe(404)
    const messageId = newId()
    seedMessage(messageId, { sender: 'not-an-address' })
    const invalid = await call('POST', `/accounts/${accountId}/emails/${messageId}/block-sender`)
    expect(invalid.status).toBe(400)
    expect(store.getEmail(messageId)?.folder_id).toBe('inbox')
  })

  it('keeps the message inside its account', async () => {
    const messageId = newId()
    seedMessage(messageId)
    userId = newId()
    const response = await call('POST', `/accounts/${accountId}/emails/${messageId}/block-sender`)
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('email_account_not_found')
    expect(store.getEmail(messageId)?.folder_id).toBe('inbox')
  })
})
