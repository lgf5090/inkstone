const QUOTED_DATE = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

export function escapeEmailHtml(text: string): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function textToEmailHtml(text: string): string {
  if (!text) return ''
  return `<div style="white-space:pre-wrap">${escapeEmailHtml(text).replace(/\n/g, '<br>')}</div>`
}

export function stripEmailHtmlToText(html: string): string {
  if (!html) return ''
  return decodeEmailEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

export function decodeEmailEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

export function emailSnippet(html: string | null | undefined, maxLength = 100): string {
  if (!html) return ''
  const clean = stripEmailHtmlToText(html)
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}...` : clean
}

export function splitEmailList(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function toEmailListValue(addresses: string[]): string | string[] | undefined {
  if (addresses.length === 0) return undefined
  return addresses.length === 1 ? addresses[0] : addresses
}

export function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase()
}

export function isValidEmailAddress(value: string): boolean {
  if (value.length > 320) return false
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
}

export function formatEmailQuotedDate(value: string | number | undefined): string {
  if (value === undefined || value === '') return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : QUOTED_DATE.format(date)
}

export function buildEmailQuoteMarkdown(date: string | undefined, sender: string, body: string): string {
  const text = stripEmailHtmlToText(body)
  if (!text) return ''
  const quoted = text
    .split(/\n+/)
    .map((line) => `> ${line}`)
    .join('\n')
  return `\n\n> On ${formatEmailQuotedDate(date)}, ${sender} wrote:\n>\n${quoted}`
}

export function buildEmailQuoteHtml(date: string | undefined, sender: string, body: string): string {
  const text = stripEmailHtmlToText(body)
  if (!text) return ''
  return `<br><blockquote><p>On ${escapeEmailHtml(formatEmailQuotedDate(date))}, ${escapeEmailHtml(sender)} wrote:</p>${textToEmailHtml(text)}</blockquote>`
}
