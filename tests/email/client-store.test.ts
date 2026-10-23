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

  it('toggles, ranges, selects all and clears the batch selection', () => {
    const rows = [
      message({ id: 'm1' }),
      message({ id: 'm2' }),
      message({ id: 'm3' }),
    ]
    useEmailStore.setState({ messages: rows })
    const state = useEmailStore.getState()
    state.toggleSelected('m1')
    state.toggleSelected('m3')
    expect([...useEmailStore.getState().selectedIds]).toEqual(['m1', 'm3'])
    state.selectRange('m2')
    expect([...useEmailStore.getState().selectedIds].sort()).toEqual(['m1', 'm2', 'm3'])
    state.toggleSelected('m2')
    expect([...useEmailStore.getState().selectedIds].sort()).toEqual(['m1', 'm3'])
    state.selectAll(['m1', 'm2', 'm3'], true)
    expect([...useEmailStore.getState().selectedIds].sort()).toEqual(['m1', 'm2', 'm3'])
    state.selectAll(['m1', 'm2', 'm3'], false)
    expect(useEmailStore.getState().selectedIds.size).toBe(0)
    state.toggleSelected('m1')
    state.clearSelection()
    expect(useEmailStore.getState().selectedIds.size).toBe(0)
    expect(useEmailStore.getState().selectionAnchorId).toBeNull()
  })

  it('sends the selected ids once and refreshes the list after a batch action', async () => {
    const rows = [message({ id: 'm1' }), message({ id: 'm2' })]
    useEmailStore.setState({
      messages: rows,
      total: rows.length,
      accountId: 'a1',
      folderId: 'inbox',
      listMode: 'folder',
      page: 1,
      listStatus: 'ready',
      selectedIds: new Set(['m1', 'm2']),
      selectionAnchorId: 'm2',
    })
    const batch = vi.spyOn(api.email, 'batchEmails').mockResolvedValue({ updated: 2 })
    const folders = vi.spyOn(api.email, 'listFolders').mockResolvedValue([])
    const list = vi.spyOn(api.email, 'listEmails').mockResolvedValue({
      emails: rows.map((row) => ({ ...row, read: true })),
      totalCount: 2,
    })

    await expect(useEmailStore.getState().batchEmails('a1', 'read')).resolves.toBe(true)
    expect(batch).toHaveBeenCalledWith('a1', { ids: ['m1', 'm2'], action: 'read' })
    expect(useEmailStore.getState().selectedIds.size).toBe(0)
    expect(useEmailStore.getState().selectionAnchorId).toBeNull()
    expect(folders).toHaveBeenCalledWith('a1')
    expect(list).toHaveBeenCalledWith('a1', {
      folder: 'inbox',
      page: 1,
      limit: 25,
      threaded: 'true',
    })
    expect(useEmailStore.getState().messages.every((row) => row.read)).toBe(true)
  })

  it('keeps the batch selection and reports a failed batch action', async () => {
    const rows = [message({ id: 'm1' })]
    useEmailStore.setState({
      messages: rows,
      accountId: 'a1',
      folderId: 'inbox',
      selectedIds: new Set(['m1']),
      selectionAnchorId: 'm1',
      actionError: null,
    })
    vi.spyOn(api.email, 'batchEmails').mockRejectedValue(new Error('network down'))
    await expect(useEmailStore.getState().batchEmails('a1', 'star')).resolves.toBe(false)
    expect([...useEmailStore.getState().selectedIds]).toEqual(['m1'])
    expect(useEmailStore.getState().actionError).toBe('network down')
  })

  it('passes the target folder when moving a batch', async () => {
    useEmailStore.setState({
      messages: [message({ id: 'm1' })],
      accountId: 'a1',
      folderId: 'inbox',
      selectedIds: new Set(['m1']),
    })
    const batch = vi.spyOn(api.email, 'batchEmails').mockResolvedValue({ updated: 1 })
    vi.spyOn(api.email, 'listFolders').mockResolvedValue([])
    vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
    await expect(useEmailStore.getState().batchEmails('a1', 'move', 'archive')).resolves.toBe(true)
    expect(batch).toHaveBeenCalledWith('a1', { ids: ['m1'], action: 'move', folderId: 'archive' })
  })
})
