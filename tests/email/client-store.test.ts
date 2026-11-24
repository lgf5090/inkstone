// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailFolder, EmailMessage, EmailSummary, EmailTag } from '@shared/email/model'
import type { EmailSavedSearch } from '@shared/email/searches'
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function folder(patch: Partial<EmailFolder> = {}): EmailFolder {
  return {
    id: 'inbox',
    name: 'Inbox',
    isDeletable: false,
    unreadCount: 1,
    totalCount: 1,
    parentId: null,
    color: null,
    sortOrder: 0,
    ...patch,
  }
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
      accountId: 'a1',
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
      accountId: 'a1',
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

  it.each([
    {
      name: 'markThreadRead',
      start: (row: EmailMessage) => {
        const pending = deferred<void>()
        vi.spyOn(api.email, 'markThreadRead').mockReturnValue(pending.promise)
        return { pending, run: () => useEmailStore.getState().markThreadRead('a1', row) }
      },
    },
    {
      name: 'setRead',
      start: (row: EmailMessage) => {
        const pending = deferred<EmailMessage>()
        vi.spyOn(api.email, 'updateEmail').mockReturnValue(pending.promise)
        return { pending, run: () => useEmailStore.getState().setRead('a1', row.id, true) }
      },
    },
    {
      name: 'toggleStar',
      start: (row: EmailMessage) => {
        const pending = deferred<EmailMessage>()
        vi.spyOn(api.email, 'updateEmail').mockReturnValue(pending.promise)
        return { pending, run: () => useEmailStore.getState().toggleStar('a1', row.id) }
      },
    },
    {
      name: 'toggleImportant',
      start: (row: EmailMessage) => {
        const pending = deferred<EmailMessage>()
        vi.spyOn(api.email, 'updateEmail').mockReturnValue(pending.promise)
        return { pending, run: () => useEmailStore.getState().toggleImportant('a1', row.id) }
      },
    },
    {
      name: 'muteThread',
      start: (row: EmailMessage) => {
        const pending = deferred<void>()
        vi.spyOn(api.email, 'muteThread').mockReturnValue(pending.promise)
        return { pending, run: () => useEmailStore.getState().muteThread('a1', row.threadId!, true) }
      },
    },
    {
      name: 'moveMessage',
      start: (row: EmailMessage) => {
        const pending = deferred<void>()
        vi.spyOn(api.email, 'moveEmail').mockReturnValue(pending.promise)
        return { pending, run: () => useEmailStore.getState().moveMessage('a1', row.id, 'archive') }
      },
    },
    {
      name: 'deleteMessage',
      start: (row: EmailMessage) => {
        const pending = deferred<void>()
        vi.spyOn(api.email, 'deleteEmail').mockReturnValue(pending.promise)
        return { pending, run: () => useEmailStore.getState().deleteMessage('a1', row.id) }
      },
    },
  ])('does not roll $name state back after switching accounts', async ({ start }) => {
    const row = message()
    useEmailStore.setState({
      accountId: 'a1',
      folderId: 'inbox',
      messages: [row],
      total: 1,
      trash: [row],
      trashTotal: 1,
      selectedId: row.id,
      selectedMessage: row,
      thread: [row],
      folders: [folder()],
      selectedIds: new Set([row.id]),
      selectionAnchorId: row.id,
      actionError: null,
    })
    const { pending, run } = start(row)
    const applied = run()
    const other = message({ id: 'other', read: true, starred: true, important: true, muted: true })
    useEmailStore.setState({
      accountId: 'b1',
      folderId: 'sent',
      messages: [other],
      total: 7,
      trash: [],
      trashTotal: 0,
      selectedId: other.id,
      selectedMessage: other,
      thread: [other],
      folders: [folder({ id: 'sent', unreadCount: 0, totalCount: 7 })],
      selectedIds: new Set([other.id]),
      selectionAnchorId: other.id,
    })
    const beforeFailure = useEmailStore.getState()
    pending.reject(new Error('account A failed'))
    await expect(applied).resolves.toBe(false)
    expect(useEmailStore.getState()).toEqual(beforeFailure)
  })

  it('does not let an older failed mutation roll back a newer request', async () => {
    const first = message({ id: 'm1' })
    const second = message({ id: 'm2' })
    const older = deferred<EmailMessage>()
    const newer = deferred<EmailMessage>()
    vi.spyOn(api.email, 'updateEmail')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    useEmailStore.setState({ accountId: 'a1', messages: [first, second], total: 2 })
    const olderApplied = useEmailStore.getState().setRead('a1', first.id, true)
    const newerApplied = useEmailStore.getState().setRead('a1', second.id, true)
    older.reject(new Error('older request failed'))
    await expect(olderApplied).resolves.toBe(false)
    expect(useEmailStore.getState().messages).toEqual([first, { ...second, read: true }])
    expect(useEmailStore.getState().actionError).toBe('older request failed')
    newer.reject(new Error('newer request failed'))
    await expect(newerApplied).resolves.toBe(false)
    expect(useEmailStore.getState().messages).toEqual([
      first,
      second,
    ])
    expect(useEmailStore.getState().actionError).toBe('newer request failed')
  })

  it('does not roll an old A mutation back after switching A, B, then A again', async () => {
    const row = message()
    const pending = deferred<EmailMessage>()
    vi.spyOn(api.email, 'updateEmail').mockReturnValue(pending.promise)
    vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
    useEmailStore.setState({ accountId: 'a1', messages: [row], total: 1 })
    const applied = useEmailStore.getState().setRead('a1', row.id, true)
    await useEmailStore.getState().loadList('b1', 'inbox')
    const current = message({ id: 'current', read: false })
    await useEmailStore.getState().loadList('a1', 'inbox')
    useEmailStore.setState({ accountId: 'a1', messages: [current], total: 1 })
    const beforeFailure = useEmailStore.getState()
    pending.reject(new Error('old A request failed'))
    await expect(applied).resolves.toBe(false)
    expect(useEmailStore.getState()).toEqual(beforeFailure)
  })

  it('ignores a successful update from an account that is no longer active', async () => {
    const row = message()
    const pending = deferred<EmailMessage>()
    vi.spyOn(api.email, 'updateEmail').mockReturnValue(pending.promise)
    useEmailStore.setState({ accountId: 'a1', messages: [row], total: 1 })
    const applied = useEmailStore.getState().setRead('a1', row.id, true)
    const other = message({ id: 'other', read: false })
    useEmailStore.setState({ accountId: 'b1', messages: [other], total: 1 })
    const beforeResponse = useEmailStore.getState()
    pending.resolve({ ...row, read: false })
    await expect(applied).resolves.toBe(true)
    expect(useEmailStore.getState()).toEqual(beforeResponse)
  })

  it('deletes a draft that exists only inside the open thread', async () => {
    const inbound = message({ id: 'm1' })
    const draft = message({ id: 'd1', folderId: 'draft', threadId: 't1' })
    useEmailStore.setState({
      messages: [inbound],
      total: 1,
      selectedId: inbound.id,
      selectedMessage: inbound,
      thread: [inbound, draft],
      listStatus: 'ready',
    })
    const remove = vi.spyOn(api.email, 'deleteEmail').mockResolvedValue(undefined)
    await expect(useEmailStore.getState().deleteMessage('a1', 'd1')).resolves.toBe(true)
    expect(remove).toHaveBeenCalledWith('a1', 'd1', false)
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

describe('the mailbox refresh', () => {
  it('ignores the first A folder response after loading A, B, then A again', async () => {
    const older = deferred<EmailFolder[]>()
    const other = deferred<EmailFolder[]>()
    const current = deferred<EmailFolder[]>()
    vi.spyOn(api.email, 'listFolders')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(other.promise)
      .mockReturnValueOnce(current.promise)
    const olderLoad = useEmailStore.getState().loadFolders('a1')
    const otherLoad = useEmailStore.getState().loadFolders('b1')
    const currentLoad = useEmailStore.getState().loadFolders('a1')
    other.resolve([folder({ id: 'b-folder', name: 'B' })])
    await otherLoad
    current.resolve([folder({ id: 'a-current', name: 'Current A' })])
    await currentLoad
    older.resolve([folder({ id: 'a-old', name: 'Old A' })])
    await olderLoad
    expect(useEmailStore.getState().folders.map((entry) => entry.id)).toEqual(['a-current'])
    expect(useEmailStore.getState().foldersAccountId).toBe('a1')
    expect(useEmailStore.getState().foldersStatus).toBe('ready')
  })

  it('ignores the first A tag response after loading A, B, then A again', async () => {
    const older = deferred<EmailTag[]>()
    const other = deferred<EmailTag[]>()
    const current = deferred<EmailTag[]>()
    vi.spyOn(api.email, 'listTags')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(other.promise)
      .mockReturnValueOnce(current.promise)
    const olderLoad = useEmailStore.getState().loadTags('a1')
    const otherLoad = useEmailStore.getState().loadTags('b1')
    const currentLoad = useEmailStore.getState().loadTags('a1')
    other.resolve([{ id: 'b-tag', name: 'B', color: null, count: 1 }])
    await otherLoad
    current.resolve([{ id: 'a-current', name: 'Current A', color: null, count: 2 }])
    await currentLoad
    older.resolve([{ id: 'a-old', name: 'Old A', color: null, count: 3 }])
    await olderLoad
    expect(useEmailStore.getState().tags.map((entry) => entry.id)).toEqual(['a-current'])
    expect(useEmailStore.getState().tagsAccountId).toBe('a1')
    expect(useEmailStore.getState().tagsStatus).toBe('ready')
  })

  it('ignores the first A saved-search response after loading A, B, then A again', async () => {
    const older = deferred<EmailSavedSearch[]>()
    const other = deferred<EmailSavedSearch[]>()
    const current = deferred<EmailSavedSearch[]>()
    vi.spyOn(api.email, 'listSearches')
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(other.promise)
      .mockReturnValueOnce(current.promise)
    const olderLoad = useEmailStore.getState().loadSearches('a1')
    const otherLoad = useEmailStore.getState().loadSearches('b1')
    const currentLoad = useEmailStore.getState().loadSearches('a1')
    other.resolve([{ id: 'b-search', name: 'B', query: 'B', createdAt: '2026-01-01T00:00:00.000Z' }])
    await otherLoad
    current.resolve([{ id: 'a-current', name: 'Current A', query: 'current', createdAt: '2026-01-01T00:00:00.000Z' }])
    await currentLoad
    older.resolve([{ id: 'a-old', name: 'Old A', query: 'old', createdAt: '2026-01-01T00:00:00.000Z' }])
    await olderLoad
    expect(useEmailStore.getState().searches.map((entry) => entry.id)).toEqual(['a-current'])
    expect(useEmailStore.getState().searchesAccountId).toBe('a1')
    expect(useEmailStore.getState().searchesStatus).toBe('ready')
  })

  it('reloads folders, tags, and saved searches together', async () => {
    vi.spyOn(api.email, 'listFolders').mockResolvedValue([])
    vi.spyOn(api.email, 'listTags').mockResolvedValue([{ id: 't1', name: 'ai/demo', color: null, count: 1 }])
    vi.spyOn(api.email, 'listSearches').mockResolvedValue([{ id: 's1', name: 'AI Q4', query: 'Q4', createdAt: '2026-01-01T00:00:00.000Z' }])
    vi.spyOn(api.email, 'listEmails').mockResolvedValue({ emails: [], totalCount: 0 })
    useEmailStore.setState({ accountId: 'a1', folderId: 'inbox', listMode: 'folder' })
    await useEmailStore.getState().refresh()
    expect(useEmailStore.getState().tags.map((tag) => tag.name)).toEqual(['ai/demo'])
    expect(useEmailStore.getState().searches.map((search) => search.name)).toEqual(['AI Q4'])
  })
})
