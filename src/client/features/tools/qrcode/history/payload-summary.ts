import type { QrContentType } from '../../../../../shared/tools/qrcode/types'

/** Undo the escaping `encodeQrData` applies to the fields a Wi-Fi or vCard payload is built from. */
function unescapeField(value: string, escapes: RegExp): string {
  return value.replace(escapes, (_match, char: string) => char)
}

/**
 * The one line a history card prints for a stored payload. The raw string is what a phone reads, not
 * what a person wants to scan a list of: a Wi-Fi payload carries the network key in cleartext and a
 * vCard is a dozen lines, so each protocol contributes its identifying field instead.
 */
export function summarizeQrPayload(contentType: QrContentType, payload: string): string {
  const value = payload.trim()
  if (!value) return ''
  switch (contentType) {
    case 'wifi': {
      const ssid = /S:((?:[^;\\]|\\.)*)/.exec(value)?.[1]
      return ssid ? unescapeField(ssid, /\\([\\;,:"])/g) : value
    }
    case 'vcard': {
      const name = /^FN:(.*)$/m.exec(value)?.[1]?.trim()
      return name ? unescapeField(name, /\\([,;:\\])/g).replace(/\\n/g, ' ') : value
    }
    case 'email':
      return /^mailto:([^?]+)/.exec(value)?.[1] ?? value
    case 'phone': {
      const sms = /^smsto:([^:]+)/i.exec(value)?.[1]
      return sms ?? value.replace(/^tel:/i, '')
    }
    default:
      return value
  }
}
