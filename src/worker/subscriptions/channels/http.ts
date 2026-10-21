export {
  OUTBOUND_MAX_BYTES,
  OUTBOUND_TIMEOUT_MS,
  checkTarget,
  outbound,
} from '../../lib/outbound'
export type { OutboundOptions, OutboundResponse } from '../../lib/outbound'

const DETAIL_MAX_CHARS = 500

/** A response body fit for a log row: short, and with anything that looks like a credential removed. */
export function redact(text: string): string {
  return text
    .replace(/(bot)[\w:-]{8,}/gi, '$1***')
    .replace(/((?:token|key|secret|sendkey|password)=)[^&\s"']+/gi, '$1***')
    .replace(/(Bearer\s+)[\w.-]{8,}/gi, '$1***')
    .slice(0, DETAIL_MAX_CHARS)
}

/** `JSON.parse` that answers null instead of throwing, for a channel reading somebody else's API. */
export function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}
