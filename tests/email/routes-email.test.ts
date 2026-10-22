// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_BODY_MAX_BYTES, EMAIL_SUBJECT_MAX_CHARS } from '../../src/shared/email/model'
import type { EmailFolder, EmailListResponse, EmailMessage } from '../../src/shared/email/model'
import { SCHEMA_STATEMENTS } from '../../src/worker/db/schema'
import { claimAutoDraftJobs, createEmailAccount, finishAutoDraftJob, queueAutoDraftJob } from '../../src/worker/email/account-store'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore, type EmailData } from '../../src/worker/email/mailbox-store'
import type { AppBindings, Env } from '../../src/worker/env'
import { errorResponse } from '../../src/worker/lib/errors'
import { newId } from '../../src/worker/lib/id'
import { emailRoutes } from '../../src/worker/routes/email'
import { makeD1 } from '../doubles/d1-sqlite'
import { makeSqlExec } from '../doubles/do-sqlite'
import { fakeEmailMailboxNamespace } from '../doubles/email-mailbox'
import { testBindings, testR2Bucket, type TestR2Bucket } from '../doubles/bindings'

let sqlite: DatabaseSync
let db: D1Database
let store: MailboxStore
let bucket: TestR2Bucket
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
  instance.route('/api/email', emailRoutes)
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

function seedMessage(id: string, overrides: Omit<Partial<EmailData>, 'id'> & { folder?: string } = {}): void {
  const { folder = 'inbox', ...data } = overrides
  expect(store.createEmail(folder, {
    id,
    subject: 'Subject',
    sender: 'Alice <alice@example.com>',
    recipient: 'owner@example.com',
    date: 1_700_000_000_000,
    body: '<p>Hello</p>',
    ...data,
  })).toBe(true)
}

async function seedAttachment(input: {
  emailId: string | null
  account?: string | null
  owner?: string
  filename?: string
  mime?: string
  bytes?: Uint8Array
  locked?: number
  sha?: string
}): Promise<string> {
  const id = newId()
  const filename = input.filename ?? 'report.pdf'
  const mime = input.mime ?? 'application/pdf'
  const bytes = input.bytes ?? new TextEncoder().encode('hello attachment bytes')
  const objectKey = `mail/docs/${id}.pdf`
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { sha256: input.sha ?? `sha-${id}` },
  })
  sqlite.prepare(
    `INSERT INTO email_attachments (
       id, user_id, account_id, email_id, filename, mime, size, width, height,
       content_id, disposition, object_key, storage, folder_id, is_starred,
       is_pinned, tags, locked, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'attachment', ?, 'r2', NULL, 0, 0, '[]', ?, ?)`,
  ).run(
    id,
    input.owner ?? userId,
    input.account === undefined ? accountId : input.account,
    input.emailId,
    filename,
    mime,
    bytes.byteLength,
    objectKey,
    input.locked ?? 0,
    Date.now(),
  )
  return id
}

function count(sql: string, ...values: Array<string | number | null>): number {
  return Number((sqlite.prepare(sql).get(...values) as { n: number }).n)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  const sql = makeSqlExec(sqlite)
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
  bucket = testR2Bucket()
  userId = newId()
  userRole = 'owner'
  env = testBindings(db, {
    FILES: bucket,
    EMAIL_MAILBOX: fakeEmailMailboxNamespace(store),
  })
  accountId = (await createEmailAccount(db, {
    userId,
    address: 'owner@example.com',
    displayName: 'Owner',
  })).id
})

describe('email route auth and ownership', () => {
  it('rejects anonymous callers and members', async () => {
    userId = ''
    const anonymous = await call('GET', '/accounts')
    expect(anonymous.status).toBe(401)
    expect((await errorOf(anonymous)).code).toBe('unauthenticated')

    userId = newId()
    userRole = 'member'
    const member = await call('GET', '/accounts')
    expect(member.status).toBe(403)
    expect((await errorOf(member)).code).toBe('forbidden')
  })

  it('treats another account as absent', async () => {
    const other = newId()
    userId = other
    const response = await call('GET', `/accounts/${accountId}/folders`)
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('email_account_not_found')
  })

  it('reports the latest automatic draft attempt without inventing one', async () => {
    const empty = await json<{ status: string | null, reason: string | null }>(
      await call('GET', `/accounts/${accountId}/auto-draft`),
    )
    expect(empty).toEqual({ status: null, reason: null, attempts: 0, updatedAt: null })

    await queueAutoDraftJob(db, { userId, accountId, messageId: 'm1', threadId: null })
    await claimAutoDraftJobs(db)
    await finishAutoDraftJob(db, {
      userId,
      accountId,
      messageId: 'm1',
      status: 'skipped',
      reason: 'injection',
    })
    const after = await json<{ status: string | null, reason: string | null, attempts: number }>(
      await call('GET', `/accounts/${accountId}/auto-draft`),
    )
    expect(after).toMatchObject({ status: 'skipped', reason: 'injection', attempts: 1 })

    userId = newId()
    const other = await call('GET', `/accounts/${accountId}/auto-draft`)
    expect(other.status).toBe(404)
  })
})

describe('email folders', () => {
  it('creates, renames and lists custom folders', async () => {
    const created = await call('POST', `/accounts/${accountId}/folders`, { name: '项目' })
    expect(created.status).toBe(201)
    const folder = await json<EmailFolder>(created)
    expect(folder).toMatchObject({ name: '项目', isDeletable: true, unreadCount: 0 })

    const renamed = await call('PATCH', `/accounts/${accountId}/folders/${folder.id}`, { name: 'Work' })
    expect(renamed.status).toBe(200)
    expect((await json<EmailFolder>(renamed)).name).toBe('Work')

    const listed = await call('GET', `/accounts/${accountId}/folders`)
    const folders = await json<EmailFolder[]>(listed)
    expect(folders.map((entry) => entry.name)).toContain('Work')
  })

  it('validates folder names and refuses system folders', async () => {
    const reserved = await call('POST', `/accounts/${accountId}/folders`, { name: 'Inbox' })
    expect(reserved.status).toBe(400)
    expect((await errorOf(reserved)).code).toBe('email_folder_reserved')

    const missing = await call('POST', `/accounts/${accountId}/folders`, {})
    expect(missing.status).toBe(400)

    const created = await call('POST', `/accounts/${accountId}/folders`, { name: 'Reports' })
    const duplicate = await call('POST', `/accounts/${accountId}/folders`, { name: 'reports' })
    expect(duplicate.status).toBe(409)
    expect((await errorOf(duplicate)).code).toBe('email_folder_exists')

    const folder = await json<EmailFolder>(created)
    const renameSystem = await call('PATCH', `/accounts/${accountId}/folders/inbox`, { name: 'In' })
    expect(renameSystem.status).toBe(400)
    expect((await errorOf(renameSystem)).code).toBe('email_folder_reserved')
    const deleteSystem = await call('DELETE', `/accounts/${accountId}/folders/inbox`)
    expect(deleteSystem.status).toBe(400)
    expect((await errorOf(deleteSystem)).code).toBe('email_folder_not_deletable')
    expect(folder.id).toBeTruthy()
  })

  it('moves messages to the inbox when a folder is deleted', async () => {
    const folder = await json<EmailFolder>(await call('POST', `/accounts/${accountId}/folders`, { name: 'Temporary' }))
    const messageId = newId()
    seedMessage(messageId, { folder: folder.id })

    const response = await call('DELETE', `/accounts/${accountId}/folders/${folder.id}`)
    expect(response.status).toBe(204)
    expect(store.getEmail(messageId)?.folder_id).toBe('inbox')
    const detail = await call('GET', `/accounts/${accountId}/emails/${messageId}`)
    expect(detail.status).toBe(200)
  })

  it('deletes messages and their stored attachments when asked', async () => {
    const folder = await json<EmailFolder>(await call('POST', `/accounts/${accountId}/folders`, { name: 'Bulk' }))
    const messageId = newId()
    seedMessage(messageId, { folder: folder.id })
    const attachmentId = await seedAttachment({ emailId: messageId })
    const key = `mail/docs/${attachmentId}.pdf`
    expect(bucket.objects.has(key)).toBe(true)

    const response = await call('DELETE', `/accounts/${accountId}/folders/${folder.id}?deleteEmails=true`)
    expect(response.status).toBe(204)
    expect(store.getEmail(messageId)).toBeNull()
    expect(count('SELECT COUNT(*) AS n FROM email_attachments WHERE id = ?', attachmentId)).toBe(0)
    expect(bucket.objects.has(key)).toBe(false)
  })
})

describe('email listing and detail', () => {
  it('lists summaries with pagination and no attachments payload', async () => {
    seedMessage(newId(), { subject: 'Older', date: 1_000 })
    const newest = newId()
    seedMessage(newest, { subject: 'Newer', date: 2_000 })
    seedMessage(newId(), { folder: 'sent', subject: 'Sent mail', date: 3_000 })

    const response = await call('GET', `/accounts/${accountId}/emails?folder=inbox&limit=1&page=1`)
    expect(response.status).toBe(200)
    const page = await json<EmailListResponse>(response)
    expect(page.totalCount).toBe(2)
    expect(page.emails).toHaveLength(1)
    expect(page.emails[0]).toMatchObject({ id: newest, subject: 'Newer', folderId: 'inbox', read: false })
    expect(page.emails[0]!.date).toBe(new Date(2_000).toISOString())
    expect('attachments' in page.emails[0]!).toBe(false)
    expect(page.emails[0]!.snippet).toBe('<p>Hello</p>')

    const second = await json<EmailListResponse>(await call('GET', `/accounts/${accountId}/emails?folder=inbox&limit=1&page=2`))
    expect(second.emails).toHaveLength(1)
    expect(second.emails[0]!.subject).toBe('Older')
  })

  it('rejects an unknown folder and threads the listing on request', async () => {
    const missing = await call('GET', `/accounts/${accountId}/emails?folder=missing`)
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('email_folder_not_found')

    seedMessage(newId(), { threadId: 'thread-a', date: 1_000 })
    seedMessage(newId(), { threadId: 'thread-a', date: 2_000 })
    const threaded = await json<EmailListResponse>(
      await call('GET', `/accounts/${accountId}/emails?folder=inbox&threaded=true`),
    )
    expect(threaded.totalCount).toBe(1)
    expect(threaded.emails[0]!.threadCount).toBe(2)
    expect(threaded.emails[0]!.read).toBe(false)
  })

  it('returns a message with its attachments, headers and references', async () => {
    const messageId = newId()
    seedMessage(messageId, {
      body: '<p>Full body</p>',
      bodySource: 'Full body',
      messageId: '<message@example.com>',
      emailReferences: JSON.stringify(['<one@example.com>', '<two@example.com>']),
      rawHeaders: JSON.stringify([{ key: 'Subject', value: 'Subject' }, { name: 'X-Test', value: 'yes' }]),
    })
    const attachmentId = await seedAttachment({ emailId: messageId })

    const response = await call('GET', `/accounts/${accountId}/emails/${messageId}`)
    expect(response.status).toBe(200)
    const message = await json<EmailMessage>(response)
    expect(message).toMatchObject({
      id: messageId,
      body: '<p>Full body</p>',
      bodySource: 'Full body',
      messageId: '<message@example.com>',
      references: ['<one@example.com>', '<two@example.com>'],
      rawHeaders: [{ key: 'Subject', value: 'Subject' }, { key: 'X-Test', value: 'yes' }],
    })
    expect(message.attachments).toHaveLength(1)
    expect(message.attachments[0]!.id).toBe(attachmentId)
    expect(message.attachments[0]!.url).toBe(`/api/email/files/${attachmentId}`)
    expect(message.deletedAt).toBeNull()
  })

  it('answers a missing message with the email code', async () => {
    const response = await call('GET', `/accounts/${accountId}/emails/${newId()}`)
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('email_message_not_found')
  })
})

describe('email updates, trash and moves', () => {
  it('updates read and starred flags', async () => {
    const messageId = newId()
    seedMessage(messageId)
    const response = await call('PATCH', `/accounts/${accountId}/emails/${messageId}`, { read: true, starred: true })
    expect(response.status).toBe(200)
    expect(await json<EmailMessage>(response)).toMatchObject({ read: true, starred: true })
    expect(store.getEmail(messageId)).toMatchObject({ read: 1, starred: 1 })

    const invalid = await call('PATCH', `/accounts/${accountId}/emails/${messageId}`, { read: 'yes' })
    expect(invalid.status).toBe(400)
  })

  it('soft-deletes, restores and permanently deletes a message with attachments', async () => {
    const messageId = newId()
    seedMessage(messageId)
    const attachmentId = await seedAttachment({ emailId: messageId })
    const key = `mail/docs/${attachmentId}.pdf`

    expect((await call('DELETE', `/accounts/${accountId}/emails/${messageId}`)).status).toBe(204)
    expect(store.getEmail(messageId)).toBeNull()
    const trash = await json<EmailListResponse>(await call('GET', `/accounts/${accountId}/trash`))
    expect(trash.totalCount).toBe(1)
    expect(trash.emails[0]!.id).toBe(messageId)
    expect((await call('GET', `/accounts/${accountId}/emails/${messageId}`)).status).toBe(404)

    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/restore`)).status).toBe(204)
    expect(store.getEmail(messageId)?.folder_id).toBe('inbox')

    expect((await call('DELETE', `/accounts/${accountId}/emails/${messageId}?permanent=true`)).status).toBe(204)
    expect(store.getEmail(messageId)).toBeNull()
    expect(count('SELECT COUNT(*) AS n FROM email_attachments WHERE id = ?', attachmentId)).toBe(0)
    expect(bucket.objects.has(key)).toBe(false)

    const notInTrash = await call('POST', `/accounts/${accountId}/emails/${newId()}/restore`)
    expect(notInTrash.status).toBe(404)
    expect((await errorOf(notInTrash)).code).toBe('email_not_in_trash')
  })

  it('empties the trash only with confirmation', async () => {
    const messageId = newId()
    seedMessage(messageId)
    await call('DELETE', `/accounts/${accountId}/emails/${messageId}`)
    const attachmentId = await seedAttachment({ emailId: messageId })
    const key = `mail/docs/${attachmentId}.pdf`

    const refused = await call('DELETE', `/accounts/${accountId}/trash`)
    expect(refused.status).toBe(400)
    expect(store.countTrash()).toBe(1)

    expect((await call('DELETE', `/accounts/${accountId}/trash?confirm=true`)).status).toBe(204)
    expect(store.countTrash()).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM email_attachments WHERE id = ?', attachmentId)).toBe(0)
    expect(bucket.objects.has(key)).toBe(false)
  })

  it('moves messages between folders and uses the trash for trash moves', async () => {
    const messageId = newId()
    seedMessage(messageId)
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/move`, { folderId: 'archive' })).status).toBe(204)
    expect(store.getEmail(messageId)?.folder_id).toBe('archive')

    const missingFolder = await call('POST', `/accounts/${accountId}/emails/${messageId}/move`, { folderId: 'nope' })
    expect(missingFolder.status).toBe(404)
    expect((await errorOf(missingFolder)).code).toBe('email_folder_not_found')

    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/move`, { folderId: 'trash' })).status).toBe(204)
    expect(store.getEmail(messageId)).toBeNull()
    expect(store.countTrash()).toBe(1)
  })
})

describe('email threads and search', () => {
  it('returns every message in a thread with attachments and marks it read', async () => {
    const first = newId()
    const second = newId()
    seedMessage(first, { threadId: 'thread-1', date: 1_000 })
    seedMessage(second, { threadId: 'thread-1', date: 2_000 })
    const attachmentId = await seedAttachment({ emailId: second })

    const response = await call('GET', `/accounts/${accountId}/threads/thread-1`)
    expect(response.status).toBe(200)
    const messages = await json<EmailMessage[]>(response)
    expect(messages.map((message) => message.id)).toEqual([first, second])
    expect(messages[1]!.attachments[0]!.id).toBe(attachmentId)

    expect((await call('POST', `/accounts/${accountId}/threads/thread-1/read`)).status).toBe(204)
    expect(store.getThreadEmails('thread-1').every((message) => message.read === 1)).toBe(true)
  })

  it('searches with text, folder, flags and dates', async () => {
    const invoice = newId()
    seedMessage(invoice, {
      subject: 'Invoice 42',
      body: '<p>Please pay</p>',
      date: 1_000,
      hasAttachment: true,
      read: true,
    })
    seedMessage(newId(), { subject: 'Lunch', body: '<p>Hello</p>', date: 5_000 })

    const response = await call(
      'GET',
      `/accounts/${accountId}/search?query=Invoice&folder=inbox&is_read=true&has_attachment=true&date_start=500&date_end=2000`,
    )
    expect(response.status).toBe(200)
    const result = await json<EmailListResponse & { emails: Array<{ id: string; folderName?: string | null }> }>(
      response,
    )
    expect(result.totalCount).toBe(1)
    expect(result.emails[0]).toMatchObject({ id: invoice, folderName: 'Inbox' })

    const invalidDate = await call('GET', `/accounts/${accountId}/search?date_start=not-a-date`)
    expect(invalidDate.status).toBe(400)
    const invalidFlag = await call('GET', `/accounts/${accountId}/search?is_starred=maybe`)
    expect(invalidFlag.status).toBe(400)
  })
})

describe('email drafts and attachments', () => {
  it('saves and replaces a draft, storing HTML as the body and markdown as the source', async () => {
    const created = await call('POST', `/accounts/${accountId}/drafts`, {
      to: 'bob@example.com',
      subject: 'Draft',
      body: 'Hello **there**',
      bodyHtml: '<p>Hello <strong>there</strong></p>',
    })
    expect(created.status).toBe(201)
    const { draftId } = await json<{ draftId: string }>(created)
    const draft = store.getEmail(draftId)
    expect(draft).toMatchObject({
      folder_id: 'draft',
      subject: 'Draft',
      recipient: 'bob@example.com',
      body: '<p>Hello <strong>there</strong></p>',
      body_source: 'Hello **there**',
    })

    const replaced = await call('POST', `/accounts/${accountId}/drafts`, {
      draftId,
      to: 'bob@example.com',
      subject: 'Draft two',
      body: 'Updated',
      bodyHtml: '<p>Updated</p>',
    })
    expect(replaced.status).toBe(200)
    expect(await json<{ draftId: string }>(replaced)).toEqual({ draftId })
    expect(store.getEmail(draftId)?.subject).toBe('Draft two')
    expect(store.getEmail(draftId)?.body_source).toBe('Updated')

    const missing = await call('POST', `/accounts/${accountId}/drafts`, {
      draftId: newId(),
      to: 'bob@example.com',
      subject: 'Gone',
      body: '',
      bodyHtml: '',
    })
    expect(missing.status).toBe(404)

    const tooLong = await call('POST', `/accounts/${accountId}/drafts`, {
      to: 'bob@example.com',
      subject: 'x'.repeat(EMAIL_SUBJECT_MAX_CHARS + 1),
      body: '',
      bodyHtml: '',
    })
    expect(tooLong.status).toBe(400)
    expect((await errorOf(tooLong)).code).toBe('email_draft_invalid')

    const tooLarge = await call('POST', `/accounts/${accountId}/drafts`, {
      to: 'bob@example.com',
      subject: 'Big',
      body: 'x',
      bodyHtml: 'x'.repeat(EMAIL_BODY_MAX_BYTES + 1),
    })
    expect(tooLarge.status).toBe(413)
  })

  it('links an unfiled attachment to a draft and unlinks it into deletion', async () => {
    const { draftId } = await json<{ draftId: string }>(await call('POST', `/accounts/${accountId}/drafts`, {
      to: 'bob@example.com',
      subject: 'With file',
      body: '',
      bodyHtml: '',
    }))
    const attachmentId = await seedAttachment({ emailId: null, account: null })
    const key = `mail/docs/${attachmentId}.pdf`

    const linked = await call('POST', `/accounts/${accountId}/drafts/${draftId}/attachments`, { attachmentId })
    expect(linked.status).toBe(204)
    const row = sqlite.prepare('SELECT email_id, account_id FROM email_attachments WHERE id = ?').get(attachmentId) as {
      email_id: string
      account_id: string
    }
    expect(row).toEqual({ email_id: draftId, account_id: accountId })
    expect(store.getEmail(draftId)?.has_attachment).toBe(1)

    const detached = await call('DELETE', `/accounts/${accountId}/drafts/${draftId}/attachments/${attachmentId}`)
    expect(detached.status).toBe(204)
    expect(count('SELECT COUNT(*) AS n FROM email_attachments WHERE id = ?', attachmentId)).toBe(0)
    expect(bucket.objects.has(key)).toBe(false)
    expect(store.getEmail(draftId)?.has_attachment).toBe(0)
  })

  it('refuses to link a locked attachment or one from another draft', async () => {
    const { draftId } = await json<{ draftId: string }>(await call('POST', `/accounts/${accountId}/drafts`, {
      to: 'bob@example.com',
      subject: 'With file',
      body: '',
      bodyHtml: '',
    }))
    const locked = await seedAttachment({ emailId: null, account: null, locked: 1 })
    const lockedResponse = await call('POST', `/accounts/${accountId}/drafts/${draftId}/attachments`, {
      attachmentId: locked,
    })
    expect(lockedResponse.status).toBe(409)
    expect((await errorOf(lockedResponse)).code).toBe('email_attachment_locked')

    const otherDraft = newId()
    seedMessage(otherDraft, { folder: 'draft' })
    const linkedElsewhere = await seedAttachment({ emailId: otherDraft })
    const notFound = await call('POST', `/accounts/${accountId}/drafts/${draftId}/attachments`, {
      attachmentId: linkedElsewhere,
    })
    expect(notFound.status).toBe(404)
    expect((await errorOf(notFound)).code).toBe('email_attachment_not_found')
  })
})

describe('email file serving', () => {
  it('serves an owned attachment with ETag, range and safe headers', async () => {
    const messageId = newId()
    seedMessage(messageId)
    const bytes = new TextEncoder().encode('0123456789')
    const attachmentId = await seedAttachment({ emailId: messageId, bytes, sha: 'abc123' })
    const path = `/files/${attachmentId}`

    const response = await call('GET', path)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''report.pdf")
    expect(response.headers.get('etag')).toBe('"abc123"')
    expect(await response.text()).toBe('0123456789')

    const cached = await call('GET', path, undefined)
    const conditional = await app().request(`/api/email${path}`, {
      headers: { 'if-none-match': '"abc123"' },
    }, env)
    expect(conditional.status).toBe(304)
    expect(cached.status).toBe(200)

    const ranged = await app().request(`/api/email${path}`, {
      headers: { range: 'bytes=2-5' },
    }, env)
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await ranged.text()).toBe('2345')

    const invalid = await app().request(`/api/email${path}`, {
      headers: { range: 'bytes=20-30' },
    }, env)
    expect(invalid.status).toBe(416)
  })

  it('does not serve another account attachment', async () => {
    const messageId = newId()
    seedMessage(messageId)
    const attachmentId = await seedAttachment({ emailId: messageId })
    userId = newId()
    const response = await call('GET', `/files/${attachmentId}`)
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('email_attachment_not_found')

    const invalid = await call('GET', '/files/not-an-id')
    expect(invalid.status).toBe(404)
  })
})
