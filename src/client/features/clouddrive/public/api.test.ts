// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudDrivePublicApi } from './api'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cloudDrivePublicApi', () => {
  it('keeps public reads on the same-origin client contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ name: 'Shared' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(cloudDrivePublicApi.share('a/b')).resolves.toEqual({ name: 'Shared' })
    expect(fetchMock).toHaveBeenCalledWith('/api/public/clouddrive/shares/a%2Fb', expect.objectContaining({
      credentials: 'same-origin',
      headers: expect.any(Headers),
    }))
    expect(fetchMock.mock.calls[0]![1]!.headers.get('X-Inkstone-Client')).toBe('1')
  })

  it('encodes folder cursors and builds content URLs without exposing another route shape', () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries: [], cursor: null, total: 0 }))
    vi.stubGlobal('fetch', fetchMock)

    return cloudDrivePublicApi.listShare('share', '/team/a b', 'next/+').then(() => {
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/public/clouddrive/shares/share/list?path=%2Fteam%2Fa+b&cursor=next%2F%2B')
      expect(cloudDrivePublicApi.shareContentUrl('share', '/team/a b', false))
        .toBe('/api/public/clouddrive/shares/share/content?path=%2Fteam%2Fa%20b')
      expect(cloudDrivePublicApi.shareContentUrl('share', '/', true))
        .toBe('/d/share/raw?path=%2F')
    })
  })

  it('preserves refusal status and sends request uploads as the selected file', async () => {
    const file = new File(['hello'], 'a b.txt', { type: 'text/plain' })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ name: 'a b.txt' }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'clouddrive_share_locked', message: 'locked' } }, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(cloudDrivePublicApi.uploadToRequest('request', file, 'secret')).resolves.toEqual({ name: 'a b.txt' })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.body).toBe(file)
    expect(new Headers(init.headers).get('Content-Type')).toBe('text/plain')
    expect(new Headers(init.headers).get('X-CloudDrive-Request-Password')).toBe('secret')

    await expect(cloudDrivePublicApi.verifyShare('share', 'wrong')).rejects.toMatchObject({
      name: 'CloudDriveApiError',
      status: 401,
      code: 'clouddrive_share_locked',
    })
  })
})
