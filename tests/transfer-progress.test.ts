// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadAsBlob, uploadWithProgress } from '../src/client/lib/transfer'

/**
 * The two progress contracts, measured rather than assumed.
 *
 * A bar that never moves is worse than no bar, and neither half of this can be seen on a 14 kB fixture in
 * a browser — the whole body arrives in one read. So the chunk arithmetic is pinned here, where a stream
 * can be fed deliberately.
 */
describe('the download bar', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('reports every chunk against the length the server declared', async () => {
    const chunks = [new Uint8Array(40), new Uint8Array(40), new Uint8Array(20)]
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      headers: { 'Content-Length': '100', 'Content-Type': 'application/epub+zip' },
    })))

    const seen: [number, number][] = []
    const blob = await downloadAsBlob('/api/reader/books/x/blob', (sent, total) => { seen.push([sent, total]) })
    expect(blob.size).toBe(100)
    expect(seen).toEqual([[40, 100], [80, 100], [100, 100]])
  })

  it('does not pretend a failed download is a slow one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(downloadAsBlob('/api/reader/books/x/blob')).rejects.toThrow(/404/)
  })

  it('says why the server said no, in the reader\'s own words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: { code: 'unrecognised_code', message: 'This account has no shelf for that book' } },
      { status: 403 },
    )))
    // The sync line prints exactly this string, so a body the transfer helper misreads shows up there as
    // `[object Object]` — which is what the first version of this did.
    await expect(downloadAsBlob('/api/reader/books/x/blob')).rejects.toThrow('This account has no shelf for that book')
  })
})

describe('the upload bar', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('forwards what the browser has actually sent', async () => {
    const sent: [number, number][] = []
    class FakeXhr {
      method = ''
      url = ''
      status = 200
      responseType = ''
      responseText = '{"ok":true,"size":120,"key":"k"}'
      upload = {
        onprogress: null as ((event: unknown) => void) | null,
      }

      open(method: string, url: string) {
        this.method = method
        this.url = url
      }

      setRequestHeader() {}

      send() {
        setTimeout(() => {
          this.upload.onprogress?.({ loaded: 60, total: 120, lengthComputable: true })
          this.upload.onprogress?.({ loaded: 120, total: 120, lengthComputable: true })
          this.onload?.()
        }, 0)
      }

      onload?: () => void
      onerror?: () => void
      onabort?: () => void
    }

    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const answer = await uploadWithProgress<{ ok: boolean; size: number }>(
      '/api/reader/books/x/blob',
      new Blob([new Uint8Array(120)]),
      120,
      (value, total) => sent.push([value, total]),
    )
    expect(answer.ok).toBe(true)
    expect(sent).toEqual([[60, 120], [120, 120]])
  })

  it('carries the server\'s reason for a refusal up to the sync line', async () => {
    class RefusingXhr {
      open() {}
      setRequestHeader() {}
      upload = { onprogress: null }
      status = 403
      responseType = ''
      responseText = '{"error":{"code":"unrecognised_code","message":"This account\'s shelf has 12 bytes free and the file needs 4096"}}'

      send() {
        setTimeout(() => this.onload?.(), 0)
      }

      onload?: () => void
    }
    vi.stubGlobal('XMLHttpRequest', RefusingXhr)
    await expect(uploadWithProgress('/api/reader/books/x/blob', new Blob(['x']), 1))
      .rejects.toThrow('This account\'s shelf has 12 bytes free and the file needs 4096')
  })

  it('reports a transport failure instead of a stalled bar', async () => {

    class BrokenXhr extends Object {
      open() {}
      setRequestHeader() {}
      upload = { onprogress: null }
      send() {
        setTimeout(() => this.onerror?.(), 0)
      }

      onerror?: () => void
    }
    vi.stubGlobal('XMLHttpRequest', BrokenXhr)
    await expect(uploadWithProgress('/api/reader/books/x/blob', new Blob(['x']), 1)).rejects.toThrow(/did not reach/)
  })
})
