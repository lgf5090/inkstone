import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HubAttachmentListResponse,
  HubAttachmentStats,
  HubAttachmentWithUsage,
} from '@shared/attachment-hub'
import { renderElement, type RenderedElement } from '../../../lib/test-render'
import { useAttachmentHubModal } from './hooks'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../api', () => ({
  attachmentHubApi: { list: mocks.list },
}))

vi.mock('../../../store/ui', () => ({
  useUi: (selector: (state: { toast: typeof mocks.toast }) => unknown) => selector({ toast: mocks.toast }),
}))

vi.mock('../attachment-store', () => ({
  useHubOrganizer: () => [],
}))

vi.mock('../hub-scope', () => ({
  useHubScope: () => 'notes',
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function file(value: string): HubAttachmentWithUsage {
  return {
    id: value.repeat(26),
    scope: 'notes',
    filename: `${value}.txt`,
    mime: 'text/plain',
    size: 10,
    width: null,
    height: null,
    url: `/api/files/${value.repeat(26)}`,
    thumbnailUrl: null,
    folderId: null,
    isStarred: false,
    isPinned: false,
    tags: [],
    ownerId: null,
    createdAt: 1,
    references: 0,
  }
}

function stats(): HubAttachmentStats {
  return {
    totalCount: 2,
    totalBytes: 20,
    totalQuotaBytes: 1_000,
    imageBytes: 0,
    documentBytes: 20,
    mediaBytes: 0,
    archiveBytes: 0,
    codeBytes: 0,
    otherBytes: 0,
    unreferencedCount: 2,
    folderCount: 0,
    tagCount: 0,
    extensionBreakdown: {},
    largestFiles: [],
  }
}

function response(
  files: HubAttachmentWithUsage[],
  nextCursor: string | null = null,
): HubAttachmentListResponse {
  return { files, nextCursor }
}

let rendered: RenderedElement | undefined
let hub: ReturnType<typeof useAttachmentHubModal>

function Probe({ open }: { open: boolean }) {
  hub = useAttachmentHubModal(open)
  return null
}

async function mount(): Promise<void> {
  rendered = renderElement(createElement(Probe, { open: true }))
  await act(async () => {})
}

beforeEach(() => {
  mocks.list.mockReset()
  mocks.toast.mockReset()
  mocks.list.mockResolvedValue(response([]))
})

afterEach(() => {
  rendered?.unmount()
  rendered = undefined
  vi.useRealTimers()
})

describe('attachment hub search requests', () => {
  it('waits 180ms after the last search edit before listing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await mount()
    expect(mocks.list).toHaveBeenCalledTimes(1)

    act(() => { hub.setSearch('a') })
    await act(async () => { vi.advanceTimersByTime(179) })
    expect(mocks.list).toHaveBeenCalledTimes(1)

    act(() => { hub.setSearch('ab') })
    await act(async () => { vi.advanceTimersByTime(179) })
    expect(mocks.list).toHaveBeenCalledTimes(1)

    await act(async () => { vi.advanceTimersByTime(1) })
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(mocks.list.mock.calls[1]?.[1]).toMatchObject({ search: 'ab' })
  })

  it('aborts a superseded request and ignores its late response', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stale = deferred<HubAttachmentListResponse>()
    mocks.list.mockReset()
    mocks.list.mockReturnValueOnce(stale.promise)
    mocks.list.mockResolvedValueOnce(response([file('b')]))
    await mount()
    const staleSignal = mocks.list.mock.calls[0]?.[2] as AbortSignal

    act(() => { hub.setSearch('fresh') })
    expect(staleSignal.aborted).toBe(true)
    expect(mocks.list).toHaveBeenCalledTimes(1)

    await act(async () => { stale.resolve(response([file('a')])) })
    expect(hub.files).toEqual([])

    await act(async () => { vi.advanceTimersByTime(180) })
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(hub.files.map((entry) => entry.filename)).toEqual(['b.txt'])
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('keeps first-page stats when a later page omits them', async () => {
    const firstStats = stats()
    mocks.list.mockReset()
    mocks.list.mockResolvedValueOnce({
      files: [file('a')],
      nextCursor: 'next',
      stats: firstStats,
    })
    mocks.list.mockResolvedValueOnce(response([file('b')]))
    await mount()

    await act(async () => { await hub.loadMore() })

    expect(mocks.list.mock.calls[1]?.[1]).toMatchObject({ cursor: 'next' })
    expect(hub.files.map((entry) => entry.filename)).toEqual(['a.txt', 'b.txt'])
    expect(hub.stats).toBe(firstStats)
  })
})
