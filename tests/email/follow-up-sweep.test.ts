// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/worker/env'
import { createEmailAccount } from '../../src/worker/email/account-store'
import { runEmailFollowUpSweep } from '../../src/worker/email/follow-up'
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
  env = testBindings(database.db, { EMAIL_MAILBOX: followUpNamespace(harness) })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function followUpNamespace(harness: MailboxHarness): DurableObjectNamespace {
  const base = harness.namespace
  return {
    ...base,
    get: ((id: DurableObjectId) => {
      const name = id.name ?? id.toString()
      const stub = base.get(id) as unknown as {
        wakeFollowUps: (now?: number, limit?: number) => string[]
      }
      stub.wakeFollowUps = (now?: number, limit?: number) => harness.store(name).wakeFollowUps(now, limit)
      return stub as unknown as DurableObjectStub
    }) as DurableObjectNamespace['get'],
  } as DurableObjectNamespace
}

async function account(id: string, address: string): Promise<void> {
  await createEmailAccount(database.db, { id, userId: OWNER, address, displayName: address })
}

function seedFollowUp(accountId: string, messageId: string, at: number): void {
  const store = harness.store(accountId)
  expect(store.createEmail('inbox', {
    id: messageId,
    subject: `Subject ${messageId}`,
    sender: 'sender@example.com',
    recipient: 'me@example.com',
    date: Date.now(),
    body: 'Body',
    read: true,
  })).toBe(true)
  expect(store.setFollowUp(messageId, at)).not.toBeNull()
}

describe('email follow-up sweep', () => {
  it('wakes due reminders across every mailbox and leaves future ones alone', async () => {
    const now = Date.now()
    await account('a1', 'one@example.com')
    await account('a2', 'two@example.com')
    seedFollowUp('a1', 'due', now + MINUTE_MS)
    seedFollowUp('a1', 'future', now + 60 * MINUTE_MS)
    seedFollowUp('a2', 'also-due', now + 2 * MINUTE_MS)

    const result = await runEmailFollowUpSweep(env, now + 3 * MINUTE_MS)

    expect(result).toEqual({ accounts: 2, messages: 2 })
    expect(harness.store('a1').getEmail('due')).toMatchObject({ follow_up_at: null, important: 1, read: 0 })
    expect(harness.store('a1').getEmail('future')?.follow_up_at).toBe(now + 60 * MINUTE_MS)
    expect(harness.store('a2').getEmail('also-due')?.follow_up_at).toBeNull()
  })

  it('logs a failing mailbox and keeps sweeping the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = Date.now()
    await account('a-broken', 'broken@example.com')
    await account('b-ok', 'ok@example.com')
    seedFollowUp('a-broken', 'stuck', now + MINUTE_MS)
    seedFollowUp('b-ok', 'woken', now + MINUTE_MS)
    const healthy = followUpNamespace(harness)
    const namespace = {
      ...healthy,
      get: ((id: DurableObjectId) => {
        if ((id.name ?? id.toString()) === 'a-broken') {
          return {
            wakeFollowUps: () => { throw new Error('storage down') },
          } as unknown as DurableObjectStub
        }
        return healthy.get(id)
      }) as DurableObjectNamespace['get'],
    } as DurableObjectNamespace
    env = testBindings(database.db, { EMAIL_MAILBOX: namespace })

    const result = await runEmailFollowUpSweep(env, now + 2 * MINUTE_MS)

    expect(result).toEqual({ accounts: 2, messages: 1 })
    expect(harness.store('a-broken').getEmail('stuck')?.follow_up_at).toBe(now + MINUTE_MS)
    expect(harness.store('b-ok').getEmail('woken')?.follow_up_at).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a-broken'), 'storage down')
  })

  it('reports zero when no mailbox storage is bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await runEmailFollowUpSweep(testBindings(database.db))).toEqual({ accounts: 0, messages: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMAIL_MAILBOX'))
  })
})
