// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailMessage, EmailSummary } from '@shared/email/model'
import { api } from '../../src/client/lib/api'
import { useEmailStore } from '../../src/client/features/email/store'

const original = useEmailStore.getState()

function message(patch: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: 'm1',
    folderId: 'inbox',
    subject: 'Quarterly report',
    sender: 'Ada <ada@example.com>',
    recipient: 'me@example.com',
    cc: null,
    bcc: null,
    date: '2026-01-01T10:00:00.000Z',
    read: false,
    starred: false,
    threadId: 't1',
    threadCount: 1,
    snippet: 'The numbers are ready.',
    body: '<p>The numbers are ready.</p>',
    bodySource: null,
    inReplyTo: null,
    references: [],
    messageId: null,
    rawHeaders: [],
    attachments: [],
    ...patch,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  useEmailStore.setState(original, true)
})

afterEach(() => {
  vi.restoreAllMocks()
  useEmailStore.setState(original, true)
})

describe('the mailbox store', () => {
  it('applies a star immediately and rolls it back when the write fails', async () => {
    const row = message()
    useEmailStore.setState({
      messages: [row],
      total: 1,
      selectedId: row.id,
      selectedMessage: row,
      thread: [row],
      listStatus: 'ready',
    })
    const update = vi.spyOn(api.email, 'updateEmail').mockResolvedValue({ ...row, starred: true })
    const applied = useEmailStore.getState().toggleStar('a1', row.id)
    expect(useEmailStore.getState().messages[0]!.starred).toBe(true)
    expect(useEmailStore.getState().selectedMessage!.starred).toBe(true)
    await expect(applied).resolves.toBe(true)
    expect(update).toHaveBeenCalledWith('a1', row.id, { starred: true })

    useEmailStore.setState({
      messages: [row],
      total: 1,
      selectedId: row.id,
      selectedMessage: row,
      thread: [row],
      listStatus: 'ready',
      actionError: null,
    })
    update.mockRejectedValueOnce(new Error('network down'))
    const failed = useEmailStore.getState().toggleStar('a1', row.id)
    expect(useEmailStore.getState().messages[0]!.starred).toBe(true)
    await expect(failed).resolves.toBe(false)
    expect(useEmailStore.getState().messages[0]!.starred).toBe(false)
    expect(useEmailStore.getState().actionError).toBe('network down')
  })

  it('ignores a stale list answer that arrives after a newer one', async () => {
    const first = deferred<{ emails: EmailSummary[]; totalCount: number }>()
    const second = deferred<{ emails: EmailSummary[]; totalCount: number }>()
    const list = vi.spyOn(api.email, 'listEmails')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const firstLoad = useEmailStore.getState().loadList('a1', 'inbox')
    const secondLoad = useEmailStore.getState().loadList('a1', 'sent')
    second.resolve({ emails: [message({ id: 'new', folderId: 'sent' })], totalCount: 1 })
    await secondLoad
    expect(useEmailStore.getState().messages[0]!.id).toBe('new')
    first.resolve({ emails: [message({ id: 'old' })], totalCount: 1 })
    await firstLoad
    expect(useEmailStore.getState().messages[0]!.id).toBe('new')
    expect(useEmailStore.getState().folderId).toBe('sent')
    expect(list).toHaveBeenCalledTimes(2)
  })
})
