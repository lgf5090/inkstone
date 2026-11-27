import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('subscription API queries', () => {
  it('builds one query separator and preserves cursor pagination', async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [], nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)

    await api.subscriptions.expiring('2026-11-27', 500, 'opaque')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/subscriptions/expiring?day=2026-11-27&limit=500&cursor=opaque',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    )
  })
})
