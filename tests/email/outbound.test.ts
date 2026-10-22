import { describe, expect, it } from 'vitest'
import { EMAIL_RECIPIENTS_MAX } from '../../src/shared/email/model'
import type { Env } from '../../src/worker/env'
import { buildThreadingHeaders, normalizeRecipients, outgoingMessageId, sendViaBinding, validateBody, validateFrom } from '../../src/worker/email/outbound'

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
})
