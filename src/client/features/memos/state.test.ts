import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MEMO_DISPLAY_DEFAULTS,
  MEMO_DRAFT_VERSION,
  MEMO_PAGE_SIZE,
} from '@shared/memos/constants'
import type {
  Memo,
  MemoCreateInput,
  MemoDisplayPreferences,
  MemoListQuery,
  MemoListResponse,
  MemoPatchInput,
} from '@shared/memos/types'
import { ApiError } from '../../lib/api'
import { renderElement } from '../../lib/test-render'
import { revisionOf } from './events'
import {
  MEMO_DISPLAY_STORAGE_KEY,
  clearMemoDraft,
  createMemoDraftDebouncer,
  loadMemoDisplayPrefs,
  loadMemoDraft,
  memoDraftStorageKey,
  saveMemoDisplayPrefs,
  saveMemoDraft,
  useMemos,
  useRefreshOnFocus,
} from './state'

type ListMock = (query?: MemoListQuery, signal?: AbortSignal) => Promise<MemoListResponse>
type GetMock = (id: string, signal?: AbortSignal) => Promise<Memo>
type CreateMock = (input: MemoCreateInput) => Promise<Memo>
type PatchMock = (id: string, input: MemoPatchInput) => Promise<Memo>
type RemoveMock = (id: string) => Promise<{ ok: true }>
type RestoreMock = (id: string) => Promise<Memo>

const { api } = vi.hoisted(() => ({
  api: {
    list: vi.fn<ListMock>(),
    get: vi.fn<GetMock>(),
    create: vi.fn<CreateMock>(),
    patch: vi.fn<PatchMock>(),
    remove: vi.fn<RemoveMock>(),
    restore: vi.fn<RestoreMock>(),
  },
}))

vi.mock('./api', () => ({ memosApi: api }))

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  messages: unknown[] = []

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this)
  }

  postMessage(data: unknown): void {
    this.messages.push(data)
  }

  close(): void {}
}

vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)

function memo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: 'a'.repeat(26),
    content: 'first memo',
    title: '',
    snippet: '',
    tags: [],
    visibility: 'private',
    state: 'normal',
    pinned: false,
    spaceId: null,
    parentId: null,
    location: null,
    properties: {
      hasLink: false,
      hasCode: false,
      hasTaskList: false,
      hasIncompleteTasks: false,
      hasLocation: false,
    },
    attachments: [],
    reactions: [],
    relations: [],
    commentCount: 0,
    rev: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial))
  return {
    get length() {
      return data.size
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
    clear: () => {
      data.clear()
    },
  }
}

async function seed(items: Memo[], nextCursor: string | null = null, query = {}): Promise<void> {
  useMemos.setState((state) => ({ query: { ...state.query, ...query } }))
  api.list.mockResolvedValueOnce({ items, nextCursor })
  await useMemos.getState().load()
}

function select(memoToSelect: Memo): void {
  useMemos.setState({
    selectedId: memoToSelect.id,
    detail: memoToSelect,
    detailStatus: 'ready',
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  useMemos.getState().reset()
  for (const instance of FakeBroadcastChannel.instances) instance.messages.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('memo list state', () => {
  it('loads the first page with the current query', async () => {
    const first = memo()
    api.list.mockResolvedValueOnce({ items: [first], nextCursor: 'next' })
    await useMemos.getState().load()
    const [query, signal] = api.list.mock.calls[0]!
    expect(query).toMatchObject({
      state: 'normal',
      orderBy: 'created',
      order: 'desc',
      cursor: null,
      limit: MEMO_PAGE_SIZE,
    })
    expect(signal).toBeInstanceOf(AbortSignal)
    const state = useMemos.getState()
    expect(state.status).toBe('ready')
    expect(state.items).toEqual([first])
    expect(state.cursor).toBe('next')
    expect(state.hasMore).toBe(true)
  })

  it('combines a tag with the filter expression', async () => {
    api.list.mockResolvedValueOnce({ items: [], nextCursor: null })
    useMemos.getState().setQuery({ tag: 'design', filter: 'pinned == true' })
    await useMemos.getState().load()
    expect(api.list.mock.calls[0]![0]).toMatchObject({
      filter: '(pinned == true) && tag == "design"',
    })
  })

  it('appends a later page without repeating a memo', async () => {
    const first = memo({ id: 'a'.repeat(26) })
    const second = memo({ id: 'b'.repeat(26) })
    await seed([first], 'next')
    api.list.mockResolvedValueOnce({ items: [first, second], nextCursor: null })
    await useMemos.getState().loadMore()
    expect(api.list.mock.calls[1]![0]).toMatchObject({ cursor: 'next' })
    const state = useMemos.getState()
    expect(state.items.map((entry) => entry.id)).toEqual([first.id, second.id])
    expect(state.hasMore).toBe(false)
    expect(state.cursor).toBeNull()
  })

  it('retries the same cursor after a failed later page', async () => {
    const first = memo({ id: 'a'.repeat(26) })
    const second = memo({ id: 'b'.repeat(26) })
    await seed([first], 'next')
    api.list.mockRejectedValueOnce(new Error('page failed'))
    await useMemos.getState().loadMore()
    expect(useMemos.getState().status).toBe('error')
    expect(useMemos.getState().items).toEqual([first])
    api.list.mockResolvedValueOnce({ items: [second], nextCursor: null })
    await useMemos.getState().loadMore()
    expect(api.list.mock.calls[2]![0]).toMatchObject({ cursor: 'next' })
    expect(useMemos.getState().items.map((entry) => entry.id)).toEqual([first.id, second.id])
    expect(useMemos.getState().status).toBe('ready')
  })

  it('drops a response whose query was replaced', async () => {
    const pending = deferred<{ items: Memo[]; nextCursor: string | null }>()
    const signals: Array<AbortSignal | undefined> = []
    api.list.mockImplementationOnce((_query, nextSignal) => {
      signals.push(nextSignal)
      return pending.promise
    })
    const loading = useMemos.getState().load()
    useMemos.getState().setQuery({ tag: 'design' })
    expect(signals[0]?.aborted).toBe(true)
    pending.resolve({ items: [memo()], nextCursor: null })
    await loading
    const state = useMemos.getState()
    expect(state.items).toEqual([])
    expect(state.status).toBe('idle')
  })

  it('keeps only the latest detail answer', async () => {
    const first = memo({ id: 'a'.repeat(26) })
    const second = memo({ id: 'b'.repeat(26) })
    const slow = deferred<Memo>()
    const fast = deferred<Memo>()
    api.get.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    const firstOpen = useMemos.getState().openDetail(first.id)
    const secondOpen = useMemos.getState().openDetail(second.id)
    expect(api.get.mock.calls[0]![1]?.aborted).toBe(true)
    fast.resolve(second)
    await secondOpen
    slow.resolve(first)
    await firstOpen
    expect(useMemos.getState().detail).toEqual(second)
    expect(useMemos.getState().selectedId).toBe(second.id)
  })
})

describe('memo writes', () => {
  it('inserts an optimistic memo and replaces it with the server copy', async () => {
    const before = revisionOf('list')
    const saved = memo({ id: 'c'.repeat(26), content: 'created', rev: 1 })
    const pending = deferred<Memo>()
    api.create.mockReturnValueOnce(pending.promise)
    const creating = useMemos.getState().create({ content: 'created' })
    const optimistic = useMemos.getState().items[0]
    expect(optimistic?.content).toBe('created')
    expect(optimistic?.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      id: optimistic?.id,
      content: 'created',
    }))
    pending.resolve(saved)
    expect(await creating).toEqual(saved)
    expect(useMemos.getState().items).toEqual([saved])
    expect(revisionOf('list')).toBe(before + 1)
    const message = FakeBroadcastChannel.instances[0]?.messages[0] as { domains: string[] } | undefined
    expect(message?.domains).toContain('list')
  })

  it('removes an optimistic memo when the create fails', async () => {
    api.create.mockRejectedValueOnce(new Error('create refused'))
    const result = await useMemos.getState().create({ content: 'created' })
    expect(result).toBeNull()
    expect(useMemos.getState().items).toEqual([])
    expect(useMemos.getState().mutationError).toBe('create refused')
  })

  it('applies a patch optimistically and adopts the server revision', async () => {
    const original = memo()
    await seed([original])
    select(original)
    const saved = memo({ content: 'edited', rev: 2 })
    const pending = deferred<Memo>()
    api.patch.mockReturnValueOnce(pending.promise)
    const patching = useMemos.getState().patch(original.id, { rev: 1, content: 'edited' })
    expect(useMemos.getState().items[0]?.content).toBe('edited')
    expect(useMemos.getState().detail?.content).toBe('edited')
    pending.resolve(saved)
    expect(await patching).toEqual(saved)
    expect(useMemos.getState().items[0]).toEqual(saved)
    expect(useMemos.getState().detail).toEqual(saved)
  })

  it('rolls a patch back when the write fails', async () => {
    const original = memo()
    await seed([original])
    select(original)
    api.patch.mockRejectedValueOnce(new Error('patch refused'))
    const result = await useMemos.getState().patch(original.id, { rev: 1, content: 'edited' })
    expect(result).toBeNull()
    expect(useMemos.getState().items[0]).toEqual(original)
    expect(useMemos.getState().detail).toEqual(original)
    expect(useMemos.getState().mutationError).toBe('patch refused')
  })

  it('replaces the local copy on a revision conflict instead of overwriting the server', async () => {
    const original = memo()
    const server = memo({ content: 'server copy', rev: 2 })
    await seed([original])
    select(original)
    api.patch.mockRejectedValueOnce(new ApiError(409, 'memo_conflict', 'conflict'))
    api.get.mockResolvedValueOnce(server)
    const result = await useMemos.getState().patch(original.id, { rev: 1, content: 'mine' })
    expect(result).toBeNull()
    expect(api.get).toHaveBeenCalledWith(original.id)
    const state = useMemos.getState()
    expect(state.items[0]).toEqual(server)
    expect(state.detail).toEqual(server)
    expect(state.conflict).toMatchObject({ memoId: original.id, memo: server })
    expect(state.conflict?.message).toBeTruthy()
    expect(state.mutationError).toBe(state.conflict?.message)
    useMemos.getState().clearConflict()
    expect(useMemos.getState().conflict).toBeNull()
  })

  it('rolls a conflicted patch back when the server copy cannot be read', async () => {
    const original = memo()
    await seed([original])
    select(original)
    api.patch.mockRejectedValueOnce(new ApiError(409, 'memo_conflict', 'conflict'))
    api.get.mockRejectedValueOnce(new Error('read failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await useMemos.getState().patch(original.id, { rev: 1, content: 'mine' })
    expect(result).toBeNull()
    const state = useMemos.getState()
    expect(state.items[0]).toEqual(original)
    expect(state.detail).toEqual(original)
    expect(state.conflict).toMatchObject({ memoId: original.id, memo: null })
  })

  it('removes a memo optimistically and bumps the attachment domain', async () => {
    const first = memo({ id: 'a'.repeat(26) })
    const second = memo({ id: 'b'.repeat(26) })
    await seed([first, second])
    select(first)
    const before = revisionOf('attachments')
    const pending = deferred<{ ok: true }>()
    api.remove.mockReturnValueOnce(pending.promise)
    const removing = useMemos.getState().remove(first.id)
    expect(useMemos.getState().items.map((entry) => entry.id)).toEqual([second.id])
    expect(useMemos.getState().detail).toBeNull()
    expect(useMemos.getState().selectedId).toBeNull()
    pending.resolve({ ok: true })
    expect(await removing).toBe(true)
    expect(revisionOf('attachments')).toBe(before + 1)
  })

  it('restores a memo in place when the delete fails', async () => {
    const first = memo({ id: 'a'.repeat(26) })
    const second = memo({ id: 'b'.repeat(26) })
    await seed([first, second])
    select(first)
    api.remove.mockRejectedValueOnce(new Error('delete refused'))
    expect(await useMemos.getState().remove(first.id)).toBe(false)
    const state = useMemos.getState()
    expect(state.items.map((entry) => entry.id)).toEqual([first.id, second.id])
    expect(state.detail).toEqual(first)
    expect(state.selectedId).toBe(first.id)
    expect(state.mutationError).toBe('delete refused')
  })

  it('takes a restored memo out of the archived list', async () => {
    const archived = memo({ state: 'archived' })
    await seed([archived], null, { state: 'archived' })
    const before = revisionOf('list')
    api.restore.mockResolvedValueOnce(memo())
    const restored = await useMemos.getState().restore(archived.id)
    expect(restored?.state).toBe('normal')
    expect(useMemos.getState().items).toEqual([])
    expect(revisionOf('list')).toBe(before + 1)
  })

  it('bumps the local revision bus for a mutation from another tab', () => {
    api.create.mockResolvedValueOnce(memo({ id: 'c'.repeat(26) }))
    const pending = useMemos.getState().create({ content: 'created' })
    return pending.then(() => {
      const bus = FakeBroadcastChannel.instances[0]
      expect(bus?.name).toBe('inkstone.memos')
      const message = bus?.messages[0] as { sourceId: string }
      const before = revisionOf('stats')
      bus?.onmessage?.(new MessageEvent('message', {
        data: { type: 'memo-mutation', sourceId: 'other-tab', domains: ['stats'] },
      }))
      expect(revisionOf('stats')).toBe(before + 1)
      bus?.onmessage?.(new MessageEvent('message', {
        data: { type: 'memo-mutation', sourceId: message.sourceId, domains: ['stats'] },
      }))
      expect(revisionOf('stats')).toBe(before + 1)
    })
  })
})

describe('display preferences', () => {
  it('falls back to the defaults for an empty storage', () => {
    expect(loadMemoDisplayPrefs(makeStorage())).toEqual(MEMO_DISPLAY_DEFAULTS)
  })

  it('round-trips the stored preferences', () => {
    const storage = makeStorage()
    const prefs: MemoDisplayPreferences = {
      columns: 2,
      compact: true,
      linkPreview: false,
      timeBasis: 'updated',
      order: 'asc',
    }
    saveMemoDisplayPrefs(prefs, storage)
    expect(storage.getItem(MEMO_DISPLAY_STORAGE_KEY)).toBe(JSON.stringify(prefs))
    expect(loadMemoDisplayPrefs(storage)).toEqual(prefs)
  })

  it('repairs invalid fields while keeping valid ones', () => {
    const storage = makeStorage({
      [MEMO_DISPLAY_STORAGE_KEY]: JSON.stringify({
        columns: 9,
        compact: 'yes',
        linkPreview: false,
        timeBasis: 'created',
        order: 'sideways',
      }),
    })
    expect(loadMemoDisplayPrefs(storage)).toEqual({
      ...MEMO_DISPLAY_DEFAULTS,
      linkPreview: false,
      timeBasis: 'created',
      order: MEMO_DISPLAY_DEFAULTS.order,
    })
  })

  it('ignores unreadable storage and reports it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = makeStorage({ [MEMO_DISPLAY_STORAGE_KEY]: '{not json' })
    expect(loadMemoDisplayPrefs(storage)).toEqual(MEMO_DISPLAY_DEFAULTS)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('memo drafts', () => {
  it('names the draft after the user and scope', () => {
    expect(memoDraftStorageKey('user1', 'new')).toBe('inkstone.memos.draft:user1:new')
  })

  it('round-trips a draft with the current version and timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'))
    const storage = makeStorage()
    const saved = saveMemoDraft('user1', 'new', {
      content: 'draft body',
      attachmentIds: ['att1'],
      spaceId: 'space1',
      visibility: 'protected',
    }, storage)
    expect(saved.version).toBe(MEMO_DRAFT_VERSION)
    expect(saved.updatedAt).toBe(Math.floor(Date.now() / 1000))
    expect(loadMemoDraft('user1', 'new', storage)).toEqual(saved)
  })

  it('rejects a draft from an unknown version or unreadable json', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = makeStorage({
      [memoDraftStorageKey('user1', 'old')]: JSON.stringify({ version: 99, content: 'old' }),
      [memoDraftStorageKey('user1', 'broken')]: '{not json',
    })
    expect(loadMemoDraft('user1', 'old', storage)).toBeNull()
    expect(loadMemoDraft('user1', 'broken', storage)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('clears a draft', () => {
    const storage = makeStorage()
    saveMemoDraft('user1', 'new', { content: 'draft body' }, storage)
    clearMemoDraft('user1', 'new', storage)
    expect(storage.getItem(memoDraftStorageKey('user1', 'new'))).toBeNull()
    expect(loadMemoDraft('user1', 'new', storage)).toBeNull()
  })
})

describe('memo draft debounce', () => {
  it('writes once after the quiet window', () => {
    vi.useFakeTimers()
    const write = vi.fn()
    const debouncer = createMemoDraftDebouncer(write)
    debouncer.schedule('a')
    debouncer.schedule('b')
    vi.advanceTimersByTime(499)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenLastCalledWith('b')
  })

  it('flushes the pending value immediately and cancels a scheduled one', () => {
    vi.useFakeTimers()
    const write = vi.fn()
    const debouncer = createMemoDraftDebouncer(write)
    debouncer.schedule('a')
    debouncer.flush()
    expect(write).toHaveBeenLastCalledWith('a')
    debouncer.schedule('b')
    debouncer.cancel()
    vi.advanceTimersByTime(1_000)
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('focus refresh', () => {
  function FocusProbe() {
    useRefreshOnFocus(['list'])
    return null
  }

  it('bumps the requested domains when the window regains focus', () => {
    const view = renderElement(createElement(FocusProbe))
    try {
      const before = revisionOf('list')
      act(() => {
        window.dispatchEvent(new Event('focus'))
      })
      expect(revisionOf('list')).toBe(before + 1)
    } finally {
      view.unmount()
    }
  })

  it('bumps once when a hidden page becomes visible again', () => {
    const view = renderElement(createElement(FocusProbe))
    try {
      const before = revisionOf('list')
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(revisionOf('list')).toBe(before)
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(revisionOf('list')).toBe(before + 1)
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
      view.unmount()
    }
  })
})
