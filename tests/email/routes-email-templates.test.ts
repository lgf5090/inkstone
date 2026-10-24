// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  EMAIL_TEMPLATE_BODY_MAX_CHARS,
  EMAIL_TEMPLATE_MAX,
  EMAIL_TEMPLATE_NAME_MAX_CHARS,
  type EmailTemplate,
  type EmailTemplateInput,
} from '../../src/shared/email/templates'
import { SCHEMA_STATEMENTS } from '../../src/worker/db/schema'
import { createEmailAccount } from '../../src/worker/email/account-store'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../src/worker/email/mailbox-store'
import type { AppBindings, Env } from '../../src/worker/env'
import { errorResponse } from '../../src/worker/lib/errors'
import { newId } from '../../src/worker/lib/id'
import { emailTemplatesRoutes } from '../../src/worker/routes/email-templates'
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
  instance.route('/api/email', emailTemplatesRoutes)
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
      stub.listTemplates = () => target.listTemplates()
      stub.countTemplates = () => target.countTemplates()
      stub.getTemplate = (templateId: string) => target.getTemplate(templateId)
      stub.createTemplate = (input: EmailTemplateInput) => target.createTemplate(input)
      stub.updateTemplate = (templateId: string, patch: Parameters<MailboxStore['updateTemplate']>[1]) =>
        target.updateTemplate(templateId, patch)
      stub.deleteTemplate = (templateId: string) => target.deleteTemplate(templateId)
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

const templateBody = {
  name: 'Welcome',
  subject: 'Hello',
  body: 'Hi there',
}

describe('email templates route auth and ownership', () => {
  it('rejects anonymous callers and members', async () => {
    userId = ''
    const anonymous = await call('GET', `/accounts/${accountId}/templates`)
    expect(anonymous.status).toBe(401)
    expect((await errorOf(anonymous)).code).toBe('unauthenticated')

    userId = newId()
    userRole = 'member'
    const member = await call('POST', `/accounts/${accountId}/templates`, templateBody)
    expect(member.status).toBe(403)
    expect((await errorOf(member)).code).toBe('forbidden')
  })

  it('treats another account as absent', async () => {
    userId = newId()
    const response = await call('GET', `/accounts/${accountId}/templates`)
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('email_account_not_found')
  })
})

describe('email template routes', () => {
  it('creates, lists, updates and deletes a template', async () => {
    const created = await call('POST', `/accounts/${accountId}/templates`, templateBody)
    expect(created.status).toBe(201)
    const template = await json<EmailTemplate>(created)
    expect(template).toMatchObject(templateBody)
    expect(template.createdAt).toBe(template.updatedAt)
    expect(Date.parse(template.createdAt)).toBeGreaterThan(0)

    const listed = await json<EmailTemplate[]>(await call('GET', `/accounts/${accountId}/templates`))
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(template.id)

    const patched = await call('PATCH', `/accounts/${accountId}/templates/${template.id}`, {
      subject: 'Updated',
      body: 'New body',
    })
    expect(patched.status).toBe(200)
    expect(await json<EmailTemplate>(patched)).toMatchObject({
      id: template.id,
      name: 'Welcome',
      subject: 'Updated',
      body: 'New body',
    })

    const removed = await call('DELETE', `/accounts/${accountId}/templates/${template.id}`)
    expect(removed.status).toBe(204)
    expect(await json<EmailTemplate[]>(await call('GET', `/accounts/${accountId}/templates`))).toEqual([])
  })

  it('validates input and template identifiers', async () => {
    const missingName = await call('POST', `/accounts/${accountId}/templates`, { subject: 'Hello' })
    expect(missingName.status).toBe(400)
    expect((await errorOf(missingName)).code).toBe('bad_request')

    const longName = await call('POST', `/accounts/${accountId}/templates`, {
      ...templateBody,
      name: 'x'.repeat(EMAIL_TEMPLATE_NAME_MAX_CHARS + 1),
    })
    expect(longName.status).toBe(400)

    const longBody = await call('POST', `/accounts/${accountId}/templates`, {
      ...templateBody,
      body: 'x'.repeat(EMAIL_TEMPLATE_BODY_MAX_CHARS + 1),
    })
    expect(longBody.status).toBe(400)

    const notAnId = await call('DELETE', `/accounts/${accountId}/templates/nope`)
    expect(notAnId.status).toBe(404)
    expect((await errorOf(notAnId)).code).toBe('not_found')

    const missing = await call('PATCH', `/accounts/${accountId}/templates/${newId()}`, { subject: 'x' })
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('not_found')

    const template = await json<EmailTemplate>(await call('POST', `/accounts/${accountId}/templates`, templateBody))
    const emptyPatch = await call('PATCH', `/accounts/${accountId}/templates/${template.id}`, {})
    expect(emptyPatch.status).toBe(400)
  })

  it('answers a case-insensitive name collision with 409', async () => {
    expect((await call('POST', `/accounts/${accountId}/templates`, templateBody)).status).toBe(201)
    const duplicate = await call('POST', `/accounts/${accountId}/templates`, {
      ...templateBody,
      name: 'welcome',
    })
    expect(duplicate.status).toBe(409)
    expect((await errorOf(duplicate)).code).toBe('conflict')

    const second = await json<EmailTemplate>(await call('POST', `/accounts/${accountId}/templates`, {
      name: 'Beta',
      subject: '',
      body: '',
    }))
    const renamed = await call('PATCH', `/accounts/${accountId}/templates/${second.id}`, { name: 'WELCOME' })
    expect(renamed.status).toBe(409)
    expect((await errorOf(renamed)).code).toBe('conflict')
    expect(store.getTemplate(second.id)?.name).toBe('Beta')
  })

  it('answers the template limit with 409', async () => {
    for (let index = 0; index < EMAIL_TEMPLATE_MAX; index += 1) {
      store.createTemplate({ name: `Template ${index}`, subject: '', body: '' })
    }
    const response = await call('POST', `/accounts/${accountId}/templates`, {
      name: 'One more',
      subject: '',
      body: '',
    })
    expect(response.status).toBe(409)
    expect((await errorOf(response)).message).toContain(String(EMAIL_TEMPLATE_MAX))
  })
})
