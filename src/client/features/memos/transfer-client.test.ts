// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_HEADER } from '@shared/constants'
import { MEMO_IMPORT_CHUNK_BYTES } from '@shared/memos/constants'
import { ApiError, CLIENT_ID } from '../../lib/api'
import { getLocale } from '../../lib/i18n'
import { downloadExport, uploadImportChunk } from './transfer-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers)
}

describe('the memos transfer client', () => {
  it('downloads the export with the shared client headers and the server filename', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    fetchMock.mockResolvedValue(new Response('zip-bytes', {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="fallback.zip"; filename*=UTF-8\'\'memos-export-alice%20smith.zip',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadExport()

    expect(result.filename).toBe('memos-export-alice smith.zip')
    expect(await result.blob.text()).toBe('zip-bytes')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/memos/export')
    expect(init?.credentials).toBe('same-origin')
    const headers = headersOf(init)
    expect(headers.get(CLIENT_HEADER)).toBe('1')
    expect(headers.get('X-Inkstone-Origin')).toBe(CLIENT_ID)
    expect(headers.get('Accept-Language')).toBe(getLocale())
  })

  it('maps an export refusal to the route error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'payload_too_large', message: 'The archive is too large' } }),
      { status: 413, headers: { 'content-type': 'application/json' } },
    )))

    await expect(downloadExport()).rejects.toMatchObject({
      status: 413,
      code: 'payload_too_large',
      serverMessage: 'The archive is too large',
    })
  })

  it('maps an unreachable export to the offline error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))

    const failure = await downloadExport().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 0, code: 'offline' })
  })

  it('uploads one chunk as octet-stream at the given offset', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ received: MEMO_IMPORT_CHUNK_BYTES }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const chunk = new Blob([new Uint8Array(MEMO_IMPORT_CHUNK_BYTES)], { type: 'application/zip' })

    const result = await uploadImportChunk('session-1', MEMO_IMPORT_CHUNK_BYTES, chunk)

    expect(result).toEqual({ received: MEMO_IMPORT_CHUNK_BYTES })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/memos/import/sessions/session-1?offset=${MEMO_IMPORT_CHUNK_BYTES}`)
    expect(init?.method).toBe('PUT')
    expect(init?.body).toBe(chunk)
    const headers = headersOf(init)
    expect(headers.get('Content-Type')).toBe('application/octet-stream')
    expect(headers.get(CLIENT_HEADER)).toBe('1')
    expect(headers.get('X-Inkstone-Origin')).toBe(CLIENT_ID)
    expect(headers.get('Accept-Language')).toBe(getLocale())
  })

  it('maps a chunk offset conflict to the route error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'memo_import_conflict', message: 'The upload offset changed' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )))

    await expect(uploadImportChunk('session-1', 0, new Blob(['chunk']))).rejects.toMatchObject({
      status: 409,
      code: 'memo_import_conflict',
      serverMessage: 'The upload offset changed',
    })
  })
})
