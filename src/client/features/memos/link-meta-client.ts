import { MEMO_LINK_METADATA_BATCH_MAX, MEMO_LINK_METADATA_TTL_MS } from '@shared/memos/constants'
import type { MemoLinkMetadata } from '@shared/memos/types'
import { memoRequest } from './api'

interface CachedMetadata {
  metadata: MemoLinkMetadata
  storedAt: number
}

const cache = new Map<string, CachedMetadata>()

export function clearMemoLinkMetadataCache(): void {
  cache.clear()
}

function emptyMetadata(url: string): MemoLinkMetadata {
  return { url, title: '', description: '', image: '' }
}

function cachedMetadata(url: string, now: number): MemoLinkMetadata | null {
  const entry = cache.get(url)
  if (!entry) return null
  if (now - entry.storedAt > MEMO_LINK_METADATA_TTL_MS) {
    cache.delete(url)
    return null
  }
  return entry.metadata
}

async function requestBatch(
  urls: readonly string[],
  signal?: AbortSignal,
): Promise<MemoLinkMetadata[]> {
  const response = await memoRequest<{ items: MemoLinkMetadata[] }>('/link-metadata', {
    method: 'POST',
    body: { urls },
    signal,
  })
  const byUrl = new Map(response.items.map((item) => [item.url, item]))
  return urls.map((url) => byUrl.get(url) ?? emptyMetadata(url))
}

export async function fetchMemoLinkMetadata(
  urls: readonly string[],
  signal?: AbortSignal,
): Promise<MemoLinkMetadata[]> {
  const unique = [...new Set(urls)].filter((url) => url !== '')
  if (unique.length === 0) return []
  const now = Date.now()
  const results = new Map<string, MemoLinkMetadata>()
  const missing: string[] = []
  for (const url of unique) {
    const hit = cachedMetadata(url, now)
    if (hit) results.set(url, hit)
    else missing.push(url)
  }
  if (missing.length > 0) {
    signal?.throwIfAborted()
    const batches: string[][] = []
    for (let index = 0; index < missing.length; index += MEMO_LINK_METADATA_BATCH_MAX) {
      batches.push(missing.slice(index, index + MEMO_LINK_METADATA_BATCH_MAX))
    }
    const fetched = (await Promise.all(batches.map((batch) => requestBatch(batch, signal)))).flat()
    const storedAt = Date.now()
    missing.forEach((url, index) => {
      const metadata = fetched[index] ?? emptyMetadata(url)
      results.set(url, metadata)
      cache.set(url, { metadata, storedAt })
    })
  }
  return unique.map((url) => results.get(url) ?? emptyMetadata(url))
}
