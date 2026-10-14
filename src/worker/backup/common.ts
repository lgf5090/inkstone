import { APP_VERSION } from '@shared/constants'
import { readStreamWithinLimit } from '../lib/request'

export interface DeliverResult {
  files: number
  bytes: number
}


export const BACKUP_USER_AGENT = `Mozilla/5.0 (compatible; InkstoneBackup/${APP_VERSION})`


export function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/SignatureDoesNotMatch/i.test(message)) return 'Signature mismatch. Check the Secret Key and region'
  if (/InvalidAccessKeyId/i.test(message)) return 'The Access Key is invalid'
  if (/aborted|timeout/i.test(message)) return 'Connection timed out. Check the network and URL'
  if (/fetch failed|Network|ENOTFOUND|getaddrinfo/i.test(message)) {
    return 'Could not connect. Check the URL'
  }
  if (/internal error; reference/i.test(message)) {
    return 'Could not connect. Check DNS, the port, and the TLS certificate'
  }
  return message
    .replace(/\bBearer\s+[^\s,]+/gi, 'Bearer [redacted]')
    .replace(/:\/\/[^\s/@]+:[^\s@]+@/g, '://[redacted]@')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 240)
}


export function isTransientBackupError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    /\bHTTP\s+(?:408|425|429|5\d\d)\b/i.test(message) ||
    /aborted|timeout|fetch failed|network|enotfound|getaddrinfo|internal error; reference/i.test(message)
  )
}


/**
 * The bytes of a third-party response, refused whole once it passes `maxBytes`.
 *
 * A storage service that answers with more than the limit is not worth reading further, and a backup
 * target is somebody's server: the ceiling is what keeps one misbehaving endpoint from deciding how
 * much memory this run holds. Over the ceiling this throws plainly — the callers are background jobs
 * that record the failure on the run, not an API answering a reader.
 */
export async function readResponseBytesWithinLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Best-effort: the body is being thrown away either way, and a failed `cancel()` must not
    // replace the honest "too large" answer above.
    await response.body?.cancel().catch(() => {})
    throw new Error('The third-party response exceeds the safety limit')
  }
  const bytes = await readStreamWithinLimit(response.body, maxBytes)
  if (bytes === null) throw new Error('The third-party response exceeds the safety limit')
  return bytes
}
