import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageUrlCache } from '../src/client/features/reading/engine/page-url-cache'

let urlSequence = 0
const createObjectURL = vi.fn((_blob: Blob) => `blob:page-${++urlSequence}`)
const revokeObjectURL = vi.fn()
const loader = vi.fn(async (path: string) => new Blob([path], { type: 'image/jpeg' }))

beforeEach(() => {
  urlSequence = 0
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  loader.mockClear()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
})

afterEach(() => vi.unstubAllGlobals())

describe('PageUrlCache', () => {
  it('keeps the most recently used pages and revokes the evicted URL', async () => {
    const cache = new PageUrlCache(loader, 2)
    const a = await cache.load('a.jpg')
    const b = await cache.load('b.jpg')
    expect(await cache.load('a.jpg')).toBe(a)
    expect(loader).toHaveBeenCalledTimes(2)

    const c = await cache.load('c.jpg')
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(b)
    expect(await cache.load('a.jpg')).toBe(a)
    expect(await cache.load('c.jpg')).toBe(c)

    await cache.load('b.jpg')
    expect(revokeObjectURL).toHaveBeenCalledWith(a)
    expect(loader).toHaveBeenCalledTimes(4)
  })

  it('shares one decompression and one URL between concurrent requests', async () => {
    let finish!: (blob: Blob) => void
    const pendingLoader = vi.fn(() => new Promise<Blob>((resolve) => { finish = resolve }))
    const cache = new PageUrlCache(pendingLoader, 6)
    const first = cache.load('page.jpg')
    const second = cache.load('page.jpg')
    expect(second).toBe(first)
    expect(pendingLoader).toHaveBeenCalledExactlyOnceWith('page.jpg')

    finish(new Blob(['page']))
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('removes a failed in-flight read so the page can be retried', async () => {
    const retryLoader = vi.fn()
      .mockRejectedValueOnce(new Error('corrupt page'))
      .mockResolvedValueOnce(new Blob(['recovered']))
    const cache = new PageUrlCache(retryLoader, 6)
    const first = cache.load('bad.jpg')
    expect(cache.load('bad.jpg')).toBe(first)
    await expect(first).rejects.toThrow('corrupt page')
    expect(createObjectURL).not.toHaveBeenCalled()

    await expect(cache.load('bad.jpg')).resolves.toMatch(/^blob:page-/)
    expect(retryLoader).toHaveBeenCalledTimes(2)
  })

  it('revokes one page without disturbing the others', async () => {
    const cache = new PageUrlCache(loader, 6)
    const a = await cache.load('a.jpg')
    const b = await cache.load('b.jpg')
    cache.revoke('a.jpg')
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(a)
    expect(await cache.load('b.jpg')).toBe(b)
    expect(loader).toHaveBeenCalledTimes(2)

    await cache.load('a.jpg')
    expect(loader).toHaveBeenCalledTimes(3)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('clears all URLs and remains reusable', async () => {
    const cache = new PageUrlCache(loader, 6)
    const a = await cache.load('a.jpg')
    const b = await cache.load('b.jpg')
    cache.clear()
    expect(revokeObjectURL.mock.calls).toEqual([[a], [b]])
    expect(createObjectURL).toHaveBeenCalledTimes(2)

    await cache.load('a.jpg')
    expect(loader).toHaveBeenCalledTimes(3)
    expect(createObjectURL).toHaveBeenCalledTimes(3)
  })

  it('revokes a URL that arrives after the cache was cleared', async () => {
    let finish!: (blob: Blob) => void
    const cache = new PageUrlCache(() => new Promise<Blob>((resolve) => { finish = resolve }), 6)
    const loading = cache.load('late.jpg')
    cache.clear()
    finish(new Blob(['late']))

    await expect(loading).rejects.toThrow('cache was cleared')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:page-1')
  })

  it('revokes a URL that arrives after one page was revoked', async () => {
    let finish!: (blob: Blob) => void
    const cache = new PageUrlCache(() => new Promise<Blob>((resolve) => { finish = resolve }), 6)
    const loading = cache.load('late.jpg')
    cache.revoke('late.jpg')
    finish(new Blob(['late']))

    await expect(loading).rejects.toThrow('cache was cleared')
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:page-1')
  })

  it('rejects a non-positive or fractional capacity', () => {
    expect(() => new PageUrlCache(loader, 0)).toThrow(RangeError)
    expect(() => new PageUrlCache(loader, 1.5)).toThrow(RangeError)
  })
})
