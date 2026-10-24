// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/worker/env'
import { createEmailAccount } from '../../src/worker/email/account-store'
import { runEmailSnoozeWake } from '../../src/worker/email/snooze'
import { testBindings } from '../doubles/bindings'
import {
  mailboxHarness,
  seedUser,
  testDatabase,
  type MailboxHarness,
  type TestDatabase,
} from '../fixtures/email/harness'

const OWNER = 'owner-user'
const MINUTE_MS = 60 * 1000

let database: TestDatabase
let harness: MailboxHarness
let env: Env

beforeEach(() => {
  database = testDatabase()
  seedUser(database.sqlite, OWNER, 'owner')
  harness = mailboxHarness()
  env = testBindings(database.db, { EMAIL_MAILBOX: snoozeNamespace(harness) })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function snoozeNamespace(harness: MailboxHarness): DurableObjectNamespace {
  const base = harness.namespace
  return {
    ...base,
    get: ((id: DurableObjectId) => {
      const name = id.name ?? id.toString()
      const stub = base.get(id) as unknown as {
        wakeSnoozed: (now?: number, limit?: number) => string[]
      }
      stub.wakeSnoozed = (now?: number, limit?: number) => harness.store(name).wakeSnoozed(now, limit)
      return stub as unknown as DurableObjectStub
    }) as DurableObjectNamespace['get'],
  } as DurableObjectNamespace
}

async function account(id: string, address: string): Promise<void> {
  await createEmailAccount(database.db, { id, userId: OWNER, address, displayName: address })
}

function seedSnoozed(accountId: string, messageId: string, until: number, read = true): void {
  const store = harness.store(accountId)
  expect(store.createEmail('inbox', {
    id: messageId,
    subject: `Subject ${messageId}`,
    sender: 'sender@example.com',
    recipient: 'me@example.com',
    date: Date.now(),
    body: 'Body',
    read,
  })).toBe(true)
  expect(store.snoozeEmail(messageId, until)).not.toBeNull()
}

describe('email snooze wake', () => {
  it('wakes due messages across every mailbox and leaves future snoozes alone', async () => {
    const now = Date.now()
    await account('a1', 'one@example.com')
    await account('a2', 'two@example.com')
    seedSnoozed('a1', 'due', now + MINUTE_MS)
    seedSnoozed('a1', 'future', now + 60 * MINUTE_MS)
    seedSnoozed('a2', 'also-due', now + 2 * MINUTE_MS)

    const result = await runEmailSnoozeWake(env, now + 3 * MINUTE_MS)

    expect(result).toEqual({ accounts: 2, messages: 2 })
    expect(harness.store('a1').getEmail('due')).toMatchObject({ snoozed_until: null, read: 0 })
    expect(harness.store('a1').getEmail('future')?.snoozed_until).toBe(now + 60 * MINUTE_MS)
    expect(harness.store('a2').getEmail('also-due')?.snoozed_until).toBeNull()
    expect(harness.store('a1').getEmails({ folder: 'inbox' }).map((row) => row.id)).toEqual(['due'])
  })

  it('walks every account across pages', async () => {
    const now = Date.now()
    const total = 51
    for (let index = 0; index < total; index++) {
      const id = `account-${String(index).padStart(2, '0')}`
      await account(id, `page-${index}@example.com`)
      seedSnoozed(id, `message-${index}`, now + MINUTE_MS)
    }

    const result = await runEmailSnoozeWake(env, now + 2 * MINUTE_MS)

    expect(result).toEqual({ accounts: total, messages: total })
    for (let index = 0; index < total; index++) {
      const id = `account-${String(index).padStart(2, '0')}`
      expect(harness.store(id).getEmail(`message-${index}`)?.snoozed_until).toBeNull()
    }
  })

  it('logs a failing mailbox and keeps sweeping the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    await account('a-broken', 'broken@example.com')
    await account('b-ok', 'ok@example.com')
    seedSnoozed('a-broken', 'stuck', now + MINUTE_MS)
    seedSnoozed('b-ok', 'woken', now + MINUTE_MS)
    const healthy = snoozeNamespace(harness)
    const namespace = {
      ...healthy,
      get: ((id: DurableObjectId) => {
        if ((id.name ?? id.toString()) === 'a-broken') {
          return {
            wakeSnoozed: () => { throw new Error('storage down') },
          } as unknown as DurableObjectStub
        }
        return healthy.get(id)
      }) as DurableObjectNamespace['get'],
    } as DurableObjectNamespace
    env = testBindings(database.db, { EMAIL_MAILBOX: namespace })

    const result = await runEmailSnoozeWake(env, now + 2 * MINUTE_MS)

    expect(result).toEqual({ accounts: 2, messages: 1 })
    expect(harness.store('a-broken').getEmail('stuck')?.snoozed_until).toBe(now + MINUTE_MS)
    expect(harness.store('b-ok').getEmail('woken')?.snoozed_until).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a-broken'), 'storage down')
  })

  it('reports zero when no mailbox storage is bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await runEmailSnoozeWake(testBindings(database.db))).toEqual({ accounts: 0, messages: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMAIL_MAILBOX'))
  })
})
