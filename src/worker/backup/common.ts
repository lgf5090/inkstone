import { APP_VERSION } from '@shared/constants'

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


export async function readResponseBytesWithinLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error('The third-party response exceeds the safety limit')
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('The third-party response exceeds the safety limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
