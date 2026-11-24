import { describe, expect, it } from 'vitest'
import { normalizeOutboxItem, outboxRetryDelay, OUTBOX_MAX_ATTEMPTS } from './db'

const item = {
  id: 'patch:n1', clientId: 'client', writeId: 'w1', entity: 'note', entityId: 'n1',
  payload: { content: 'body', rev: 1 }, attempts: 1, createdAt: 1,
}

describe('outbox retry policy', () => {
  it('normalizes persistent failure and retry scheduling fields', () => {
    expect(normalizeOutboxItem({ ...item, failed: true, nextAttemptAt: 1234, lastError: 'refused' }))
      .toMatchObject({ failed: true, nextAttemptAt: 1234, lastError: 'refused' })
  })

  it('caps exponential backoff and keeps the attempt ceiling explicit', () => {
    expect(outboxRetryDelay(1)).toBe(1000)
    expect(outboxRetryDelay(2)).toBe(2000)
    expect(outboxRetryDelay(20)).toBe(30_000)
    expect(OUTBOX_MAX_ATTEMPTS).toBe(5)
  })
})
