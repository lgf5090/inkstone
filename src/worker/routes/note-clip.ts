import { Hono } from 'hono'
import sanitizeHtml from 'sanitize-html'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { assertAttemptBudget, consumeAttemptBudget } from '../lib/throttle'
import { requireAuth } from '../middleware/auth'
import { guardedFetch, readGuardedBytes } from '../nav/safe-fetch'

export const noteClipRoutes = new Hono<AppBindings>()

noteClipRoutes.use('*', requireAuth)

const MAX_URL_LENGTH = 2048
const MAX_HTML_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 8000
const READ_TIMEOUT_MS = 8000
const MAX_REDIRECTS = 5
const MAX_TITLE_LENGTH = 512
const CLIP_ATTEMPTS = 20
const CLIP_WINDOW_MS = 10 * 60 * 1000

const ARTICLE_TAGS = [
  'article', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'code',
  'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'a', 'br', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'dl', 'dt', 'dd', 'figcaption', 'sup', 'sub',
]

function clipUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) {
    throw ApiError.badRequest('A valid URL of at most 2048 characters is required')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  }
  catch {
    throw ApiError.badRequest('The URL is invalid')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw ApiError.badRequest('Only HTTP and HTTPS URLs can be clipped')
  }
  if (url.username || url.password) throw ApiError.badRequest('The URL may not contain credentials')
  return url
}

function htmlType(contentType: string): boolean {
  return /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType.trim())
}

function decodeTitleEntities(value: string): string {
  const codePoint = (raw: string, radix: number): string => {
    const point = Number.parseInt(raw, radix)
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd'
  }
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(hex, 16))
    .replace(/&#(\d+);/g, (_, code: string) => codePoint(code, 10))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function extractTitle(source: string, finalUrl: string): string {
  const matched = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)
  const title = decodeTitleEntities(sanitizeHtml(matched?.[1] ?? '', {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'template', 'svg', 'math'],
  })).replace(/\s+/g, ' ').trim()
  return title.slice(0, MAX_TITLE_LENGTH) || new URL(finalUrl).hostname
}

function sanitizeArticle(source: string): string {
  return sanitizeHtml(source, {
    allowedTags: ARTICLE_TAGS,
    allowedAttributes: {
      a: ['href', 'title'],
      ol: ['start'],
      code: ['class'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedClasses: { code: [/^language-[a-z0-9_-]+$/i] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: true,
    nonTextTags: ['title', 'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'],
    parser: { decodeEntities: true },
  }).trim()
}

async function discardUnusedBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

noteClipRoutes.post('/clip', async (c) => {
  const userId = c.get('userId')
  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [
    { key: `note-clip:${userId}`, maxAttempts: CLIP_ATTEMPTS, windowMs: CLIP_WINDOW_MS, lockMs: 60_000 },
  ]), 'Too many URL clip requests')

  const body = await readJson<{ url?: unknown }>(c, JSON_BODY_LIMITS.small)
  const url = clipUrl(body.url)
  const fetched = await guardedFetch(url.href, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    headers: { Accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1' },
  })
  if (fetched.error) {
    const status = fetched.error === 'invalid_url' ? 400 : fetched.error === 'blocked_target' ? 403 : 502
    const code = status === 400 ? 'bad_request' : status === 403 ? 'forbidden' : 'upstream_unavailable'
    throw new ApiError(status, code, 'The URL could not be fetched safely')
  }
  const response = fetched.response
  if (!response.ok) {
    await discardUnusedBody(response)
    throw new ApiError(502, 'upstream_unavailable', `The page returned HTTP ${response.status}`)
  }
  if (!htmlType(response.headers.get('content-type') ?? '')) {
    await discardUnusedBody(response)
    throw new ApiError(415, 'bad_request', 'Only HTML and XHTML pages can be clipped')
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
    await discardUnusedBody(response)
    throw ApiError.tooLarge('The page exceeds the 2 MB clip limit')
  }

  const bytes = await readGuardedBytes(response, MAX_HTML_BYTES, READ_TIMEOUT_MS)
  if (bytes === null) throw ApiError.tooLarge('The page is too large or took too long to read')
  const source = new TextDecoder().decode(bytes)
  const html = sanitizeArticle(source)
  if (!html.replace(/<[^>]*>/g, '').trim()) throw ApiError.badRequest('The page has no readable article content')
  return c.json({ title: extractTitle(source, fetched.finalUrl), url: fetched.finalUrl, html })
})
