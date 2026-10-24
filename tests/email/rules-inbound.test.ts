// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/worker/env'
import { createEmailAccount, type EmailAccountRow } from '../../src/worker/email/account-store'
import { handleMailboxInbound } from '../../src/worker/email/mailbox'
import type { InboundRuleInput } from '../../src/worker/email/mailbox-store'
import { testBindings } from '../doubles/bindings'
import {
  mailboxHarness,
  seedUser,
  testDatabase,
  type MailboxHarness,
  type TestDatabase,
} from '../fixtures/email/harness'
import { buildMime, executionContext, forwardedMail } from '../fixtures/email/mime'

const USER = 'owner-user'
const ACCOUNT = 'account-1'
const ADDRESS = 'me@example.com'

let database: TestDatabase
let harness: MailboxHarness
let env: Env
let account: EmailAccountRow

function rulesNamespace(base: MailboxHarness, accountId: string): DurableObjectNamespace {
  const store = base.store(accountId)
  return {
    ...base.namespace,
    get: ((id: DurableObjectId) => {
      const stub = base.namespace.get(id) as unknown as Record<string, unknown>
      stub.evaluateInboundRules = (input: InboundRuleInput) => store.evaluateInboundRules(input)
      stub.attachTagPaths = (messageId: string, paths: readonly string[]) => store.attachTagPaths(messageId, paths)
      return stub as unknown as DurableObjectStub
    }) as DurableObjectNamespace['get'],
  } as DurableObjectNamespace
}

beforeEach(async () => {
  database = testDatabase()
  seedUser(database.sqlite, USER, 'owner')
  harness = mailboxHarness()
  env = testBindings(database.db, { EMAIL_MAILBOX: rulesNamespace(harness, ACCOUNT) })
  account = await createEmailAccount(database.db, {
    id: ACCOUNT,
    userId: USER,
    address: ADDRESS,
    displayName: 'Me',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function deliver(input: { from?: string; subject?: string; messageId: string; text?: string }) {
  const from = input.from ?? 'Alice <alice@example.com>'
  const raw = buildMime({
    to: ADDRESS,
    from,
    subject: input.subject ?? 'Weekly digest',
    messageId: `<${input.messageId}@example.com>`,
    text: input.text ?? 'Body',
  })
  return handleMailboxInbound(forwardedMail({ to: ADDRESS, from, raw }), account, env, executionContext())
}

function autoDraftCount(): number {
  const row = database.sqlite.prepare(
    `SELECT COUNT(*) AS total FROM email_auto_draft_jobs WHERE user_id = ?1`,
  ).get(USER) as { total: number }
  return Number(row.total)
}

describe('inbound filter application', () => {
  it('moves, marks read, stars and tags a matching message before it is stored', async () => {
    const store = harness.store(ACCOUNT)
    const folder = store.createFolder('Receipts')!
    store.createFilter({
      name: 'Receipts',
      enabled: true,
      conditions: [
        { field: 'fromContains', value: 'alice' },
        { field: 'subjectContains', value: 'digest' },
      ],
      actions: [
        { type: 'moveTo', folder: folder.id },
        { type: 'addTag', tag: 'billing/digest' },
        { type: 'markRead' },
        { type: 'star' },
      ],
    })

    expect(await deliver({ messageId: 'filtered' })).toBe('created')

    expect(store.getEmails({ folder: 'inbox' })).toHaveLength(0)
    const [row] = store.getEmails({ folder: folder.id })
    expect(row).toBeDefined()
    expect(row!.read).toBe(1)
    expect(row!.starred).toBe(1)
    const tag = store.findTagByPath('billing/digest')
    expect(tag).not.toBeNull()
    expect(tag!.color).toBeNull()
    const attached = harness.sqlite(ACCOUNT).prepare(
      `SELECT COUNT(*) AS total FROM email_message_tags WHERE message_id = ?1 AND tag_id = ?2`,
    ).get(row!.id, tag!.id) as { total: number }
    expect(Number(attached.total)).toBe(1)
    expect(autoDraftCount()).toBe(1)
  })

  it('soft-deletes a message the rule trashes and skips its auto-draft', async () => {
    harness.store(ACCOUNT).createFilter({
      name: 'Trash digest',
      enabled: true,
      conditions: [{ field: 'subjectContains', value: 'digest' }],
      actions: [{ type: 'trash' }],
    })

    expect(await deliver({ messageId: 'trashed' })).toBe('created')

    const trash = harness.store(ACCOUNT).listTrash()
    expect(trash).toHaveLength(1)
    expect(trash[0]!.folder_id).toBe('trash')
    expect(trash[0]!.deleted_at).not.toBeNull()
    expect(autoDraftCount()).toBe(0)
  })

  it('keeps delivering when a rule moves to a folder that no longer exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    harness.store(ACCOUNT).createFilter({
      name: 'Gone',
      enabled: true,
      conditions: [{ field: 'subjectContains', value: 'digest' }],
      actions: [{ type: 'moveTo', folder: 'Deleted folder' }, { type: 'star' }],
    })

    expect(await deliver({ messageId: 'missing-folder' })).toBe('created')

    const [row] = harness.store(ACCOUNT).getEmails({ folder: 'inbox' })
    expect(row).toBeDefined()
    expect(row!.starred).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('move target'), expect.any(String), 'Deleted folder')
  })

  it('leaves mail alone when every rule is disabled', async () => {
    harness.store(ACCOUNT).createFilter({
      name: 'Off',
      enabled: false,
      conditions: [{ field: 'subjectContains', value: 'digest' }],
      actions: [{ type: 'moveTo', folder: 'archive' }, { type: 'markRead' }],
    })

    expect(await deliver({ messageId: 'disabled' })).toBe('created')

    const [row] = harness.store(ACCOUNT).getEmails({ folder: 'inbox' })
    expect(row).toBeDefined()
    expect(row!.read).toBe(0)
    expect(harness.store(ACCOUNT).getEmails({ folder: 'archive' })).toHaveLength(0)
  })
})

describe('blocked senders on inbound mail', () => {
  it('delivers to spam, read, without tags or an auto-draft', async () => {
    const store = harness.store(ACCOUNT)
    store.addBlockedSender('alice@example.com')
    store.createFilter({
      name: 'Would tag',
      enabled: true,
      conditions: [{ field: 'subjectContains', value: 'digest' }],
      actions: [{ type: 'addTag', tag: 'blocked' }, { type: 'moveTo', folder: 'archive' }],
    })

    expect(await deliver({ messageId: 'blocked' })).toBe('created')

    expect(store.getEmails({ folder: 'inbox' })).toHaveLength(0)
    expect(store.getEmails({ folder: 'archive' })).toHaveLength(0)
    const [row] = store.getEmails({ folder: 'spam' })
    expect(row).toBeDefined()
    expect(row!.read).toBe(1)
    expect(store.findTagByPath('blocked')).toBeNull()
    expect(autoDraftCount()).toBe(0)
  })

  it('applies filters again once the sender is unblocked', async () => {
    const store = harness.store(ACCOUNT)
    store.addBlockedSender('alice@example.com')
    store.createFilter({
      name: 'Archive digest',
      enabled: true,
      conditions: [{ field: 'subjectContains', value: 'digest' }],
      actions: [{ type: 'moveTo', folder: 'archive' }],
    })

    expect(await deliver({ messageId: 'first' })).toBe('created')
    expect(store.removeBlockedSender('alice@example.com')).toBe(true)
    expect(await deliver({ messageId: 'second' })).toBe('created')

    expect(store.getEmails({ folder: 'spam' })).toHaveLength(1)
    expect(store.getEmails({ folder: 'archive' })).toHaveLength(1)
  })
})
