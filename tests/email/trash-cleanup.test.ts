// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMAIL_TRASH_RETENTION_DAYS } from '../../src/shared/email/model'
import type { Env } from '../../src/worker/env'
import { newId } from '../../src/worker/lib/id'
import { persistEmailAttachment } from '../../src/worker/attachments/storage'
import { runEmailTrashCleanup } from '../../src/worker/email/trash'
import { createEmailAccount } from '../../src/worker/email/account-store'
import { testBindings, testR2Bucket, type TestR2Bucket } from '../doubles/bindings'
import {
  mailboxHarness,
  seedUser,
  testDatabase,
  type MailboxHarness,
  type TestDatabase,
} from '../fixtures/email/harness'

const OWNER = 'owner-user'
const MEMBER = 'member-user'
const DAY_MS = 24 * 60 * 60 * 1000

let database: TestDatabase
let harness: MailboxHarness
let r2: TestR2Bucket
let env: Env

beforeEach(() => {
  database = testDatabase()
  seedUser(database.sqlite, OWNER, 'owner')
  seedUser(database.sqlite, MEMBER, 'member')
  harness = mailboxHarness()
  r2 = testR2Bucket()
  env = testBindings(database.db, { EMAIL_MAILBOX: harness.namespace, FILES: r2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function trashMessage(accountId: string, messageId: string, deletedAt: number): void {
  harness.store(accountId).createEmail('inbox', {
    id: messageId,
    subject: `Subject ${messageId}`,
    sender: 'sender@example.com',
    recipient: 'me@example.com',
    date: deletedAt,
    body: 'Body',
  })
  harness.sqlite(accountId).prepare(
    `UPDATE email_messages SET folder_id = 'trash', deleted_at = ?1 WHERE id = ?2`,
  ).run(deletedAt, messageId)
}

async function attach(accountId: string, userId: string, messageId: string): Promise<string> {
  const stored = await persistEmailAttachment(env, {
    id: newId(),
    userId,
    accountId,
    emailId: messageId,
    filename: 'report.pdf',
    reportedMime: 'application/pdf',
    bytes: new TextEncoder().encode('%PDF-1.4'),
    locked: true,
    createdAt: Date.now(),
  })
  return stored.objectKey
}

async function attachmentCount(userId: string): Promise<number> {
  const row = await database.db.prepare(
    `SELECT COUNT(*) AS total FROM email_attachments WHERE user_id = ?1`,
  ).bind(userId).first<{ total: number }>()
  return Number(row?.total ?? 0)
}

describe('email trash cleanup', () => {
  it('purges only expired trash and removes its attachments from D1 and R2', async () => {
    await createEmailAccount(database.db, { id: 'owner-account', userId: OWNER, address: 'me@example.com', displayName: 'Me' })
    const now = Date.now()
    const cutoff = now - EMAIL_TRASH_RETENTION_DAYS * DAY_MS
    trashMessage('owner-account', 'expired', cutoff - 1)
    trashMessage('owner-account', 'recent', cutoff + DAY_MS)
    const objectKey = await attach('owner-account', OWNER, 'expired')
    expect(r2.objects.has(objectKey)).toBe(true)

    const result = await runEmailTrashCleanup(env, now)

    expect(result).toEqual({ accounts: 1, messages: 1, attachments: 1 })
    expect(harness.store('owner-account').listTrash().map((row) => row.id)).toEqual(['recent'])
    expect(await attachmentCount(OWNER)).toBe(0)
    expect(r2.objects.has(objectKey)).toBe(false)
  })

  it('leaves a non-owner mailbox out of the sweep', async () => {
    await createEmailAccount(database.db, { id: 'member-account', userId: MEMBER, address: 'member@example.com', displayName: 'Member' })
    const now = Date.now()
    trashMessage('member-account', 'member-trash', now - (EMAIL_TRASH_RETENTION_DAYS + 1) * DAY_MS)
    const objectKey = await attach('member-account', MEMBER, 'member-trash')

    const result = await runEmailTrashCleanup(env, now)

    expect(result).toEqual({ accounts: 0, messages: 0, attachments: 0 })
    expect(harness.store('member-account').listTrash()).toHaveLength(1)
    expect(await attachmentCount(MEMBER)).toBe(1)
    expect(r2.objects.has(objectKey)).toBe(true)
  })

  it('walks every owner account across pages', async () => {
    const now = Date.now()
    const deletedAt = now - (EMAIL_TRASH_RETENTION_DAYS + 1) * DAY_MS
    const total = 51
    for (let index = 0; index < total; index++) {
      const accountId = `account-${String(index).padStart(2, '0')}`
      await createEmailAccount(database.db, {
        id: accountId,
        userId: OWNER,
        address: `page-${index}@example.com`,
        displayName: `Page ${index}`,
      })
      trashMessage(accountId, `message-${index}`, deletedAt)
    }

    const result = await runEmailTrashCleanup(env, now)

    expect(result.accounts).toBe(total)
    expect(result.messages).toBe(total)
    for (let index = 0; index < total; index++) {
      expect(harness.store(`account-${String(index).padStart(2, '0')}`).countTrash()).toBe(0)
    }
  })

  it('reports zero when no mailbox storage is bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unbound = testBindings(database.db)

    expect(await runEmailTrashCleanup(unbound)).toEqual({ accounts: 0, messages: 0, attachments: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMAIL_MAILBOX'))
  })
})
