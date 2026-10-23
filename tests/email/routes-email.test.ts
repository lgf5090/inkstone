// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { EMAIL_BODY_MAX_BYTES, EMAIL_FOLLOW_UP_MAX_MS, EMAIL_LEGACY_SIGNATURE_ID, EMAIL_SIGNATURES_MAX, EMAIL_SIGNATURE_NAME_MAX_CHARS, EMAIL_SIGNATURE_TEXT_MAX_CHARS, EMAIL_SNOOZE_MAX_MS, EMAIL_SUBJECT_MAX_CHARS, EMAIL_VACATION_BODY_MAX_CHARS, EMAIL_VACATION_SUBJECT_MAX_CHARS } from '../../src/shared/email/model'
import type { EmailAccount, EmailFolder, EmailListResponse, EmailMailboxStats, EmailMessage, EmailTag } from '../../src/shared/email/model'
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

function mailboxNamespace(store: MailboxStore): DurableObjectNamespace {
  const base = fakeEmailMailboxNamespace(store)
  return {
    ...base,
    get: ((id: DurableObjectId) => {
      const stub = base.get(id) as unknown as {
        batchUpdate: (
          ids: string[],
          action: Parameters<MailboxStore['batchUpdate']>[1],
          folderId?: string,
        ) => { updated: number }
        snoozeEmail: (id: string, until: number) => ReturnType<MailboxStore['snoozeEmail']>
        wakeSnoozed: (now?: number, limit?: number) => string[]
        muteThread: (threadId: string, muted: boolean) => number
        setFollowUp: (id: string, at: number | null) => ReturnType<MailboxStore['setFollowUp']>
      }
      stub.batchUpdate = (ids, action, folderId) => store.batchUpdate(ids, action, folderId)
      stub.snoozeEmail = (id: string, until: number) => store.snoozeEmail(id, until)
      stub.wakeSnoozed = (now?: number, limit?: number) => store.wakeSnoozed(now, limit)
      stub.muteThread = (threadId: string, muted: boolean) => store.muteThread(threadId, muted)
      stub.setFollowUp = (id: string, at: number | null) => store.setFollowUp(id, at)
      return stub as unknown as DurableObjectStub
    }) as DurableObjectNamespace['get'],
  } as DurableObjectNamespace
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
    EMAIL_MAILBOX: mailboxNamespace(store),
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

describe('email account settings', () => {
  it('saves multiple signatures and their default', async () => {
    const response = await call('PATCH', `/accounts/${accountId}`, {
      settings: {
        signatures: [
          { id: 'work', name: ' Work ', text: 'Ada at work', enabled: true, extra: 'ignored' },
          { id: 'personal', name: 'Personal', text: 'Ada at home' },
        ],
        defaultSignatureId: 'personal',
        signature: { enabled: true, text: 'Legacy signature' },
        autoDraft: false,
        extra: 'ignored',
      },
    })
    expect(response.status).toBe(200)
    const saved = await json<EmailAccount>(response)
    expect(saved.settings.signatures).toEqual([
      { id: 'work', name: 'Work', text: 'Ada at work', enabled: true },
      { id: 'personal', name: 'Personal', text: 'Ada at home', enabled: true },
    ])
    expect(saved.settings.defaultSignatureId).toBe('personal')
    expect(saved.settings.signature).toBeUndefined()
    expect(saved.settings.autoDraft).toBe(false)
    expect(saved.settings).not.toHaveProperty('extra')
  })

  it('normalizes a legacy signature into one entry', async () => {
    const response = await call('PATCH', `/accounts/${accountId}`, {
      settings: { signature: { enabled: true, text: 'Ada Lovelace' } },
    })
    expect(response.status).toBe(200)
    const saved = await json<EmailAccount>(response)
    expect(saved.settings.signatures).toEqual([{
      id: EMAIL_LEGACY_SIGNATURE_ID,
      name: '',
      text: 'Ada Lovelace',
      enabled: true,
    }])
    expect(saved.settings.defaultSignatureId).toBe(EMAIL_LEGACY_SIGNATURE_ID)
    expect(saved.settings.signature).toBeUndefined()
  })

  it('rejects signature lists that break the settings contract', async () => {
    const tooMany = await call('PATCH', `/accounts/${accountId}`, {
      settings: {
        signatures: Array.from({ length: EMAIL_SIGNATURES_MAX + 1 }, (_, index) => ({
          id: `s${index}`,
          name: `Signature ${index}`,
          text: 'Text',
        })),
      },
    })
    expect(tooMany.status).toBe(400)
    expect((await errorOf(tooMany)).code).toBe('email_settings_invalid')

    const missingDefault = await call('PATCH', `/accounts/${accountId}`, {
      settings: {
        signatures: [{ id: 'work', name: 'Work', text: 'Ada at work' }],
        defaultSignatureId: 'personal',
      },
    })
    expect(missingDefault.status).toBe(400)
    expect((await errorOf(missingDefault)).code).toBe('email_settings_invalid')

    const duplicateIds = await call('PATCH', `/accounts/${accountId}`, {
      settings: {
        signatures: [
          { id: 'work', name: 'Work', text: 'Ada at work' },
          { id: 'work', name: 'Other', text: 'Ada again' },
        ],
      },
    })
    expect(duplicateIds.status).toBe(400)
    expect((await errorOf(duplicateIds)).code).toBe('email_settings_invalid')

    const longName = await call('PATCH', `/accounts/${accountId}`, {
      settings: {
        signatures: [{ id: 'work', name: 'x'.repeat(EMAIL_SIGNATURE_NAME_MAX_CHARS + 1), text: 'Ada at work' }],
      },
    })
    expect(longName.status).toBe(400)
    expect((await errorOf(longName)).code).toBe('email_settings_invalid')

    const longText = await call('PATCH', `/accounts/${accountId}`, {
      settings: {
        signatures: [{ id: 'work', name: 'Work', text: 'x'.repeat(EMAIL_SIGNATURE_TEXT_MAX_CHARS + 1) }],
      },
    })
    expect(longText.status).toBe(400)
    expect((await errorOf(longText)).code).toBe('email_settings_invalid')

    const strayDefault = await call('PATCH', `/accounts/${accountId}`, {
      settings: { defaultSignatureId: 'work' },
    })
    expect(strayDefault.status).toBe(400)
    expect((await errorOf(strayDefault)).code).toBe('email_settings_invalid')
  })

  it('saves a normalized vacation reply window', async () => {
    const start = Date.parse('2026-05-01T09:00:00.000Z')
    const end = Date.parse('2026-05-03T18:30:00.000Z')
    const response = await call('PATCH', `/accounts/${accountId}`, {
      settings: {
        vacation: {
          enabled: true,
          start: '2026-05-01T09:00:00.000Z',
          end,
          subject: '  Out of office  ',
          body: 'Back on Monday',
          extra: 'ignored',
        },
      },
    })
    expect(response.status).toBe(200)
    const saved = await json<EmailAccount>(response)
    expect(saved.settings.vacation).toEqual({
      enabled: true,
      start,
      end,
      subject: 'Out of office',
      body: 'Back on Monday',
    })
  })

  it('rejects vacation settings that break the settings contract', async () => {
    const enabledAsText = await call('PATCH', `/accounts/${accountId}`, {
      settings: { vacation: { enabled: 'yes', start: null, end: null, subject: '', body: '' } },
    })
    expect(enabledAsText.status).toBe(400)
    expect((await errorOf(enabledAsText)).code).toBe('email_settings_invalid')

    const longSubject = await call('PATCH', `/accounts/${accountId}`, {
      settings: {
        vacation: {
          enabled: true,
          start: null,
          end: null,
          subject: 'x'.repeat(EMAIL_VACATION_SUBJECT_MAX_CHARS + 1),
          body: '',
        },
      },
    })
    expect(longSubject.status).toBe(400)
    expect((await errorOf(longSubject)).code).toBe('email_settings_invalid')

    const longBody = await call('PATCH', `/accounts/${accountId}`, {
      settings: {
        vacation: {
          enabled: true,
          start: null,
          end: null,
          subject: '',
          body: 'x'.repeat(EMAIL_VACATION_BODY_MAX_CHARS + 1),
        },
      },
    })
    expect(longBody.status).toBe(400)
    expect((await errorOf(longBody)).code).toBe('email_settings_invalid')

    const badStart = await call('PATCH', `/accounts/${accountId}`, {
      settings: { vacation: { enabled: true, start: 'tomorrow', end: null, subject: '', body: '' } },
    })
    expect(badStart.status).toBe(400)
    expect((await errorOf(badStart)).code).toBe('email_settings_invalid')

    const reversed = await call('PATCH', `/accounts/${accountId}`, {
      settings: { vacation: { enabled: true, start: 2_000, end: 1_000, subject: '', body: '' } },
    })
    expect(reversed.status).toBe(400)
    expect((await errorOf(reversed)).code).toBe('email_settings_invalid')

    const notAnObject = await call('PATCH', `/accounts/${accountId}`, {
      settings: { vacation: 'on' },
    })
    expect(notAnObject.status).toBe(400)
    expect((await errorOf(notAnObject)).code).toBe('email_settings_invalid')
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

describe('email raw download', () => {
  it('serves a complete .eml with reconstructed headers and the HTML body', async () => {
    const messageId = newId()
    seedMessage(messageId, {
      subject: 'Quarterly report',
      sender: 'Ada <ada@example.com>',
      recipient: 'owner@example.com',
      cc: 'team@example.com',
      bcc: 'secret@example.com',
      body: '<p>The numbers are ready.</p>',
      messageId: '<message-1@example.com>',
      inReplyTo: '<parent@example.com>',
      emailReferences: JSON.stringify(['<root@example.com>', '<parent@example.com>']),
      rawHeaders: JSON.stringify([
        { key: 'Reply-To', value: 'ada@example.com' },
        { key: 'Subject', value: 'ignored duplicate' },
      ]),
      hasAttachment: true,
    })

    const response = await call('GET', `/accounts/${accountId}/emails/${messageId}/raw`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('message/rfc822')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(disposition).toContain('attachment')
    expect(disposition).toContain('filename="Quarterly report.eml"')

    const eml = await response.text()
    expect(eml).toContain('From: Ada <ada@example.com>')
    expect(eml).toContain('To: owner@example.com')
    expect(eml).toContain('Cc: team@example.com')
    expect(eml).toContain('Bcc: secret@example.com')
    expect(eml).toContain('Subject: Quarterly report')
    expect(eml).toContain('Date: ')
    expect(eml).toContain('Message-ID: <message-1@example.com>')
    expect(eml).toContain('In-Reply-To: <parent@example.com>')
    expect(eml).toContain('References: <root@example.com> <parent@example.com>')
    expect(eml).toContain('MIME-Version: 1.0')
    expect(eml).toContain('Content-Type: text/html; charset=utf-8')
    expect(eml).toContain('Content-Transfer-Encoding: 8bit')
    expect(eml).toContain('Reply-To: ada@example.com')
    expect(eml).not.toContain('ignored duplicate')
    expect(eml).toContain('X-Inkstone-Attachments-Omitted: true')
    expect(eml).toContain('\r\n\r\n<p>The numbers are ready.</p>')
  })

  it('strips injected line breaks and folds long header values', async () => {
    const messageId = newId()
    const longValue = 'word '.repeat(24).trim()
    seedMessage(messageId, {
      subject: 'Hello\r\nBcc: victim@example.com',
      sender: 'Ada\r\nX-Injected: yes <ada@example.com>',
      body: '<p>Body</p>',
      rawHeaders: JSON.stringify([
        { key: 'X-Note', value: 'safe\r\nX-Injected: no' },
        { key: 'X-Long', value: longValue },
        { key: 'Bad Header', value: 'x' },
      ]),
    })

    const response = await call('GET', `/accounts/${accountId}/emails/${messageId}/raw`)
    expect(response.status).toBe(200)
    const eml = await response.text()
    expect(eml).not.toContain('\r\nBcc:')
    expect(eml).not.toContain('\r\nX-Injected:')
    expect(eml).not.toContain('Bad Header:')
    expect(eml).toContain('Subject: Hello Bcc: victim@example.com')
    expect(eml).toContain('From: Ada X-Injected: yes <ada@example.com>')
    expect(eml).toContain('X-Note: safe X-Injected: no')
    expect(eml).toContain(`X-Long: ${longValue.slice(0, 60)}`)
    expect(eml).toContain('\r\n word')
    expect(eml).toContain('\r\n\r\n<p>Body</p>')
  })

  it('is owner-only and keeps the message inside its account', async () => {
    const messageId = newId()
    seedMessage(messageId)
    const missing = await call('GET', `/accounts/${accountId}/emails/${newId()}/raw`)
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('email_message_not_found')

    userRole = 'member'
    const member = await call('GET', `/accounts/${accountId}/emails/${messageId}/raw`)
    expect(member.status).toBe(403)
    expect((await errorOf(member)).code).toBe('forbidden')

    userRole = 'owner'
    userId = newId()
    const other = await call('GET', `/accounts/${accountId}/emails/${messageId}/raw`)
    expect(other.status).toBe(404)
    expect((await errorOf(other)).code).toBe('email_account_not_found')
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

  it('updates important and muted flags and filters lists by them', async () => {
    const importantId = newId()
    const mutedId = newId()
    seedMessage(importantId)
    seedMessage(mutedId)

    const response = await call('PATCH', `/accounts/${accountId}/emails/${importantId}`, { important: true })
    expect(response.status).toBe(200)
    expect(await json<EmailMessage>(response)).toMatchObject({ important: true, muted: false, followUpAt: null })
    expect((await call('PATCH', `/accounts/${accountId}/emails/${mutedId}`, { muted: true })).status).toBe(200)

    const importantList = await json<EmailListResponse>(
      await call('GET', `/accounts/${accountId}/emails?folder=inbox&is_important=true`),
    )
    expect(importantList.emails.map((email) => email.id)).toEqual([importantId])
    expect(importantList.totalCount).toBe(1)
    const mutedList = await json<EmailListResponse>(
      await call('GET', `/accounts/${accountId}/emails?folder=inbox&is_muted=true&threaded=true`),
    )
    expect(mutedList.emails.map((email) => email.id)).toEqual([mutedId])
    const everything = await json<EmailListResponse>(
      await call('GET', `/accounts/${accountId}/emails?folder=inbox`),
    )
    expect(everything.totalCount).toBe(2)

    const invalid = await call('PATCH', `/accounts/${accountId}/emails/${importantId}`, { important: 'yes' })
    expect(invalid.status).toBe(400)
    expect((await call('PATCH', `/accounts/${accountId}/emails/${importantId}`, {})).status).toBe(400)
  })

  it('filters lists and search by focused', async () => {
    const focusedId = newId()
    const otherId = newId()
    seedMessage(focusedId, { focused: true })
    seedMessage(otherId, { focused: false })

    const other = await json<EmailListResponse>(
      await call('GET', `/accounts/${accountId}/emails?folder=inbox&focused=0`),
    )
    expect(other.emails.map((email) => email.id)).toEqual([otherId])
    expect(other.emails[0]!.focused).toBe(false)
    expect(other.totalCount).toBe(1)

    const focused = await json<EmailListResponse>(
      await call('GET', `/accounts/${accountId}/emails?folder=inbox&focused=1`),
    )
    expect(focused.emails.map((email) => email.id)).toEqual([focusedId])
    expect(focused.emails[0]!.focused).toBe(true)
    expect(focused.totalCount).toBe(1)

    const everything = await json<EmailListResponse>(
      await call('GET', `/accounts/${accountId}/emails?folder=inbox`),
    )
    expect(everything.totalCount).toBe(2)

    const searched = await json<EmailListResponse>(
      await call('GET', `/accounts/${accountId}/search?is_focused=false`),
    )
    expect(searched.emails.map((email) => email.id)).toEqual([otherId])
    expect(searched.totalCount).toBe(1)

    expect((await call('GET', `/accounts/${accountId}/emails?folder=inbox&focused=maybe`)).status).toBe(400)
    expect((await call('GET', `/accounts/${accountId}/search?is_focused=maybe`)).status).toBe(400)
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

describe('email batch actions', () => {
  it('updates flags, moves, archives, trashes and restores selected messages', async () => {
    const first = newId()
    const second = newId()
    seedMessage(first)
    seedMessage(second)

    const read = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [first, second, first],
      action: 'read',
    })
    expect(read.status).toBe(200)
    expect(await json<{ updated: number }>(read)).toEqual({ updated: 2 })
    expect(store.getEmail(first)?.read).toBe(1)
    expect(store.getEmail(second)?.read).toBe(1)

    const unread = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [first, second],
      action: 'unread',
    })
    expect(await json<{ updated: number }>(unread)).toEqual({ updated: 2 })
    expect(store.getEmail(first)?.read).toBe(0)

    const star = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [first, second],
      action: 'star',
    })
    expect(await json<{ updated: number }>(star)).toEqual({ updated: 2 })
    expect(store.getEmail(second)?.starred).toBe(1)
    const unstar = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [first, second],
      action: 'unstar',
    })
    expect(await json<{ updated: number }>(unstar)).toEqual({ updated: 2 })
    expect(store.getEmail(second)?.starred).toBe(0)

    const moved = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [first, second],
      action: 'move',
      folderId: 'archive',
    })
    expect(await json<{ updated: number }>(moved)).toEqual({ updated: 2 })
    expect(store.getEmail(first)?.folder_id).toBe('archive')
    expect(store.getEmail(second)?.folder_id).toBe('archive')

    const archived = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [first, second],
      action: 'archive',
    })
    expect(await json<{ updated: number }>(archived)).toEqual({ updated: 2 })
    expect(store.getEmail(first)?.folder_id).toBe('archive')

    const trashed = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [first, second],
      action: 'trash',
    })
    expect(await json<{ updated: number }>(trashed)).toEqual({ updated: 2 })
    expect(store.getEmail(first)).toBeNull()
    expect(store.countTrash()).toBe(2)

    const restored = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [first, second],
      action: 'restore',
    })
    expect(await json<{ updated: number }>(restored)).toEqual({ updated: 2 })
    expect(store.getEmail(first)?.folder_id).toBe('inbox')
    expect(store.getEmail(second)?.deleted_at).toBeNull()
  })

  it('soft-deletes messages moved to the trash and leaves attachments alone', async () => {
    const messageId = newId()
    seedMessage(messageId)
    const attachmentId = await seedAttachment({ emailId: messageId })
    const key = `mail/docs/${attachmentId}.pdf`

    const moved = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [messageId],
      action: 'move',
      folderId: 'trash',
    })
    expect(moved.status).toBe(200)
    expect(store.getEmail(messageId)).toBeNull()
    expect(store.countTrash()).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM email_attachments WHERE id = ?', attachmentId)).toBe(1)
    expect(bucket.objects.has(key)).toBe(true)

    const trashed = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [messageId],
      action: 'trash',
    })
    expect(await json<{ updated: number }>(trashed)).toEqual({ updated: 0 })
  })

  it('validates ids, actions, limits and target folders', async () => {
    const messageId = newId()
    seedMessage(messageId)

    const empty = await call('POST', `/accounts/${accountId}/emails/batch`, { ids: [], action: 'read' })
    expect(empty.status).toBe(400)
    const nonArray = await call('POST', `/accounts/${accountId}/emails/batch`, { ids: messageId, action: 'read' })
    expect(nonArray.status).toBe(400)
    const invalidId = await call('POST', `/accounts/${accountId}/emails/batch`, { ids: ['nope'], action: 'read' })
    expect(invalidId.status).toBe(400)
    const tooMany = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: Array.from({ length: 101 }, () => newId()),
      action: 'read',
    })
    expect(tooMany.status).toBe(400)
    const atLimit = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: Array.from({ length: 100 }, () => newId()),
      action: 'read',
    })
    expect(atLimit.status).toBe(200)
    expect(await json<{ updated: number }>(atLimit)).toEqual({ updated: 0 })
    const invalidAction = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [messageId],
      action: 'delete',
    })
    expect(invalidAction.status).toBe(400)
    const missingFolder = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [messageId],
      action: 'move',
    })
    expect(missingFolder.status).toBe(400)
    const unknownFolder = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [messageId],
      action: 'move',
      folderId: 'nope',
    })
    expect(unknownFolder.status).toBe(404)
    expect((await errorOf(unknownFolder)).code).toBe('email_folder_not_found')
    expect(store.getEmail(messageId)?.read).toBe(0)
  })

  it('treats another account as absent', async () => {
    const messageId = newId()
    seedMessage(messageId)
    userId = newId()
    const response = await call('POST', `/accounts/${accountId}/emails/batch`, {
      ids: [messageId],
      action: 'read',
    })
    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('email_account_not_found')
    expect(store.getEmail(messageId)?.read).toBe(0)
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

  it('mutes and unmutes every message in a thread', async () => {
    seedMessage(newId(), { threadId: 'thread-1', date: 1_000 })
    seedMessage(newId(), { threadId: 'thread-1', date: 2_000 })
    seedMessage(newId(), { threadId: 'thread-2', date: 3_000 })

    const muted = await call('POST', `/accounts/${accountId}/threads/thread-1/mute`, { muted: true })
    expect(muted.status).toBe(204)
    expect(store.getThreadEmails('thread-1').every((message) => message.muted === 1)).toBe(true)
    expect(store.getThreadEmails('thread-2').every((message) => message.muted === 0)).toBe(true)

    const unmuted = await call('POST', `/accounts/${accountId}/threads/thread-1/mute`, { muted: false })
    expect(unmuted.status).toBe(204)
    expect(store.getThreadEmails('thread-1').every((message) => message.muted === 0)).toBe(true)

    expect((await call('POST', `/accounts/${accountId}/threads/thread-1/mute`, {})).status).toBe(400)
    expect((await call('POST', `/accounts/${accountId}/threads/missing/mute`, { muted: true })).status).toBe(404)
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
    const invalidImportant = await call('GET', `/accounts/${accountId}/search?is_important=maybe`)
    expect(invalidImportant.status).toBe(400)

    const at = Date.now() + 60 * 60 * 1000
    const flagged = newId()
    seedMessage(flagged, { subject: 'Tracked' })
    expect((await call('PATCH', `/accounts/${accountId}/emails/${flagged}`, { important: true })).status).toBe(200)
    expect((await call('POST', `/accounts/${accountId}/emails/${flagged}/follow-up`, { at })).status).toBe(200)
    const filtered = await json<EmailListResponse>(
      await call('GET', `/accounts/${accountId}/search?is_important=true&is_followup=true&is_muted=false`),
    )
    expect(filtered.emails.map((email) => email.id)).toEqual([flagged])
    expect(filtered.totalCount).toBe(1)
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

describe('email folder hierarchy routes', () => {
  it('creates nested folders, allows sibling names under different parents and rejects duplicates', async () => {
    const parent = await json<EmailFolder>(await call('POST', `/accounts/${accountId}/folders`, {
      name: 'Projects',
      color: '#2563eb',
    }))
    expect(parent).toMatchObject({ parentId: null, color: '#2563eb', sortOrder: 0, unreadCount: 0 })

    const child = await json<EmailFolder>(await call('POST', `/accounts/${accountId}/folders`, {
      name: 'Child',
      parentId: parent.id,
    }))
    expect(child).toMatchObject({ parentId: parent.id, color: null, sortOrder: 0 })

    const other = await json<EmailFolder>(await call('POST', `/accounts/${accountId}/folders`, { name: 'Other' }))
    expect((await call('POST', `/accounts/${accountId}/folders`, { name: 'Child', parentId: other.id })).status)
      .toBe(201)

    const duplicate = await call('POST', `/accounts/${accountId}/folders`, { name: 'child', parentId: parent.id })
    expect(duplicate.status).toBe(409)
    expect((await errorOf(duplicate)).code).toBe('email_folder_exists')

    expect((await call('POST', `/accounts/${accountId}/folders`, { name: 'Bad color', color: 'not-a-color' })).status)
      .toBe(400)
    expect((await call('POST', `/accounts/${accountId}/folders`, { name: 'bad/name' })).status).toBe(400)
    expect((await call('POST', `/accounts/${accountId}/folders`, { name: 'Bad parent', parentId: newId() })).status)
      .toBe(404)

    const listed = await json<EmailFolder[]>(await call('GET', `/accounts/${accountId}/folders`))
    expect(listed.find((folder) => folder.id === child.id)).toMatchObject({ parentId: parent.id })
  })

  it('limits folder nesting to five levels', async () => {
    let parentId: string | null = null
    const ids: string[] = []
    for (let level = 0; level < 5; level++) {
      const body = parentId ? { name: `Level ${level}`, parentId } : { name: `Level ${level}` }
      const response = await call('POST', `/accounts/${accountId}/folders`, body)
      expect(response.status).toBe(201)
      parentId = (await json<EmailFolder>(response)).id
      ids.push(parentId)
    }
    const tooDeep = await call('POST', `/accounts/${accountId}/folders`, { name: 'Level 5', parentId })
    expect(tooDeep.status).toBe(400)
    const tooDeepMove = await call('PATCH', `/accounts/${accountId}/folders/${ids[0]}`, {
      parentId: ids[4],
    })
    expect(tooDeepMove.status).toBe(400)
  })

  it('moves folders while rejecting self, cycles, duplicates and system changes', async () => {
    const root = await json<EmailFolder>(await call('POST', `/accounts/${accountId}/folders`, { name: 'Root' }))
    const child = await json<EmailFolder>(await call('POST', `/accounts/${accountId}/folders`, {
      name: 'Child',
      parentId: root.id,
    }))
    await call('POST', `/accounts/${accountId}/folders`, { name: 'Sibling' })

    const self = await call('PATCH', `/accounts/${accountId}/folders/${child.id}`, { parentId: child.id })
    expect(self.status).toBe(400)
    const cycle = await call('PATCH', `/accounts/${accountId}/folders/${root.id}`, { parentId: child.id })
    expect(cycle.status).toBe(400)

    const moved = await call('PATCH', `/accounts/${accountId}/folders/${child.id}`, {
      parentId: null,
      color: '#059669',
      sortOrder: 4,
    })
    expect(moved.status).toBe(200)
    expect(await json<EmailFolder>(moved)).toMatchObject({
      parentId: null,
      color: '#059669',
      sortOrder: 4,
    })
    const cleared = await call('PATCH', `/accounts/${accountId}/folders/${child.id}`, { color: null })
    expect(cleared.status).toBe(200)
    expect((await json<EmailFolder>(cleared)).color).toBeNull()

    const duplicate = await call('PATCH', `/accounts/${accountId}/folders/${child.id}`, { name: 'sibling' })
    expect(duplicate.status).toBe(409)
    expect((await errorOf(duplicate)).code).toBe('email_folder_exists')

    const system = await call('PATCH', `/accounts/${accountId}/folders/inbox`, { color: '#2563eb' })
    expect(system.status).toBe(400)
    expect((await errorOf(system)).code).toBe('email_folder_reserved')

    const missing = await call('PATCH', `/accounts/${accountId}/folders/${newId()}`, { name: 'Gone' })
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('email_folder_not_found')

    const empty = await call('PATCH', `/accounts/${accountId}/folders/${child.id}`, {})
    expect(empty.status).toBe(400)
  })

  it('promotes children and moves messages when a nested folder is deleted', async () => {
    const parent = await json<EmailFolder>(await call('POST', `/accounts/${accountId}/folders`, { name: 'Parent' }))
    const child = await json<EmailFolder>(await call('POST', `/accounts/${accountId}/folders`, {
      name: 'Child',
      parentId: parent.id,
    }))
    const messageId = newId()
    seedMessage(messageId, { folder: parent.id })

    expect((await call('DELETE', `/accounts/${accountId}/folders/${parent.id}`)).status).toBe(204)
    const folders = await json<EmailFolder[]>(await call('GET', `/accounts/${accountId}/folders`))
    expect(folders.find((folder) => folder.id === child.id)?.parentId).toBeNull()
    expect(store.getEmail(messageId)?.folder_id).toBe('inbox')
  })
})

describe('email tag routes', () => {
  it('creates, renames and deletes tags with duplicate and invalid name handling', async () => {
    expect(await json<EmailTag[]>(await call('GET', `/accounts/${accountId}/tags`))).toEqual([])

    const work = await json<EmailTag>(await call('POST', `/accounts/${accountId}/tags`, {
      name: 'work',
      color: '#2563eb',
    }))
    expect(work).toMatchObject({ name: 'work', color: '#2563eb', count: 0 })
    const meeting = await json<EmailTag>(await call('POST', `/accounts/${accountId}/tags`, { name: 'work/meeting' }))
    expect(meeting.name).toBe('work/meeting')

    const duplicate = await call('POST', `/accounts/${accountId}/tags`, { name: 'WORK' })
    expect(duplicate.status).toBe(409)
    expect((await errorOf(duplicate)).code).toBe('conflict')
    expect((await call('POST', `/accounts/${accountId}/tags`, { name: '   ' })).status).toBe(400)
    expect((await call('POST', `/accounts/${accountId}/tags`, { name: 'bad\\path' })).status).toBe(400)

    const renamed = await call('PATCH', `/accounts/${accountId}/tags/${work.id}`, { name: 'job' })
    expect(renamed.status).toBe(200)
    expect((await json<EmailTag>(renamed)).name).toBe('job')
    const conflict = await call('PATCH', `/accounts/${accountId}/tags/${work.id}`, { name: 'work/meeting' })
    expect(conflict.status).toBe(409)
    expect((await call('PATCH', `/accounts/${accountId}/tags/${newId()}`, { name: 'x' })).status).toBe(404)

    expect((await call('DELETE', `/accounts/${accountId}/tags/${meeting.id}`)).status).toBe(204)
    expect((await call('DELETE', `/accounts/${accountId}/tags/${meeting.id}`)).status).toBe(404)
  })

  it('attaches and detaches tags idempotently and filters list and search results', async () => {
    const tag = await json<EmailTag>(await call('POST', `/accounts/${accountId}/tags`, { name: 'inbox-tag' }))
    const messageId = newId()
    seedMessage(messageId)

    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/tags`, { tagId: tag.id })).status).toBe(204)
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/tags`, { tagId: tag.id })).status).toBe(204)
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/tags`, { path: 'inbox-tag' })).status).toBe(204)

    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/tags`, {})).status).toBe(400)
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/tags`, { tagId: 'nope' })).status).toBe(400)
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/tags`, { path: 'missing' })).status)
      .toBe(404)
    expect((await call('POST', `/accounts/${accountId}/emails/${newId()}/tags`, { tagId: tag.id })).status).toBe(404)

    const listed = await json<EmailListResponse>(await call(
      'GET',
      `/accounts/${accountId}/emails?tag=inbox-tag`,
    ))
    expect(listed.totalCount).toBe(1)
    expect(listed.emails.map((email) => email.id)).toEqual([messageId])

    const searched = await json<EmailListResponse>(await call(
      'GET',
      `/accounts/${accountId}/search?tag=inbox-tag`,
    ))
    expect(searched.totalCount).toBe(1)
    expect((await call('GET', `/accounts/${accountId}/emails?tag=bad%5Cpath`)).status).toBe(400)

    const tags = await json<EmailTag[]>(await call('GET', `/accounts/${accountId}/tags`))
    expect(tags.find((entry) => entry.id === tag.id)?.count).toBe(1)

    expect((await call('DELETE', `/accounts/${accountId}/emails/${messageId}/tags/${tag.id}`)).status).toBe(204)
    expect((await call('DELETE', `/accounts/${accountId}/emails/${messageId}/tags/${tag.id}`)).status).toBe(204)
    expect((await call('DELETE', `/accounts/${accountId}/emails/${messageId}/tags/${newId()}`)).status).toBe(404)
    expect((await call('DELETE', `/accounts/${accountId}/emails/${newId()}/tags/${tag.id}`)).status).toBe(404)

    const after = await json<EmailListResponse>(await call(
      'GET',
      `/accounts/${accountId}/emails?tag=inbox-tag`,
    ))
    expect(after.totalCount).toBe(0)

    expect((await call('DELETE', `/accounts/${accountId}/tags/${tag.id}`)).status).toBe(204)
    expect((await json<EmailListResponse>(await call(
      'GET',
      `/accounts/${accountId}/emails?tag=inbox-tag`,
    ))).totalCount).toBe(0)
  })

  it('keeps tags and stats owned by the account', async () => {
    userId = newId()
    expect((await call('GET', `/accounts/${accountId}/tags`)).status).toBe(404)
    expect((await call('GET', `/accounts/${accountId}/stats`)).status).toBe(404)
  })
})

describe('email stats route', () => {
  it('returns folder counts, overview totals and attachment bytes', async () => {
    const now = Date.now()
    seedMessage(newId(), {
      folder: 'inbox',
      date: now - 1_000,
      starred: true,
      hasAttachment: true,
    })
    const readInbox = newId()
    seedMessage(readInbox, { folder: 'inbox', date: now - 2 * 24 * 60 * 60 * 1000, read: true })
    seedMessage(newId(), { folder: 'sent', date: now - 2_000 })
    seedMessage(newId(), { folder: 'draft', date: now - 3_000 })
    const trashed = newId()
    seedMessage(trashed, { folder: 'inbox' })
    store.trashEmail(trashed)
    const attachmentId = await seedAttachment({ emailId: readInbox, bytes: new Uint8Array(7) })

    const response = await call('GET', `/accounts/${accountId}/stats`)
    expect(response.status).toBe(200)
    const stats = await json<EmailMailboxStats>(response)
    expect(stats).toMatchObject({
      total: 4,
      read: 2,
      unread: 2,
      starred: 1,
      withAttachments: 1,
      sent: 1,
      draft: 1,
      trash: 1,
      attachmentBytes: 7,
    })
    expect(stats.folders).toHaveLength(6)
    expect(stats.folders.find((folder) => folder.folderId === 'inbox')).toMatchObject({
      total: 2,
      read: 1,
      unread: 1,
      starred: 1,
      withAttachments: 1,
    })
    expect(stats.receivedLast7Days).toHaveLength(7)
    expect(stats.sentLast7Days).toHaveLength(7)
    expect(stats.receivedLast7Days.at(-1)?.count).toBe(1)
    expect(stats.sentLast7Days.at(-1)?.count).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM email_attachments WHERE id = ?', attachmentId)).toBe(1)
  })
})

describe('email snooze route', () => {
  it('snoozes a message, hides it from the inbox and returns the stored time', async () => {
    const messageId = newId()
    seedMessage(messageId)
    const until = Date.now() + 60 * 60 * 1000

    const response = await call('POST', `/accounts/${accountId}/emails/${messageId}/snooze`, {
      until: new Date(until).toISOString(),
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      id: messageId,
      snoozedUntil: new Date(until).toISOString(),
    })

    const list = await json<EmailListResponse>(await call('GET', `/accounts/${accountId}/emails?folder=inbox`))
    expect(list.totalCount).toBe(0)
    expect((await call('GET', `/accounts/${accountId}/emails/${messageId}`)).status).toBe(200)
    expect(store.getEmail(messageId)?.snoozed_until).toBe(until)
  })

  it('accepts an epoch value and rejects past, distant and malformed times', async () => {
    const messageId = newId()
    seedMessage(messageId)

    const epoch = Date.now() + 60 * 60 * 1000
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/snooze`, { until: epoch })).status).toBe(200)

    const past = await call('POST', `/accounts/${accountId}/emails/${messageId}/snooze`, { until: Date.now() - 1 })
    expect(past.status).toBe(400)
    expect((await errorOf(past)).code).toBe('bad_request')

    const distant = await call('POST', `/accounts/${accountId}/emails/${messageId}/snooze`, {
      until: Date.now() + EMAIL_SNOOZE_MAX_MS + 60 * 60 * 1000,
    })
    expect(distant.status).toBe(400)

    const malformed = await call('POST', `/accounts/${accountId}/emails/${messageId}/snooze`, { until: 'not-a-date' })
    expect(malformed.status).toBe(400)

    const missing = await call('POST', `/accounts/${accountId}/emails/${messageId}/snooze`, {})
    expect(missing.status).toBe(400)
  })

  it('refuses drafts, sent mail, trash and spam', async () => {
    const until = Date.now() + 60 * 60 * 1000
    for (const folder of ['draft', 'sent', 'trash', 'spam']) {
      const messageId = newId()
      seedMessage(messageId, { folder })
      const response = await call('POST', `/accounts/${accountId}/emails/${messageId}/snooze`, { until })
      expect(response.status).toBe(400)
      expect(store.getEmail(messageId)?.snoozed_until).toBeNull()
    }
  })

  it('requires the owner, the account and an existing message', async () => {
    const ownerId = userId
    const messageId = newId()
    seedMessage(messageId)
    const until = Date.now() + 60 * 60 * 1000

    userRole = 'member'
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/snooze`, { until })).status).toBe(403)

    userRole = 'owner'
    userId = newId()
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/snooze`, { until })).status).toBe(404)

    userId = ownerId
    const missing = await call('POST', `/accounts/${accountId}/emails/${newId()}/snooze`, { until })
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('email_message_not_found')
  })
})

describe('email follow-up route', () => {
  it('sets and clears a reminder and marks the message important', async () => {
    const messageId = newId()
    seedMessage(messageId)
    const at = Date.now() + 60 * 60 * 1000

    const response = await call('POST', `/accounts/${accountId}/emails/${messageId}/follow-up`, {
      at: new Date(at).toISOString(),
    })
    expect(response.status).toBe(200)
    expect(await json<EmailMessage>(response)).toMatchObject({
      important: true,
      followUpAt: new Date(at).toISOString(),
    })
    expect(store.getEmail(messageId)).toMatchObject({ important: 1, follow_up_at: at })

    const listed = await json<EmailListResponse>(await call('GET', `/accounts/${accountId}/search?is_followup=true`))
    expect(listed.emails.map((email) => email.id)).toEqual([messageId])

    const cleared = await call('POST', `/accounts/${accountId}/emails/${messageId}/follow-up`, { at: null })
    expect(cleared.status).toBe(200)
    expect(await json<EmailMessage>(cleared)).toMatchObject({ important: true, followUpAt: null })
    expect(store.getEmail(messageId)?.follow_up_at).toBeNull()
  })

  it('accepts an epoch value and rejects past, distant, malformed and missing times', async () => {
    const messageId = newId()
    seedMessage(messageId)

    const epoch = Date.now() + 60 * 60 * 1000
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/follow-up`, { at: epoch })).status).toBe(200)

    const past = await call('POST', `/accounts/${accountId}/emails/${messageId}/follow-up`, { at: Date.now() - 1 })
    expect(past.status).toBe(400)
    expect((await errorOf(past)).code).toBe('bad_request')

    const distant = await call('POST', `/accounts/${accountId}/emails/${messageId}/follow-up`, {
      at: Date.now() + EMAIL_FOLLOW_UP_MAX_MS + 60 * 60 * 1000,
    })
    expect(distant.status).toBe(400)

    const malformed = await call('POST', `/accounts/${accountId}/emails/${messageId}/follow-up`, { at: 'not-a-date' })
    expect(malformed.status).toBe(400)

    const missing = await call('POST', `/accounts/${accountId}/emails/${messageId}/follow-up`, {})
    expect(missing.status).toBe(400)
  })

  it('requires the owner, the account and an existing message', async () => {
    const ownerId = userId
    const messageId = newId()
    seedMessage(messageId)
    const at = Date.now() + 60 * 60 * 1000

    userRole = 'member'
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/follow-up`, { at })).status).toBe(403)

    userRole = 'owner'
    userId = newId()
    expect((await call('POST', `/accounts/${accountId}/emails/${messageId}/follow-up`, { at })).status).toBe(404)

    userId = ownerId
    const missing = await call('POST', `/accounts/${accountId}/emails/${newId()}/follow-up`, { at })
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('email_message_not_found')
  })
})
