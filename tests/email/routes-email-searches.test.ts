// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_SAVED_SEARCH_MAX, type EmailSavedSearch } from '../../src/shared/email/searches'
import { SCHEMA_STATEMENTS } from '../../src/worker/db/schema'
import { createEmailAccount } from '../../src/worker/email/account-store'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../src/worker/email/mailbox-store'
import type { AppBindings, Env } from '../../src/worker/env'
import { errorResponse } from '../../src/worker/lib/errors'
import { newId } from '../../src/worker/lib/id'
import { emailSearchesRoutes } from '../../src/worker/routes/email-searches'
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
  instance.route('/api/email', emailSearchesRoutes)
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
      stub.listSavedSearches = () => target.listSavedSearches()
      stub.countSavedSearches = () => target.countSavedSearches()
      stub.getSavedSearch = (searchId: string) => target.getSavedSearch(searchId)
      stub.createSavedSearch = (input: Parameters<MailboxStore['createSavedSearch']>[0]) => target.createSavedSearch(input)
      stub.updateSavedSearch = (searchId: string, patch: Parameters<MailboxStore['updateSavedSearch']>[1]) =>
        target.updateSavedSearch(searchId, patch)
      stub.deleteSavedSearch = (searchId: string) => target.deleteSavedSearch(searchId)
      return stub as unknown as DurableObjectStub
    }) as DurableObjectNamespace['get'],
  } as DurableObjectNamespace
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

describe('email saved search route auth and ownership', () => {
  it('rejects anonymous callers and members', async () => {
    userId = ''
    const anonymous = await call('GET', `/accounts/${accountId}/searches`)
    expect(anonymous.status).toBe(401)
    expect((await errorOf(anonymous)).code).toBe('unauthenticated')

    userId = newId()
    userRole = 'member'
    const member = await call('GET', `/accounts/${accountId}/searches`)
    expect(member.status).toBe(403)
    expect((await errorOf(member)).code).toBe('forbidden')
  })

  it('treats another user account as absent', async () => {
    userId = newId()
    const response = await call('GET', `/accounts/${accountId}/searches`)
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('email_account_not_found')
  })
})

describe('email saved search routes', () => {
  it('creates, lists, updates and deletes a saved search', async () => {
    const created = await call('POST', `/accounts/${accountId}/searches`, {
      name: '  Invoices  ',
      query: '  from:billing is:unread  ',
    })
    expect(created.status).toBe(201)
    const search = await json<EmailSavedSearch>(created)
    expect(search.name).toBe('Invoices')
    expect(search.query).toBe('from:billing is:unread')

    const listed = await json<EmailSavedSearch[]>(await call('GET', `/accounts/${accountId}/searches`))
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(search.id)

    const patched = await call('PATCH', `/accounts/${accountId}/searches/${search.id}`, {
      name: 'Billing',
      query: 'subject:invoice',
    })
    expect(patched.status).toBe(200)
    expect(await json<EmailSavedSearch>(patched)).toMatchObject({ name: 'Billing', query: 'subject:invoice' })

    expect((await call('DELETE', `/accounts/${accountId}/searches/${search.id}`)).status).toBe(204)
    expect(await json<EmailSavedSearch[]>(await call('GET', `/accounts/${accountId}/searches`))).toEqual([])
    expect((await call('DELETE', `/accounts/${accountId}/searches/${search.id}`)).status).toBe(404)
  })

  it('validates bodies, ids and patches', async () => {
    const invalid = await call('POST', `/accounts/${accountId}/searches`, { name: '', query: 'from:billing' })
    expect(invalid.status).toBe(400)
    expect((await errorOf(invalid)).code).toBe('bad_request')

    const missingQuery = await call('POST', `/accounts/${accountId}/searches`, { name: 'Invoices' })
    expect(missingQuery.status).toBe(400)

    const missing = await call('PATCH', `/accounts/${accountId}/searches/${newId()}`, { name: 'Invoices' })
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('not_found')

    const invalidId = await call('DELETE', `/accounts/${accountId}/searches/not-an-id`)
    expect(invalidId.status).toBe(404)

    const created = await json<EmailSavedSearch>(
      await call('POST', `/accounts/${accountId}/searches`, { name: 'Invoices', query: 'from:billing' }),
    )
    const empty = await call('PATCH', `/accounts/${accountId}/searches/${created.id}`, {})
    expect(empty.status).toBe(400)

    const emptyQuery = await call('PATCH', `/accounts/${accountId}/searches/${created.id}`, { query: '   ' })
    expect(emptyQuery.status).toBe(400)
  })

  it('refuses a duplicate name regardless of case', async () => {
    expect((await call('POST', `/accounts/${accountId}/searches`, { name: 'Invoices', query: 'from:billing' })).status).toBe(201)
    const duplicate = await call('POST', `/accounts/${accountId}/searches`, { name: 'invoices', query: 'from:other' })
    expect(duplicate.status).toBe(409)
    expect((await errorOf(duplicate)).code).toBe('conflict')

    const first = store.listSavedSearches()[0]!
    const second = await json<EmailSavedSearch>(
      await call('POST', `/accounts/${accountId}/searches`, { name: 'Team', query: 'tag:team' }),
    )
    const renamed = await call('PATCH', `/accounts/${accountId}/searches/${second.id}`, { name: 'INVOICES' })
    expect(renamed.status).toBe(409)
    expect(store.getSavedSearch(first.id)?.name).toBe('Invoices')
  })

  it('refuses a saved search beyond the cap', async () => {
    for (let index = 0; index < EMAIL_SAVED_SEARCH_MAX; index += 1) {
      expect(store.createSavedSearch({ name: `Search ${index}`, query: `subject:${index}` })).not.toBeNull()
    }
    const response = await call('POST', `/accounts/${accountId}/searches`, { name: 'One more', query: 'is:unread' })
    expect(response.status).toBe(409)
    const error = await errorOf(response)
    expect(error.code).toBe('conflict')
    expect(error.message).toContain(String(EMAIL_SAVED_SEARCH_MAX))
  })
})
