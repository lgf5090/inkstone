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

const EMAIL_BLOCK_TAG_RE = /<\/?(?:address|article|aside|blockquote|caption|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|tfoot|thead|tr|ul)(?:\s[^>]*)?\/?>/gi
const EMAIL_LINE_BREAK_TAG_RE = /<br(?:\s[^>]*)?\/?>/gi
const EMAIL_CELL_TAG_RE = /<\/?(?:td|th)(?:\s[^>]*)?\/?>/gi

export function stripEmailHtmlToText(html: string): string {
  if (!html) return ''
  return decodeEmailEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(EMAIL_LINE_BREAK_TAG_RE, '\n')
      .replace(EMAIL_CELL_TAG_RE, '\t')
      .replace(EMAIL_BLOCK_TAG_RE, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
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
  const clean = stripEmailHtmlToText(html).replace(/\s+/g, ' ')
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

export function normalizeSubject(value: string): string {
  return value
    .replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*[:\uff1a]\s*|(?:\u56de\u590d|\u56de\u8986|\u7b54\u590d|\u8f6c\u5bc4|\u8f49\u5bc4|\u8f6c\u53d1|\u8f49\u53d1)\s*[:\uff1a]\s*)+/i, '')
    .trim()
    .toLowerCase()
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
