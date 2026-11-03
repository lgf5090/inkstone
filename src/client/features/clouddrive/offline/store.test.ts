import { describe, expect, it, vi } from 'vitest'
import { offlineRefusal, readOfflineResponse } from './store'

const MIB = 1024 * 1024

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
