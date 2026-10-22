// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/worker/env'
import { AssistantStore } from '../../src/worker/assistant/store'
import { createEmailAccount } from '../../src/worker/email/account-store'
import { newMailToken } from '../../src/worker/email/inbound'
import worker from '../../src/worker/index'
import { testBindings, testR2Bucket } from '../doubles/bindings'
import {
  mailboxHarness,
  seedUser,
  testDatabase,
  type MailboxHarness,
  type TestDatabase,
} from '../fixtures/email/harness'
import { buildMime, executionContext, forwardedMail, type ForwardedMailInput } from '../fixtures/email/mime'

const OWNER = 'owner-user'
const MEMBER = 'member-user'
const TOKEN_USER = 'token-user'
const DOMAIN = 'mail.example.com'
const ADDRESS = 'me@example.com'

let database: TestDatabase
let harness: MailboxHarness
let env: Env

beforeEach(() => {
  database = testDatabase()
  seedUser(database.sqlite, OWNER, 'owner')
  seedUser(database.sqlite, MEMBER, 'member')
  seedUser(database.sqlite, TOKEN_USER, 'owner')
  harness = mailboxHarness()
  env = testBindings(database.db, {
    MAIL_DOMAIN: DOMAIN,
    EMAIL_MAILBOX: harness.namespace,
    FILES: testR2Bucket(),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function deliver(input: ForwardedMailInput, target: Env = env): Promise<void> {
  await worker.email!(forwardedMail(input), target, executionContext())
}

function mailbox(accountId: string) {
  return harness.store(accountId).getEmails({ folder: 'inbox' })
}

describe('inbound mail dispatch', () => {
  it('delivers a normalized mailbox recipient to the owner mailbox', async () => {
    await createEmailAccount(database.db, { id: 'owner-account', userId: OWNER, address: ADDRESS, displayName: 'Me' })

    await deliver({
      to: `Me <${ADDRESS.toUpperCase()}>`,
      from: 'alice@example.com',
      raw: buildMime({ to: ADDRESS, from: 'alice@example.com', subject: 'Hello', messageId: '<hello@example.com>', text: 'Hi' }),
    })

    const rows = mailbox('owner-account')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.subject).toBe('Hello')
  })

  it('keeps the to-do token path ahead of a colliding mailbox row', async () => {
    const token = newMailToken()
    const address = `u+${token}@${DOMAIN}`
    database.sqlite.prepare(
      `INSERT INTO todos_mail_tokens (user_id, token, created_at) VALUES (?1, ?2, ?3)`,
    ).run(TOKEN_USER, token, Date.now())
    await createEmailAccount(database.db, { id: 'collision', userId: OWNER, address, displayName: 'Collision' })

    await deliver({
      to: address,
      raw: buildMime({ to: address, subject: 'Buy milk', messageId: '<todo@example.com>', text: 'Two bottles' }),
    })

    const tasks = await new AssistantStore(database.db, TOKEN_USER, env).listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('Buy milk')
    expect(mailbox('collision')).toHaveLength(0)
  })

  it('drops an address that names no mailbox and no token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await deliver({
      to: 'nobody@example.com',
      raw: buildMime({ to: 'nobody@example.com', text: 'Hello?' }),
    })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no mailbox'))
    expect(mailbox('nobody')).toHaveLength(0)
  })

  it('drops a mailbox whose owner is not an owner account', async () => {
    await createEmailAccount(database.db, { id: 'member-account', userId: MEMBER, address: 'member@example.com', displayName: 'Member' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await deliver({
      to: 'member@example.com',
      raw: buildMime({ to: 'member@example.com', text: 'For a member' }),
    })

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('non-owner'))
    expect(mailbox('member-account')).toHaveLength(0)
  })

  it('drops an unknown u+ token through the to-do path without touching a mailbox', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const address = `u+${'z'.repeat(40)}@${DOMAIN}`

    await deliver({ to: address, raw: buildMime({ to: address, text: 'Guess' }) })

    expect(warn).toHaveBeenCalled()
    expect(await new AssistantStore(database.db, TOKEN_USER, env).listTasks()).toHaveLength(0)
  })

  it('delivers a mailbox address even when MAIL_DOMAIN is not configured', async () => {
    await createEmailAccount(database.db, { id: 'owner-account', userId: OWNER, address: ADDRESS, displayName: 'Me' })
    const withoutDomain = testBindings(database.db, { EMAIL_MAILBOX: harness.namespace })

    await deliver({
      to: ADDRESS,
      raw: buildMime({ to: ADDRESS, subject: 'No domain', messageId: '<nodomain@example.com>', text: 'Still here' }),
    }, withoutDomain)

    expect(mailbox('owner-account')).toHaveLength(1)
  })
})
