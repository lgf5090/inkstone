// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/worker/env'
import { createEmailAccount } from '../../src/worker/email/account-store'
import {
  assertEmailOwner,
  discardDraftTool,
  draftEmailReplyTool,
  draftEmailTool,
  findEmailAccountForInbound,
  getEmailToolMessage,
  listEmailToolMessages,
  markEmailReadTool,
  moveEmailTool,
  resolveEmailAccount,
  searchEmailToolMessages,
} from '../../src/worker/email/tools'
import { ApiError } from '../../src/worker/lib/errors'
import { mailboxHarness, seedUser, testDatabase, type MailboxHarness } from '../fixtures/email/harness'

let db: D1Database
let boxes: MailboxHarness
let env: Env
let accountId: string

const owner = 'owner-1'
const member = 'member-1'

async function seedMessage(id: string, patch: { folder?: string; threadId?: string | null } = {}): Promise<void> {
  const created = boxes.store(accountId).createEmail(patch.folder ?? 'inbox', {
    id,
    subject: 'Quarterly report',
    sender: 'Grace Hopper <grace@example.com>',
    recipient: 'ada@example.com',
    date: 1_700_000_000_000,
    body: '<p>The numbers are ready.</p>',
    threadId: patch.threadId ?? null,
  })
  expect(created).toBe(true)
}

beforeEach(async () => {
  const database = testDatabase()
  seedUser(database.sqlite, owner)
  seedUser(database.sqlite, member, 'member')
  boxes = mailboxHarness()
  db = database.db
  env = { DB: db, EMAIL_MAILBOX: boxes.namespace } as unknown as Env
  const account = await createEmailAccount(db, {
    userId: owner,
    address: 'ada@example.com',
    displayName: 'Ada',
  })
  accountId = account.id
})

describe('the assistant email tools', () => {
  it('keeps the mailbox away from members', async () => {
    await expect(assertEmailOwner(env, member)).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('takes the only mailbox by default and asks which one when there are several', async () => {
    expect((await resolveEmailAccount(env, owner)).id).toBe(accountId)
    const second = await createEmailAccount(db, {
      userId: owner,
      address: 'grace@example.com',
      displayName: 'Grace',
    })
    await expect(resolveEmailAccount(env, owner)).rejects.toBeInstanceOf(ApiError)
    expect((await resolveEmailAccount(env, owner, second.id)).id).toBe(second.id)
    await expect(resolveEmailAccount(env, owner, 'missing')).rejects.toMatchObject({ status: 404 })
  })

  it('reads, lists and searches only the owner mailbox', async () => {
    await seedMessage('m1')
    const list = await listEmailToolMessages(env, owner, { accountId, folder: 'inbox' })
    expect(list.map((entry) => entry.id)).toEqual(['m1'])
    expect(list[0]?.snippet).toContain('numbers')
    const read = await getEmailToolMessage(env, owner, { accountId, emailId: 'm1' })
    expect(read?.body).toContain('The numbers are ready.')
    const found = await searchEmailToolMessages(env, owner, { accountId, query: 'numbers' })
    expect(found.map((entry) => entry.id)).toEqual(['m1'])
    expect(await getEmailToolMessage(env, owner, { accountId, emailId: 'missing' })).toBeNull()
  })

  it('writes a reply draft with the original quoted in the thread', async () => {
    await seedMessage('m1')
    const draft = await draftEmailReplyTool(env, owner, {
      accountId,
      originalEmailId: 'm1',
      to: 'grace@example.com',
      subject: 'Re: Quarterly report',
      body: 'Thanks, reading now.',
    })
    expect(draft?.threadId).toBe('m1')
    const row = boxes.store(accountId).getEmail(draft!.draftId)!
    expect(row.folder_id).toBe('draft')
    expect(row.in_reply_to).toBe('m1')
    expect(row.thread_id).toBe('m1')
    expect(row.body_source).toContain('> On ')
    expect(row.body_source).toContain('The numbers are ready.')
    expect(row.body).toContain('<blockquote>')
  })

  it('creates a standalone draft and refuses to discard anything that is not one', async () => {
    const draft = await draftEmailTool(env, owner, {
      accountId,
      to: 'grace@example.com',
      subject: 'Hello',
      body: 'A line.',
    })
    expect((await discardDraftTool(env, owner, { accountId, draftId: draft.draftId }))).toBe(true)
    await seedMessage('m1')
    expect(await discardDraftTool(env, owner, { accountId, draftId: 'm1' })).toBe(false)
  })

  it('marks and moves messages without leaving the account', async () => {
    await seedMessage('m1')
    expect(await markEmailReadTool(env, owner, { accountId, emailId: 'm1', read: true })).toBe(true)
    expect(await moveEmailTool(env, owner, { accountId, emailId: 'm1', folderId: 'archive' })).toBe(true)
    expect(boxes.store(accountId).getEmail('m1')?.folder_id).toBe('archive')
    expect(await moveEmailTool(env, owner, { accountId, emailId: 'm1', folderId: 'missing' })).toBe(false)
  })

  it('routes inbound mail to the owner account by address only', async () => {
    expect((await findEmailAccountForInbound(env, ' ADA@example.com '))?.id).toBe(accountId)
    expect(await findEmailAccountForInbound(env, 'nobody@example.com')).toBeNull()
  })
})
