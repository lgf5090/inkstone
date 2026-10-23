// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { EmailAccountSettings } from '../../src/shared/email/model'
import type { Env } from '../../src/worker/env'
import {
  createEmailAccount,
  getEmailAccount,
  type EmailAccountRow,
} from '../../src/worker/email/account-store'
import { createEmailContact } from '../../src/worker/email/contacts'
import { handleMailboxInbound, type MailboxInboundResult } from '../../src/worker/email/mailbox'
import { testBindings, testR2Bucket, type TestR2Bucket } from '../doubles/bindings'
import {
  mailboxHarness,
  seedUser,
  testDatabase,
  type MailboxHarness,
  type TestDatabase,
} from '../fixtures/email/harness'
import { buildMime, executionContext, forwardedMail, type ForwardedMailInput } from '../fixtures/email/mime'

const USER = 'owner-user'
const ACCOUNT = 'account-1'
const ADDRESS = 'me@example.com'

let database: TestDatabase
let harness: MailboxHarness
let r2: TestR2Bucket
let env: Env
let account: EmailAccountRow

beforeEach(async () => {
  database = testDatabase()
  seedUser(database.sqlite, USER, 'owner')
  harness = mailboxHarness()
  r2 = testR2Bucket()
  env = testBindings(database.db, { EMAIL_MAILBOX: harness.namespace, FILES: r2 })
  account = await createEmailAccount(database.db, {
    id: ACCOUNT,
    userId: USER,
    address: ADDRESS,
    displayName: 'Me',
  })
})

function deliver(input: ForwardedMailInput): Promise<MailboxInboundResult> {
  return handleMailboxInbound(forwardedMail(input), account, env, executionContext())
}

async function setSettings(settings: EmailAccountSettings): Promise<void> {
  await database.db.prepare(`UPDATE email_accounts SET settings = ?1 WHERE id = ?2`)
    .bind(JSON.stringify(settings), ACCOUNT).run()
  account = (await getEmailAccount(database.db, USER, ACCOUNT))!
}

function focusedBySubject(): Record<string, number> {
  return Object.fromEntries(
    harness.store(ACCOUNT).getEmails({ folder: 'inbox' }).map((row) => [row.subject, row.focused]),
  )
}

describe('focused inbox classification', () => {
  it('keeps contacts, replies and prior senders focused and files unknown or automated mail as other', async () => {
    await createEmailContact(database.db, USER, {
      email: 'bob@example.com',
      name: 'Bob',
      company: '',
      notes: '',
      starred: false,
    })

    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Alice <alice@example.com>',
        subject: 'First note',
        messageId: '<focus-1@example.com>',
        text: 'Hello',
      }),
    })
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Alice <alice@example.com>',
        subject: 'Re: First note',
        messageId: '<focus-2@example.com>',
        inReplyTo: '<focus-1@example.com>',
        references: '<focus-1@example.com>',
        text: 'Reply',
      }),
    })
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Alice <alice@example.com>',
        subject: 'Second note',
        messageId: '<focus-3@example.com>',
        text: 'Again',
      }),
    })
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Bob <bob@example.com>',
        subject: 'Saved contact',
        messageId: '<focus-4@example.com>',
        text: 'Known',
      }),
    })
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Bob <bob@example.com>',
        subject: 'Bulk notice',
        messageId: '<focus-5@example.com>',
        extraHeaders: { Precedence: 'bulk' },
        text: 'Bulk',
      }),
    })
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Carol <carol@example.com>',
        subject: 'Automatic notice',
        messageId: '<focus-6@example.com>',
        extraHeaders: { 'Auto-Submitted': 'auto-generated' },
        text: 'Automatic',
      }),
    })

    expect(focusedBySubject()).toEqual({
      'First note': 0,
      'Re: First note': 1,
      'Second note': 1,
      'Saved contact': 1,
      'Bulk notice': 0,
      'Automatic notice': 0,
    })
  })

  it('keeps every new message focused when the account disables the focused inbox', async () => {
    await setSettings({ focusedInbox: false })

    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Carol <carol@example.com>',
        subject: 'Unknown sender',
        messageId: '<off-1@example.com>',
        text: 'Hello',
      }),
    })
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Carol <carol@example.com>',
        subject: 'Automated notice',
        messageId: '<off-2@example.com>',
        extraHeaders: { Precedence: 'list' },
        text: 'List',
      }),
    })

    expect(focusedBySubject()).toEqual({
      'Unknown sender': 1,
      'Automated notice': 1,
    })
  })

  it('leaves existing rows alone when the setting changes', async () => {
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Carol <carol@example.com>',
        subject: 'Before disabling',
        messageId: '<switch-1@example.com>',
        text: 'Hello',
      }),
    })
    expect(focusedBySubject()['Before disabling']).toBe(0)

    await setSettings({ focusedInbox: false })
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        from: 'Dave <dave@example.com>',
        subject: 'While disabled',
        messageId: '<switch-2@example.com>',
        text: 'Hello',
      }),
    })
    await setSettings({ focusedInbox: true })

    expect(focusedBySubject()).toEqual({
      'Before disabling': 0,
      'While disabled': 1,
    })
  })
})
