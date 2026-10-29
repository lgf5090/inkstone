/**
 * Share a generated file through the platform sheet, or download it.
 *
 * The caller owns any toast: this helper only reports which path ran. A cancelled share is not a
 * failure and must not fall through to a download, so AbortError is answered silently.
 */
import { downloadBlob } from '../export-note'

export type ShareResult = 'shared' | 'downloaded'

export async function shareOrDownload(blob: Blob, filename: string): Promise<ShareResult> {
  if (typeof navigator !== 'undefined'
    && typeof navigator.share === 'function'
    && typeof navigator.canShare === 'function'
    && typeof File === 'function') {
    try {
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename })
        return 'shared'
      }
    } catch (error) {
      if (isAbortError(error)) return 'shared'
      // A refused or unavailable share sheet falls back to the download path below; the caller still
      // gets the file, which is the promise this helper makes.
    }
  }
  downloadBlob(filename, blob)
  return 'downloaded'
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError'
}
