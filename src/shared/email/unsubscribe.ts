import { isValidEmailAddress } from './format'

export interface EmailUnsubscribeAction {
  url?: string
  email?: string
  oneClick: boolean
}

export function emailUnsubscribeAction(headers: readonly { key: string, value: string }[]): EmailUnsubscribeAction | null {
  const value = headers.find((header) => header.key.toLowerCase() === 'list-unsubscribe')?.value
  if (!value) return null
  const oneClick = headers.some((header) =>
    header.key.toLowerCase() === 'list-unsubscribe-post' && /list-unsubscribe\s*=\s*one-click/i.test(header.value),
  )
  let email: string | undefined
  for (const match of value.matchAll(/<([^<>]+)>/g)) {
    const uri = match[1]?.trim() ?? ''
    if (/^https:\/\//i.test(uri)) {
      try {
        const url = new URL(uri)
        if (url.protocol === 'https:' && !/[\u0000-\u001f\u007f]/.test(url.href)) return { url: url.href, oneClick }
      } catch {
        continue
      }
    }
    if (!email && /^mailto:/i.test(uri)) {
      const address = uri.slice(7).split('?', 1)[0]?.trim() ?? ''
      try {
        const decoded = decodeURIComponent(address)
        if (isValidEmailAddress(decoded)) email = decoded
      } catch {
        continue
      }
    }
  }
  return email ? { email, oneClick: false } : null
}
