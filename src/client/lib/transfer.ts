/**
 * Byte transfers that tell the reader how far they have got.
 *
 * `fetch` cannot report how much of a request body the server has taken, which is the one number a
 * 40 MB book needs while it is going up, so the upload goes through `XMLHttpRequest` — the browser API
 * that still has `upload.onprogress` — and carries the same headers the rest of the app's requests do.
 * Downloads use `fetch` and count the chunks, because that side can be streamed.
 */
import { CLIENT_HEADER } from '@shared/constants'
import { CLIENT_ID } from './api'
import { getLocale } from './i18n'

export type ProgressFn = (sent: number, total: number) => void

export class TransferAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'TransferAborted'
  }
}

function baseHeaders(): Record<string, string> {
  return {
    [CLIENT_HEADER]: '1',
    'X-Inkstone-Origin': CLIENT_ID,
    'Accept-Language': getLocale(),
  }
}

/** PUT `body` to `url`, reporting bytes as they leave. Resolves with the parsed JSON response. */
export function uploadWithProgress<T>(url: string, body: Blob | ArrayBuffer, total: number, onProgress?: ProgressFn, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    for (const [key, value] of Object.entries(baseHeaders())) xhr.setRequestHeader(key, value)
    xhr.responseType = 'text'
    xhr.upload.onprogress = (event) => {
      onProgress?.(event.loaded, event.lengthComputable ? event.total || total : total)
    }
    const abort = () => xhr.abort()
    signal?.addEventListener('abort', abort, { once: true })
    xhr.onabort = () => {
      signal?.removeEventListener('abort', abort)
      reject(new TransferAborted())
    }
    xhr.onerror = () => {
      signal?.removeEventListener('abort', abort)
      reject(new Error('The upload did not reach the server'))
    }
    xhr.onload = () => {
      signal?.removeEventListener('abort', abort)
      let parsed: unknown = null
      try {
        parsed = JSON.parse(xhr.responseText || '{}')
      } catch {
        parsed = null
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T)
      else reject(new Error((parsed as { error?: string } | null)?.error || `Upload failed (${xhr.status})`))
    }
    xhr.send(body as XMLHttpRequestBodyInit)
  })
}

/** GET `url` as a Blob, counting chunks so a slow line still shows a moving bar. */
export async function downloadAsBlob(url: string, onProgress?: ProgressFn, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { headers: baseHeaders(), credentials: 'include', signal })
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  if (!response.body) {
    const blob = await response.blob()
    onProgress?.(blob.size, blob.size)
    return blob
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    received += value.byteLength
    onProgress?.(received, total || received)
  }
  return new Blob(chunks as BlobPart[], { type: response.headers.get('content-type') ?? 'application/octet-stream' })
}
