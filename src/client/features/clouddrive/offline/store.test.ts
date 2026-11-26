import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudDriveEntry } from '@shared/clouddrive/model'
import { getOffline, listOffline, offlineRefusal, putOffline, readOfflineResponse, removeOffline } from './store'

const MIB = 1024 * 1024

afterEach(() => {
  vi.unstubAllGlobals()
})

function requestOf<T>(result: T): IDBRequest<T> {
  const request = { result } as unknown as IDBRequest<T>
  queueMicrotask(() => (request.onsuccess as (() => void) | null)?.())
  return request
}

function installIndexedDb() {
  const opened: string[] = []
  const databases = new Map<string, Map<IDBValidKey, unknown>>()
  const factory = {
    open(name: string) {
      opened.push(name)
      const rows = databases.get(name) ?? new Map<IDBValidKey, unknown>()
      databases.set(name, rows)
      const store = {
        getAll: () => requestOf([...rows.values()]),
        get: (key: IDBValidKey) => requestOf(rows.get(key)),
        put: (value: unknown) => {
          const key = (value as { id: IDBValidKey }).id
          rows.set(key, value)
          return requestOf(key)
        },
        delete: (key: IDBValidKey) => { rows.delete(key); return requestOf(undefined) },
      }
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: vi.fn(),
        transaction: () => ({ objectStore: () => store }),
        close: vi.fn(),
      }
      const request = {
        result: null as unknown as IDBDatabase,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      }
      queueMicrotask(() => {
        request.result = db as unknown as IDBDatabase
        request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
  vi.stubGlobal('indexedDB', factory as unknown as IDBFactory)
  return opened
}

function entry(id: string): CloudDriveEntry {
  return { id, name: `${id}.txt`, mime: 'text/plain', size: 3, mountId: 'primary', path: `/${id}.txt` } as CloudDriveEntry
}

function meta(id: string, size: number) {
  return { id, name: `${id}.txt`, mime: 'text/plain', size, savedAt: 1, mountId: 'primary', path: `/${id}.txt` }
}

describe('offlineRefusal', () => {
  const limits = { file: 10 * MIB, total: 25 * MIB }

  it('refuses a single file past the per-file ceiling', () => {
    expect(offlineRefusal([], 'a', 11 * MIB, limits)).toBe('offline_too_large')
    expect(offlineRefusal([], 'a', 10 * MIB, limits)).toBeNull()
  })

  it('refuses a save that would pass the total ceiling', () => {
    expect(offlineRefusal([meta('b', 20 * MIB)], 'a', 6 * MIB, limits)).toBe('offline_quota')
    expect(offlineRefusal([meta('b', 20 * MIB)], 'a', 5 * MIB, limits)).toBeNull()
  })

  it('does not count the copy a re-save replaces against itself', () => {
    expect(offlineRefusal([meta('a', 20 * MIB)], 'a', 5 * MIB, limits)).toBeNull()
  })
})

describe('offline account isolation', () => {
  it('uses a separate database and identical entry ids for each user', async () => {
    const opened = installIndexedDb()
    await putOffline('user-a', entry('same'), new Blob(['aaa'], { type: 'text/plain' }))
    await putOffline('user-b', entry('same'), new Blob(['bbb'], { type: 'text/plain' }))

    expect(opened).toEqual([
      'inkstone-clouddrive-offline.user-a',
      'inkstone-clouddrive-offline.user-a',
      'inkstone-clouddrive-offline.user-b',
      'inkstone-clouddrive-offline.user-b',
    ])
    expect((await listOffline('user-a')).map((row) => row.name)).toEqual(['same.txt'])
    expect(await (await getOffline('user-a', 'same'))?.blob.text()).toBe('aaa')
    expect(await (await getOffline('user-b', 'same'))?.blob.text()).toBe('bbb')

    await removeOffline('user-b', 'same')
    expect(await getOffline('user-b', 'same')).toBeNull()
    expect(await (await getOffline('user-a', 'same'))?.blob.text()).toBe('aaa')
  })

  it('refuses to open an unscoped anonymous cache', async () => {
    installIndexedDb()
    await expect(listOffline('')).rejects.toThrow('offline_user_required')
  })
})

describe('readOfflineResponse', () => {
  function streamed(chunks: number[], headers: Record<string, string> = {}) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const size of chunks) controller.enqueue(new Uint8Array(size))
        controller.close()
      },
    })
    return new Response(body, { headers })
  }

  it('checks the declared length before reading a byte', async () => {
    const assertRoom = vi.fn(async (bytes: number) => {
      if (bytes > 10 * MIB) throw new Error('offline_too_large')
    })
    const response = new Response(new Uint8Array(4), { headers: { 'content-length': String(50 * MIB) } })
    await expect(readOfflineResponse(response, 'text/plain', assertRoom, 10 * MIB)).rejects.toThrow('offline_too_large')
    expect(assertRoom).toHaveBeenCalledWith(50 * MIB)
  })

  it('cancels a stream whose running total passes the ceiling', async () => {
    const assertRoom = vi.fn(async () => {})
    const response = streamed([6 * MIB, 6 * MIB])
    await expect(readOfflineResponse(response, 'text/plain', assertRoom, 10 * MIB)).rejects.toThrow('offline_too_large')
    // The pre-flight check runs on the known size, so a lying `content-length` is not the only guard.
    expect(assertRoom).not.toHaveBeenCalledWith(12 * MIB)
  })

  it('keeps a response that fits and honours the mime it was asked for', async () => {
    const assertRoom = vi.fn(async () => {})
    const blob = await readOfflineResponse(streamed([3 * MIB, 2 * MIB]), 'text/markdown', assertRoom, 10 * MIB)
    expect(blob.size).toBe(5 * MIB)
    expect(blob.type).toBe('text/markdown')
  })
})
