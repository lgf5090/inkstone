import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudDriveBootstrap, CloudDriveEntry } from '../src/shared/clouddrive/model'
import { clouddriveApi } from '../src/client/features/clouddrive/api'
import { useCloudDriveStore } from '../src/client/features/clouddrive/store'
import { partRetryDelay, putPartWithRetry, useTransferStore, type TransferItem } from '../src/client/features/clouddrive/transfers/useTransferStore'

vi.mock('../src/client/features/clouddrive/transfers/hash', () => ({
  sha256File: vi.fn().mockResolvedValue('a'.repeat(64)),
}))

const HISTORY_VERSION = 'v1'
const originalCreateObjectURL = URL.createObjectURL

function historyKey(userId: string): string {
  return `inkstone.clouddrive.transfers.${HISTORY_VERSION}.${userId}`
}

function item(id: string, status: TransferItem['status'], name: string): TransferItem {
  return {
    id,
    kind: 'upload',
    name,
    mime: 'text/plain',
    size: 4,
    transferred: status === 'success' ? 4 : 0,
    status,
    errorKey: null,
    createdAt: 1,
    finishedAt: status === 'success' ? 2 : null,
    mountId: 'primary',
    parentPath: '/',
    entryId: null,
    sessionId: null,
  }
}

beforeEach(() => {
  localStorage.clear()
  useTransferStore.setState({ items: [] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: originalCreateObjectURL })
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker
})

describe('CloudDrive upload scheduling', () => {
  it('does not request a session when init reports conflict=skip', async () => {
    const existing = { id: 'existing', name: 'same.bin', path: '/same.bin' } as CloudDriveEntry
    vi.spyOn(clouddriveApi, 'initUpload').mockResolvedValue({ skipped: true, existing, entryPath: '/same.bin' })
    const complete = vi.spyOn(clouddriveApi, 'completeUpload')
    const abort = vi.spyOn(clouddriveApi, 'abortUpload')
    const session = vi.spyOn(clouddriveApi, 'uploadSession')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    useTransferStore.getState().enqueueUpload([new File(['data'], 'same.bin')], {
      mountId: 'primary', parentPath: '/', conflict: 'skip',
    })

    await vi.waitFor(() => expect(useTransferStore.getState().items[0]?.status).toBe('success'))
    expect(useTransferStore.getState().items[0]).toMatchObject({ transferred: 0, sessionId: null, entryId: 'existing' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
  })

  it.each([
    { wanted: 3, policy: 2, expected: 2 },
    { wanted: 1, policy: 8, expected: 1 },
  ])('uploads parts concurrently at the smaller of preference $wanted and policy $policy', async ({ wanted, policy, expected }) => {
    const prefs = useCloudDriveStore.getState().prefs
    useCloudDriveStore.setState({
      prefs: { ...prefs, uploadConcurrency: wanted },
      bootstrap: { settings: { uploadConcurrentParts: policy } } as unknown as CloudDriveBootstrap,
    })
    vi.spyOn(clouddriveApi, 'initUpload').mockResolvedValue({
      session: { id: 'session-parts', strategy: 'multipart', partSize: 2, totalParts: 3 },
      entryPath: '/parts.bin',
    })
    const complete = vi.spyOn(clouddriveApi, 'completeUpload').mockResolvedValue({ entry: { id: 'done' } as CloudDriveEntry })
    let active = 0
    let maximum = 0
    const fetchMock = vi.fn(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    useTransferStore.getState().enqueueUpload([new File(['abcdef'], 'parts.bin')], { mountId: 'primary', parentPath: '/' })

    await vi.waitFor(() => expect(useTransferStore.getState().items[0]?.status).toBe('success'))
    expect(maximum).toBe(expected)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(complete).toHaveBeenCalledWith('session-parts')
  })

  it('shares the server part budget across concurrent files', async () => {
    const prefs = useCloudDriveStore.getState().prefs
    useCloudDriveStore.setState({
      prefs: { ...prefs, uploadConcurrency: 3 },
      bootstrap: { settings: { uploadConcurrentParts: 2 } } as unknown as CloudDriveBootstrap,
    })
    vi.spyOn(clouddriveApi, 'initUpload')
      .mockResolvedValueOnce({ session: { id: 'session-a', strategy: 'multipart', partSize: 2, totalParts: 2 }, entryPath: '/a.bin' })
      .mockResolvedValueOnce({ session: { id: 'session-b', strategy: 'multipart', partSize: 2, totalParts: 2 }, entryPath: '/b.bin' })
    vi.spyOn(clouddriveApi, 'completeUpload').mockResolvedValue({ entry: { id: 'done' } as CloudDriveEntry })
    let active = 0
    let maximum = 0
    const fetchMock = vi.fn(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    useTransferStore.getState().enqueueUpload([
      new File(['abcd'], 'a.bin'),
      new File(['efgh'], 'b.bin'),
    ], { mountId: 'primary', parentPath: '/' })

    await vi.waitFor(() => expect(useTransferStore.getState().items.every((entry) => entry.status === 'success')).toBe(true))
    expect(maximum).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('retries transient part failures with exponential backoff', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'internal', message: 'busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const upload = putPartWithRetry('/part/1', new Blob(['x']), controller.signal)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(partRetryDelay(0) - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await upload
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(partRetryDelay(1)).toBe(partRetryDelay(0) * 2)
  })
})

describe('CloudDrive download streaming', () => {
  function downloadEntry(): CloudDriveEntry {
    return {
      id: 'file-download', kind: 'file', name: 'large.bin', mime: 'application/octet-stream', size: 6,
      mountId: 'primary', path: '/large.bin',
    } as CloudDriveEntry
  }

  it('pipes the response into a File System Access writable without building a Blob', async () => {
    const chunks: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({
      write(chunk) { chunks.push(chunk.slice()) },
    })
    const createWritable = vi.fn().mockResolvedValue(writable)
    const picker = vi.fn().mockResolvedValue({ createWritable })
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, writable: true, value: picker })
    const createObjectURL = vi.fn(() => 'blob:must-not-be-used')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6]))
        controller.close()
      },
    }), { headers: { 'Content-Length': '6' } })))

    useTransferStore.getState().enqueueDownload(downloadEntry())

    await vi.waitFor(() => expect(useTransferStore.getState().items[0]?.status).toBe('success'))
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'large.bin' })
    expect(createWritable).toHaveBeenCalledTimes(1)
    expect(chunks.map((chunk) => [...chunk])).toEqual([[1, 2, 3], [4, 5, 6]])
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(useTransferStore.getState().items[0]).toMatchObject({ transferred: 6, size: 6 })
  })

  it('uses the browser download manager when no save-file picker exists', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    useTransferStore.getState().enqueueDownload(downloadEntry())

    await vi.waitFor(() => expect(useTransferStore.getState().items[0]?.status).toBe('success'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('/api/clouddrive/files/file-download/content?download=1')
    expect(anchor.download).toBe('large.bin')
    expect(useTransferStore.getState().items[0]).toMatchObject({ transferred: 6, size: 6 })
  })

  it('treats cancelling the save dialog as a cancelled transfer without fetching', async () => {
    const picker = vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError'))
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, writable: true, value: picker })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    useTransferStore.getState().enqueueDownload(downloadEntry())

    await vi.waitFor(() => expect(useTransferStore.getState().items[0]?.status).toBe('cancelled'))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('CloudDrive transfer history hydration', () => {
  it('keeps a live successful transfer instead of dropping it between the two lists', () => {
    const userId = 'hydrate-success-live'
    const live = item('tr-1', 'success', 'live.txt')
    localStorage.setItem(historyKey(userId), JSON.stringify([live]))
    useTransferStore.setState({ items: [live] })

    useTransferStore.getState().hydrate(userId)

    expect(useTransferStore.getState().items.map((entry) => entry.id)).toEqual(['tr-1'])
  })

  it('merges history with an active transfer and does not duplicate a shared id', () => {
    const userId = 'hydrate-active-history'
    const active = item('tr-active', 'running', 'active.bin')
    const older = item('tr-old', 'success', 'old.txt')
    localStorage.setItem(historyKey(userId), JSON.stringify([older]))
    useTransferStore.setState({ items: [active] })

    useTransferStore.getState().hydrate(userId)

    expect(useTransferStore.getState().items.map((entry) => entry.id).sort()).toEqual(['tr-active', 'tr-old'])
  })
})
