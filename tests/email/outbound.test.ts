import { describe, expect, it } from 'vitest'
import { buildThreadingHeaders, normalizeRecipients, outgoingMessageId, validateBody, validateFrom } from '../../src/worker/email/outbound'

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
})
