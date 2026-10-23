import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { EMAIL_RECIPIENTS_MAX } from '../../src/shared/email/model'
import type { Env } from '../../src/worker/env'
import { buildThreadingHeaders, loadOutgoingAttachments, normalizeRecipients, outgoingMessageId, sendViaBinding, validateBody, validateFrom } from '../../src/worker/email/outbound'
import { newId } from '../../src/worker/lib/id'
import { makeD1 } from '../doubles/d1-sqlite'
import { testBindings, testR2Bucket } from '../doubles/bindings'

describe('outbound helpers', () => {
  it('accepts only the mailbox sender', () => {
    expect(validateFrom('me@example.com', 'Me <me@example.com>')).toEqual({ address: 'me@example.com', name: 'Me' })
    expect(() => validateFrom('me@example.com', 'other@example.com')).toThrow('mailbox address')
  })

  it('normalizes and bounds recipients', () => {
    expect(normalizeRecipients('A@X.com, b@y.com; a@x.com', 'to')).toEqual(['a@x.com', 'b@y.com'])
    expect(() => normalizeRecipients('not-an-email', 'to')).toThrow('Invalid recipient')
  })

  it('builds threading headers and a message id', () => {
    expect(buildThreadingHeaders('one', ['zero', 'one'])).toEqual({
      'In-Reply-To': '<one>',
      References: '<zero> <one>',
    })
    expect(outgoingMessageId('m1', 'me@example.com')).toBe('m1@example.com')
  })

  it('rejects an empty body', () => {
    expect(() => validateBody({ to: 'a@x.com', subject: 's', body: '', bodyHtml: '', operationId: 'op' }))
      .toThrow('empty')
  })

  it('stops at the recipient limit', () => {
    const addresses = Array.from({ length: EMAIL_RECIPIENTS_MAX + 1 }, (_, index) => `u${index}@example.com`).join(',')
    expect(() => normalizeRecipients(addresses, 'to')).toThrow('Too many recipients')
  })

  it('says sending is unavailable instead of pretending a send happened', async () => {
    await expect(sendViaBinding({} as Env, {
      to: 'a@example.com',
      from: 'me@example.com',
      subject: 'Hello',
    })).rejects.toMatchObject({ status: 503, code: 'email_send_unavailable' })
  })

  it('sends inline attachments with their content id and regular ones without', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(`CREATE TABLE email_attachments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email_id TEXT,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      object_key TEXT NOT NULL,
      disposition TEXT,
      content_id TEXT,
      locked INTEGER NOT NULL DEFAULT 0
    )`)
    const db = makeD1(sqlite)
    const bucket = testR2Bucket()
    const userId = newId()
    const messageId = newId()
    const inlineId = newId()
    const fileId = newId()
    await bucket.put('mail/inline.png', new TextEncoder().encode('image-bytes'))
    await bucket.put('mail/notes.txt', new TextEncoder().encode('file-bytes'))
    sqlite.prepare(
      `INSERT INTO email_attachments
         (id, user_id, email_id, filename, mime, object_key, disposition, content_id, locked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(inlineId, userId, messageId, 'photo.png', 'image/png', 'mail/inline.png', 'inline', 'photo-1@inkstone')
    sqlite.prepare(
      `INSERT INTO email_attachments
         (id, user_id, email_id, filename, mime, object_key, disposition, content_id, locked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(fileId, userId, messageId, 'notes.txt', 'text/plain', 'mail/notes.txt', 'attachment', null)
    const env = testBindings(db, { FILES: bucket })

    const attachments = await loadOutgoingAttachments(env, userId, messageId, [inlineId, fileId])

    expect(attachments).toEqual([
      {
        content: btoa('image-bytes'),
        filename: 'photo.png',
        type: 'image/png',
        disposition: 'inline',
        contentId: 'photo-1@inkstone',
      },
      {
        content: btoa('file-bytes'),
        filename: 'notes.txt',
        type: 'text/plain',
        disposition: 'attachment',
      },
    ])
  })
})
