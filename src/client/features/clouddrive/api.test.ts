// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clouddriveApi, request } from './api'

afterEach(() => vi.unstubAllGlobals())

describe('clouddrive API transport', () => {
  it('returns a structured 207 result instead of turning partial success into a request failure', async () => {
    const payload = { results: [{ id: 'one', ok: true }, { id: 'two', ok: false, error: 'conflict' }] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload, { status: 207 })))
    await expect(request('/api/clouddrive/files/move', { method: 'POST' })).resolves.toEqual(payload)
  })

  it('versions mutable content and thumbnail URLs', () => {
    expect(clouddriveApi.contentUrl('file-1', true, 123)).toContain('v=123')
    expect(clouddriveApi.thumbnailUrl('file-1', 320, 123)).toContain('v=123')
  })

  it('sends share and ACL cursors and accepts the allow-list policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ shares: [], cursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    await clouddriveApi.shares('next')
    expect(fetchMock.mock.calls[0]![0]).toContain('cursor=next')
    await clouddriveApi.sharedWithMe('shared-next')
    expect(fetchMock.mock.calls[1]![0]).toContain('cursor=shared-next')
    await clouddriveApi.sharedList('owner', 'folder', '/docs', 'children-next')
    expect(fetchMock.mock.calls[2]![0]).toContain('cursor=children-next')
    await clouddriveApi.recent('uploaded', 'recent-next')
    expect(fetchMock.mock.calls[3]![0]).toContain('cursor=recent-next')
  })
})
