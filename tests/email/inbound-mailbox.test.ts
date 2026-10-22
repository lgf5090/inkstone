// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/worker/env'
import {
  createEmailAccount,
  getEmailAccount,
  type EmailAccountRow,
} from '../../src/worker/email/account-store'
import { loadEmailAttachments } from '../../src/worker/email/attachments'
import {
  clampInboundDate,
  extractInboundMessageIds,
  handleMailboxInbound,
  MAX_MAILBOX_INBOUND_BYTES,
  normalizeEnvelopeAddress,
  readRawWithCap,
} from '../../src/worker/email/mailbox'
import type { MailboxInboundResult } from '../../src/worker/email/mailbox'
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

afterEach(() => {
  vi.restoreAllMocks()
})

function deliver(input: ForwardedMailInput): Promise<MailboxInboundResult> {
  return handleMailboxInbound(forwardedMail(input), account, env, executionContext())
}

function inbox() {
  return harness.store(ACCOUNT).getEmails({ folder: 'inbox' })
}

describe('the inbound mailbox handler', () => {
  it('stores an HTML alternative, decodes the subject and keeps the envelope recipient', async () => {
    const raw = buildMime({
      to: ADDRESS,
      from: 'Alice <alice@example.com>',
      subject: '=?utf-8?B?Q2Fmw6kgcnVu?=',
      messageId: '<html@example.com>',
      text: 'Plain body',
      html: '<p>HTML body</p>',
    })

    expect(await deliver({ to: ADDRESS, raw })).toBe('created')

    const [row] = inbox()
    expect(row).toBeDefined()
    expect(row!.subject).toBe('Café run')
    expect(row!.sender).toBe('Alice <alice@example.com>')
    expect(row!.recipient).toBe(ADDRESS)
    expect(row!.body).toBe('<p>HTML body</p>')
    expect(row!.body_source).toBeNull()
    expect(row!.message_id).toBe('<html@example.com>')
    expect(row!.read).toBe(0)
    expect(row!.size).toBe(new TextEncoder().encode(raw).byteLength)
    const headers = JSON.parse(row!.raw_headers!) as { key: string; value: string }[]
    expect(headers.some((header) => header.key === 'subject' && header.value.includes('Q2Fmw6kgcnVu'))).toBe(true)
  })

  it('stores a text-only body when the message has no HTML part', async () => {
    await deliver({ to: ADDRESS, raw: buildMime({ to: ADDRESS, messageId: '<text@example.com>', text: 'Just text' }) })

    const [row] = inbox()
    expect(row!.body).toBe('Just text\n')
  })

  it('persists attachments under the mail prefix with a locked row for the message', async () => {
    const content = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        messageId: '<attachment@example.com>',
        text: 'See attached',
        attachments: [{
          filename: 'report.pdf',
          mime: 'application/pdf',
          content,
          contentId: 'report-1',
          disposition: 'attachment',
        }],
      }),
    })

    const [row] = inbox()
    expect(row!.has_attachment).toBe(1)
    expect(row!.attachments_skipped).toBe(0)

    const stored = await database.db.prepare(
      `SELECT account_id, locked, object_key, content_id, disposition
         FROM email_attachments WHERE user_id = ?1 AND email_id = ?2`,
    ).bind(USER, row!.id).first<{
      account_id: string
      locked: number
      object_key: string
      content_id: string | null
      disposition: string | null
    }>()
    expect(stored).not.toBeNull()
    expect(stored!.account_id).toBe(ACCOUNT)
    expect(stored!.locked).toBe(1)
    expect(stored!.content_id).toBe('<report-1>')
    expect(stored!.disposition).toBe('attachment')
    expect(stored!.object_key.startsWith('mail/')).toBe(true)
    expect(r2.objects.get(stored!.object_key)).toEqual(content)

    const attachments = await loadEmailAttachments(database.db, USER, [row!.id])
    expect(attachments.get(row!.id)).toHaveLength(1)
    expect(attachments.get(row!.id)![0]!.filename).toBe('report.pdf')
  })

  it('keeps the message but skips attachments when R2 is not configured', async () => {
    env = testBindings(database.db, { EMAIL_MAILBOX: harness.namespace })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        messageId: '<no-r2@example.com>',
        text: 'No blob storage',
        attachments: [{ filename: 'notes.txt', content: 'hello' }],
      }),
    })

    expect(result).toBe('created')
    const [row] = inbox()
    expect(row!.attachments_skipped).toBe(1)
    expect(row!.has_attachment).toBe(0)
    const attachments = await database.db.prepare(
      `SELECT COUNT(*) AS total FROM email_attachments WHERE user_id = ?1`,
    ).bind(USER).first<{ total: number }>()
    expect(Number(attachments!.total)).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('R2'))
  })

  it('files a redelivered Message-ID once and returns duplicate', async () => {
    const raw = buildMime({ to: ADDRESS, messageId: '<same@example.com>', text: 'Once' })

    expect(await deliver({ to: ADDRESS, raw })).toBe('created')
    expect(await deliver({ to: ADDRESS, raw })).toBe('duplicate')
    expect(inbox()).toHaveLength(1)
  })

  it('falls back to a digest of the raw message when Message-ID is missing', async () => {
    const raw = buildMime({ to: ADDRESS, messageId: null, text: 'No id' })

    expect(await deliver({ to: ADDRESS, raw })).toBe('created')
    expect(await deliver({ to: ADDRESS, raw })).toBe('duplicate')
    expect(inbox()).toHaveLength(1)
    expect(inbox()[0]!.message_id).toBeNull()
  })

  it('drops a self-sent message without claiming it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = buildMime({ to: ADDRESS, from: `Me <${ADDRESS}>`, messageId: '<self@example.com>', text: 'Loop' })

    expect(await deliver({ to: ADDRESS, from: ADDRESS, raw })).toBe('dropped')
    expect(inbox()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('own mailbox'))
    expect(harness.store(ACCOUNT).claimInbound('<self@example.com>', Date.now())).toBe(true)
  })

  it('rejects a message over the raw ceiling before reading the stream', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(deliver({
      to: ADDRESS,
      raw: buildMime({ to: ADDRESS, text: 'Too big' }),
      rawSize: MAX_MAILBOX_INBOUND_BYTES + 1,
    })).rejects.toThrow('size limit')
    expect(inbox()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ceiling'))
  })

  it('stops reading a stream that grows past the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6))
        controller.enqueue(new Uint8Array(6))
        controller.close()
      },
    })
    expect(await readRawWithCap(stream, 10)).toBeNull()
  })

  it('threads by the first reference, then by In-Reply-To', async () => {
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        messageId: '<child@example.com>',
        inReplyTo: '<parent@example.com>',
        references: '<root@example.com> <parent@example.com>',
        text: 'Reply',
      }),
    })
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        messageId: '<other@example.com>',
        inReplyTo: '<parent@example.com>',
        subject: 'Another reply',
        text: 'Second',
      }),
    })

    const rows = inbox()
    const threaded = rows.find((row) => row.message_id === '<child@example.com>')!
    expect(threaded.thread_id).toBe('root@example.com')
    expect(threaded.in_reply_to).toBe('parent@example.com')
    expect(JSON.parse(threaded.email_references!)).toEqual(['root@example.com', 'parent@example.com'])

    const second = rows.find((row) => row.message_id === '<other@example.com>')!
    expect(second.thread_id).toBe('parent@example.com')
  })

  it('falls back to the subject and participants, then to its own Message-ID', async () => {
    harness.store(ACCOUNT).createEmail('inbox', {
      id: 'earlier',
      subject: 'Re: Hello',
      sender: 'Alice <alice@example.com>',
      recipient: ADDRESS,
      date: Date.now() - 60_000,
      body: 'Earlier',
      threadId: 'thread-1',
      messageId: '<earlier@example.com>',
    })

    await deliver({
      to: ADDRESS,
      from: 'alice@example.com',
      raw: buildMime({ to: ADDRESS, from: 'alice@example.com', subject: 'Hello', messageId: '<fallback@example.com>', text: 'Same thread' }),
    })
    await deliver({
      to: ADDRESS,
      from: 'bob@example.com',
      raw: buildMime({ to: ADDRESS, from: 'bob@example.com', subject: 'Unrelated', messageId: '<fresh@example.com>', text: 'New thread' }),
    })

    const rows = inbox()
    expect(rows.find((row) => row.message_id === '<fallback@example.com>')!.thread_id).toBe('thread-1')
    expect(rows.find((row) => row.message_id === '<fresh@example.com>')!.thread_id).toBe('<fresh@example.com>')
  })

  it('clamps an invalid, pre-1970 or future Date header to the receive time', async () => {
    const before = Date.now()
    const cases = [
      ['future', '2999-01-01T00:00:00Z'],
      ['invalid', 'not a date'],
      ['ancient', '1969-12-31T23:59:59Z'],
    ] as const
    for (const [subject, date] of cases) {
      await deliver({
        to: ADDRESS,
        raw: buildMime({ to: ADDRESS, subject, date, messageId: `<${subject}@example.com>`, text: subject }),
      })
    }
    await deliver({
      to: ADDRESS,
      raw: buildMime({ to: ADDRESS, subject: 'past', date: '2024-05-01T10:00:00Z', messageId: '<past@example.com>', text: 'past' }),
    })

    const rows = inbox()
    for (const [subject] of cases) {
      const row = rows.find((entry) => entry.subject === subject)!
      expect(row.date).toBeGreaterThanOrEqual(before)
    }
    expect(rows.find((entry) => entry.subject === 'past')!.date).toBe(Date.parse('2024-05-01T10:00:00Z'))
  })

  it('queues one auto-draft job by default without creating a draft', async () => {
    await deliver({ to: ADDRESS, raw: buildMime({ to: ADDRESS, subject: 'Draft me', messageId: '<auto@example.com>', text: 'Hello' }) })

    const jobs = await database.db.prepare(
      `SELECT account_id, message_id, thread_id, status FROM email_auto_draft_jobs WHERE user_id = ?1`,
    ).bind(USER).all<{ account_id: string; message_id: string; thread_id: string; status: string }>()
    expect(jobs.results).toHaveLength(1)
    expect(jobs.results[0]).toMatchObject({
      account_id: ACCOUNT,
      message_id: inbox()[0]!.id,
      thread_id: '<auto@example.com>',
      status: 'queued',
    })
    expect(harness.store(ACCOUNT).getEmails({ folder: 'draft' })).toHaveLength(0)
  })

  it('does not queue auto-draft when the account opted out or the message is automated', async () => {
    await database.db.prepare(`UPDATE email_accounts SET settings = ?1 WHERE id = ?2`)
      .bind(JSON.stringify({ autoDraft: false }), ACCOUNT).run()
    account = (await getEmailAccount(database.db, USER, ACCOUNT))!
    await deliver({ to: ADDRESS, raw: buildMime({ to: ADDRESS, messageId: '<off@example.com>', text: 'Off' }) })

    await database.db.prepare(`UPDATE email_accounts SET settings = '{}' WHERE id = ?1`).bind(ACCOUNT).run()
    account = (await getEmailAccount(database.db, USER, ACCOUNT))!
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        messageId: '<auto-reply@example.com>',
        extraHeaders: { 'Auto-Submitted': 'auto-replied' },
        text: 'Out of office',
      }),
    })
    await deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        messageId: '<bulk@example.com>',
        extraHeaders: { Precedence: 'bulk' },
        text: 'Newsletter',
      }),
    })

    const jobs = await database.db.prepare(
      `SELECT COUNT(*) AS total FROM email_auto_draft_jobs WHERE user_id = ?1`,
    ).bind(USER).first<{ total: number }>()
    expect(Number(jobs!.total)).toBe(0)
  })

  it('releases the claim and removes attachments when the mailbox refuses the message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.sqlite(ACCOUNT).exec(`DELETE FROM email_folders WHERE id = 'inbox'`)

    await expect(deliver({
      to: ADDRESS,
      raw: buildMime({
        to: ADDRESS,
        messageId: '<failure@example.com>',
        text: 'Fails',
        attachments: [{ filename: 'lost.txt', content: 'bytes' }],
      }),
    })).rejects.toThrow('did not accept')

    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not be stored'), expect.any(Error))
    expect(r2.objects.size).toBe(0)
    const attachments = await database.db.prepare(
      `SELECT COUNT(*) AS total FROM email_attachments WHERE user_id = ?1`,
    ).bind(USER).first<{ total: number }>()
    expect(Number(attachments!.total)).toBe(0)
    expect(harness.store(ACCOUNT).claimInbound('<failure@example.com>', Date.now())).toBe(true)
  })
})

describe('the inbound parsing helpers', () => {
  it('normalizes an angle-bracket recipient to a bare lower-case address', () => {
    expect(normalizeEnvelopeAddress('Name <ME@Example.COM>')).toBe('me@example.com')
    expect(normalizeEnvelopeAddress('  me@example.com ')).toBe('me@example.com')
  })

  it('extracts message ids in wire order and ignores bare tokens', () => {
    expect(extractInboundMessageIds('<a@example.com> bare <b@example.com>')).toEqual([
      'a@example.com',
      'b@example.com',
    ])
    expect(extractInboundMessageIds(undefined)).toEqual([])
  })

  it('accepts a parseable past date and rejects a future one', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(clampInboundDate('2025-01-01T00:00:00Z', now)).toBe(Date.parse('2025-01-01T00:00:00Z'))
    expect(clampInboundDate('2026-01-03T00:00:00Z', now)).toBe(now)
    expect(clampInboundDate(undefined, now)).toBe(now)
  })
})
