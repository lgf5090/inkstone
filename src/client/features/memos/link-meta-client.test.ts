import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMO_LINK_METADATA_BATCH_MAX, MEMO_LINK_METADATA_TTL_MS } from '@shared/memos/constants'
import type { MemoLinkMetadata } from '@shared/memos/types'

const memoRequest = vi.hoisted(() => vi.fn())

vi.mock('./api', () => ({ memoRequest }))

import { clearMemoLinkMetadataCache, fetchMemoLinkMetadata } from './link-meta-client'

interface RequestOptions {
  method?: string
  body?: { urls?: string[] }
  signal?: AbortSignal
}

function metadata(url: string): MemoLinkMetadata {
  return { url, title: url, description: '', image: '' }
}

function requestOptions(index: number): RequestOptions {
  return memoRequest.mock.calls[index]![1] as RequestOptions
}

beforeEach(() => {
  memoRequest.mockReset()
  clearMemoLinkMetadataCache()
})

describe('the link metadata client', () => {
  it('batches requests and answers in input order', async () => {
    memoRequest.mockImplementation((_path: string, options: RequestOptions) => {
      const urls = options.body?.urls ?? []
      return Promise.resolve({ items: urls.map(metadata).reverse() })
    })
    const urls = Array.from({ length: 12 }, (_, index) => `https://site${index}.test/page`)
    const result = await fetchMemoLinkMetadata(urls)

    expect(memoRequest).toHaveBeenCalledTimes(2)
    expect(requestOptions(0).body?.urls).toHaveLength(MEMO_LINK_METADATA_BATCH_MAX)
    expect(requestOptions(1).body?.urls).toHaveLength(2)
    expect(requestOptions(0).method).toBe('POST')
    expect(result.map((item) => item.url)).toEqual(urls)
  })

  it('serves cached URLs without a second request', async () => {
    memoRequest.mockImplementation((_path: string, options: RequestOptions) => {
      const urls = options.body?.urls ?? []
      return Promise.resolve({ items: urls.map(metadata) })
    })
    await fetchMemoLinkMetadata(['https://a.test/x'])
    const result = await fetchMemoLinkMetadata(['https://a.test/x', 'https://b.test/y'])

    expect(memoRequest).toHaveBeenCalledTimes(2)
    expect(requestOptions(1).body?.urls).toEqual(['https://b.test/y'])
    expect(result.map((item) => item.title)).toEqual(['https://a.test/x', 'https://b.test/y'])
  })

  it('refetches after the server cache window', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    memoRequest.mockResolvedValue({ items: [metadata('https://a.test/x')] })
    try {
      await fetchMemoLinkMetadata(['https://a.test/x'])
      now.mockReturnValue(1_000 + MEMO_LINK_METADATA_TTL_MS + 1)
      await fetchMemoLinkMetadata(['https://a.test/x'])
      expect(memoRequest).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('refuses an aborted signal before asking the server', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fetchMemoLinkMetadata(['https://a.test/x'], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(memoRequest).not.toHaveBeenCalled()
  })

  it('forwards the signal and fills missing metadata with an empty item', async () => {
    memoRequest.mockResolvedValue({ items: [] })
    const controller = new AbortController()
    const result = await fetchMemoLinkMetadata(['https://a.test/x'], controller.signal)

    expect(requestOptions(0).signal).toBe(controller.signal)
    expect(result).toEqual([{ url: 'https://a.test/x', title: '', description: '', image: '' }])
  })

  it('does nothing for an empty list', async () => {
    expect(await fetchMemoLinkMetadata([])).toEqual([])
    expect(memoRequest).not.toHaveBeenCalled()
  })
})
